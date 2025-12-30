import * as admin from "firebase-admin";
import { onCall } from "firebase-functions/v2/https";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { REGION } from "../shared/region";

const db = admin.firestore();

/**
 * Background trigger: When maintenance ends, automatically credit all players
 * Triggered by changes to /GameConfig/maintenance document
 */
export const creditPlayersOnMaintenanceEnd = onDocumentWritten({
    document: "/GameConfig/maintenance",
    region: REGION,
}, async (event) => {
    try {
        const beforeData = event.data?.before.data();
        const afterData = event.data?.after.data();

        // Check if maintenance just ended (was true, now false)
        const maintenanceEnded = beforeData?.maintenance === true && afterData?.maintenance === false;

        if (!maintenanceEnded) {
            console.log("Maintenance status unchanged or not ending, skipping credit");
            return;
        }

        const rewardGems = afterData?.rewardGems || 100;
        const maintenanceId = afterData?.activeHistoryId || beforeData?.activeHistoryId;

        if (!maintenanceId) {
            console.error("No maintenance ID found, cannot track rewards");
            return;
        }

        console.log(`Maintenance ended. Crediting all players ${rewardGems} gems (maintenanceId: ${maintenanceId})`);

        // Get all players
        const playersSnapshot = await db.collection("Players").get();

        if (playersSnapshot.empty) {
            console.log("No players found to credit");
            return;
        }

        // Process in batches of 500 (Firestore batch limit)
        const batchSize = 500;
        let batch = db.batch();
        let operationCount = 0;
        let totalCredited = 0;

        for (const playerDoc of playersSnapshot.docs) {
            const playerId = playerDoc.id;
            const playerRef = db.doc(`/Players/${playerId}`);
            const currentBalance = playerDoc.data().balance || 0;

            // Update player balance
            batch.update(playerRef, {
                balance: currentBalance + rewardGems,
            });

            // Create reward tracking entry
            const rewardRef = db.doc(`/Players/${playerId}/maintenanceRewards/${maintenanceId}`);
            batch.set(rewardRef, {
                gems: rewardGems,
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
                seen: false,
                credited: true,
            });

            operationCount += 2; // Two operations per player
            totalCredited++;

            // Commit batch every 250 players (500 operations)
            if (operationCount >= batchSize) {
                await batch.commit();
                console.log(`Credited ${totalCredited} players so far...`);
                batch = db.batch();
                operationCount = 0;
            }
        }

        // Commit remaining operations
        if (operationCount > 0) {
            await batch.commit();
        }

        console.log(`✅ Successfully credited ${totalCredited} players with ${rewardGems} gems each`);

    } catch (error) {
        console.error("Error in creditPlayersOnMaintenanceEnd:", error);
        throw error;
    }
});

/**
 * Callable function: Get unseen maintenance rewards for a player
 * Returns total gems and list of rewards they haven't viewed yet
 */
export const getUnseenMaintenanceRewards = onCall({
    region: REGION,
}, async (request) => {
    try {
        const uid = request.auth?.uid;

        if (!uid) {
            throw new Error("Authentication required");
        }

        // Query unseen rewards
        const rewardsSnapshot = await db.collection(`/Players/${uid}/maintenanceRewards`)
            .where("seen", "==", false)
            .orderBy("timestamp", "desc")
            .get();

        if (rewardsSnapshot.empty) {
            return {
                totalGems: 0,
                count: 0,
                rewards: [],
            };
        }

        let totalGems = 0;
        const rewards: any[] = [];

        rewardsSnapshot.forEach((doc) => {
            const data = doc.data();
            totalGems += data.gems || 0;
            rewards.push({
                maintenanceId: doc.id,
                gems: data.gems,
                timestamp: data.timestamp?.toMillis() || 0,
            });
        });

        return {
            totalGems,
            count: rewards.length,
            rewards,
        };

    } catch (error) {
        console.error("Error in getUnseenMaintenanceRewards:", error);
        throw error;
    }
});

/**
 * Callable function: Mark maintenance rewards as seen
 * Call this after showing the notification popup to the player
 */
export const markMaintenanceRewardsSeen = onCall({
    region: REGION,
}, async (request) => {
    try {
        const uid = request.auth?.uid;
        const { maintenanceIds } = request.data;

        if (!uid) {
            throw new Error("Authentication required");
        }

        if (!maintenanceIds || !Array.isArray(maintenanceIds)) {
            throw new Error("maintenanceIds array required");
        }

        // Update all specified rewards to seen: true
        const batch = db.batch();

        for (const maintenanceId of maintenanceIds) {
            const rewardRef = db.doc(`/Players/${uid}/maintenanceRewards/${maintenanceId}`);
            batch.update(rewardRef, { seen: true });
        }

        await batch.commit();

        console.log(`Marked ${maintenanceIds.length} rewards as seen for player ${uid}`);

        return {
            success: true,
            markedCount: maintenanceIds.length,
        };

    } catch (error) {
        console.error("Error in markMaintenanceRewardsSeen:", error);
        throw error;
    }
});
