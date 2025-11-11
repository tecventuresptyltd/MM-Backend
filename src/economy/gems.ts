import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency";
import { runTransactionWithReceipt } from "../core/transactions";

const db = admin.firestore();

// --- Adjust Gems ---

interface AdjustGemsRequest {
  amount: number; // Positive to grant, negative to spend
  opId: string;
  reason: string;
}

interface AdjustGemsResponse {
  success: boolean;
  opId: string;
  gemsBefore: number;
  gemsAfter: number;
  deltaAmount: number;
}

export const adjustGems = onCall({ region: REGION }, async (request) => {
  const { amount, opId, reason } = request.data as AdjustGemsRequest;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (!opId || typeof opId !== "string") {
    throw new HttpsError("invalid-argument", "Invalid opId provided.");
  }

  if (typeof amount !== "number" || amount === 0) {
    throw new HttpsError("invalid-argument", "Amount must be a non-zero number.");
  }

  try {
    const idempotencyResult = await checkIdempotency(uid, opId);
    if (idempotencyResult) {
      return idempotencyResult;
    }

    await createInProgressReceipt(uid, opId, reason);

    return await runTransactionWithReceipt<AdjustGemsResponse>(
      uid,
      opId,
      reason,
      async (transaction) => {
        const statsRef = db.doc(`/Players/${uid}/Economy/Stats`);
        const statsDoc = await transaction.get(statsRef);

        if (!statsDoc.exists) {
          throw new HttpsError("not-found", "Player economy stats not found.");
        }

        const stats = statsDoc.data()!;
        const gemsBefore = stats.gems || 0;

        if (amount < 0 && gemsBefore < -amount) {
          throw new HttpsError("failed-precondition", "Insufficient funds.");
        }

        const gemsAfter = gemsBefore + amount;

        transaction.update(statsRef, {
          gems: admin.firestore.FieldValue.increment(amount),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
          success: true,
          opId,
          gemsBefore,
          gemsAfter,
          deltaAmount: amount,
        };
      }
    );
  } catch (error) {
    const e = error as Error;
    throw new HttpsError("internal", e.message, e);
  }
});