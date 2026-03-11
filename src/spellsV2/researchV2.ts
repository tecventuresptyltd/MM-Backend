/**
 * V2 Spell Research (Library) Functions
 *
 * Handles the new spell progression system where spells:
 * 1. Level up via Time-gated Research
 * 2. Research requires Spell Shards + Time in the Library queue
 *
 * @module spellsV2
 */

import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import {
    getSpellEvolutionV2Catalog,
    getResearchCostForLevel,
    getPlayerSlotsConfig,
    calculateSkipCost,
    getUnlockResearchCost,
} from "../core/configV2.js";
import { getSpellsCatalog } from "../core/catalog.js";
import {
    StartSpellResearchRequest,
    StartSpellResearchResponse,
    ClaimSpellResearchRequest,
    ClaimSpellResearchResponse,
    UserLibraryDoc,
    LibrarySlotEntry,
} from "../shared/typesV2.js";
import { scheduleUpgradeCompletion, cancelUpgradeCompletion } from "../upgrades/upgradeScheduler.js";

const db = admin.firestore();

// =============================================================================
// startSpellResearchV2
// =============================================================================

/**
 * Start researching a spell to level it up.
 *
 * Check Logic:
 * 1. Verify player owns the spell (level >= 1)
 * 2. Verify spell is not already at max level
 * 3. Verify Library has available slot
 * 4. Verify player has sufficient Spell Shards
 * 5. Deduct shards
 * 6. Add to Library queue with completesAt timestamp
 */
