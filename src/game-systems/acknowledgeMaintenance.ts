import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region.js";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { db } from "../shared/firestore.js";

interface AcknowledgeMaintenanceRewardsRequest {
    maintenanceIds?: string[];  // Specific rewards to acknowledge, or omit/empty for "all"
}

interface AcknowledgeMaintenanceRewardsResponse {
    acknowledged: number;
    remaining: number;
}

/**
 * Marks maintenance rewards as "seen" by removing them from the unseen rewards list.
 * 
 * If maintenanceIds is provided and non-empty, only those specific rewards are acknowledged.
 * If maintenanceIds is omitted or empty, ALL unseen rewards are acknowledged.
 * 
 * @param maintenanceIds - Optional array of maintenance IDs to acknowledge. Empty/omitted = acknowledge all.
 * @returns Number of rewards acknowledged and number remaining.
 */
export const acknowledgeMaintenanceRewards = onCall(callableOptions({ minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true), async (rawRequest) => {
    const uid = rawRequest.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const { maintenanceIds } = (rawRequest.data || {}) as AcknowledgeMaintenanceRewardsRequest;

    const unseenRewardsRef = db.doc(`Players/${uid}/Maintenance/UnseenRewards`);

    return await db.runTransaction(async (transaction) => {
        const unseenSnap = await transaction.get(unseenRewardsRef);

        if (!unseenSnap.exists) {
            return { acknowledged: 0, remaining: 0 };
        }

        const data = unseenSnap.data()!;
        const currentUnseen = data.unseenRewards || [];

        // If maintenanceIds is empty or not provided, acknowledge all
        const toAcknowledge = maintenanceIds && maintenanceIds.length > 0
            ? new Set(maintenanceIds)
            : new Set(currentUnseen.map((r: any) => r.maintenanceId));

        const remaining = currentUnseen.filter(
            (reward: any) => !toAcknowledge.has(reward.maintenanceId)
        );

        const acknowledgedCount = currentUnseen.length - remaining.length;

        transaction.set(
            unseenRewardsRef,
            {
                unseenRewards: remaining,
                totalUnseen: remaining.length,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );

        return {
            acknowledged: acknowledgedCount,
            remaining: remaining.length,
        };
    });
});
