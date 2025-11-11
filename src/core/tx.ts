import { firestore } from "firebase-admin";

type Tx = firestore.Transaction;

const PHASE_SYMBOL = Symbol("runReadThenWrite.phase");
const ORIGINAL_GET_SYMBOL = Symbol("runReadThenWrite.originalGet");

type GuardedTransaction = Tx & {
  [PHASE_SYMBOL]?: "read" | "write";
  [ORIGINAL_GET_SYMBOL]?: Tx["get"];
};

const isDevelopment = (): boolean => {
  const env = process.env.NODE_ENV;
  return !env || env.toLowerCase() !== "production";
};

const ensureGetGuard = (transaction: Tx): void => {
  if (!isDevelopment()) {
    return;
  }

  const guarded = transaction as GuardedTransaction;
  if (guarded[ORIGINAL_GET_SYMBOL]) {
    return;
  }

  const originalGet = transaction.get.bind(transaction);
  guarded[ORIGINAL_GET_SYMBOL] = originalGet;

  (transaction as GuardedTransaction).get = (async (
    ...args: Parameters<Tx["get"]>
  ) => {
    if ((transaction as GuardedTransaction)[PHASE_SYMBOL] === "write") {
      throw new Error(
        "Do not call tx.get in writePhase—move the read to readPhase.",
      );
    }
    return originalGet(...args);
  }) as Tx["get"];
};

export async function runReadThenWrite<TReads, TResult = void>(
  db: firestore.Firestore,
  readPhase: (tx: Tx) => Promise<TReads>,
  writePhase: (tx: Tx, reads: TReads) => Promise<TResult>,
): Promise<TResult> {
  return await db.runTransaction(async (transaction) => {
    ensureGetGuard(transaction);
    (transaction as GuardedTransaction)[PHASE_SYMBOL] = "read";
    const reads = await readPhase(transaction);
    (transaction as GuardedTransaction)[PHASE_SYMBOL] = "write";
    try {
      return await writePhase(transaction, reads);
    } finally {
      (transaction as GuardedTransaction)[PHASE_SYMBOL] = undefined;
      if (isDevelopment()) {
        const guarded = transaction as GuardedTransaction;
        if (guarded[ORIGINAL_GET_SYMBOL]) {
          guarded.get = guarded[ORIGINAL_GET_SYMBOL]!;
        }
      }
    }
  }) as Promise<TResult>;
}

