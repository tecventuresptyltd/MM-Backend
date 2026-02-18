/**
 * V2 Crate Slots Functions
 *
 * Handles the new crate slot system where:
 * 1. Players have 4 slots for crates
 * 2. Only 1 crate can be unlocking at a time
 * 3. Full slots grant fallback currency instead
 *
 * @module cratesV2
 */

import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import {
    getCrateSlotsConfig,
    getUnlockDurationForRarity,
    calculateSkipCost,
    getCrateRewardsConfig,
} from "../core/configV2.js";
import { getCratesCatalog, listSkusByFilter } from "../core/config.js";
import {
    ReceiveCrateV2Request,
    ReceiveCrateV2Response,
    StartCrateUnlockRequest,
    StartCrateUnlockResponse,
    ClaimCrateRewardV2Request,
    ClaimCrateRewardV2Response,
    UserCrateSlotsDoc,
    CrateSlotEntry,
    AwardedItem,
    CrateRewardItem,
} from "../shared/typesV2.js";
import { grantInventoryRewards } from "../shared/inventoryAwards.js";

const db = admin.firestore();

// =============================================================================
// receiveCrateV2
// =============================================================================

/**
 * Receive a crate after winning a race.
 *
 * Check Logic:
 * 1. Check if slots are available
 * 2. If available, add crate to slot
 * 3. If full, grant fallback currency instead
 */
