import * as admin from "firebase-admin";
import {
  resolveInventoryContext,
  mergeInventorySummary,
  summaryAdjustmentFromSku,
  writeInventorySummary,
  InventorySummaryData,
  SummaryAdjustment,
} from "../shared/inventory.js";
import { resolveSkuOrThrow } from "../core/config.js";

const normaliseQuantity = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
};

const ensureSkuId = (skuId: string): string => {
  if (typeof skuId !== "string") {
    throw new Error("skuId must be a string.");
  }
  const trimmed = skuId.trim();
  if (!trimmed) {
    throw new Error("skuId must be a non-empty string.");
  }
  return trimmed;
};

const getSkuDocRef = (
  db: FirebaseFirestore.Firestore,
  uid: string,
  skuId: string,
): FirebaseFirestore.DocumentReference =>
  db.doc(`Players/${uid}/Inventory/${skuId}`);

export interface TxSkuMutationContext {
  quantity?: number;
  exists?: boolean;
  createdAt?: unknown;
  timestamp?: FirebaseFirestore.FieldValue;
}

export interface GetSkuQtyTxOptions {
  capture?: (context: TxSkuMutationContext) => void;
}

export interface TxSkuDocState {
  ref: FirebaseFirestore.DocumentReference;
  quantity: number;
  exists: boolean;
  createdAt?: unknown;
}

export interface TxInventorySummaryState {
  ref: FirebaseFirestore.DocumentReference;
  data?: InventorySummaryData;
}

export const createTxSkuDocState = (
  db: FirebaseFirestore.Firestore,
  uid: string,
  skuId: string,
  snapshot?: FirebaseFirestore.DocumentSnapshot,
): TxSkuDocState => {
  const resolvedSkuId = ensureSkuId(skuId);
  const ref = getSkuDocRef(db, uid, resolvedSkuId);
  const data = snapshot?.data() ?? {};
  return {
    ref,
    quantity: snapshot ? normaliseQuantity(data.quantity ?? data.qty) : 0,
    exists: Boolean(snapshot?.exists),
    createdAt: data.createdAt,
  };
};

export const createTxInventorySummaryState = (
  summaryRef: FirebaseFirestore.DocumentReference,
  snapshot?: FirebaseFirestore.DocumentSnapshot,
): TxInventorySummaryState => ({
  ref: summaryRef,
  data: snapshot?.exists ? (snapshot.data() as InventorySummaryData) : undefined,
});

interface InventoryMutationOptions {
  transaction?: FirebaseFirestore.Transaction;
  timestamp?: FirebaseFirestore.FieldValue;
  currentSummary?: InventorySummaryData | null | undefined;
}

interface InventoryReadOptions {
  transaction?: FirebaseFirestore.Transaction;
}

const runWithTransaction = async <T>(
  db: FirebaseFirestore.Firestore,
  options: InventoryMutationOptions | undefined,
  handler: (
    transaction: FirebaseFirestore.Transaction,
    timestamp: FirebaseFirestore.FieldValue,
  ) => Promise<T>,
): Promise<T> => {
  const timestamp =
    options?.timestamp ?? admin.firestore.FieldValue.serverTimestamp();
  if (options?.transaction) {
    return handler(options.transaction, timestamp);
  }
  return db.runTransaction(async (transaction) => handler(transaction, timestamp));
};

export async function getSkuQty(
  db: FirebaseFirestore.Firestore,
  uid: string,
  skuId: string,
  options?: InventoryReadOptions,
): Promise<number> {
  const resolvedSkuId = ensureSkuId(skuId);
  const docRef = getSkuDocRef(db, uid, resolvedSkuId);
  if (options?.transaction) {
    return getSkuQtyTx(options.transaction, db, uid, resolvedSkuId);
  }
  const snapshot = await docRef.get();
  if (!snapshot.exists) {
    return 0;
  }
  const data = snapshot.data() ?? {};
  return normaliseQuantity(data.quantity ?? data.qty);
}

export async function getSkuQtyTx(
  transaction: FirebaseFirestore.Transaction,
  db: FirebaseFirestore.Firestore,
  uid: string,
  skuId: string,
  options?: GetSkuQtyTxOptions,
): Promise<number> {
  const resolvedSkuId = ensureSkuId(skuId);
  const docRef = getSkuDocRef(db, uid, resolvedSkuId);
  const snapshot = await transaction.get(docRef);
  const data = snapshot.data() ?? {};
  const quantity = normaliseQuantity(data.quantity ?? data.qty);
  if (options?.capture) {
    options.capture({
      quantity,
      exists: snapshot.exists,
      createdAt: data.createdAt,
    });
  }
  return quantity;
}

