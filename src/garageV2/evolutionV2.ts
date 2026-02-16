/**
 * V2 Car Evolution (Pit Crew) Functions
 *
 * Handles the new car progression system where cars:
 * 1. Earn XP from races
 * 2. Hit XP caps requiring Evolution (Star Up)
 * 3. Evolution requires Coins + Time in the Pit Crew queue
 *
 * @module evolutionV2
 */

import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import {
    getCarEvolutionV2Catalog,
    getEvolutionCostForStarLevel,
    getXpCapForStarLevel,
    getPlayerSlotsConfig,
    calculateSkipCost,
    calculateCarLevel,
} from "../core/configV2.js";
import {
    StartCarEvolutionRequest,
    StartCarEvolutionResponse,
    ClaimCarEvolutionRequest,
    ClaimCarEvolutionResponse,
    SkipCarEvolutionRequest,
    SkipCarEvolutionResponse,
    UserPitCrewDoc,
    PitCrewSlotEntry,
} from "../shared/typesV2.js";

const db = admin.firestore();

// =============================================================================
// startCarEvolutionV2
// =============================================================================

/**
 * Start evolving a car (Star Up).
 *
 * Check Logic:
 * 1. Verify player owns the car
 * 2. Verify car is XP capped
 * 3. Verify Pit Crew has available slot
 * 4. Verify player has sufficient coins
 * 5. Deduct coins
 * 6. Add to Pit Crew queue with completesAt timestamp
 */
