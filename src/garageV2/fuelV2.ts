/**
 * V2 Fuel System Functions
 *
 * Handles per-car fuel management:
 * - 5 bars per car, regenerates over time
 * - Refill via ads, fuel cells, or gems
 *
 * @module fuelV2
 */

import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import { getFuelConfig, calculateFuelBars } from "../core/configV2.js";
import {
    RefuelWithAdRequest,
    RefuelWithAdResponse,
    UseFuelCellRequest,
    UseFuelCellResponse,
    FuelConfig,
} from "../shared/typesV2.js";

const db = admin.firestore();

// =============================================================================
// Helper: Get current fuel with regeneration
// =============================================================================

export interface FuelState {
    currentBars: number;
    maxBars: number;
    lastRefillAt: Date | null;
    nextRegenAt: Date | null;
    regenIntervalMinutes: number;
}

export async function getCarFuelState(
    uid: string,
    carId: string,
): Promise<FuelState> {
    const [garageDoc, fuelConfig] = await Promise.all([
        db.doc(`/Players/${uid}/Garage/Cars`).get(),
        getFuelConfig(),
    ]);

    if (!garageDoc.exists) {
        return {
            currentBars: fuelConfig.maxBars,
            maxBars: fuelConfig.maxBars,
            lastRefillAt: null,
            nextRegenAt: null,
            regenIntervalMinutes: fuelConfig.regenIntervalMinutes,
        };
    }

    const garageData = garageDoc.data()!;
    const carData = garageData.cars?.[carId];

    if (!carData) {
        return {
            currentBars: fuelConfig.maxBars,
            maxBars: fuelConfig.maxBars,
            lastRefillAt: null,
            nextRegenAt: null,
            regenIntervalMinutes: fuelConfig.regenIntervalMinutes,
        };
    }

    const storedBars = carData.fuelBars ?? fuelConfig.maxBars;
    const lastRefillAt = carData.fuelLastRefillAt
        ? (carData.fuelLastRefillAt as admin.firestore.Timestamp).toDate()
        : null;

    // Calculate regenerated bars
    const currentBars = calculateFuelBars(storedBars, lastRefillAt, fuelConfig);

    // Calculate next regen time
    let nextRegenAt: Date | null = null;
    if (currentBars < fuelConfig.maxBars && lastRefillAt) {
        const elapsedMs = Date.now() - lastRefillAt.getTime();
        const elapsedIntervals = Math.floor(elapsedMs / (fuelConfig.regenIntervalMinutes * 60 * 1000));
        const nextIntervalMs = (elapsedIntervals + 1) * fuelConfig.regenIntervalMinutes * 60 * 1000;
        nextRegenAt = new Date(lastRefillAt.getTime() + nextIntervalMs);
    }

    return {
        currentBars,
        maxBars: fuelConfig.maxBars,
        lastRefillAt,
        nextRegenAt,
        regenIntervalMinutes: fuelConfig.regenIntervalMinutes,
    };
}

// =============================================================================
// consumeFuelV2 (Internal helper)
// =============================================================================

/**
 * Consume fuel before a race.
 * Called internally by race preparation.
 *
 * @param transaction - Firestore transaction
 * @param uid - Player UID
 * @param carId - Car to consume fuel from
 * @param timestamp - Server timestamp
 * @returns Whether fuel was available and consumed
 */