export async function incSkuQty(
  db: FirebaseFirestore.Firestore,
  uid: string,
  skuId: string,
  delta: number,
  options?: InventoryMutationOptions,
): Promise<{ previous: number; next: number }> {
  if (!Number.isFinite(delta) || delta <= 0) {
    throw new Error("incSkuQty requires a positive delta.");
  }
  const resolvedSkuId = ensureSkuId(skuId);
  const docRef = getSkuDocRef(db, uid, resolvedSkuId);
  return runWithTransaction(db, options, async (transaction, timestamp) => {
    const snapshot = await transaction.get(docRef);
    const data = snapshot.data() ?? {};
    const current = normaliseQuantity(data.quantity ?? data.qty);
    const result = await incSkuQtyTx(transaction, db, uid, resolvedSkuId, delta, {
      quantity: current,
      exists: snapshot.exists,
      createdAt: data.createdAt,
      timestamp,
    });
    return { previous: result.before, next: result.after };
  });
}

export async function decSkuQtyOrThrow(
  db: FirebaseFirestore.Firestore,
  uid: string,
  skuId: string,
  delta: number,
  options?: InventoryMutationOptions,
): Promise<{ previous: number; next: number }> {
  if (!Number.isFinite(delta) || delta <= 0) {
    throw new Error("decSkuQtyOrThrow requires a positive delta.");
  }
  const resolvedSkuId = ensureSkuId(skuId);
  const docRef = getSkuDocRef(db, uid, resolvedSkuId);
  return runWithTransaction(db, options, async (transaction, timestamp) => {
    const snapshot = await transaction.get(docRef);
    const data = snapshot.data() ?? {};
    const current = normaliseQuantity(data.quantity ?? data.qty);
    const result = await decSkuQtyOrThrowTx(transaction, db, uid, resolvedSkuId, delta, {
      quantity: current,
      exists: snapshot.exists,
      createdAt: data.createdAt,
      timestamp,
    });
    return { previous: result.before, next: result.after };
  });
}

export async function incSkuQtyTx(
  transaction: FirebaseFirestore.Transaction,
  db: FirebaseFirestore.Firestore,
  uid: string,
  skuId: string,
  delta: number,
  context?: TxSkuMutationContext,
): Promise<{ before: number; after: number }> {
  if (!Number.isFinite(delta) || delta <= 0) {
    throw new Error("incSkuQtyTx requires a positive delta.");
  }
  const resolvedSkuId = ensureSkuId(skuId);
  const ref = getSkuDocRef(db, uid, resolvedSkuId);
  let quantity = context?.quantity;
  let exists = context?.exists ?? false;
  let createdAt = context?.createdAt;
  if (quantity === undefined) {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data() ?? {};
    quantity = normaliseQuantity(data.quantity ?? data.qty);
    exists = snapshot.exists;
    createdAt = data.createdAt;
  }
  const timestamp =
    context?.timestamp ?? admin.firestore.FieldValue.serverTimestamp();
  const before = Math.max(0, Number(quantity ?? 0));
  const after = before + Math.floor(delta);
  const payload: Record<string, unknown> = {
    skuId: resolvedSkuId,
    quantity: after,
    qty: after,
    updatedAt: timestamp,
  };
  if (exists && createdAt !== undefined) {
    payload.createdAt = createdAt;
  } else {
    payload.createdAt = createdAt ?? timestamp;
  }

  transaction.set(ref, payload, { merge: true });
  return { before, after };
}

export async function decSkuQtyOrThrowTx(
  transaction: FirebaseFirestore.Transaction,
  db: FirebaseFirestore.Firestore,
  uid: string,
  skuId: string,
  delta: number,
  context?: TxSkuMutationContext,
): Promise<{ before: number; after: number }> {
  if (!Number.isFinite(delta) || delta <= 0) {
    throw new Error("decSkuQtyOrThrowTx requires a positive delta.");
  }
  const resolvedSkuId = ensureSkuId(skuId);
  const ref = getSkuDocRef(db, uid, resolvedSkuId);
  let quantity = context?.quantity;
  let exists = context?.exists ?? false;
  let createdAt = context?.createdAt;
  if (quantity === undefined) {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data() ?? {};
    quantity = normaliseQuantity(data.quantity ?? data.qty);
    exists = snapshot.exists;
    createdAt = data.createdAt;
  }
  const before = Math.max(0, Number(quantity ?? 0));
  if (before < delta) {
    throw new Error(`Insufficient quantity for ${resolvedSkuId}.`);
  }
  const timestamp =
    context?.timestamp ?? admin.firestore.FieldValue.serverTimestamp();
  const after = before - Math.floor(delta);
  const payload: Record<string, unknown> = {
    skuId: resolvedSkuId,
    quantity: after,
    qty: after,
    updatedAt: timestamp,
  };
  if (exists && createdAt !== undefined) {
    payload.createdAt = createdAt;
  } else {
    payload.createdAt = createdAt ?? timestamp;
  }

  transaction.set(ref, payload, { merge: true });
  return { before, after };
}

