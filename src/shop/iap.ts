import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { callableOptions } from "../shared/callableOptions.js";
import { findGemPackByProductId } from "../game-data/catalogs/GemPacksCatalog.js";
import { isReceiptVerificationEnabled } from "./iapConfig.js";
import {
  ReceiptRejected,
  VerifierNotConfigured,
  verifyReceipt,
} from "./receiptVerification.js";

type VerifyIapRequest = {
  platform: unknown;
  productId: unknown;
  receipt: unknown;
  transactionId: unknown;
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

const readTransactionId = (receipt: unknown, transactionId: unknown): string => {
  if (typeof transactionId === "string" && transactionId.trim()) {
    return transactionId.trim();
  }

  if (receipt && typeof receipt === "object") {
    const direct = (receipt as Record<string, unknown>).transactionId;
    if (typeof direct === "string" && direct.trim()) {
      return direct.trim();
    }
  }

  if (typeof receipt === "string" && receipt.trim()) {
    const trimmed = receipt.trim();
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const fromReceipt = parsed.TransactionID ?? parsed.transactionId;
      if (typeof fromReceipt === "string" && fromReceipt.trim()) {
        return fromReceipt.trim();
      }
    } catch {
      return trimmed;
    }
    return trimmed;
  }

  throw new HttpsError("invalid-argument", "receipt transactionId is required.");
};

const resolveTransactionId = async (
  platform: "ios" | "android",
  receipt: unknown,
  transactionId: unknown,
  productId: string,
  uid: string,
): Promise<{ transactionId: string; verified: boolean }> => {
  if (!(await isReceiptVerificationEnabled())) {
    return { transactionId: readTransactionId(receipt, transactionId), verified: false };
  }

  try {
    const result = await verifyReceipt(platform, receipt, productId);
    return { transactionId: result.transactionId, verified: true };
  } catch (error) {
    if (error instanceof VerifierNotConfigured) {
      logger.error("IAP verification is not configured", {
        platform,
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
        platform,
        productId,
        message: (error as Error).message,
      });
      throw new HttpsError("permission-denied", "Purchase could not be verified.");
    }
    throw error;
  }
};

export const verifyIapPurchase = onCall(
  callableOptions({ cpu: 1, concurrency: 80 }),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const { platform, productId, receipt, transactionId } =
      (request.data ?? {}) as VerifyIapRequest;
    const normalizedPlatform = normalizePlatform(platform);

    if (typeof productId !== "string" || !productId.trim()) {
      throw new HttpsError("invalid-argument", "productId must be provided.");
    }

    const pack = await findGemPackByProductId(productId.trim());
    if (!pack) {
      throw new HttpsError("not-found", "Unknown productId.");
    }

    const resolved = await resolveTransactionId(
      normalizedPlatform,
      receipt,
      transactionId,
      pack.productId,
      uid,
    );

    const db = admin.firestore();
    const economyRef = db.doc(`Players/${uid}/Economy/Stats`);
    const receiptRef = db.doc(`Players/${uid}/Receipts/iap.${resolved.transactionId}`);
    const ledgerRef = db.doc(
      `IapTransactions/${normalizedPlatform}.${resolved.transactionId}`,
    );

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
        transactionId: resolved.transactionId,
        platform: normalizedPlatform,
        productId: pack.productId,
        iapId: pack.iapId,
        gemAmount: pack.gemAmount,
        verified: resolved.verified,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      transaction.set(ledgerRef, {
        uid,
        platform: normalizedPlatform,
        productId: pack.productId,
        transactionId: resolved.transactionId,
        gemAmount: pack.gemAmount,
        verified: resolved.verified,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    return {
      success: true,
      transactionId: resolved.transactionId,
      iapId: pack.iapId,
      gemsGranted: pack.gemAmount,
    };
  },
);
