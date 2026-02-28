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
    getFuelConfig,
    getPlayerSlotsConfig,
    getCarsCatalog,
    getXpCapForCar,
    getEvolutionCostForCar,
    calculateSkipCost,
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
                if (carData.isXpCapped !== true) {
                    throw new HttpsError("failed-precondition", "Car has not reached the XP cap for its current level.");
                }

                // Check evolution costs from CarsCatalog (per-car, per-star-level)
                const currentStarLevel = carData.starLevel ?? 1; // 1-10, matching CarsCatalog keys

                const evolutionCost = await getEvolutionCostForCar(carId, currentStarLevel);
                if (!evolutionCost) {
                    throw new HttpsError(
                        "failed-precondition",
                        `Car is fully evolved. Star level ${currentStarLevel} is the maximum.`,
                    );
                }

                const { coins: requiredCoins, durationSeconds, targetStarLevel } = evolutionCost;

                // Load slot config
                const slotsConfig = await getPlayerSlotsConfig();
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
                if (playerCoins < requiredCoins) {
                    throw new HttpsError(
                        "failed-precondition",
                        `Insufficient coins. Required: ${requiredCoins}, Available: ${playerCoins}.`,
                    );
                }

                // Calculate completesAt
                const completesAtMs = now + durationSeconds * 1000;
                const completesAtTimestamp = admin.firestore.Timestamp.fromMillis(completesAtMs);

                // --- WRITES ---

                // Deduct coins
                transaction.update(economyRef, {
                    coins: admin.firestore.FieldValue.increment(-requiredCoins),
                    updatedAt: timestamp,
                });

                // Add to pit crew queue
                // NOTE: FieldValue.serverTimestamp() cannot be used inside array elements.
                // We use Timestamp.fromMillis(now) for startedAt — consistent with how
                // completesAtTimestamp is built just above.
                const startedAtTimestamp = admin.firestore.Timestamp.fromMillis(now);
                const newSlotEntry: PitCrewSlotEntry = {
                    carId,
                    startedAt: startedAtTimestamp,
                    completesAt: completesAtTimestamp,
                    targetCarLevel: targetStarLevel, // targetStarLevel == targetCarLevel (1:1)
                    coinsPaid: requiredCoins,
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
                    targetCarLevel: targetStarLevel,
                    completesAt: completesAtMs,
                    coinsSpent: requiredCoins,
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

                // Update car: increment starLevel and carLevel (1:1), reset XP
                const newStarLevel = slot.targetCarLevel; // targetCarLevel == targetStarLevel (1:1)
                transaction.update(garageRef, {
                    [`cars.${carId}.starLevel`]: newStarLevel,
                    [`cars.${carId}.carLevel`]: newStarLevel,
                    [`cars.${carId}.xp`]: 0,
                    [`cars.${carId}.isXpCapped`]: false,
                    [`cars.${carId}.updatedAt`]: timestamp,
                });

                return {
                    success: true,
                    opId,
                    carId,
                    newCarLevel: newStarLevel,
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

        // evolutionCatalog replaced with hardcoded bypass
        // const evolutionCatalog = await getCarEvolutionV2Catalog();

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

                // Since CarEvolutionV2 is gone, we'll use a hardcoded fallback for skip cost 
                // Alternatively, this can be moved to another config but for now we default to a standard rate
                // 100 gems per hour, minimum 5 gems.
                const remainingSeconds = Math.ceil((completesAt.toMillis() - now) / 1000);
                const skipCost = calculateSkipCost(
                    remainingSeconds,
                    100, // gems per hour
                    5,   // min gems
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
        targetCarLevel: number;
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

        const [pitCrewDoc, profileDoc, slotsConfig] = await Promise.all([
            db.doc(`/Players/${uid}/Queues/PitCrew`).get(),
            db.doc(`/Players/${uid}/Profile/Profile`).get(),
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
                    100, // Hardcoded fallback for now
                    5,
                );

            return {
                carId: slot.carId,
                targetCarLevel: slot.targetCarLevel,
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
 * XP cap is looked up from CarsCatalog.cars[carId].levels[starLevel].xpToNext.
 * starLevel runs 1-10 (matching CarsCatalog keys). carLevel == starLevel (1:1 mapping).
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
): Promise<{ newXp: number; isNowCapped: boolean; carLevel: number }> {
    const garageRef = db.doc(`/Players/${uid}/Garage/Cars`);
    const garageDoc = await transaction.get(garageRef);

    if (!garageDoc.exists) {
        console.warn(`[EvolutionV2] Garage not found for ${uid}`);
        return { newXp: 0, isNowCapped: false, carLevel: 1 };
    }

    const garageData = garageDoc.data()!;
    const carData = garageData.cars?.[carId];
    if (!carData) {
        console.warn(`[EvolutionV2] Car ${carId} not found in garage for ${uid}`);
        return { newXp: 0, isNowCapped: false, carLevel: 1 };
    }

    // Use starLevel for CarsCatalog XP cap lookup (starLevel == carLevel, 1-10)
    const starLevel = carData.starLevel ?? 1; // 1-10, matching CarsCatalog keys
    const currentXp = carData.xp ?? 0;

    // Load XP cap from CarsCatalog (per-car, per-star-level)
    const xpCap = await getXpCapForCar(carId, starLevel);

    // Determine new XP and capping status
    let newXp: number;
    let isNowCapped: boolean;

    if (xpCap <= 0) {
        // xpToNext=0 means max star level — no further XP gain
        newXp = currentXp;
        isNowCapped = true;
    } else {
        newXp = Math.min(currentXp + xpAmount, xpCap);
        isNowCapped = newXp >= xpCap;
    }

    transaction.update(garageRef, {
        [`cars.${carId}.xp`]: newXp,
        [`cars.${carId}.isXpCapped`]: isNowCapped,
        [`cars.${carId}.carLevel`]: starLevel, // carLevel == starLevel (1-10, 1:1)
        [`cars.${carId}.updatedAt`]: timestamp,
    });

    return { newXp, isNowCapped, carLevel: starLevel };
}
