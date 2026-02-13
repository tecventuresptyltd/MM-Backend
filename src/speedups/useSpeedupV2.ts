/**
 * V2 Speedup System
 *
 * Allows players to use speedup items from their inventory to reduce
 * the remaining time on Pit Crew (car evolution) or Library (spell research) queue slots.
 *
 * Speedup SKU data is read from the existing ItemSkusCatalog (no separate catalog needed).
 *
 * Supports: pitCrew, library
 *
 * @module useSpeedupV2
 */

import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import { resolveSkuOrThrow } from "../core/config.js";
import {
    UseSpeedupRequest,
    UseSpeedupResponse,
    SpeedupQueueType,
} from "../shared/typesV2.js";
import {
    decSkuQtyOrThrowTx,
} from "../inventory/index.js";

const db = admin.firestore();

// =============================================================================
// useSpeedupV2
// =============================================================================

/**
 * Use a speedup item to reduce time remaining on a queue slot.
 *
 * Check Logic:
 * 1. Validate speedup SKU exists in ItemSkusCatalog and is type "speedup"
 * 2. Validate target queue slot exists and is not already complete
 * 3. Verify player owns at least 1 of the speedup item
 * 4. Deduct 1 speedup item from inventory
 * 5. Subtract durationSeconds from the slot's completesAt
 * 6. If new completesAt is in the past, clamp to now (instantly claimable)
 */
export const useSpeedupV2 = onCall(
    callableOptions({ minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const { queueType, targetId, speedupSkuId, opId } = request.data as UseSpeedupRequest;
        const uid = request.auth?.uid;

        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        if (!queueType || !targetId || !speedupSkuId || !opId) {
            throw new HttpsError(
                "invalid-argument",
                "Missing required fields: queueType, targetId, speedupSkuId, opId.",
            );
        }

        if (queueType !== "pitCrew" && queueType !== "library") {
            throw new HttpsError(
                "invalid-argument",
                `Invalid queueType: ${queueType}. Must be "pitCrew" or "library".`,
            );
        }

        // Look up speedup SKU from the existing ItemSkusCatalog
        const sku = await resolveSkuOrThrow(speedupSkuId);

        if (sku.type !== "speedup") {
            throw new HttpsError(
                "invalid-argument",
                `SKU ${speedupSkuId} is not a speedup item (type: ${sku.type}).`,
            );
        }

        const durationSeconds = sku.durationSeconds;
        if (!durationSeconds || durationSeconds <= 0) {
            throw new HttpsError(
                "internal",
                `Speedup SKU ${speedupSkuId} has no valid durationSeconds.`,
            );
        }

        const speedupDurationMs = durationSeconds * 1000;

        console.log(
            `[SpeedupV2] uid=${uid} queue=${queueType} target=${targetId} sku=${speedupSkuId} duration=${durationSeconds}s`,
        );

        return await runTransactionWithReceipt<UseSpeedupResponse>(
            uid,
            opId,
            "useSpeedupV2",
            async (transaction) => {
                const now = Date.now();
                const timestamp = admin.firestore.FieldValue.serverTimestamp();

                // Resolve queue path based on type
                const queuePath = resolveQueuePath(uid, queueType);
                const queueRef = db.doc(queuePath);

                // Read queue document
                const queueDoc = await transaction.get(queueRef);

                if (!queueDoc.exists) {
                    throw new HttpsError(
                        "not-found",
                        `No active ${queueType} queue found.`,
                    );
                }

                // Find the slot matching targetId
                const queueData = queueDoc.data()!;
                const slots = queueData.slots ?? [];
                const slotIndex = findSlotIndex(slots, queueType, targetId);

                if (slotIndex === -1) {
                    throw new HttpsError(
                        "not-found",
                        `No active ${queueType} slot found for target: ${targetId}`,
                    );
                }

                const slot = slots[slotIndex];
                const currentCompletesAt = (slot.completesAt as admin.firestore.Timestamp).toMillis();

                // Check if already complete
                if (currentCompletesAt <= now) {
                    throw new HttpsError(
                        "failed-precondition",
                        "This slot has already completed. Claim it instead of using a speedup.",
                    );
                }

                // Deduct 1 speedup item from inventory (throws if insufficient)
                await decSkuQtyOrThrowTx(transaction, db, uid, speedupSkuId, 1);

                // Calculate new completesAt
                let newCompletesAtMs = currentCompletesAt - speedupDurationMs;
                if (newCompletesAtMs < now) {
                    newCompletesAtMs = now; // Clamp to now — instantly claimable
                }

                const newCompletesAtTimestamp = admin.firestore.Timestamp.fromMillis(newCompletesAtMs);
                const isNowComplete = newCompletesAtMs <= now;
                const newRemainingSeconds = isNowComplete
                    ? 0
                    : Math.ceil((newCompletesAtMs - now) / 1000);

                // Update the slot's completesAt in the queue
                const updatedSlots = [...slots];
                updatedSlots[slotIndex] = {
                    ...slot,
                    completesAt: newCompletesAtTimestamp,
                };

                transaction.update(queueRef, {
                    slots: updatedSlots,
                    updatedAt: timestamp,
                });

                console.log(
                    `[SpeedupV2] Applied ${durationSeconds}s speedup to ${queueType}/${targetId}. ` +
                    `Old completesAt=${currentCompletesAt}, New completesAt=${newCompletesAtMs}, ` +
                    `isNowComplete=${isNowComplete}`,
                );

                return {
                    success: true,
                    opId,
                    queueType,
                    targetId,
                    speedupUsed: speedupSkuId,
                    secondsRemoved: durationSeconds,
                    newCompletesAt: newCompletesAtMs,
                    isNowComplete,
                    newRemainingSeconds,
                };
            },
        );
    },
);

// =============================================================================
// HELPERS
// =============================================================================

function resolveQueuePath(uid: string, queueType: SpeedupQueueType): string {
    switch (queueType) {
        case "pitCrew":
            return `/Players/${uid}/Queues/PitCrew`;
        case "library":
            return `/Players/${uid}/Queues/Library`;
        default:
            throw new HttpsError("invalid-argument", `Unknown queue type: ${queueType}`);
    }
}

function findSlotIndex(
    slots: Array<Record<string, unknown>>,
    queueType: SpeedupQueueType,
    targetId: string,
): number {
    switch (queueType) {
        case "pitCrew":
            return slots.findIndex((s) => s.carId === targetId);
        case "library":
            return slots.findIndex((s) => s.spellId === targetId);
        default:
            return -1;
    }
}