export async function consumeFuel(
    transaction: FirebaseFirestore.Transaction,
    uid: string,
    carId: string,
    timestamp: FirebaseFirestore.FieldValue,
): Promise<{ success: boolean; fuelBarsRemaining: number; error?: string }> {
    const garageRef = db.doc(`/Players/${uid}/Garage/Cars`);
    const garageDoc = await transaction.get(garageRef);
    const fuelConfig = await getFuelConfig();

    if (!garageDoc.exists) {
        return { success: false, fuelBarsRemaining: 0, error: "Garage not found" };
    }

    const garageData = garageDoc.data()!;
    const carData = garageData.cars?.[carId];

    if (!carData) {
        return { success: false, fuelBarsRemaining: 0, error: "Car not found" };
    }

    const storedBars = carData.fuelBars ?? fuelConfig.maxBars;
    const lastRefillAt = carData.fuelLastRefillAt
        ? (carData.fuelLastRefillAt as admin.firestore.Timestamp).toDate()
        : null;

    // Calculate current bars with regen
    const currentBars = calculateFuelBars(storedBars, lastRefillAt, fuelConfig);

    if (currentBars < fuelConfig.raceCostPerRace) {
        return {
            success: false,
            fuelBarsRemaining: currentBars,
            error: "Insufficient fuel. Refill to continue racing.",
        };
    }

    // Consume fuel
    const newBars = currentBars - fuelConfig.raceCostPerRace;

    transaction.update(garageRef, {
        [`cars.${carId}.fuelBars`]: newBars,
        [`cars.${carId}.fuelLastRefillAt`]: timestamp,
        [`cars.${carId}.updatedAt`]: timestamp,
    });

    return { success: true, fuelBarsRemaining: newBars };
}

// =============================================================================
// refuelWithAdV2
// =============================================================================

/**
 * Refuel a car by watching an ad.
 * Grants partial refill (+3 bars by default).
 */
