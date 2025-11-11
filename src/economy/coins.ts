import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency";
import { runTransactionWithReceipt } from "../core/transactions";

const db = admin.firestore();

interface AdjustCoinsRequest {
  amount: number; // Positive to grant, negative to spend
  opId: string;
  reason: string;
}

interface AdjustCoinsResponse {
  success: boolean;
  opId: string;
  coinsBefore: number;
  coinsAfter: number;
  deltaAmount: number;
}

export const adjustCoins = onCall(async (request) => {
  const { amount, opId, reason } = request.data as AdjustCoinsRequest;
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

    return await runTransactionWithReceipt<AdjustCoinsResponse>(
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
        const coinsBefore = stats.coins || 0;

        if (amount < 0 && coinsBefore < -amount) {
          throw new HttpsError("failed-precondition", "Insufficient funds.");
        }

        const coinsAfter = coinsBefore + amount;

        transaction.update(statsRef, {
          coins: admin.firestore.FieldValue.increment(amount),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
          success: true,
          opId,
          coinsBefore,
          coinsAfter,
          deltaAmount: amount,
        };
      }
    );
  } catch (error) {
    const e = error as Error;
    throw new HttpsError("internal", e.message, e);
  }
});