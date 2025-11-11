import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./firestore";

type ReceiptMetadata = Record<string, unknown> | undefined;

/**
 * Ensures that an operation is idempotent by reserving a receipt document.
 * If the receipt already exists, the operation is treated as a no-op.
 *
 * @param uid     The player's UID.
 * @param opId    The client-supplied idempotency key.
 * @param meta    Optional metadata to persist alongside the receipt.
 */
export async function ensureOp(uid: string, opId: string, meta?: ReceiptMetadata): Promise<boolean> {
  if (!opId || typeof opId !== "string") {
    throw new HttpsError("invalid-argument", "opId must be a non-empty string.");
  }

  const receiptRef = db.collection("Players").doc(uid).collection("Receipts").doc(opId);
  try {
    await receiptRef.create({
      opId,
      status: "reserved",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      ...(meta ?? {}),
    });
    return true;
  } catch (error: unknown) {
    const code = (error as { code?: number }).code;
    if (code === 6) {
      // ALREADY_EXISTS → caller is retrying a completed/reserved operation.
      return false;
    }
    throw new HttpsError(
      "internal",
      `Failed to create idempotency receipt for opId: ${opId}`,
      error,
    );
  }
}
