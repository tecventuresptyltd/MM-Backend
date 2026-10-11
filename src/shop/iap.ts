import { createHash } from "node:crypto";
import { getOffersCatalog } from "../core/config.js";
import { fulfillOfferPurchase } from "./purchaseOffer.js";
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
    const result = await verifyReceipt(platform, receipt, productId, readTransactionId(receipt, transactionId));
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

    const requestedProductId = productId.trim();
    const requestedTransactionId = readTransactionId(receipt, transactionId);
    if (!requestedTransactionId || requestedTransactionId.includes("/") || requestedTransactionId.length > 256)
      throw new HttpsError("invalid-argument", "Invalid store transaction identifier.");
    const priorLedger = await admin.firestore().collection("IapTransactions").doc(`${normalizedPlatform}.${requestedTransactionId}`).get();
    if (priorLedger.exists) {
      const previous = priorLedger.data()!;
      if (previous.uid !== uid || previous.productId !== requestedProductId)
        throw new HttpsError("permission-denied", "Receipt belongs to another purchase or player.");
      if (previous.result) return { ...previous.result, transactionId: requestedTransactionId, productId: requestedProductId, verified: previous.verified === true };
      if (typeof previous.gemAmount === "number") return { success: true, transactionId: requestedTransactionId,
        productId: requestedProductId, gemsGranted: previous.gemAmount, verified: previous.verified === true };
    }
    const pack = await findGemPackByProductId(requestedProductId);
    const offer = pack ? null : Object.values(await getOffersCatalog()).find(entry => entry.productId === requestedProductId);
    if (!pack && !offer) throw new HttpsError("not-found", "Unknown productId.");
    const resolved = await resolveTransactionId(normalizedPlatform, receipt, transactionId, requestedProductId, uid);
    if (!resolved.transactionId || resolved.transactionId.includes("/") || resolved.transactionId.length > 256)
      throw new HttpsError("invalid-argument", "Invalid store transaction identifier.");
    if (offer) {
      const operationId = "iap-offer-" + createHash("sha256").update(normalizedPlatform + ":" + resolved.transactionId).digest("hex");
      const result = await fulfillOfferPurchase(uid, operationId, offer.offerId, {
        platform: normalizedPlatform, transactionId: resolved.transactionId,
        productId: requestedProductId, verified: resolved.verified,
      });
      return { ...result, transactionId: resolved.transactionId, productId: requestedProductId, verified: resolved.verified };
    }
    if (!pack) throw new HttpsError("not-found", "Unknown productId.");
    const db = admin.firestore();
    const economyRef = db.doc(`Players/${uid}/Economy/Stats`);
    const receiptRef = db.collection(`Players/${uid}/Receipts`).doc(`iap.${resolved.transactionId}`);
    const ledgerRef = db.collection("IapTransactions").doc(`${normalizedPlatform}.${resolved.transactionId}`);
    const result = {
      success: true, transactionId: resolved.transactionId, productId: pack.productId,
      iapId: pack.iapId, gemsGranted: pack.gemAmount, verified: resolved.verified,
    };
    return db.runTransaction(async transaction => {
      const [economySnap, receiptSnap, ledgerSnap] = await transaction.getAll(economyRef, receiptRef, ledgerRef);
      if (ledgerSnap.exists) {
        const previous = ledgerSnap.data()!;
        if (previous.uid !== uid || previous.productId !== pack.productId)
          throw new HttpsError("permission-denied", "Receipt belongs to another purchase or player.");
        return previous.result ?? { ...result, gemsGranted: previous.gemAmount ?? pack.gemAmount };
      }
      if (receiptSnap.exists) {
        const previous = receiptSnap.data()!;
        if (previous.productId !== pack.productId || previous.platform !== normalizedPlatform)
          throw new HttpsError("permission-denied", "Receipt does not match purchase.");
        transaction.set(ledgerRef, { uid, platform: normalizedPlatform, productId: pack.productId,
          transactionId: resolved.transactionId, result, verified: resolved.verified, grantApplied: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp() });
        return result;
      }
      if (!economySnap.exists) throw new HttpsError("failed-precondition", "Player economy data missing.");
      transaction.update(economyRef, { gems: admin.firestore.FieldValue.increment(pack.gemAmount), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      const entry = { uid, type: "iap", grantApplied: true, transactionId: resolved.transactionId, platform: normalizedPlatform,
        productId: pack.productId, iapId: pack.iapId, gemAmount: pack.gemAmount, verified: resolved.verified,
        result, createdAt: admin.firestore.FieldValue.serverTimestamp() };
      transaction.set(receiptRef, entry);
      transaction.set(ledgerRef, entry);
      return result;
    });
  },
);
