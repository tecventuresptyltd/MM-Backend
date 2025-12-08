import * as admin from "firebase-admin";
import { db } from "./firestore.js";
import { resolveInventoryContext } from "./inventory.js";
import {
  createTxInventorySummaryState,
  createTxSkuDocState,
  txIncSkuQty,
  txUpdateInventorySummary,
} from "../inventory/index.js";

export interface InventoryGrant {
  skuId: string;
  quantity: number;
}

export interface InventoryGrantResult {
  skuId: string;
  quantity: number;
  previous: number;
  next: number;
}

const normaliseGrant = (grant: InventoryGrant): InventoryGrant | null => {
  if (!grant || typeof grant.skuId !== "string") {
    return null;
  }
  const skuId = grant.skuId.trim();
  if (!skuId) {
    return null;
  }
  const quantity = Math.floor(Number(grant.quantity ?? 0));
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return null;
  }
  return { skuId, quantity };
};

/**
 * Grants one or more SKU quantities inside the current transaction.
 * Also keeps the player's inventory summary in sync.
 */
export const grantInventoryRewards = async (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  grants: InventoryGrant[],
  options?: { timestamp?: FirebaseFirestore.FieldValue },
): Promise<InventoryGrantResult[]> => {
  const normalised = grants
    .map((grant) => normaliseGrant(grant))
    .filter((grant): grant is InventoryGrant => Boolean(grant));

  if (normalised.length === 0) {
    return [];
  }

  const inventoryCtx = resolveInventoryContext(uid);
  const summarySnap = await transaction.get(inventoryCtx.summaryRef);
  const summaryState = createTxInventorySummaryState(inventoryCtx.summaryRef, summarySnap);

  // Preload all SKU docs before performing any writes to satisfy transaction ordering.
  const skuRefs = normalised.map((grant) =>
    inventoryCtx.inventoryCollection.doc(grant.skuId)
  );
  const skuSnaps = await Promise.all(skuRefs.map((ref) => transaction.get(ref)));
  const skuStates = skuSnaps.map((snap, idx) =>
    createTxSkuDocState(db, uid, normalised[idx].skuId, snap)
  );

  const summaryDelta: Record<string, number> = {};
  const timestamp = options?.timestamp ?? admin.firestore.FieldValue.serverTimestamp();
  const results: InventoryGrantResult[] = [];

  for (let i = 0; i < normalised.length; i += 1) {
    const grant = normalised[i];
    const skuState = skuStates[i];
    const adjustment = await txIncSkuQty(transaction, db, uid, grant.skuId, grant.quantity, {
      state: skuState,
      timestamp,
    });
    summaryDelta[grant.skuId] = (summaryDelta[grant.skuId] ?? 0) + grant.quantity;
    results.push({
      skuId: grant.skuId,
      quantity: grant.quantity,
      previous: adjustment.previous,
      next: adjustment.next,
    });
  }

  if (Object.keys(summaryDelta).length > 0) {
    await txUpdateInventorySummary(transaction, db, uid, summaryDelta, {
      state: summaryState,
      timestamp,
    });
  }

  return results;
};
