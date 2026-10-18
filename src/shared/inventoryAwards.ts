import * as admin from "firebase-admin";
import { db } from "./firestore.js";
import { resolveInventoryContext } from "./inventory.js";
import { resolveSkuOrThrow } from "../core/config.js";
import {
  createTxInventorySummaryState,
  createTxSkuDocState,
  txIncSkuQty,
  txUpdateInventorySummary,
  TxInventorySummaryState,
  TxSkuDocState,
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

/**
 * Everything `applyInventoryGrants` needs, captured during the read phase so the
 * write phase issues zero reads. Firestore requires all reads in a transaction to
 * happen before any write, and `runReadThenWrite` enforces that in dev.
 */
export interface InventoryGrantPlan {
  grants: InventoryGrant[];
  summaryState: TxInventorySummaryState;
  skuStates: TxSkuDocState[];
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

const isCosmeticState = async (state: TxSkuDocState, skuId: string): Promise<boolean> => {
  if (state.type) {
    return state.type === "cosmetic";
  }
  const sku = await resolveSkuOrThrow(skuId);
  return sku?.type === "cosmetic";
};

const dropOwnedCosmetics = async (
  grants: InventoryGrant[],
  skuStates: TxSkuDocState[],
): Promise<{ grants: InventoryGrant[]; skuStates: TxSkuDocState[] }> => {
  const keptGrants: InventoryGrant[] = [];
  const keptStates: TxSkuDocState[] = [];
  const grantedCosmetics = new Set<string>();

  for (let i = 0; i < grants.length; i += 1) {
    const grant = grants[i];
    const state = skuStates[i];
    if (await isCosmeticState(state, grant.skuId)) {
      if (Number(state.quantity ?? 0) > 0 || grantedCosmetics.has(grant.skuId)) {
        continue;
      }
      grantedCosmetics.add(grant.skuId);
      keptGrants.push({ skuId: grant.skuId, quantity: 1 });
    } else {
      keptGrants.push(grant);
    }
    keptStates.push(state);
  }

  return { grants: keptGrants, skuStates: keptStates };
};

export const readOwnedSkuIds = async (
  uid: string,
  skuIds: string[],
  transaction?: FirebaseFirestore.Transaction,
): Promise<Set<string>> => {
  const owned = new Set<string>();
  const uniqueIds = [...new Set(skuIds.filter((id) => typeof id === "string" && id.trim()))];
  if (uniqueIds.length === 0) {
    return owned;
  }
  const inventoryCtx = resolveInventoryContext(uid);
  const refs = uniqueIds.map((id) => inventoryCtx.inventoryCollection.doc(id));
  const snaps = transaction ? await transaction.getAll(...refs) : await db.getAll(...refs);
  snaps.forEach((snap, idx) => {
    const data = snap.data() ?? {};
    if (Number(data.quantity ?? data.qty ?? 0) > 0) {
      owned.add(uniqueIds[idx]);
    }
  });
  return owned;
};

/**
 * READ PHASE. Loads the inventory summary and every target SKU doc up front.
 * Safe to call alongside other reads; performs no writes.
 */
export const prepareInventoryGrants = async (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  grants: InventoryGrant[],
): Promise<InventoryGrantPlan> => {
  const normalised = grants
    .map((grant) => normaliseGrant(grant))
    .filter((grant): grant is InventoryGrant => Boolean(grant));

  const inventoryCtx = resolveInventoryContext(uid);

  if (normalised.length === 0) {
    return {
      grants: [],
      summaryState: createTxInventorySummaryState(inventoryCtx.summaryRef),
      skuStates: [],
    };
  }

  const summarySnap = await transaction.get(inventoryCtx.summaryRef);
  const summaryState = createTxInventorySummaryState(inventoryCtx.summaryRef, summarySnap);

  const skuRefs = normalised.map((grant) =>
    inventoryCtx.inventoryCollection.doc(grant.skuId)
  );
  const skuSnaps = await Promise.all(skuRefs.map((ref) => transaction.get(ref)));
  const skuStates = skuSnaps.map((snap, idx) =>
    createTxSkuDocState(db, uid, normalised[idx].skuId, snap)
  );

  const filtered = await dropOwnedCosmetics(normalised, skuStates);

  return { grants: filtered.grants, summaryState, skuStates: filtered.skuStates };
};

/**
 * WRITE PHASE. Applies a plan produced by `prepareInventoryGrants`. Issues no reads.
 */
export const applyInventoryGrants = async (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  plan: InventoryGrantPlan,
  options?: { timestamp?: FirebaseFirestore.FieldValue },
): Promise<InventoryGrantResult[]> => {
  if (plan.grants.length === 0) {
    return [];
  }

  const summaryDelta: Record<string, number> = {};
  const timestamp = options?.timestamp ?? admin.firestore.FieldValue.serverTimestamp();
  const results: InventoryGrantResult[] = [];

  for (let i = 0; i < plan.grants.length; i += 1) {
    const grant = plan.grants[i];
    const skuState = plan.skuStates[i];
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
      state: plan.summaryState,
      timestamp,
    });
  }

  return results;
};

/**
 * Grants one or more SKU quantities inside the current transaction.
 * Also keeps the player's inventory summary in sync.
 *
 * NOTE: this reads *and* writes, so it must be called before any other write in
 * the transaction. Callers that already have a read/write split (see
 * `runReadThenWrite`) should use `prepareInventoryGrants` + `applyInventoryGrants`
 * instead.
 */
export const grantInventoryRewards = async (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  grants: InventoryGrant[],
  options?: { timestamp?: FirebaseFirestore.FieldValue },
): Promise<InventoryGrantResult[]> => {
  const plan = await prepareInventoryGrants(transaction, uid, grants);
  return applyInventoryGrants(transaction, uid, plan, options);
};
