import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency";
import { runTransactionWithReceipt } from "../core/transactions";

const db = admin.firestore();

// --- Get Maintenance Status ---

export const getMaintenanceStatus = onCall({ region: REGION }, async () => {
  const maintenanceRef = db.doc("/GameConfig/maintenance");
  const maintenanceDoc = await maintenanceRef.get();

  if (!maintenanceDoc.exists) {
    return { maintenance: false };
  }

  return maintenanceDoc.data();
});

// --- Claim Maintenance Reward ---

interface ClaimMaintenanceRewardRequest {
  opId: string;
}

interface ClaimMaintenanceRewardResponse {
  success: boolean;
  opId: string;
}

export const claimMaintenanceReward = onCall({ region: REGION }, async (request) => {
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
        if (!maintenanceDoc.exists || !maintenanceDoc.data()!.rewardAvailable) {
          throw new HttpsError("failed-precondition", "No maintenance reward available.");
        }

        const playerStats = playerStatsDoc.data()!;
        if (playerStats.claimedMaintenanceRewards?.includes(maintenanceDoc.id)) {
          throw new HttpsError("failed-precondition", "Reward already claimed.");
        }

        transaction.update(playerStatsRef, {
          gems: admin.firestore.FieldValue.increment(maintenanceDoc.data()!.rewardGems || 100),
          claimedMaintenanceRewards: admin.firestore.FieldValue.arrayUnion(maintenanceDoc.id),
        });

        return {
          success: true,
          opId,
        };
      }
    );
  } catch (error) {
    const e = error as Error;
    throw new HttpsError("internal", e.message, e);
  }
});