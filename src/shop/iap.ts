import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { callableOptions } from "../shared/callableOptions.js";
import { findGemPackByProductId } from "../game-data/catalogs/GemPacksCatalog.js";
import {
  ReceiptRejected,
  VerifierNotConfigured,
  verifyReceipt,
} from "./receiptVerification.js";

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

export const verifyIapPurchase = onCall(
  callableOptions({ cpu: 1, concurrency: 80 }),
  async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const { platform, productId, receipt } = (request.data ?? {}) as VerifyIapRequest;
  const normalizedPlatform = normalizePlatform(platform);

  if (typeof productId !== "string" || !productId.trim()) {
    throw new HttpsError("invalid-argument", "productId must be provided.");
  }

  const pack = await findGemPackByProductId(productId.trim());
  if (!pack) {
    throw new HttpsError("not-found", "Unknown productId.");
  }

  let verified;
  try {
    verified = await verifyReceipt(normalizedPlatform, receipt, pack.productId);
  } catch (error) {
    if (error instanceof VerifierNotConfigured) {
      logger.error("IAP verification is not configured", {
        platform: normalizedPlatform,
        message: (error as Error).message,
      });
      throw new HttpsError(
        "failed-precondition",
        "Purchases cannot be verified right now. Please try again later.",
      );
    }
    if (error instanceof ReceiptRejected) {
      logger.warn("IAP receipt rejected", {
        uid,
        platform: normalizedPlatform,
        productId: pack.productId,
        message: (error as Error).message,
      });
      throw new HttpsError("permission-denied", "Purchase could not be verified.");
    }
    throw error;
  }

  const transactionId = verified.transactionId;
  const db = admin.firestore();
  const economyRef = db.doc(`Players/${uid}/Economy/Stats`);
  const receiptRef = db.doc(`Players/${uid}/Receipts/iap.${transactionId}`);
  const ledgerRef = db.doc(`IapTransactions/${normalizedPlatform}.${transactionId}`);

  await db.runTransaction(async (transaction) => {
    const [economySnap, receiptSnap, ledgerSnap] = await Promise.all([
      transaction.get(economyRef),
      transaction.get(receiptRef),
      transaction.get(ledgerRef),
    ]);

    if (receiptSnap.exists) {
      throw new HttpsError("already-exists", "Receipt already processed.");
    }
    if (ledgerSnap.exists) {
      throw new HttpsError("already-exists", "Receipt already redeemed.");
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
      verified: true,
    });

    transaction.set(ledgerRef, {
      uid,
      platform: normalizedPlatform,
      productId: pack.productId,
      transactionId,
      gemAmount: pack.gemAmount,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return {
    success: true,
    transactionId,
    iapId: pack.iapId,
    gemsGranted: pack.gemAmount,
  };
});
