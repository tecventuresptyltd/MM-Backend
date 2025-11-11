import * as admin from "firebase-admin";

const db = admin.firestore();

export interface ReceiptMetadata {
  kind?: string;
  inputsHash?: string;
}

const receiptCollection = (uid: string) =>
  db.collection("Players").doc(uid).collection("Receipts");

export const applyReceiptMetadata = <T extends Record<string, unknown>>(
  target: T,
  metadata?: ReceiptMetadata,
): T => {
  if (!metadata) {
    return target;
  }
  if (metadata.kind) {
    (target as Record<string, unknown>).kind = metadata.kind;
  }
  if (metadata.inputsHash) {
    (target as Record<string, unknown>).inputsHash = metadata.inputsHash;
  }
  return target;
};

/**
 * Checks for an existing receipt. Returns the stored result when the
 * operation was already completed, throws if it is currently in progress,
 * otherwise returns null so the caller can continue.
 */
export async function checkIdempotency(uid: string, opId: string): Promise<unknown | null> {
  const receiptRef = receiptCollection(uid).doc(opId);
  const snapshot = await receiptRef.get();

  if (!snapshot.exists) {
    return null;
  }

  const receipt = snapshot.data();
  if (receipt?.status === "completed") {
    console.log(`[Idempotency] Returning cached result for opId=${opId}`);
    return receipt.result ?? null;
  }

  if (receipt?.status === "in_progress" || receipt?.status === "reserved") {
    throw new Error(`Operation ${opId} is already in progress.`);
  }

  return null;
}

/**
 * Marks a receipt as in-progress, overwriting any prior reserved state.
 */
export async function createInProgressReceipt(
  uid: string,
  opId: string,
  reason: string,
  metadata?: ReceiptMetadata,
): Promise<void> {
  await receiptCollection(uid)
    .doc(opId)
    .set(
      applyReceiptMetadata(
        {
          opId,
          status: "in_progress",
          reason,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        metadata,
      ),
    );
}

/**
 * Finalises a receipt by storing the result payload.
 */
export async function completeOperation(
  uid: string,
  opId: string,
  result: unknown,
  metadata?: ReceiptMetadata,
): Promise<void> {
  await receiptCollection(uid)
    .doc(opId)
    .set(
      applyReceiptMetadata(
        {
          status: "completed",
          result,
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        metadata,
      ),
      { merge: true },
    );
}
