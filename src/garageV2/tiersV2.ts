/**
 * V2 Tier License Functions
 *
 * Handles the new License Model where players purchase Tier Licenses
 * to unlock bundles of 3 cars (Tank, Speedster, Specialist).
 *
 * @module tiersV2
 */

import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import { getTiersCatalog, getTierById, getStarterTier } from "../core/configV2.js";
import {
    PurchaseTierLicenseRequest,
    PurchaseTierLicenseResponse,
    UserLicensesDoc,
    TierDefinition,
} from "../shared/typesV2.js";

const db = admin.firestore();

// =============================================================================
// purchaseTierLicenseV2
// =============================================================================

/**
 * Purchase a Tier License and receive the bundled cars.
 *
 * Check Logic:
 * 1. Verify tier exists in catalog
 * 2. Verify player meets masteryRank requirement
 * 3. Verify player has sufficient coins
 * 4. Verify player doesn't already own the license
 * 5. Grant bundled cars to garage
 * 6. Record license ownership
 */
export const purchaseTierLicenseV2 = onCall(
    callableOptions({ minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const { tierId, opId } = request.data as PurchaseTierLicenseRequest;
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        if (!tierId || !opId) {
            throw new HttpsError("invalid-argument", "Missing required parameters: tierId, opId");
        }

        // Check idempotency
        const existingResult = await checkIdempotency(uid, opId);
        if (existingResult) {
            return existingResult;
        }

        await createInProgressReceipt(uid, opId, "purchaseTierLicenseV2");

        // Load tier from catalog
        const tier = await getTierById(tierId);
        if (!tier) {
            throw new HttpsError("not-found", `Tier not found: ${tierId}`);
        }

        return await runTransactionWithReceipt<PurchaseTierLicenseResponse>(
            uid,
            opId,
            "purchaseTierLicenseV2",
            async (transaction) => {
                const timestamp = admin.firestore.FieldValue.serverTimestamp();

                // Document refs
                const profileRef = db.doc(`/Players/${uid}/Profile/Profile`);
                const economyRef = db.doc(`/Players/${uid}/Economy/Stats`);
                const licensesRef = db.doc(`/Players/${uid}/Licenses/Owned`);
                const garageRef = db.doc(`/Players/${uid}/Garage/Cars`);

                // Read all documents
                const [profileDoc, economyDoc, licensesDoc, garageDoc] = await Promise.all([
                    transaction.get(profileRef),
                    transaction.get(economyRef),
                    transaction.get(licensesRef),
                    transaction.get(garageRef),
                ]);

                // Validate profile exists
                if (!profileDoc.exists) {
                    throw new HttpsError("not-found", "Player profile not found.");
                }
                const profileData = profileDoc.data()!;

                // Validate economy exists
                if (!economyDoc.exists) {
                    throw new HttpsError("not-found", "Player economy not found.");
                }
                const economyData = economyDoc.data()!;

                // Check if already owns license
                const licensesData = (licensesDoc.exists ? licensesDoc.data() : { licenses: {} }) as UserLicensesDoc;
                if (licensesData.licenses && licensesData.licenses[tierId]) {
                    throw new HttpsError("already-exists", `Player already owns ${tier.displayName}.`);
                }

                // Check mastery rank requirement
                const playerMasteryRank = profileData.masteryRank ?? 0;
                if (playerMasteryRank < tier.requirements.masteryRank) {
                    throw new HttpsError(
                        "failed-precondition",
                        `Requires Mastery Rank ${tier.requirements.masteryRank}. Current: ${playerMasteryRank}.`,
                    );
                }

                // Check coin requirement
                const playerCoins = economyData.coins ?? 0;
                const requiredCoins = tier.requirements.coins;
                if (playerCoins < requiredCoins) {
                    throw new HttpsError(
                        "failed-precondition",
                        `Insufficient coins. Required: ${requiredCoins}, Available: ${playerCoins}.`,
                    );
                }

                // Get current garage data
                const garageData = garageDoc.exists ? garageDoc.data() : { cars: {} };
                const carsMap = garageData?.cars ?? {};

                // Prepare car grants
                const grantedCarIds: string[] = [];
                const carUpdates: Record<string, unknown> = {};

                for (const bundledCar of tier.bundledCars) {
                    // Only grant if player doesn't already own the car
                    if (!carsMap[bundledCar.carId]) {
                        grantedCarIds.push(bundledCar.carId);
                        carUpdates[`cars.${bundledCar.carId}`] = {
                            carId: bundledCar.carId,
                            upgradeLevel: 0,
                            tuning: {},
                            // V2 fields
                            xp: 0,
                            starLevel: 0,
                            isXpCapped: false,
                            fuelBars: 5, // Start with full fuel
                            fuelLastRefillAt: timestamp,
                            archetype: bundledCar.archetype,
                            acquiredVia: "tierLicense",
                            createdAt: timestamp,
                            updatedAt: timestamp,
                        };
                    }
                }

                // --- WRITES ---

                // Deduct coins
                if (requiredCoins > 0) {
                    transaction.update(economyRef, {
                        coins: admin.firestore.FieldValue.increment(-requiredCoins),
                        updatedAt: timestamp,
                    });
                }

                // Record license ownership
                if (licensesDoc.exists) {
                    transaction.update(licensesRef, {
                        [`licenses.${tierId}`]: {
                            tierId,
                            purchasedAt: timestamp,
                            grantedCars: grantedCarIds,
                        },
                        updatedAt: timestamp,
                    });
                } else {
                    transaction.set(licensesRef, {
                        licenses: {
                            [tierId]: {
                                tierId,
                                purchasedAt: timestamp,
                                grantedCars: grantedCarIds,
                            },
                        },
                        updatedAt: timestamp,
                    });
                }

                // Grant cars to garage
                if (Object.keys(carUpdates).length > 0) {
                    if (garageDoc.exists) {
                        transaction.update(garageRef, {
                            ...carUpdates,
                            updatedAt: timestamp,
                        });
                    } else {
                        // Create garage with cars
                        const carsData: Record<string, unknown> = {};
                        for (const bundledCar of tier.bundledCars) {
                            carsData[bundledCar.carId] = carUpdates[`cars.${bundledCar.carId}`];
                        }
                        transaction.set(garageRef, {
                            cars: carsData,
                            updatedAt: timestamp,
                        });
                    }
                }

                return {
                    success: true,
                    opId,
                    tierId,
                    grantedCars: grantedCarIds,
                    coinsSpent: requiredCoins,
                };
            },
        );
    },
);

// =============================================================================
// getTierCatalogV2
// =============================================================================

interface GetTierCatalogResponse {
    tiers: TierDefinition[];
    ownedLicenses: string[];
}

/**
 * Get the full tier catalog with player's owned licenses.
 * Read-only endpoint - no idempotency needed.
 */
export const getTierCatalogV2 = onCall(
    callableOptions({ cpu: 1, concurrency: 80 }),
    async (request) => {
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        const [tiersCatalog, licensesDoc] = await Promise.all([
            getTiersCatalog(),
            db.doc(`/Players/${uid}/Licenses/Owned`).get(),
        ]);

        const ownedLicenses: string[] = [];
        if (licensesDoc.exists) {
            const licensesData = licensesDoc.data() as UserLicensesDoc;
            if (licensesData.licenses) {
                ownedLicenses.push(...Object.keys(licensesData.licenses));
            }
        }

        // Sort tiers by order
        const tiers = Object.values(tiersCatalog.tiers).sort((a, b) => a.order - b.order);

        return {
            tiers,
            ownedLicenses,
        } as GetTierCatalogResponse;
    },
);

// =============================================================================
// grantStarterTierLicenseV2 (Internal helper)
// =============================================================================

/**
 * Grant the starter tier license to a new player.
 * This is called during player initialization.
 *
 * @param transaction - Firestore transaction
 * @param uid - Player UID
 * @param timestamp - Server timestamp
 */
export async function grantStarterTierLicense(
    transaction: FirebaseFirestore.Transaction,
    uid: string,
    timestamp: FirebaseFirestore.FieldValue,
): Promise<{ grantedCars: string[] }> {
    const starterTier = await getStarterTier();

    if (!starterTier) {
        console.warn("[TiersV2] No starter tier found in catalog.");
        return { grantedCars: [] };
    }

    const licensesRef = db.doc(`/Players/${uid}/Licenses/Owned`);
    const garageRef = db.doc(`/Players/${uid}/Garage/Cars`);

    // Get current state
    const [licensesDoc, garageDoc] = await Promise.all([
        transaction.get(licensesRef),
        transaction.get(garageRef),
    ]);

    // Check if already has starter license
    if (licensesDoc.exists) {
        const licensesData = licensesDoc.data() as UserLicensesDoc;
        if (licensesData.licenses?.[starterTier.tierId]) {
            console.log(`[TiersV2] Player ${uid} already has starter license.`);
            return { grantedCars: [] };
        }
    }

    const grantedCars: string[] = [];
    const garageData = garageDoc.exists ? garageDoc.data() : { cars: {} };
    const carsMap = garageData?.cars ?? {};

    // Prepare car grants
    const carUpdates: Record<string, unknown> = {};
    for (const bundledCar of starterTier.bundledCars) {
        if (!carsMap[bundledCar.carId]) {
            grantedCars.push(bundledCar.carId);
            carUpdates[`cars.${bundledCar.carId}`] = {
                carId: bundledCar.carId,
                upgradeLevel: 0,
                tuning: {},
                xp: 0,
                starLevel: 0,
                isXpCapped: false,
                fuelBars: 5,
                fuelLastRefillAt: timestamp,
                archetype: bundledCar.archetype,
                acquiredVia: "starterLicense",
                createdAt: timestamp,
                updatedAt: timestamp,
            };
        }
    }

    // Write license
    if (licensesDoc.exists) {
        transaction.update(licensesRef, {
            [`licenses.${starterTier.tierId}`]: {
                tierId: starterTier.tierId,
                purchasedAt: timestamp,
                grantedCars,
            },
            updatedAt: timestamp,
        });
    } else {
        transaction.set(licensesRef, {
            licenses: {
                [starterTier.tierId]: {
                    tierId: starterTier.tierId,
                    purchasedAt: timestamp,
                    grantedCars,
                },
            },
            updatedAt: timestamp,
        });
    }

    // Write cars
    if (Object.keys(carUpdates).length > 0) {
        if (garageDoc.exists) {
            transaction.update(garageRef, {
                ...carUpdates,
                updatedAt: timestamp,
            });
        } else {
            const carsData: Record<string, unknown> = {};
            for (const bundledCar of starterTier.bundledCars) {
                const carKey = `cars.${bundledCar.carId}`;
                if (carUpdates[carKey]) {
                    carsData[bundledCar.carId] = carUpdates[carKey];
                }
            }
            transaction.set(garageRef, {
                cars: carsData,
                updatedAt: timestamp,
            });
        }
    }

    console.log(`[TiersV2] Granted starter license to ${uid}, cars: ${grantedCars.join(", ")}`);
    return { grantedCars };
}
