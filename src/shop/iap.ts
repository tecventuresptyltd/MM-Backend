import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { REGION } from "../shared/region.js";
import { findGemPackByProductId } from "../game-data/catalogs/GemPacksCatalog.js";

type VerifyIapRequest = {
  platform: unknown;
  productId: unknown;
  receipt: unknown;
};

const normalizePlatform = (value: unknown): "ios" | "android" => {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", "platform must be provided.");
  }
  const normalized = value.trim().toLowerCase();
  if (normalized !== "ios" && normalized !== "android") {
    throw new HttpsError("invalid-argument", "platform must be either ios or android.");
  }
  return normalized;
};

const extractTransactionId = (receipt: unknown): string => {
  if (typeof receipt === "string") {
    const trimmed = receipt.trim();
    if (!trimmed) {
      throw new HttpsError("invalid-argument", "receipt transactionId is required.");
    }
    return trimmed;
  }
  if (receipt && typeof receipt === "object") {
    const transactionId = (receipt as Record<string, unknown>).transactionId;
    if (typeof transactionId === "string" && transactionId.trim().length > 0) {
      return transactionId.trim();
    }
  }
  throw new HttpsError("invalid-argument", "receipt must include transactionId.");
};

export const verifyIapPurchase = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const { platform, productId, receipt } = (request.data ?? {}) as VerifyIapRequest;
  const normalizedPlatform = normalizePlatform(platform);

  if (typeof productId !== "string" || !productId.trim()) {
    throw new HttpsError("invalid-argument", "productId must be provided.");
  }

  const pack = findGemPackByProductId(productId.trim());
  if (!pack) {
    throw new HttpsError("not-found", "Unknown productId.");
  }

  const transactionId = extractTransactionId(receipt);
  const db = admin.firestore();
  const economyRef = db.doc(`Players/${uid}/Economy/Stats`);
  const receiptRef = db.doc(`Players/${uid}/Receipts/iap.${transactionId}`);

  await db.runTransaction(async (transaction) => {
    const [economySnap, receiptSnap] = await Promise.all([
      transaction.get(economyRef),
      transaction.get(receiptRef),
    ]);

    if (receiptSnap.exists) {
      throw new HttpsError("already-exists", "Receipt already processed.");
    }
    if (!economySnap.exists) {
      throw new HttpsError("failed-precondition", "Player economy data missing.");
    }

    transaction.update(economyRef, {
      gems: admin.firestore.FieldValue.increment(pack.gemAmount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    transaction.set(receiptRef, {
      type: "iap",
      transactionId,
      platform: normalizedPlatform,
      productId: pack.productId,
      iapId: pack.iapId,
      gemAmount: pack.gemAmount,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      payload: receipt ?? null,
    });
  });

  return {
    success: true,
    transactionId,
    iapId: pack.iapId,
    gemsGranted: pack.gemAmount,
  };
});
