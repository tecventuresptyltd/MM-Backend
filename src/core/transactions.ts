import * as admin from "firebase-admin";
import { applyReceiptMetadata, ReceiptMetadata, sanitizeForFirestore } from "./idempotency.js";
import { runReadThenWrite } from "./tx.js";

const db = admin.firestore();

/**
 * A function that performs work within a Firestore transaction.
 * @param transaction The Firestore transaction object.
 * @returns A promise that resolves with the result of the operation.
 */
export type TransactionalWork<T> = (transaction: admin.firestore.Transaction) => Promise<T>;

/**
 * Runs a Firestore transaction and writes a receipt upon successful completion.
 *
 * @param {string} uid The user's unique ID.
 * @param {string} opId The idempotent operation ID.
 * @param {string} reason A description of the operation.
 * @param {TransactionalWork<T>} work The function to execute within the transaction.
 * @returns {Promise<T>} The result of the transactional work.
 */
const receiptCollection = (uid: string) =>
  db.collection("Players").doc(uid).collection("Receipts");

export async function runTransactionWithReceipt<T>(
  uid: string,
  opId: string,
  reason: string,
  work: TransactionalWork<T>,
  metadata?: ReceiptMetadata,
): Promise<T> {
  const receiptRef = receiptCollection(uid).doc(opId);

  try {
    const result = await db.runTransaction(async (transaction) => {
      const workResult = await work(transaction);
      const sanitisedResult = sanitizeForFirestore(workResult);

      // Write the success receipt within the same transaction
      transaction.set(
        receiptRef,
        applyReceiptMetadata(
          {
            opId,
            status: "completed",
            reason,
            result: sanitisedResult,
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          metadata,
        ),
      );

      return workResult;
    });

    return result;
  } catch (error) {
    // If the transaction fails, write a failure receipt for auditing.
    await receiptRef.set(
      applyReceiptMetadata(
        {
          opId,
          status: "failed",
          reason,
          error: (error as Error).message,
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        metadata,
      ),
    );
    throw error; // Re-throw the original error
  }
}

export async function runReadThenWriteWithReceipt<TReads, TResult>(
  uid: string,
  opId: string,
  reason: string,
  readPhase: (transaction: admin.firestore.Transaction) => Promise<TReads>,
  writePhase: (
    transaction: admin.firestore.Transaction,
    reads: TReads,
  ) => Promise<TResult>,
  metadata?: ReceiptMetadata,
): Promise<TResult> {
  const receiptRef = receiptCollection(uid).doc(opId);

  try {
    const result = await runReadThenWrite(
      db,
      async (transaction) => readPhase(transaction),
      async (transaction, reads) => {
        const workResult = await writePhase(transaction, reads);
        const sanitisedResult = sanitizeForFirestore(workResult);
        transaction.set(
          receiptRef,
          applyReceiptMetadata(
            {
              opId,
              status: "completed",
              reason,
              result: sanitisedResult,
              completedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            metadata,
          ),
        );
        return workResult;
      },
    );

    return result;
  } catch (error) {
    await receiptRef.set(
      applyReceiptMetadata(
        {
          opId,
          status: "failed",
          reason,
          error: (error as Error).message,
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        metadata,
      ),
    );
    throw error;
  }
}