export const startSpellResearchV2 = onCall(
    callableOptions({ minInstances: getMinInstances(false), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const { spellId, opId } = request.data as StartSpellResearchRequest;
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        if (!spellId || !opId) {
            throw new HttpsError("invalid-argument", "Missing required parameters: spellId, opId");
        }

        // Check idempotency
        const existingResult = await checkIdempotency(uid, opId);
        if (existingResult) {
            return existingResult;
        }

        await createInProgressReceipt(uid, opId, "startSpellResearchV2");

        // Load configs
        const [researchCatalog, slotsConfig, spellsCatalog, unlockCost] = await Promise.all([
            getSpellEvolutionV2Catalog(),
            getPlayerSlotsConfig(),
            getSpellsCatalog(),
            getUnlockResearchCost(),
        ]);

        const result = await runTransactionWithReceipt<StartSpellResearchResponse>(
            uid,
            opId,
            "startSpellResearchV2",
            async (transaction) => {
                const now = Date.now();
                const timestamp = admin.firestore.FieldValue.serverTimestamp();

                // Document refs
                const economyRef = db.doc(`/Players/${uid}/Economy/Stats`);
                const spellsRef = db.doc(`/Players/${uid}/Spells/Levels`);
                const libraryRef = db.doc(`/Players/${uid}/Queues/Library`);
                const profileRef = db.doc(`/Players/${uid}/Profile/Profile`);

                // Read all documents
                const [economyDoc, spellsDoc, libraryDoc, profileDoc] = await Promise.all([
                    transaction.get(economyRef),
                    transaction.get(spellsRef),
                    transaction.get(libraryRef),
                    transaction.get(profileRef),
                ]);

                // Validate economy exists
                if (!economyDoc.exists) {
                    throw new HttpsError("not-found", "Player economy not found.");
                }
                const economyData = economyDoc.data()!;

                // Read spells data (may not exist for brand new players)
                const spellsData = spellsDoc.exists ? spellsDoc.data()! : {};

                // Read from nested structure first, fallback to legacy
                const spellsMap = (spellsData.spells ?? {}) as Record<string, { level?: number; xp?: number; isXpCapped?: boolean }>;
                const legacyLevelsMap = (spellsData.levels ?? {}) as Record<string, number>;

                // Check player owns the spell OR is eligible to unlock it
                const spellData = spellsMap[spellId];
                const currentLevel = spellData?.level ?? legacyLevelsMap[spellId] ?? 0;

                // Determine if this is an unlock research (0 → 1)
                const isUnlockResearch = currentLevel < 1;
                let researchCost: { shards: number; durationSeconds: number };
                let targetLevel: number;

                if (isUnlockResearch) {
                    // Player doesn't own the spell — check if they can unlock it
                    const catalogSpell = spellsCatalog[spellId];
                    if (!catalogSpell) {
                        throw new HttpsError("not-found", `Spell ${spellId} not found in catalog.`);
                    }

                    // Check player mastery rank meets requirement
                    // (requiredLevel in SpellsCatalog is now interpreted as requiredMasteryRank)
                    const profileData = profileDoc.data() ?? {};
                    const playerMasteryRank = Number(profileData.masteryRank ?? 0);
                    const requiredMasteryRank = catalogSpell.requiredLevel ?? 0;
                    if (requiredMasteryRank <= 0 || playerMasteryRank < requiredMasteryRank) {
                        throw new HttpsError(
                            "failed-precondition",
                            `Mastery Rank ${playerMasteryRank} does not meet required rank ${requiredMasteryRank} for spell ${spellId}.`,
                        );
                    }

                    targetLevel = 1;
                    researchCost = unlockCost;
                } else {
                    // Normal level-up research
                    const maxLevel = researchCatalog.maxSpellLevel;
                    if (currentLevel >= maxLevel) {
                        throw new HttpsError("failed-precondition", "Spell is already at maximum level.");
                    }

                    targetLevel = currentLevel + 1;
                    const cost = researchCatalog.researchCosts[String(targetLevel)];
                    if (!cost) {
                        throw new HttpsError("internal", `Research cost not configured for level ${targetLevel}`);
                    }
                    researchCost = cost;
                }

                // Get player's library slots  
                const profileData2 = profileDoc.data() ?? {};
                const playerLibrarySlots = profileData2.librarySlots ?? slotsConfig.library.defaultSlots;

                // Check library queue
                const libraryData = (
                    libraryDoc.exists ? libraryDoc.data() : { slots: [], maxSlots: playerLibrarySlots }
                ) as UserLibraryDoc;
                const currentSlots = libraryData.slots ?? [];

                // Check if spell is already researching
                if (currentSlots.some((slot) => slot.spellId === spellId)) {
                    throw new HttpsError("already-exists", "This spell is already being researched.");
                }

                // Check slot availability
                if (currentSlots.length >= playerLibrarySlots) {
                    throw new HttpsError(
                        "failed-precondition",
                        `Library is full. Slots: ${currentSlots.length}/${playerLibrarySlots}. Wait or purchase more slots.`,
                    );
                }

                // Check Spell Shards
                const playerShards = economyData.spellShards ?? 0;
                if (playerShards < researchCost.shards) {
                    throw new HttpsError(
                        "failed-precondition",
                        `Insufficient Spell Shards. Required: ${researchCost.shards}, Available: ${playerShards}.`,
                    );
                }

                // Calculate completesAt
                const completesAtMs = now + researchCost.durationSeconds * 1000;
                const completesAtTimestamp = admin.firestore.Timestamp.fromMillis(completesAtMs);

                // --- WRITES ---

                // 1. Deduct shards
                if (researchCost.shards > 0) {
                    transaction.update(economyRef, {
                        spellShards: admin.firestore.FieldValue.increment(-researchCost.shards),
                        updatedAt: timestamp,
                    });
                }

                // 2. Add to library queue (for UI timer display)
                // NOTE: Cannot use FieldValue.serverTimestamp() inside arrays
                const startedAtTimestamp = admin.firestore.Timestamp.fromMillis(now);
                const newSlotEntry: LibrarySlotEntry = {
                    spellId,
                    startedAt: startedAtTimestamp,
                    completesAt: completesAtTimestamp,
                    targetLevel,
                    shardsPaid: researchCost.shards,
                };

                if (libraryDoc.exists) {
                    transaction.update(libraryRef, {
                        slots: admin.firestore.FieldValue.arrayUnion(newSlotEntry),
                        updatedAt: timestamp,
                    });
                } else {
                    transaction.set(libraryRef, {
                        slots: [newSlotEntry],
                        maxSlots: playerLibrarySlots,
                        updatedAt: timestamp,
                    });
                }


                return {
                    success: true,
                    opId,
                    spellId,
                    targetLevel,
                    completesAt: completesAtMs,
                    shardsSpent: researchCost.shards,
                };
            },
        );

        // Side-effect: schedule auto-completion (outside transaction per Transaction Metadata Return pattern)
        if (result && result.success) {
            try {
                await scheduleUpgradeCompletion({
                    uid,
                    upgradeType: "spellResearch",
                    targetId: spellId,
                    targetLevel: result.targetLevel,
                    completesAt: result.completesAt,
                    createdAt: Date.now(),
                });
            } catch (error) {
                console.warn(`[ResearchV2] Failed to schedule auto-completion for ${uid}/${spellId}`, error);
            }
        }

        return result;
    },
);

// =============================================================================
// claimSpellResearchV2
// =============================================================================

/**
 * Complete spell research and claim the level upgrade.
 *
 * Check Logic:
 * 1. Verify spell is in Library queue
 * 2. Verify research timer is complete
 * 3. Increment spell level
 * 4. Remove from queue
 */
export const claimSpellResearchV2 = onCall(
    callableOptions({ minInstances: getMinInstances(false), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const { spellId, opId } = request.data as ClaimSpellResearchRequest;
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        if (!spellId || !opId) {
            throw new HttpsError("invalid-argument", "Missing required parameters: spellId, opId");
        }

        // Check idempotency
        const existingResult = await checkIdempotency(uid, opId);
        if (existingResult) {
            return existingResult;
        }

        await createInProgressReceipt(uid, opId, "claimSpellResearchV2");

        const result = await runTransactionWithReceipt<ClaimSpellResearchResponse>(
            uid,
            opId,
            "claimSpellResearchV2",
            async (transaction) => {
                const now = Date.now();
                const timestamp = admin.firestore.FieldValue.serverTimestamp();

                // Document refs
                const spellsRef = db.doc(`/Players/${uid}/Spells/Levels`);
                const libraryRef = db.doc(`/Players/${uid}/Queues/Library`);

                // Read documents
                const [spellsDoc, libraryDoc] = await Promise.all([
                    transaction.get(spellsRef),
                    transaction.get(libraryRef),
                ]);

                // Validate library exists
                if (!libraryDoc.exists) {
                    throw new HttpsError("not-found", "No spells in Library queue.");
                }

                const libraryData = libraryDoc.data() as UserLibraryDoc;
                const currentSlots = libraryData.slots ?? [];

                // Find the spell in the queue
                const slotIndex = currentSlots.findIndex((slot) => slot.spellId === spellId);
                if (slotIndex === -1) {
                    throw new HttpsError("not-found", "Spell is not in the Library queue.");
                }

                const slot = currentSlots[slotIndex];

                // Check if research is complete
                const completesAt = slot.completesAt as admin.firestore.Timestamp;
                if (completesAt.toMillis() > now) {
                    const remainingSeconds = Math.ceil((completesAt.toMillis() - now) / 1000);
                    throw new HttpsError(
                        "failed-precondition",
                        `Research not complete. ${remainingSeconds} seconds remaining. Use gems to skip.`,
                    );
                }

                // --- WRITES ---

                // Remove from queue
                const updatedSlots = currentSlots.filter((_, idx) => idx !== slotIndex);
                transaction.update(libraryRef, {
                    slots: updatedSlots,
                    updatedAt: timestamp,
                });

                // Update spell level
                const isUnlockClaim = slot.targetLevel === 1;
                const spellsData = spellsDoc.exists ? spellsDoc.data() : {};
                const spellsMap = ((spellsData as Record<string, unknown>)?.spells ?? {}) as Record<string, unknown>;
                const existingSpell = spellsMap[spellId] as { level?: number } | undefined;
                const existingLevel = existingSpell?.level ?? 0;


                if (isUnlockClaim && existingLevel < 1) {
                    // Brand new spell unlock: create the entry + set unlockedAt

                    const timestamp2 = admin.firestore.FieldValue.serverTimestamp();
                    if (spellsDoc.exists) {
                        transaction.update(spellsRef, {
                            [`spells.${spellId}`]: { level: 1, xp: 0, isXpCapped: false },
                            [`unlockedAt.${spellId}`]: timestamp2,
                            updatedAt: timestamp,
                        });
                    } else {
                        transaction.set(spellsRef, {
                            spells: { [spellId]: { level: 1, xp: 0, isXpCapped: false } },
                            unlockedAt: { [spellId]: timestamp2 },
                            updatedAt: timestamp,
                        });
                    }
                } else {
                    // Normal level-up: just update the existing entry
                    transaction.update(spellsRef, {
                        [`spells.${spellId}.level`]: slot.targetLevel,
                        [`spells.${spellId}.xp`]: 0,
                        [`spells.${spellId}.isXpCapped`]: false,
                        updatedAt: timestamp,
                    });
                }

                return {
                    success: true,
                    opId,
                    spellId,
                    newLevel: slot.targetLevel,
                };
            },
        );

        // Side-effect: cancel auto-completion queue entry (player claimed manually)
        if (result && result.success) {
            try {
                await cancelUpgradeCompletion(uid, "spellResearch", spellId);
            } catch (error) {
                console.warn(`[ResearchV2] Failed to cancel auto-completion on claim for ${uid}/${spellId}`, error);
            }
        }

        return result;
    },
);

// =============================================================================
// skipSpellResearchV2
// =============================================================================

interface SkipSpellResearchRequest {
    spellId: string;
    opId: string;
}

interface SkipSpellResearchResponse {
    success: boolean;
    opId: string;
    spellId: string;
    gemsSpent: number;
}

/**
 * Pay gems to instantly complete spell research.
 */
export const skipSpellResearchV2 = onCall(
    callableOptions({ minInstances: getMinInstances(false), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const { spellId, opId } = request.data as SkipSpellResearchRequest;
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        if (!spellId || !opId) {
            throw new HttpsError("invalid-argument", "Missing required parameters: spellId, opId");
        }

        // Check idempotency
        const existingResult = await checkIdempotency(uid, opId);
        if (existingResult) {
            return existingResult;
        }

        await createInProgressReceipt(uid, opId, "skipSpellResearchV2");

        // Load config
        const researchCatalog = await getSpellEvolutionV2Catalog();

        const result = await runTransactionWithReceipt<SkipSpellResearchResponse>(
            uid,
            opId,
            "skipSpellResearchV2",
            async (transaction) => {
                const now = Date.now();
                const timestamp = admin.firestore.FieldValue.serverTimestamp();

                // Document refs
                const economyRef = db.doc(`/Players/${uid}/Economy/Stats`);
                const libraryRef = db.doc(`/Players/${uid}/Queues/Library`);
                const spellsRef = db.doc(`/Players/${uid}/Spells/Levels`);

                // Read documents
                const [economyDoc, libraryDoc, spellsDoc] = await Promise.all([
                    transaction.get(economyRef),
                    transaction.get(libraryRef),
                    transaction.get(spellsRef),
                ]);

                // Validate economy
                if (!economyDoc.exists) {
                    throw new HttpsError("not-found", "Player economy not found.");
                }
                const economyData = economyDoc.data()!;

                // Validate library
                if (!libraryDoc.exists) {
                    throw new HttpsError("not-found", "No spells in Library queue.");
                }

                const libraryData = libraryDoc.data() as UserLibraryDoc;
                const currentSlots = libraryData.slots ?? [];

                // Find the spell
                const slotIndex = currentSlots.findIndex((slot) => slot.spellId === spellId);
                if (slotIndex === -1) {
                    throw new HttpsError("not-found", "Spell is not in the Library queue.");
                }

                const slot = currentSlots[slotIndex];
                const completesAt = slot.completesAt as admin.firestore.Timestamp;

                // Check if already complete
                if (completesAt.toMillis() <= now) {
                    throw new HttpsError("failed-precondition", "Research is already complete. Use claim instead.");
                }

                // Calculate skip cost
                const remainingSeconds = Math.ceil((completesAt.toMillis() - now) / 1000);
                const skipCost = calculateSkipCost(
                    remainingSeconds,
                    researchCatalog.skipCost.gemsPerHour,
                    researchCatalog.skipCost.minGems,
                );

                // Check gems
                const playerGems = economyData.gems ?? 0;
                if (playerGems < skipCost) {
                    throw new HttpsError(
                        "failed-precondition",
                        `Insufficient gems. Required: ${skipCost}, Available: ${playerGems}.`,
                    );
                }

                // --- WRITES ---

                // Deduct gems
                transaction.update(economyRef, {
                    gems: admin.firestore.FieldValue.increment(-skipCost),
                    updatedAt: timestamp,
                });

                // Remove from queue completely since it's instantly finished
                const updatedSlots = currentSlots.filter((_, idx) => idx !== slotIndex);
                transaction.update(libraryRef, {
                    slots: updatedSlots,
                    updatedAt: timestamp,
                });

                // Update spell level
                const isUnlockClaim = slot.targetLevel === 1;
                const spellsData = spellsDoc.exists ? spellsDoc.data() : {};
                const spellsMap = ((spellsData as Record<string, unknown>)?.spells ?? {}) as Record<string, unknown>;
                const existingSpell = spellsMap[spellId] as { level?: number } | undefined;
                const existingLevel = existingSpell?.level ?? 0;

                if (isUnlockClaim && existingLevel < 1) {
                    // Brand new spell unlock: create the entry + set unlockedAt
                    const timestamp2 = admin.firestore.FieldValue.serverTimestamp();
                    if (spellsDoc.exists) {
                        transaction.update(spellsRef, {
                            [`spells.${spellId}`]: { level: 1, xp: 0, isXpCapped: false },
                            [`unlockedAt.${spellId}`]: timestamp2,
                            updatedAt: timestamp,
                        });
                    } else {
                        transaction.set(spellsRef, {
                            spells: { [spellId]: { level: 1, xp: 0, isXpCapped: false } },
                            unlockedAt: { [spellId]: timestamp2 },
                            updatedAt: timestamp,
                        });
                    }
                } else {
                    // Normal level-up: just update the existing entry
                    transaction.update(spellsRef, {
                        [`spells.${spellId}.level`]: slot.targetLevel,
                        [`spells.${spellId}.xp`]: 0,
                        [`spells.${spellId}.isXpCapped`]: false,
                        updatedAt: timestamp,
                    });
                }

                return {
                    success: true,
                    opId,
                    spellId,
                    gemsSpent: skipCost,
                    newLevel: slot.targetLevel,
                };
            },
        );

        // Side-effect: cancel auto-completion since the research was skipped (instant)
        if (result && result.success) {
            try {
                await cancelUpgradeCompletion(uid, "spellResearch", spellId);
            } catch (error) {
                console.warn(`[ResearchV2] Failed to cancel auto-completion for ${uid}/${spellId}`, error);
            }
        }

        return result;
    },
);

// =============================================================================
// getLibraryStatusV2
// =============================================================================

interface LibraryStatusResponse {
    slots: Array<{
        spellId: string;
        targetLevel: number;
        startedAt: number;
        completesAt: number;
        isComplete: boolean;
        remainingSeconds: number;
        skipCostGems: number;
    }>;
    maxSlots: number;
    availableSlots: number;
}

/**
 * Get current Library queue status.
 * Read-only endpoint.
 */
export const getLibraryStatusV2 = onCall(
    callableOptions({ cpu: 1, concurrency: 80 }),
    async (request) => {
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        const [libraryDoc, profileDoc, researchCatalog, slotsConfig] = await Promise.all([
            db.doc(`/Players/${uid}/Queues/Library`).get(),
            db.doc(`/Players/${uid}/Profile/Profile`).get(),
            getSpellEvolutionV2Catalog(),
            getPlayerSlotsConfig(),
        ]);

        const now = Date.now();
        const profileData = profileDoc.data() ?? {};
        const playerMaxSlots = profileData.librarySlots ?? slotsConfig.library.defaultSlots;

        if (!libraryDoc.exists) {
            return {
                slots: [],
                maxSlots: playerMaxSlots,
                availableSlots: playerMaxSlots,
            } as LibraryStatusResponse;
        }

        const libraryData = libraryDoc.data() as UserLibraryDoc;
        const currentSlots = libraryData.slots ?? [];

        const slots = currentSlots.map((slot) => {
            const completesAt = (slot.completesAt as admin.firestore.Timestamp).toMillis();
            const isComplete = completesAt <= now;
            const remainingSeconds = isComplete ? 0 : Math.ceil((completesAt - now) / 1000);
            const skipCostGems = isComplete
                ? 0
                : calculateSkipCost(
                    remainingSeconds,
                    researchCatalog.skipCost.gemsPerHour,
                    researchCatalog.skipCost.minGems,
                );

            return {
                spellId: slot.spellId,
                targetLevel: slot.targetLevel,
                startedAt: (slot.startedAt as admin.firestore.Timestamp).toMillis(),
                completesAt,
                isComplete,
                remainingSeconds,
                skipCostGems,
            };
        });

        return {
            slots,
            maxSlots: playerMaxSlots,
            availableSlots: playerMaxSlots - slots.length,
        } as LibraryStatusResponse;
    },
);
