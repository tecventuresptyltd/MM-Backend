import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";

const db = admin.firestore();

/**
 * Shared function to distribute maintenance rewards when maintenance ends.
 * Called by both setMaintenanceMode and activateScheduledMaintenance.
 */
export async function distributeMaintenanceRewards(
    maintenanceId: string,
    gemsToGrant: number,
    endedBy: string,
    timestamp: number
): Promise<{ playersRewarded: number }> {
    logger.info("[distributeMaintenanceRewards] Starting distribution", {
        maintenanceId,
        gemsToGrant,
        endedBy,
    });

    // Update maintenance history
    const historyRef = db.doc(`MaintenanceHistory/${maintenanceId}`);
    const historyDoc = await historyRef.get();

    if (historyDoc.exists) {
        const historyData = historyDoc.data();
        const startedAt = historyData?.startedAt || timestamp;
        const duration = timestamp - startedAt;

        logger.info("[distributeMaintenanceRewards] Updating history with endedAt");

        try {
            await historyRef.update({
                endedAt: timestamp,
                endedBy,
                duration,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            logger.info("[distributeMaintenanceRewards] History updated successfully");
        } catch (error) {
            logger.error("[distributeMaintenanceRewards] Failed to update history:", error);
            throw error;
        }
    } else {
        logger.warn(
            "[distributeMaintenanceRewards] History document does not exist:",
            maintenanceId
        );
    }

    // Get all players
    const playersSnapshot = await db.collection("Players").get();

    logger.info(
        `[distributeMaintenanceRewards] Distributing rewards to ${playersSnapshot.size} players`
    );

    // Use batched writes for efficiency (max 500 per batch)
    let batch = db.batch();
    let operationCount = 0;
    let rewardedCount = 0;

    try {
        for (const playerDoc of playersSnapshot.docs) {
            const playerId = playerDoc.id;

            // Add to unseen rewards
            const unseenRef = db.doc(`Players/${playerId}/Maintenance/UnseenRewards`);
            batch.set(
                unseenRef,
                {
                    unseenRewards: admin.firestore.FieldValue.arrayUnion({
                        maintenanceId,
                        gems: gemsToGrant,
                        timestamp,
                    }),
                    totalUnseen: admin.firestore.FieldValue.increment(1),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
            );

            // Grant gems immediately
            const statsRef = db.doc(`Players/${playerId}/Economy/Stats`);
            batch.update(statsRef, {
                gems: admin.firestore.FieldValue.increment(gemsToGrant),
            });

            operationCount += 2; // unseenRewards + stats update
            rewardedCount++;

            // Commit batch every 250 operations (500 writes / 2 ops per player)
            if (operationCount >= 500) {
                await batch.commit();
                logger.info(
                    `[distributeMaintenanceRewards] Batch committed: ${rewardedCount} players rewarded so far`
                );
                batch = db.batch();
                operationCount = 0;
            }
        }

        // Commit remaining operations
        if (operationCount > 0) {
            await batch.commit();
        }

        logger.info(
            `[distributeMaintenanceRewards] Rewards distributed to ${rewardedCount} players successfully`
        );

        return { playersRewarded: rewardedCount };
    } catch (error) {
        logger.error("[distributeMaintenanceRewards] Error during reward distribution:", error);
        throw error;
    }
}