export const startCarEvolutionV2 = onCall(
    callableOptions({ minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const { carId, opId } = request.data as StartCarEvolutionRequest;
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        if (!carId || !opId) {
            throw new HttpsError("invalid-argument", "Missing required parameters: carId, opId");
        }

        // Check idempotency
        const existingResult = await checkIdempotency(uid, opId);
        if (existingResult) {
            return existingResult;
        }

        await createInProgressReceipt(uid, opId, "startCarEvolutionV2");

        // Load configs
        const [evolutionCatalog, slotsConfig] = await Promise.all([
            getCarEvolutionV2Catalog(),
            getPlayerSlotsConfig(),
        ]);

        return await runTransactionWithReceipt<StartCarEvolutionResponse>(
            uid,
            opId,
            "startCarEvolutionV2",
            async (transaction) => {
                const now = Date.now();
                const timestamp = admin.firestore.FieldValue.serverTimestamp();

                // Document refs
                const economyRef = db.doc(`/Players/${uid}/Economy/Stats`);
                const garageRef = db.doc(`/Players/${uid}/Garage/Cars`);
                const pitCrewRef = db.doc(`/Players/${uid}/Queues/PitCrew`);
                const profileRef = db.doc(`/Players/${uid}/Profile/Profile`);

                // Read all documents
                const [economyDoc, garageDoc, pitCrewDoc, profileDoc] = await Promise.all([
                    transaction.get(economyRef),
                    transaction.get(garageRef),
                    transaction.get(pitCrewRef),
                    transaction.get(profileRef),
                ]);

                // Validate economy exists
                if (!economyDoc.exists) {
                    throw new HttpsError("not-found", "Player economy not found.");
                }
                const economyData = economyDoc.data()!;

                // Validate garage exists
                if (!garageDoc.exists) {
                    throw new HttpsError("not-found", "Player garage not found.");
                }
                const garageData = garageDoc.data()!;
                const carsMap = garageData.cars ?? {};

                // Check player owns the car
                const carData = carsMap[carId];
                if (!carData) {
                    throw new HttpsError("not-found", `Player does not own car: ${carId}`);
                }

                // Check car is XP capped
                const isXpCapped = carData.isXpCapped ?? false;
                if (!isXpCapped) {
                    throw new HttpsError(
                        "failed-precondition",
                        "Car is not XP capped. Continue racing to earn XP.",
                    );
                }

                // Get current star level
                const currentStarLevel = carData.starLevel ?? 0;
                const maxStarLevel = evolutionCatalog.maxStarLevel;

                if (currentStarLevel >= maxStarLevel) {
                    throw new HttpsError("failed-precondition", "Car is already at maximum star level.");
                }

                // Get evolution cost
                const evolutionCost = evolutionCatalog.evolutionCosts[String(currentStarLevel)];
                if (!evolutionCost) {
                    throw new HttpsError("internal", `Evolution cost not configured for star level ${currentStarLevel}`);
                }

                // Get player's pit crew slots
                const profileData = profileDoc.data() ?? {};
                const playerPitCrewSlots = profileData.pitCrewSlots ?? slotsConfig.pitCrew.defaultSlots;

                // Check pit crew queue
                const pitCrewData = (
                    pitCrewDoc.exists ? pitCrewDoc.data() : { slots: [], maxSlots: playerPitCrewSlots }
                ) as UserPitCrewDoc;
                const currentSlots = pitCrewData.slots ?? [];

                // Check if car is already evolving
                if (currentSlots.some((slot) => slot.carId === carId)) {
                    throw new HttpsError("already-exists", "This car is already evolving in the Pit Crew.");
                }

                // Check slot availability
                if (currentSlots.length >= playerPitCrewSlots) {
                    throw new HttpsError(
                        "failed-precondition",
                        `Pit Crew is full. Slots: ${currentSlots.length}/${playerPitCrewSlots}. Wait or purchase more slots.`,
                    );
                }

                // Check coin requirement
                const playerCoins = economyData.coins ?? 0;
                if (playerCoins < evolutionCost.coins) {
                    throw new HttpsError(
                        "failed-precondition",
                        `Insufficient coins. Required: ${evolutionCost.coins}, Available: ${playerCoins}.`,
                    );
                }

                // Calculate completesAt
                const completesAtMs = now + evolutionCost.durationSeconds * 1000;
                const completesAtTimestamp = admin.firestore.Timestamp.fromMillis(completesAtMs);

                // --- WRITES ---

                // Deduct coins
                transaction.update(economyRef, {
                    coins: admin.firestore.FieldValue.increment(-evolutionCost.coins),
                    updatedAt: timestamp,
                });

                // Add to pit crew queue
                const newSlotEntry: PitCrewSlotEntry = {
                    carId,
                    startedAt: timestamp,
                    completesAt: completesAtTimestamp,
                    targetStarLevel: currentStarLevel + 1,
                    coinsPaid: evolutionCost.coins,
                };

                if (pitCrewDoc.exists) {
                    transaction.update(pitCrewRef, {
                        slots: admin.firestore.FieldValue.arrayUnion(newSlotEntry),
                        updatedAt: timestamp,
                    });
                } else {
                    transaction.set(pitCrewRef, {
                        slots: [newSlotEntry],
                        maxSlots: playerPitCrewSlots,
                        updatedAt: timestamp,
                    });
                }

                return {
                    success: true,
                    opId,
                    carId,
                    targetStarLevel: currentStarLevel + 1,
                    completesAt: completesAtMs,
                    coinsSpent: evolutionCost.coins,
                };
            },
        );
    },
);

// =============================================================================
// claimCarEvolutionV2
// =============================================================================

/**
 * Complete car evolution and claim the star level upgrade.
 *
 * Check Logic:
 * 1. Verify car is in Pit Crew queue
 * 2. Verify evolution timer is complete (or has been skipped)
 * 3. Increment star level
 * 4. Reset XP and isXpCapped
 * 5. Remove from queue
 */
export const claimCarEvolutionV2 = onCall(
    callableOptions({ minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const { carId, opId } = request.data as ClaimCarEvolutionRequest;
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        if (!carId || !opId) {
            throw new HttpsError("invalid-argument", "Missing required parameters: carId, opId");
        }

        // Check idempotency
        const existingResult = await checkIdempotency(uid, opId);
        if (existingResult) {
            return existingResult;
        }

        await createInProgressReceipt(uid, opId, "claimCarEvolutionV2");

        return await runTransactionWithReceipt<ClaimCarEvolutionResponse>(
            uid,
            opId,
            "claimCarEvolutionV2",
            async (transaction) => {
                const now = Date.now();
                const timestamp = admin.firestore.FieldValue.serverTimestamp();

                // Document refs
                const garageRef = db.doc(`/Players/${uid}/Garage/Cars`);
                const pitCrewRef = db.doc(`/Players/${uid}/Queues/PitCrew`);

                // Read documents
                const [garageDoc, pitCrewDoc] = await Promise.all([
                    transaction.get(garageRef),
                    transaction.get(pitCrewRef),
                ]);

                // Validate pit crew exists
                if (!pitCrewDoc.exists) {
                    throw new HttpsError("not-found", "No cars in Pit Crew queue.");
                }

                const pitCrewData = pitCrewDoc.data() as UserPitCrewDoc;
                const currentSlots = pitCrewData.slots ?? [];

                // Find the car in the queue
                const slotIndex = currentSlots.findIndex((slot) => slot.carId === carId);
                if (slotIndex === -1) {
                    throw new HttpsError("not-found", "Car is not in the Pit Crew queue.");
                }

                const slot = currentSlots[slotIndex];

                // Check if evolution is complete
                const completesAt = slot.completesAt as admin.firestore.Timestamp;
                if (completesAt.toMillis() > now) {
                    const remainingSeconds = Math.ceil((completesAt.toMillis() - now) / 1000);
                    throw new HttpsError(
                        "failed-precondition",
                        `Evolution not complete. ${remainingSeconds} seconds remaining. Use gems to skip.`,
                    );
                }

                // Validate garage
                if (!garageDoc.exists) {
                    throw new HttpsError("internal", "Garage not found.");
                }
                const garageData = garageDoc.data()!;
                const carData = garageData.cars?.[carId];
                if (!carData) {
                    throw new HttpsError("internal", "Car not found in garage.");
                }

                // --- WRITES ---

                // Remove from queue
                const updatedSlots = currentSlots.filter((_, idx) => idx !== slotIndex);
                transaction.update(pitCrewRef, {
                    slots: updatedSlots,
                    updatedAt: timestamp,
                });

                // Update car: increment star level, reset XP (carLevel is cumulative)
                const evolutionCatalog = await getCarEvolutionV2Catalog();
                const levelsPerStar = evolutionCatalog.levelsPerStar ?? 10;
                const newCarLevel = slot.targetStarLevel * levelsPerStar;

                transaction.update(garageRef, {
                    [`cars.${carId}.starLevel`]: slot.targetStarLevel,
                    [`cars.${carId}.xp`]: 0,
                    [`cars.${carId}.carLevel`]: newCarLevel,
                    [`cars.${carId}.isXpCapped`]: false,
                    [`cars.${carId}.updatedAt`]: timestamp,
                });

                return {
                    success: true,
                    opId,
                    carId,
                    newStarLevel: slot.targetStarLevel,
                };
            },
        );
    },
);

// =============================================================================
// skipCarEvolutionV2
// =============================================================================

/**
 * Pay gems to instantly complete car evolution.
 *
 * Check Logic:
 * 1. Verify car is in Pit Crew queue
 * 2. Calculate gem cost based on remaining time
 * 3. Verify player has sufficient gems
 * 4. Deduct gems
 * 5. Set completesAt to now
 */
export const skipCarEvolutionV2 = onCall(
    callableOptions({ minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const { carId, opId } = request.data as SkipCarEvolutionRequest;
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        if (!carId || !opId) {
            throw new HttpsError("invalid-argument", "Missing required parameters: carId, opId");
        }

        // Check idempotency
        const existingResult = await checkIdempotency(uid, opId);
        if (existingResult) {
            return existingResult;
        }

        await createInProgressReceipt(uid, opId, "skipCarEvolutionV2");

        // Load config
        const evolutionCatalog = await getCarEvolutionV2Catalog();

        return await runTransactionWithReceipt<SkipCarEvolutionResponse>(
            uid,
            opId,
            "skipCarEvolutionV2",
            async (transaction) => {
                const now = Date.now();
                const timestamp = admin.firestore.FieldValue.serverTimestamp();

                // Document refs
                const economyRef = db.doc(`/Players/${uid}/Economy/Stats`);
                const pitCrewRef = db.doc(`/Players/${uid}/Queues/PitCrew`);

                // Read documents
                const [economyDoc, pitCrewDoc] = await Promise.all([
                    transaction.get(economyRef),
                    transaction.get(pitCrewRef),
                ]);

                // Validate economy
                if (!economyDoc.exists) {
                    throw new HttpsError("not-found", "Player economy not found.");
                }
                const economyData = economyDoc.data()!;

                // Validate pit crew
                if (!pitCrewDoc.exists) {
                    throw new HttpsError("not-found", "No cars in Pit Crew queue.");
                }

                const pitCrewData = pitCrewDoc.data() as UserPitCrewDoc;
                const currentSlots = pitCrewData.slots ?? [];

                // Find the car
                const slotIndex = currentSlots.findIndex((slot) => slot.carId === carId);
                if (slotIndex === -1) {
                    throw new HttpsError("not-found", "Car is not in the Pit Crew queue.");
                }

                const slot = currentSlots[slotIndex];
                const completesAt = slot.completesAt as admin.firestore.Timestamp;

                // Check if already complete
                if (completesAt.toMillis() <= now) {
                    throw new HttpsError("failed-precondition", "Evolution is already complete. Use claim instead.");
                }

                // Calculate skip cost
                const remainingSeconds = Math.ceil((completesAt.toMillis() - now) / 1000);
                const skipCost = calculateSkipCost(
                    remainingSeconds,
                    evolutionCatalog.skipCost.gemsPerHour,
                    evolutionCatalog.skipCost.minGems,
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
                const updatedSlots = [...currentSlots];
                updatedSlots[slotIndex] = {
                    ...slot,
                    completesAt: admin.firestore.Timestamp.fromMillis(now),
                };

                transaction.update(pitCrewRef, {
                    slots: updatedSlots,
                    updatedAt: timestamp,
                });

                return {
                    success: true,
                    opId,
                    carId,
                    gemsSpent: skipCost,
                };
            },
        );
    },
);

// =============================================================================
// getPitCrewStatusV2
// =============================================================================

interface PitCrewStatusResponse {
    slots: Array<{
        carId: string;
        targetStarLevel: number;
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
 * Get current Pit Crew queue status.
 * Read-only endpoint.
 */
export const getPitCrewStatusV2 = onCall(
    callableOptions({ cpu: 1, concurrency: 80 }),
    async (request) => {
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        const [pitCrewDoc, profileDoc, evolutionCatalog, slotsConfig] = await Promise.all([
            db.doc(`/Players/${uid}/Queues/PitCrew`).get(),
            db.doc(`/Players/${uid}/Profile/Profile`).get(),
            getCarEvolutionV2Catalog(),
            getPlayerSlotsConfig(),
        ]);

        const now = Date.now();
        const profileData = profileDoc.data() ?? {};
        const playerMaxSlots = profileData.pitCrewSlots ?? slotsConfig.pitCrew.defaultSlots;

        if (!pitCrewDoc.exists) {
            return {
                slots: [],
                maxSlots: playerMaxSlots,
                availableSlots: playerMaxSlots,
            } as PitCrewStatusResponse;
        }

        const pitCrewData = pitCrewDoc.data() as UserPitCrewDoc;
        const currentSlots = pitCrewData.slots ?? [];

        const slots = currentSlots.map((slot) => {
            const completesAt = (slot.completesAt as admin.firestore.Timestamp).toMillis();
            const isComplete = completesAt <= now;
            const remainingSeconds = isComplete ? 0 : Math.ceil((completesAt - now) / 1000);
            const skipCostGems = isComplete
                ? 0
                : calculateSkipCost(
                    remainingSeconds,
                    evolutionCatalog.skipCost.gemsPerHour,
                    evolutionCatalog.skipCost.minGems,
                );

            return {
                carId: slot.carId,
                targetStarLevel: slot.targetStarLevel,
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
        } as PitCrewStatusResponse;
    },
);

// =============================================================================
// grantCarXP (Internal helper)
// =============================================================================

/**
 * Grant XP to a car after a race.
 * Called internally by race result processing.
 *
 * Also dynamically calculates and persists the `carLevel` field,
 * which represents the sub-level within the current star level.
 * The car level is derived from: floor(xp / (xpCap / levelsPerStar))
 *
 * @param transaction - Firestore transaction
 * @param uid - Player UID
 * @param carId - Car to grant XP to
 * @param xpAmount - Amount of XP to grant
 * @param timestamp - Server timestamp
 * @returns Updated car state including carLevel
 */
export async function grantCarXP(
    transaction: FirebaseFirestore.Transaction,
    uid: string,
    carId: string,
    xpAmount: number,
    timestamp: FirebaseFirestore.FieldValue,
): Promise<{ newXp: number; isNowCapped: boolean; starLevel: number; carLevel: number }> {
    const garageRef = db.doc(`/Players/${uid}/Garage/Cars`);
    const garageDoc = await transaction.get(garageRef);

    if (!garageDoc.exists) {
        console.warn(`[EvolutionV2] Garage not found for ${uid}`);
        return { newXp: 0, isNowCapped: false, starLevel: 0, carLevel: 0 };
    }

    const garageData = garageDoc.data()!;
    const carData = garageData.cars?.[carId];

    if (!carData) {
        console.warn(`[EvolutionV2] Car ${carId} not found for ${uid}`);
        return { newXp: 0, isNowCapped: false, starLevel: 0, carLevel: 0 };
    }

    // Check if already capped
    const isXpCapped = carData.isXpCapped ?? false;
    if (isXpCapped) {
        console.log(`[EvolutionV2] Car ${carId} is XP capped, no XP granted.`);
        return {
            newXp: carData.xp ?? 0,
            isNowCapped: true,
            starLevel: carData.starLevel ?? 0,
            carLevel: carData.carLevel ?? 0,
        };
    }

    const currentXp = carData.xp ?? 0;
    const starLevel = carData.starLevel ?? 0;
    const xpCap = await getXpCapForStarLevel(starLevel);

    // Load levelsPerStar from catalog (default 10)
    const evolutionCatalog = await getCarEvolutionV2Catalog();
    const levelsPerStar = evolutionCatalog.levelsPerStar ?? 10;

    let newXp = currentXp + xpAmount;
    let isNowCapped = false;

    if (newXp >= xpCap) {
        newXp = xpCap;
        isNowCapped = true;
    }

    // Dynamically calculate the cumulative car level
    const { carLevel } = calculateCarLevel(newXp, xpCap, starLevel, levelsPerStar);

    // Write update (includes carLevel)
    transaction.update(garageRef, {
        [`cars.${carId}.xp`]: newXp,
        [`cars.${carId}.isXpCapped`]: isNowCapped,
        [`cars.${carId}.carLevel`]: carLevel,
        [`cars.${carId}.updatedAt`]: timestamp,
    });

    return { newXp, isNowCapped, starLevel, carLevel };
}