export const receiveCrateV2 = onCall(
    callableOptions({ minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const { crateSkuId, opId } = request.data as ReceiveCrateV2Request;
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        if (!crateSkuId || !opId) {
            throw new HttpsError("invalid-argument", "Missing required parameters: crateSkuId, opId");
        }

        // Check idempotency
        const existingResult = await checkIdempotency(uid, opId);
        if (existingResult) {
            return existingResult;
        }

        await createInProgressReceipt(uid, opId, "receiveCrateV2");

        // Load configs
        const [slotsConfig, cratesCatalog] = await Promise.all([
            getCrateSlotsConfig(),
            getCratesCatalog(),
        ]);

        // Find the crate info
        const crateInfo = Object.entries(cratesCatalog).find(
            ([_, crate]) => crate.crateSkuId === crateSkuId,
        );

        if (!crateInfo) {
            throw new HttpsError("not-found", `Crate not found for SKU: ${crateSkuId}`);
        }

        const [crateId, crate] = crateInfo;
        const rarity = crate.rarity || "common";

        // Capture unlock duration at receive time so the frontend always has it,
        // even before unlocking starts (when startedAt/completesAt are null).
        const unlockDurationSeconds = await getUnlockDurationForRarity(rarity);

        return await runTransactionWithReceipt<ReceiveCrateV2Response>(
            uid,
            opId,
            "receiveCrateV2",
            async (transaction) => {
                const timestamp = admin.firestore.FieldValue.serverTimestamp();

                // Document refs
                const slotsRef = db.doc(`/Players/${uid}/Crates/Slots`);
                const economyRef = db.doc(`/Players/${uid}/Economy/Stats`);

                // Read documents
                const slotsDoc = await transaction.get(slotsRef);

                // Get current slots
                const slotsData = (
                    slotsDoc.exists ? slotsDoc.data() : { slots: [], maxSlots: slotsConfig.maxSlots }
                ) as UserCrateSlotsDoc;

                // Filter out null entries and count
                const currentSlots = (slotsData.slots ?? []).filter((s) => s !== null);
                const maxSlots = slotsData.maxSlots ?? slotsConfig.maxSlots;

                // Check if slots are full
                if (currentSlots.length >= maxSlots) {
                    // Grant fallback currency
                    if (slotsConfig.slotFullFallback.enabled) {
                        const fallbackRewards = slotsConfig.slotFullFallback.rewards;

                        const updates: Record<string, FirebaseFirestore.FieldValue> = {
                            updatedAt: timestamp,
                        };

                        if (fallbackRewards.coins) {
                            updates.coins = admin.firestore.FieldValue.increment(fallbackRewards.coins);
                        }
                        if (fallbackRewards.spellShards) {
                            updates.spellShards = admin.firestore.FieldValue.increment(fallbackRewards.spellShards);
                        }

                        transaction.update(economyRef, updates);

                        return {
                            success: true,
                            opId,
                            slotIndex: null,
                            fallbackGranted: true,
                            fallbackRewards,
                        };
                    }

                    return {
                        success: false,
                        opId,
                        slotIndex: null,
                        fallbackGranted: false,
                    };
                }

                // Add crate to first available slot
                const newSlotEntry: CrateSlotEntry = {
                    crateSkuId,
                    crateId,
                    rarity,
                    receivedAt: admin.firestore.Timestamp.now(),
                    isUnlocking: false,
                    startedAt: null,
                    completesAt: null,
                    unlockDurationSeconds,
                };

                // Create slots array with nulls for empty slots
                const newSlots: (CrateSlotEntry | null)[] = [];
                let slotAssigned = false;
                let assignedSlotIndex = -1;

                for (let i = 0; i < maxSlots; i++) {
                    const existingSlot = currentSlots.find((_, idx) => idx === i) ?? null;
                    if (existingSlot) {
                        newSlots.push(existingSlot as CrateSlotEntry);
                    } else if (!slotAssigned) {
                        newSlots.push(newSlotEntry);
                        slotAssigned = true;
                        assignedSlotIndex = i;
                    } else {
                        newSlots.push(null);
                    }
                }

                // Simple fallback if the loop didn't work as expected
                if (!slotAssigned) {
                    newSlots.push(newSlotEntry);
                    assignedSlotIndex = currentSlots.length;
                }

                // --- WRITE ---
                if (slotsDoc.exists) {
                    transaction.update(slotsRef, {
                        slots: newSlots,
                        updatedAt: timestamp,
                    });
                } else {
                    transaction.set(slotsRef, {
                        slots: newSlots,
                        maxSlots,
                        updatedAt: timestamp,
                    });
                }

                return {
                    success: true,
                    opId,
                    slotIndex: assignedSlotIndex,
                    fallbackGranted: false,
                };
            },
        );
    },
);

// =============================================================================
// startCrateUnlockV2
// =============================================================================

/**
 * Begin unlocking a crate in a slot.
 *
 * Check Logic:
 * 1. Verify slot has a crate
 * 2. Verify no other crate is currently unlocking
 * 3. Set isUnlocking and completesAt
 */
export const startCrateUnlockV2 = onCall(
    callableOptions({ minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const { slotIndex, opId } = request.data as StartCrateUnlockRequest;
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        if (slotIndex === undefined || !opId) {
            throw new HttpsError("invalid-argument", "Missing required parameters: slotIndex, opId");
        }

        // Check idempotency
        const existingResult = await checkIdempotency(uid, opId);
        if (existingResult) {
            return existingResult;
        }

        await createInProgressReceipt(uid, opId, "startCrateUnlockV2");

        const slotsConfig = await getCrateSlotsConfig();

        return await runTransactionWithReceipt<StartCrateUnlockResponse>(
            uid,
            opId,
            "startCrateUnlockV2",
            async (transaction) => {
                const now = Date.now();
                const timestamp = admin.firestore.FieldValue.serverTimestamp();

                // Document ref
                const slotsRef = db.doc(`/Players/${uid}/Crates/Slots`);
                const slotsDoc = await transaction.get(slotsRef);

                if (!slotsDoc.exists) {
                    throw new HttpsError("not-found", "No crates in slots.");
                }

                const slotsData = slotsDoc.data() as UserCrateSlotsDoc;
                const slots = slotsData.slots ?? [];

                // Validate slot index
                if (slotIndex < 0 || slotIndex >= slots.length) {
                    throw new HttpsError("invalid-argument", `Invalid slot index: ${slotIndex}`);
                }

                const slot = slots[slotIndex];
                if (!slot) {
                    throw new HttpsError("not-found", `No crate in slot ${slotIndex}.`);
                }

                // Check if already unlocking
                if (slot.isUnlocking) {
                    throw new HttpsError("already-exists", "This crate is already unlocking.");
                }

                // Check if another crate is unlocking
                const unlockingCount = slots.filter((s) => s?.isUnlocking).length;
                if (unlockingCount >= slotsConfig.simultaneousUnlocks) {
                    throw new HttpsError(
                        "failed-precondition",
                        `Already unlocking ${unlockingCount} crate(s). Only ${slotsConfig.simultaneousUnlocks} can unlock at a time.`,
                    );
                }

                // Get unlock duration
                const unlockDuration = await getUnlockDurationForRarity(slot.rarity);
                const completesAtMs = now + unlockDuration * 1000;
                const completesAtTimestamp = admin.firestore.Timestamp.fromMillis(completesAtMs);

                // --- WRITE ---
                const updatedSlots = [...slots];
                updatedSlots[slotIndex] = {
                    ...slot,
                    isUnlocking: true,
                    startedAt: admin.firestore.Timestamp.fromMillis(now),
                    completesAt: completesAtTimestamp,
                };

                transaction.update(slotsRef, {
                    slots: updatedSlots,
                    updatedAt: timestamp,
                });

                return {
                    success: true,
                    opId,
                    slotIndex,
                    completesAt: completesAtMs,
                };
            },
        );
    },
);

// =============================================================================
// claimCrateRewardV2
// =============================================================================

/**
 * Claim the reward from a fully unlocked crate.
 *
 * Reward Logic:
 * 1. Verify slot has a crate and it's fully unlocked
 * 2. Load CrateRewardsConfig for the crate's rarity
 * 3. Roll N random cosmetics of that rarity from ItemsCatalog
 * 4. Roll M random catalog items from the reward pool (weighted)
 * 5. Grant all rewards (coins/gems to economy, inventory items via grant)
 * 6. Clear the slot
 */
export const claimCrateRewardV2 = onCall(
    callableOptions({ minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const { slotIndex, opId } = request.data as ClaimCrateRewardV2Request;
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        if (slotIndex === undefined || !opId) {
            throw new HttpsError("invalid-argument", "Missing required parameters: slotIndex, opId");
        }

        // Check idempotency
        const existingResult = await checkIdempotency(uid, opId);
        if (existingResult) {
            return existingResult;
        }

        await createInProgressReceipt(uid, opId, "claimCrateRewardV2");

        // Pre-load configs outside of transaction
        const crateRewardsConfig = await getCrateRewardsConfig();
        const cosmeticSkus = await listSkusByFilter({ category: "cosmetic" });

        return await runTransactionWithReceipt<ClaimCrateRewardV2Response>(
            uid,
            opId,
            "claimCrateRewardV2",
            async (transaction) => {
                const now = Date.now();
                const timestamp = admin.firestore.FieldValue.serverTimestamp();

                // Document refs
                const slotsRef = db.doc(`/Players/${uid}/Crates/Slots`);
                const economyRef = db.doc(`/Players/${uid}/Economy/Stats`);
                const slotsDoc = await transaction.get(slotsRef);

                if (!slotsDoc.exists) {
                    throw new HttpsError("not-found", "No crates in slots.");
                }

                const slotsData = slotsDoc.data() as UserCrateSlotsDoc;
                const slots = slotsData.slots ?? [];

                // Validate slot index
                if (slotIndex < 0 || slotIndex >= slots.length) {
                    throw new HttpsError("invalid-argument", `Invalid slot index: ${slotIndex}`);
                }

                const slot = slots[slotIndex];
                if (!slot) {
                    throw new HttpsError("not-found", `No crate in slot ${slotIndex}.`);
                }

                // Check if unlocking and complete
                if (!slot.isUnlocking) {
                    throw new HttpsError("failed-precondition", "Crate has not started unlocking. Use startCrateUnlock first.");
                }

                const completesAt = slot.completesAt as admin.firestore.Timestamp | null;
                if (!completesAt || completesAt.toMillis() > now) {
                    const remaining = completesAt ? Math.ceil((completesAt.toMillis() - now) / 1000) : "unknown";
                    throw new HttpsError(
                        "failed-precondition",
                        `Crate still unlocking. ${remaining} seconds remaining.`,
                    );
                }

                // ======================================================
                // ROLL REWARDS
                // ======================================================
                const crateRarity = slot.rarity?.toLowerCase() ?? "common";
                const rewardPool = crateRewardsConfig.rewardsByRarity[crateRarity]
                    ?? crateRewardsConfig.rewardsByRarity["common"];

                if (!rewardPool) {
                    throw new HttpsError("internal", `No reward pool configured for rarity: ${crateRarity}`);
                }

                const awardedItems: AwardedItem[] = [];
                const economyChanges: { coins: number; gems: number } = { coins: 0, gems: 0 };
                const inventoryGrants: Array<{ skuId: string; quantity: number }> = [];

                // --- 1. Roll random cosmetics of this rarity ---
                const matchingCosmetics = cosmeticSkus.filter(
                    (sku) => (sku.rarity?.toLowerCase() ?? "") === crateRarity
                );

                const cosmeticsToAward = Math.min(rewardPool.cosmeticCount, matchingCosmetics.length);
                const shuffledCosmetics = shuffleArray([...matchingCosmetics]);
                const selectedCosmetics = shuffledCosmetics.slice(0, cosmeticsToAward);

                for (const cosmetic of selectedCosmetics) {
                    awardedItems.push({
                        type: "cosmetic",
                        displayName: cosmetic.displayName ?? cosmetic.itemDisplayName ?? cosmetic.skuId,
                        quantity: 1,
                        rarity: cosmetic.rarity ?? crateRarity,
                        skuId: cosmetic.skuId,
                        itemId: cosmetic.itemId,
                    });
                    inventoryGrants.push({ skuId: cosmetic.skuId, quantity: 1 });
                }

                // --- 2. Roll random catalog items (weighted) ---
                const catalogCount = rewardPool.catalogItemCount;
                for (let i = 0; i < catalogCount; i++) {
                    const picked = weightedRandomPick(rewardPool.rewardPool);
                    if (!picked) continue;

                    const item: AwardedItem = {
                        type: picked.type,
                        displayName: picked.displayName,
                        quantity: picked.quantity,
                    };

                    if (picked.durationHours) {
                        item.durationHours = picked.durationHours;
                    }

                    if (picked.type === "coins") {
                        economyChanges.coins += picked.quantity;
                    } else if (picked.type === "gems") {
                        economyChanges.gems += picked.quantity;
                    } else if (picked.skuId) {
                        // Booster or SpeedUp — grant via inventory
                        item.skuId = picked.skuId;
                        inventoryGrants.push({ skuId: picked.skuId, quantity: picked.quantity });
                    }

                    awardedItems.push(item);
                }

                // ======================================================
                // GRANT INVENTORY (must happen before other writes —
                // grantInventoryRewards does internal reads)
                // ======================================================
                if (inventoryGrants.length > 0) {
                    await grantInventoryRewards(transaction, uid, inventoryGrants, { timestamp });
                }

                // ======================================================
                // WRITES (all reads are done, safe to write now)
                // ======================================================

                // Clear the slot
                const updatedSlots = [...slots];
                updatedSlots[slotIndex] = null;

                transaction.update(slotsRef, {
                    slots: updatedSlots,
                    updatedAt: timestamp,
                });

                // Grant economy changes
                if (economyChanges.coins > 0 || economyChanges.gems > 0) {
                    const economyUpdate: Record<string, FirebaseFirestore.FieldValue> = {
                        updatedAt: timestamp,
                    };
                    if (economyChanges.coins > 0) {
                        economyUpdate.coins = admin.firestore.FieldValue.increment(economyChanges.coins);
                    }
                    if (economyChanges.gems > 0) {
                        economyUpdate.gems = admin.firestore.FieldValue.increment(economyChanges.gems);
                    }
                    transaction.update(economyRef, economyUpdate);
                }

                return {
                    success: true,
                    opId,
                    slotIndex,
                    awarded: awardedItems,
                    economyChanges: {
                        ...(economyChanges.coins > 0 ? { coins: economyChanges.coins } : {}),
                        ...(economyChanges.gems > 0 ? { gems: economyChanges.gems } : {}),
                    },
                };
            },
        );
    },
);

// --- Helper: Fisher-Yates shuffle ---
function shuffleArray<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// --- Helper: Weighted random pick from pool ---
function weightedRandomPick(pool: CrateRewardItem[]): CrateRewardItem | null {
    if (pool.length === 0) return null;
    const totalWeight = pool.reduce((sum, item) => sum + item.weight, 0);
    let roll = Math.random() * totalWeight;
    for (const item of pool) {
        roll -= item.weight;
        if (roll <= 0) return item;
    }
    return pool[pool.length - 1];
}

// =============================================================================
// skipCrateUnlockV2
// =============================================================================

interface SkipCrateUnlockRequest {
    slotIndex: number;
    opId: string;
}

interface SkipCrateUnlockResponse {
    success: boolean;
    opId: string;
    slotIndex: number;
    gemsSpent: number;
}

/**
 * Pay gems to instantly unlock a crate.
 */
export const skipCrateUnlockV2 = onCall(
    callableOptions({ minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const { slotIndex, opId } = request.data as SkipCrateUnlockRequest;
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        if (slotIndex === undefined || !opId) {
            throw new HttpsError("invalid-argument", "Missing required parameters: slotIndex, opId");
        }

        // Check idempotency
        const existingResult = await checkIdempotency(uid, opId);
        if (existingResult) {
            return existingResult;
        }

        await createInProgressReceipt(uid, opId, "skipCrateUnlockV2");

        const slotsConfig = await getCrateSlotsConfig();

        return await runTransactionWithReceipt<SkipCrateUnlockResponse>(
            uid,
            opId,
            "skipCrateUnlockV2",
            async (transaction) => {
                const now = Date.now();
                const timestamp = admin.firestore.FieldValue.serverTimestamp();

                // Document refs
                const economyRef = db.doc(`/Players/${uid}/Economy/Stats`);
                const slotsRef = db.doc(`/Players/${uid}/Crates/Slots`);

                const [economyDoc, slotsDoc] = await Promise.all([
                    transaction.get(economyRef),
                    transaction.get(slotsRef),
                ]);

                // Validate economy
                if (!economyDoc.exists) {
                    throw new HttpsError("not-found", "Player economy not found.");
                }
                const economyData = economyDoc.data()!;

                // Validate slots
                if (!slotsDoc.exists) {
                    throw new HttpsError("not-found", "No crates in slots.");
                }

                const slotsData = slotsDoc.data() as UserCrateSlotsDoc;
                const slots = slotsData.slots ?? [];

                // Validate slot index
                if (slotIndex < 0 || slotIndex >= slots.length) {
                    throw new HttpsError("invalid-argument", `Invalid slot index: ${slotIndex}`);
                }

                const slot = slots[slotIndex];
                if (!slot) {
                    throw new HttpsError("not-found", `No crate in slot ${slotIndex}.`);
                }

                // Check if unlocking
                if (!slot.isUnlocking) {
                    throw new HttpsError("failed-precondition", "Crate is not unlocking.");
                }

                const completesAt = slot.completesAt as admin.firestore.Timestamp | null;
                if (!completesAt || completesAt.toMillis() <= now) {
                    throw new HttpsError("failed-precondition", "Crate is already unlocked. Use claim instead.");
                }

                // Calculate skip cost
                const remainingSeconds = Math.ceil((completesAt.toMillis() - now) / 1000);
                const skipCost = calculateSkipCost(
                    remainingSeconds,
                    slotsConfig.skipCost.gemsPerHour,
                    slotsConfig.skipCost.minGems,
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

                // Update slot to complete immediately
                const updatedSlots = [...slots];
                updatedSlots[slotIndex] = {
                    ...slot,
                    completesAt: admin.firestore.Timestamp.fromMillis(now),
                };

                transaction.update(slotsRef, {
                    slots: updatedSlots,
                    updatedAt: timestamp,
                });

                return {
                    success: true,
                    opId,
                    slotIndex,
                    gemsSpent: skipCost,
                };
            },
        );
    },
);

// =============================================================================
// getCrateSlotsStatusV2
// =============================================================================

interface CrateSlotsStatusResponse {
    slots: Array<{
        slotIndex: number;
        crateId: string | null;
        crateSkuId: string | null;
        rarity: string | null;
        isUnlocking: boolean;
        startedAt: number | null;
        completesAt: number | null;
        isComplete: boolean;
        remainingSeconds: number;
        skipCostGems: number;
        /** Total unlock duration in seconds for this crate's rarity */
        unlockDurationSeconds: number;
    }>;
    maxSlots: number;
    availableSlots: number;
    isAnyUnlocking: boolean;
}

/**
 * Get current crate slots status.
 * Read-only endpoint.
 */
export const getCrateSlotsStatusV2 = onCall(
    callableOptions({ cpu: 1, concurrency: 80 }),
    async (request) => {
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        const [slotsDoc, slotsConfig] = await Promise.all([
            db.doc(`/Players/${uid}/Crates/Slots`).get(),
            getCrateSlotsConfig(),
        ]);

        const now = Date.now();

        if (!slotsDoc.exists) {
            // Return empty slots
            const emptySlots = Array.from({ length: slotsConfig.maxSlots }, (_, i) => ({
                slotIndex: i,
                crateId: null,
                crateSkuId: null,
                rarity: null,
                isUnlocking: false,
                startedAt: null,
                completesAt: null,
                isComplete: false,
                remainingSeconds: 0,
                skipCostGems: 0,
                unlockDurationSeconds: 0,
            }));

            return {
                slots: emptySlots,
                maxSlots: slotsConfig.maxSlots,
                availableSlots: slotsConfig.maxSlots,
                isAnyUnlocking: false,
            } as CrateSlotsStatusResponse;
        }

        const slotsData = slotsDoc.data() as UserCrateSlotsDoc;
        const rawSlots = slotsData.slots ?? [];
        const maxSlots = slotsData.maxSlots ?? slotsConfig.maxSlots;

        let availableSlots = 0;
        let isAnyUnlocking = false;

        const slots = Array.from({ length: maxSlots }, (_, i) => {
            const slot = rawSlots[i] ?? null;

            if (!slot) {
                availableSlots++;
                return {
                    slotIndex: i,
                    crateId: null,
                    crateSkuId: null,
                    rarity: null,
                    isUnlocking: false,
                    startedAt: null,
                    completesAt: null,
                    isComplete: false,
                    remainingSeconds: 0,
                    skipCostGems: 0,
                    unlockDurationSeconds: 0,
                };
            }

            if (slot.isUnlocking) {
                isAnyUnlocking = true;
            }

            const completesAtMs = slot.completesAt
                ? (slot.completesAt as admin.firestore.Timestamp).toMillis()
                : null;
            const isComplete = completesAtMs ? completesAtMs <= now : false;
            const remainingSeconds =
                completesAtMs && !isComplete ? Math.ceil((completesAtMs - now) / 1000) : 0;
            const skipCostGems =
                slot.isUnlocking && !isComplete
                    ? calculateSkipCost(
                        remainingSeconds,
                        slotsConfig.skipCost.gemsPerHour,
                        slotsConfig.skipCost.minGems,
                    )
                    : 0;

            return {
                slotIndex: i,
                crateId: slot.crateId,
                crateSkuId: slot.crateSkuId,
                rarity: slot.rarity,
                isUnlocking: slot.isUnlocking,
                startedAt: slot.startedAt
                    ? (slot.startedAt as admin.firestore.Timestamp).toMillis()
                    : null,
                completesAt: completesAtMs,
                isComplete,
                remainingSeconds,
                skipCostGems,
                unlockDurationSeconds: slot.unlockDurationSeconds ?? 0,
            };
        });

        return {
            slots,
            maxSlots,
            availableSlots,
            isAnyUnlocking,
        } as CrateSlotsStatusResponse;
    },
);
