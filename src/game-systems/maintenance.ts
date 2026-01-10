import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency";
import { runTransactionWithReceipt } from "../core/transactions";

const db = admin.firestore();

// --- Get Maintenance Status ---

export const getMaintenanceStatus = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async () => {
  const maintenanceRef = db.doc("/GameConfig/maintenance");
  const maintenanceDoc = await maintenanceRef.get();

  if (!maintenanceDoc.exists) {
    return { maintenance: false };
  }

  return maintenanceDoc.data();
});

// --- Claim Maintenance Reward ---

/**
 * @deprecated This function is deprecated in favor of the new unseen rewards pattern.
 * 
 * **For new clients:**
 * - Listen to `/Players/{uid}/Maintenance/UnseenRewards` via Firestore
 * - Gems are granted automatically when maintenance ends
 * - Call `acknowledgeMaintenanceRewards()` to dismiss the notification popup
 * 
 * **This function is kept for backwards compatibility with older clients.**
 * 
 * @see acknowledgeMaintenanceRewards for the new pattern
 * @deprecated Will be removed after all clients migrate to unseen rewards (est. Feb 2025)
 */

interface ClaimMaintenanceRewardRequest {
  opId: string;
}

interface ClaimMaintenanceRewardResponse {
  success: boolean;
  opId: string;
  gemsGranted: number;
}

export const claimMaintenanceReward = onCall(callableOptions({ minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true), async (request) => {
  const { opId } = request.data as ClaimMaintenanceRewardRequest;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (!opId) {
    throw new HttpsError("invalid-argument", "Missing required parameters.");
  }

  try {
    const idempotencyResult = await checkIdempotency(uid, opId);
    if (idempotencyResult) {
      return idempotencyResult;
    }

    await createInProgressReceipt(uid, opId, "claimMaintenanceReward");

    return await runTransactionWithReceipt<ClaimMaintenanceRewardResponse>(
      uid,
      opId,
      "claimMaintenanceReward",
      async (transaction) => {
        const playerStatsRef = db.doc(`/Players/${uid}/Economy/Stats`);
        const maintenanceRef = db.doc("/GameConfig/maintenance");

        const playerStatsDoc = await transaction.get(playerStatsRef);
        const maintenanceDoc = await transaction.get(maintenanceRef);

        if (!playerStatsDoc.exists) {
          throw new HttpsError("not-found", "Player stats not found.");
        }

        const maintenanceData = maintenanceDoc.data()!;

        if (!maintenanceDoc.exists || !maintenanceData.rewardAvailable) {
          throw new HttpsError("failed-precondition", "No maintenance reward available.");
        }

        // CRITICAL FIX: Use activeHistoryId instead of maintenanceDoc.id
        // This allows players to claim rewards for each unique maintenance event
        const activeHistoryId = maintenanceData.activeHistoryId;
        if (!activeHistoryId) {
          throw new HttpsError("failed-precondition", "No active maintenance session.");
        }

        const playerStats = playerStatsDoc.data()!;
        if (playerStats.claimedMaintenanceRewards?.includes(activeHistoryId)) {
          throw new HttpsError("failed-precondition", "Reward already claimed.");
        }

        const gemsGranted = maintenanceData.rewardGems || 100;

        transaction.update(playerStatsRef, {
          gems: admin.firestore.FieldValue.increment(gemsGranted),
          claimedMaintenanceRewards: admin.firestore.FieldValue.arrayUnion(activeHistoryId),
        });

        return {
          success: true,
          opId,
          gemsGranted,
        };
      }
    );
  } catch (error) {
    const e = error as Error;
    throw new HttpsError("internal", e.message, e);
  }
});