export const refuelWithAdV2 = onCall(
    callableOptions({ minInstances: getMinInstances(true), memory: "256MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const { carId, opId } = request.data as RefuelWithAdRequest;
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

        await createInProgressReceipt(uid, opId, "refuelWithAdV2");

        const fuelConfig = await getFuelConfig();

        return await runTransactionWithReceipt<RefuelWithAdResponse>(
            uid,
            opId,
            "refuelWithAdV2",
            async (transaction) => {
                const timestamp = admin.firestore.FieldValue.serverTimestamp();
                const garageRef = db.doc(`/Players/${uid}/Garage/Cars`);
                const garageDoc = await transaction.get(garageRef);

                if (!garageDoc.exists) {
                    throw new HttpsError("not-found", "Garage not found.");
                }

                const garageData = garageDoc.data()!;
                const carData = garageData.cars?.[carId];

                if (!carData) {
                    throw new HttpsError("not-found", `Car not found: ${carId}`);
                }

                // Get current fuel state
                const storedBars = carData.fuelBars ?? fuelConfig.maxBars;
                const lastRefillAt = carData.fuelLastRefillAt
                    ? (carData.fuelLastRefillAt as admin.firestore.Timestamp).toDate()
                    : null;
                const currentBars = calculateFuelBars(storedBars, lastRefillAt, fuelConfig);

                // Calculate refill amount
                const adRefillAmount = fuelConfig.refillOptions.ad.refillAmount;
                const barsToAdd = Math.min(adRefillAmount, fuelConfig.maxBars - currentBars);
                const newBars = Math.min(currentBars + barsToAdd, fuelConfig.maxBars);

                // TODO: Validate ad was actually watched (integrate with ad network)
                // For now, we trust the client

                // --- WRITE ---
                transaction.update(garageRef, {
                    [`cars.${carId}.fuelBars`]: newBars,
                    [`cars.${carId}.fuelLastRefillAt`]: timestamp,
                    [`cars.${carId}.updatedAt`]: timestamp,
                });

                return {
                    success: true,
                    opId,
                    carId,
                    fuelBarsAfter: newBars,
                    barsAdded: barsToAdd,
                };
            },
        );
    },
);

// =============================================================================
// useFuelCellV2
// =============================================================================

/**
 * Use a Fuel Cell item to fully refuel a car.
 */
export const useFuelCellV2 = onCall(
    callableOptions({ minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const { carId, opId } = request.data as UseFuelCellRequest;
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

        await createInProgressReceipt(uid, opId, "useFuelCellV2");

        const fuelConfig = await getFuelConfig();
        const fuelCellSkuId = fuelConfig.refillOptions.fuelCell.skuId;

        return await runTransactionWithReceipt<UseFuelCellResponse>(
            uid,
            opId,
            "useFuelCellV2",
            async (transaction) => {
                const timestamp = admin.firestore.FieldValue.serverTimestamp();
                const garageRef = db.doc(`/Players/${uid}/Garage/Cars`);
                const fuelCellRef = db.doc(`/Players/${uid}/Inventory/${fuelCellSkuId}`);

                const [garageDoc, fuelCellDoc] = await Promise.all([
                    transaction.get(garageRef),
                    transaction.get(fuelCellRef),
                ]);

                // Validate garage
                if (!garageDoc.exists) {
                    throw new HttpsError("not-found", "Garage not found.");
                }

                const garageData = garageDoc.data()!;
                const carData = garageData.cars?.[carId];

                if (!carData) {
                    throw new HttpsError("not-found", `Car not found: ${carId}`);
                }

                // Validate fuel cell inventory
                if (!fuelCellDoc.exists) {
                    throw new HttpsError("failed-precondition", "No Fuel Cells in inventory.");
                }

                const fuelCellData = fuelCellDoc.data()!;
                const quantity = fuelCellData.quantity ?? 0;

                if (quantity < 1) {
                    throw new HttpsError("failed-precondition", "No Fuel Cells in inventory.");
                }

                // --- WRITES ---

                // Decrement fuel cell
                transaction.update(fuelCellRef, {
                    quantity: admin.firestore.FieldValue.increment(-1),
                    updatedAt: timestamp,
                });

                // Refuel to max
                transaction.update(garageRef, {
                    [`cars.${carId}.fuelBars`]: fuelConfig.maxBars,
                    [`cars.${carId}.fuelLastRefillAt`]: timestamp,
                    [`cars.${carId}.updatedAt`]: timestamp,
                });

                return {
                    success: true,
                    opId,
                    carId,
                    fuelBarsAfter: fuelConfig.maxBars,
                };
            },
        );
    },
);

// =============================================================================
// getCarFuelStatusV2
// =============================================================================

interface CarFuelStatusResponse {
    carId: string;
    currentBars: number;
    maxBars: number;
    regenIntervalMinutes: number;
    nextRegenAt: number | null;
    refillOptions: {
        ad: { barsToAdd: number; available: boolean };
        fuelCell: { quantity: number; available: boolean };
        gems: { cost: number; available: boolean };
    };
}

/**
 * Get fuel status for a specific car.
 * Read-only endpoint.
 */
export const getCarFuelStatusV2 = onCall(
    callableOptions({ cpu: 1, concurrency: 80 }),
    async (request) => {
        const { carId } = request.data as { carId: string };
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        if (!carId) {
            throw new HttpsError("invalid-argument", "Missing required parameter: carId");
        }

        const [fuelConfig, fuelState, economyDoc, fuelCellDoc] = await Promise.all([
            getFuelConfig(),
            getCarFuelState(uid, carId),
            db.doc(`/Players/${uid}/Economy/Stats`).get(),
            db.doc(`/Players/${uid}/Inventory/${(await getFuelConfig()).refillOptions.fuelCell.skuId}`).get(),
        ]);

        const economyData = economyDoc.data() ?? {};
        const playerGems = economyData.gems ?? 0;

        const fuelCellData = fuelCellDoc.data() ?? {};
        const fuelCellQty = fuelCellData.quantity ?? 0;

        const barsNeeded = fuelConfig.maxBars - fuelState.currentBars;
        const gemCost = barsNeeded * fuelConfig.refillOptions.gems.gemsPerBar;

        return {
            carId,
            currentBars: fuelState.currentBars,
            maxBars: fuelState.maxBars,
            regenIntervalMinutes: fuelState.regenIntervalMinutes,
            nextRegenAt: fuelState.nextRegenAt?.getTime() ?? null,
            refillOptions: {
                ad: {
                    barsToAdd: Math.min(fuelConfig.refillOptions.ad.refillAmount, barsNeeded),
                    available: fuelState.currentBars < fuelState.maxBars,
                },
                fuelCell: {
                    quantity: fuelCellQty,
                    available: fuelCellQty > 0,
                },
                gems: {
                    cost: gemCost,
                    available: playerGems >= gemCost && barsNeeded > 0,
                },
            },
        } as CarFuelStatusResponse;
    },
);