export async function updateInventorySummary(
  db: FirebaseFirestore.Firestore,
  uid: string,
  changes: Record<string, number>,
  options?: InventoryMutationOptions,
): Promise<void> {
  if (!changes || Object.keys(changes).length === 0) {
    return;
  }

  const adjustments = (
    await Promise.all(
      Object.entries(changes).map(async ([rawSkuId, rawDelta]) => {
        const delta = Number(rawDelta);
        if (!Number.isFinite(delta) || delta === 0) {
          return null;
        }
        const skuId = ensureSkuId(rawSkuId);
        const sku = await resolveSkuOrThrow(skuId);
        return summaryAdjustmentFromSku(skuId, sku, delta);
      }),
    )
  ).filter((entry): entry is SummaryAdjustment => entry !== null);

  if (adjustments.length === 0) {
    return;
  }

  await runWithTransaction(db, options, async (transaction, timestamp) => {
    const ctx = resolveInventoryContext(uid);
    const summaryRef = ctx.summaryRef;
    let currentSummary: InventorySummaryData | undefined;
    if (options && Object.prototype.hasOwnProperty.call(options, "currentSummary")) {
      currentSummary = options.currentSummary ?? undefined;
    } else {
      const snapshot = await transaction.get(summaryRef);
      currentSummary = snapshot.exists
        ? (snapshot.data() as InventorySummaryData)
        : undefined;
    }
    const merged = mergeInventorySummary(currentSummary, adjustments);
    writeInventorySummary(transaction, summaryRef, merged, timestamp);
  });
}

interface TxIncSkuQtyOptions {
  state: TxSkuDocState;
  timestamp?: FirebaseFirestore.FieldValue;
}

export async function txIncSkuQty(
  transaction: FirebaseFirestore.Transaction,
  db: FirebaseFirestore.Firestore,
  uid: string,
  skuId: string,
  delta: number,
  options: TxIncSkuQtyOptions,
): Promise<{ previous: number; next: number }> {
  if (!Number.isFinite(delta) || delta <= 0) {
    throw new Error("txIncSkuQty requires a positive delta.");
  }
  if (!options?.state) {
    throw new Error("txIncSkuQty requires a preloaded state.");
  }

  const resolvedSkuId = ensureSkuId(skuId);
  const timestamp =
    options.timestamp ?? admin.firestore.FieldValue.serverTimestamp();
  const state = options.state;
  const ref =
    state.ref ?? getSkuDocRef(db, uid, resolvedSkuId);

  const previous = Math.max(0, Number(state.quantity ?? 0));
  const next = previous + Math.floor(delta);

  const payload: Record<string, unknown> = {
    skuId: resolvedSkuId,
    quantity: next,
    qty: next,
    updatedAt: timestamp,
  };

  if (state.exists && state.createdAt !== undefined) {
    payload.createdAt = state.createdAt;
  } else {
    payload.createdAt = timestamp;
  }

  transaction.set(ref, payload, { merge: true });

  state.ref = ref;
  state.quantity = next;
  state.exists = true;
  if (state.createdAt === undefined || state.createdAt === null) {
    state.createdAt = payload.createdAt;
  }

  return { previous, next };
}

interface TxUpdateInventorySummaryOptions {
  state: TxInventorySummaryState;
  timestamp?: FirebaseFirestore.FieldValue;
}

export async function txUpdateInventorySummary(
  transaction: FirebaseFirestore.Transaction,
  db: FirebaseFirestore.Firestore,
  uid: string,
  changes: Record<string, number>,
  options: TxUpdateInventorySummaryOptions,
): Promise<void> {
  if (!changes || Object.keys(changes).length === 0) {
    return;
  }
  if (!options?.state) {
    throw new Error("txUpdateInventorySummary requires a preloaded state.");
  }

  const timestamp =
    options.timestamp ?? admin.firestore.FieldValue.serverTimestamp();
  const adjustments = (
    await Promise.all(
      Object.entries(changes).map(async ([rawSkuId, rawDelta]) => {
        const delta = Number(rawDelta);
        if (!Number.isFinite(delta) || delta === 0) {
          return null;
        }
        const skuId = ensureSkuId(rawSkuId);
        const sku = await resolveSkuOrThrow(skuId);
        return summaryAdjustmentFromSku(skuId, sku, delta);
      }),
    )
  ).filter((entry): entry is SummaryAdjustment => entry !== null);

  if (adjustments.length === 0) {
    return;
  }

  const mergedSummary = mergeInventorySummary(options.state.data, adjustments);
  writeInventorySummary(transaction, options.state.ref, mergedSummary, timestamp);
  options.state.data = mergedSummary;
}
