import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";

interface AcknowledgeReferralRewardsRequest {
    eventIds?: string[];  // Specific rewards to acknowledge, or omit/empty for "all"
}

interface AcknowledgeReferralRewardsResponse {
    acknowledged: number;
    remaining: number;
}

/**
 * Marks referral rewards as "seen" by removing them from the unseen rewards list.
 * 
 * If eventIds is provided and non-empty, only those specific rewards are acknowledged.
 * If eventIds is omitted or empty, ALL unseen rewards are acknowledged.
 * 
 * @param eventIds - Optional array of event IDs to acknowledge. Empty/omitted = acknowledge all.
 * @returns Number of rewards acknowledged and number remaining.
 */
export const acknowledgeReferralRewards = onCall({ region: REGION }, async (rawRequest) => {
    const uid = rawRequest.auth?.uid;
    if (!uid) {
        throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const { eventIds } = (rawRequest.data || {}) as AcknowledgeReferralRewardsRequest;

    const unseenRewardsRef = db.doc(`Players/${uid}/Referrals/UnseenRewards`);

    return await db.runTransaction(async (transaction) => {
        const unseenSnap = await transaction.get(unseenRewardsRef);

        if (!unseenSnap.exists) {
            return { acknowledged: 0, remaining: 0 };
        }

        const data = unseenSnap.data()!;
        const currentUnseen = data.unseenRewards || [];

        // If eventIds is empty or not provided, acknowledge all
        const toAcknowledge = eventIds && eventIds.length > 0
            ? new Set(eventIds)
            : new Set(currentUnseen.map((r: any) => r.eventId));

        const remaining = currentUnseen.filter(
            (reward: any) => !toAcknowledge.has(reward.eventId)
        );

        const acknowledgedCount = currentUnseen.length - remaining.length;

        transaction.set(
            unseenRewardsRef,
            {
                unseenRewards: remaining,
                totalUnseenRewards: remaining.length,
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
