import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import {
  getOffersCatalog,
  listSkusForItem,
  resolveSkuOrThrow,
} from "../core/config.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runReadThenWriteWithReceipt } from "../core/transactions.js";
import { REGION } from "../shared/region.js";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { db } from "../shared/firestore.js";
import {
  Offer,
  OfferEntitlement,
  ItemSku,
  ActiveOffers,
  ActiveSpecialOffer,
  MainOffer,
  OfferFlowState,
} from "../shared/types.js";
import {
  incSkuQtyTx,
  txUpdateInventorySummary,
  createTxInventorySummaryState,
  TxInventorySummaryState,
  TxSkuMutationContext,
} from "../inventory/index.js";
import { resolveInventoryContext } from "../shared/inventory.js";
import {
  activeOffersRef,
  offerStateRef,
  normaliseActiveOffers,
  normaliseOfferFlowState,
  pruneExpiredSpecialOffers,
  POST_PURCHASE_DELAY_MS,
  resolveNextTierOnPurchase,
} from "./offerState.js";
import { scheduleOfferTransition, cancelScheduledTransition } from "./offerScheduler.js";

interface PurchaseOfferRequest {
  opId: unknown;
  offerId: unknown;
  isIapPurchase?: boolean;
}

interface GrantSummary {
  type: OfferEntitlement["type"];
  skuId?: string;
  itemId?: string;
  quantity: number;
  total?: number;
  alreadyOwned?: boolean;
}

interface PurchaseOfferResult {
  success: true;
  opId: string;
  offerId: string;
  currency: string;
  amount: number;
  grants: GrantSummary[];
  balances: { gems?: number; coins?: number; };
  newTier?: number;
  nextOfferAt?: number;
  category?: string;
}

interface ResolvedSkuEntitlement {
  entitlement: OfferEntitlement;
  sku: ItemSku | null;
  quantity: number;
}

type GrantPlan =
  | { kind: "currency"; summary: GrantSummary; }
  | { kind: "sku"; sku: ItemSku; quantity: number; entitlementType: OfferEntitlement["type"]; context: TxSkuMutationContext; };

type ActiveOfferSlot =
  | { kind: "rotating"; index: number }
  | { kind: "special"; index: number };

interface RotatingOfferUpdate {
  index: number;
  category: string;
  nextOfferAt: number;
}

interface ActiveOfferUpdate {
  slot: ActiveOfferSlot["kind"];
  special?: ActiveSpecialOffer[];
  rotatingUpdate?: RotatingOfferUpdate;
  specialIndex?: number;
}

interface PurchaseOfferReadState {
  timestamp: FirebaseFirestore.FieldValue;
  economyRef: FirebaseFirestore.DocumentReference;
  charge: { currency: "gems" | "coins" | null; amount: number };
  balances: { gemsBefore: number; gemsAfter: number; coinsBefore: number; coinsAfter: number; };
  grantPlans: GrantPlan[];
  summaryState: TxInventorySummaryState;
  activeRef: FirebaseFirestore.DocumentReference;
  stateRef: FirebaseFirestore.DocumentReference;
  activeUpdate: ActiveOfferUpdate;
  activeUpdatedAt: number;
  flowState: OfferFlowState;
  isIapPurchase: boolean;
  offerId: string;
}

const ensureOfferRequest = (request: PurchaseOfferRequest): {
  opId: string; offerId: string; isIapPurchase: boolean;
} => {
  const { opId, offerId, isIapPurchase } = request;
  if (typeof opId !== "string" || !opId.trim()) throw new HttpsError("invalid-argument", "opId must be a non-empty string.");
  if (typeof offerId !== "string" || !offerId.trim()) throw new HttpsError("invalid-argument", "offerId must be a non-empty string.");
  return { opId: opId.trim(), offerId: offerId.trim(), isIapPurchase: Boolean(isIapPurchase) };
};

const ensureOffer = async (offerId: string): Promise<Offer> => {
  const offers = await getOffersCatalog();
  const offer = offers[offerId];
  if (!offer) throw new HttpsError("not-found", `Offer ${offerId} not found in catalog.`);
  if (!Array.isArray(offer.entitlements) || offer.entitlements.length === 0) throw new HttpsError("failed-precondition", `Offer ${offerId} has no entitlements.`);
  return offer;
};

const isIapOffer = (offer: Offer): boolean => Boolean(offer.productId) && offer.currency === "USD";
const isMainSlotOffer = (offer: Offer): boolean => {
  const type = offer.offerType ?? -1;
  return type >= 0 && type <= 8;
};

const resolveEntitlementSku = async (entitlement: OfferEntitlement): Promise<ItemSku | null> => {
  if (entitlement.type === "gems") return null;
  let targetId = typeof entitlement.id === "string" ? entitlement.id.trim() : "";
  if (!targetId) throw new HttpsError("failed-precondition", "Offer entitlement is missing an id.");
  
  if (targetId.startsWith("crt_")) {
    const legacyCrateMappings: Record<string, string> = {
      crt_ayvncyt0: "sku_zz3twgp0wx",
      crt_vzqgtd2s: "sku_72wnqwtfmx",
      crt_7y8a6hca: "sku_e8e7jeba7v",
      crt_76ar1k2x: "sku_n9hsc0wxxk",
      crt_y8fywbrs: "sku_kgkjadrd79"
    };
    if (legacyCrateMappings[targetId]) {
      targetId = legacyCrateMappings[targetId];
    }
  }

  if (targetId.startsWith("sku_")) return await resolveSkuOrThrow(targetId);
  const skus = await listSkusForItem(targetId);
  if (skus.length === 0) throw new HttpsError("failed-precondition", `Offer entitlement references unknown item ${targetId}.`);
  return skus[0];
};

const resolveEntitlements = async (offer: Offer): Promise<ResolvedSkuEntitlement[]> => {
  const resolved: ResolvedSkuEntitlement[] = [];
  for (const entitlement of offer.entitlements) {
    const quantity = Number(entitlement.quantity ?? 0);
    if (!Number.isFinite(quantity) || quantity <= 0) throw new HttpsError("failed-precondition", "Offer amount must be positive.");
    const sku = await resolveEntitlementSku(entitlement);
    if (sku && sku.stackable === false && quantity > 1) throw new HttpsError("failed-precondition", `Entitlement for ${sku.skuId} cannot grant quantity ${quantity}; item is not stackable.`);
    resolved.push({ entitlement, sku, quantity });
  }
  return resolved;
};

const resolveItemType = (sku: ItemSku): ItemSku["type"] => {
  if (sku.type) return sku.type;
  throw new HttpsError("failed-precondition", `SKU ${sku.skuId} is missing type metadata.`);
};

const resolveActiveOfferSlot = (
  offerId: string,
  state: ActiveOffers,
  now: number,
): ActiveOfferSlot | null => {
  if (state.rotating) {
    const i = state.rotating.findIndex(r => r.offerId === offerId);
    if (i >= 0) {
      if (state.rotating[i].state === "active" && state.rotating[i].expiresAt > now) {
        return { kind: "rotating", index: i };
      }
      return null;
    }
  }

  const specialIndex = state.special.findIndex((entry) => entry.offerId === offerId && entry.expiresAt > now);
  if (specialIndex >= 0) return { kind: "special", index: specialIndex };

  return null;
};

const ensureActiveOfferUpdate = (
  offerId: string,
  state: ActiveOffers,
  flowState: OfferFlowState,
  now: number,
  isIapPurchase: boolean,
  prunedSpecial?: ActiveSpecialOffer[],
): ActiveOfferUpdate => {
  const slot = resolveActiveOfferSlot(offerId, state, now);
  if (!slot) throw new HttpsError("failed-precondition", `Offer ${offerId} is not active for this player.`);

  if (slot.kind === "special") {
    const base = prunedSpecial ?? state.special;
    const filtered = base.filter((_, index) => index !== slot.index);
    return { slot: "special", special: filtered, specialIndex: slot.index };
  }

  let rotatingUpdate: RotatingOfferUpdate | undefined;
  if (slot.kind === "rotating" && state.rotating) {
    const rOffer = state.rotating[slot.index];
    rotatingUpdate = {
      index: slot.index,
      category: rOffer.category ?? "unknown",
      nextOfferAt: now + POST_PURCHASE_DELAY_MS,
    };
  }

  const update: ActiveOfferUpdate = { slot: slot.kind };
  if (prunedSpecial && prunedSpecial.length !== state.special.length) update.special = prunedSpecial;
  if (rotatingUpdate) update.rotatingUpdate = rotatingUpdate;

  return update;
};

export const purchaseOffer = onCall(callableOptions({ minInstances: getMinInstances(false), memory: "512MiB", cpu: 1, concurrency: 80 }, true), async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "User must be authenticated.");

  const { opId, offerId, isIapPurchase } = ensureOfferRequest(request.data as PurchaseOfferRequest);

  const cached = await checkIdempotency(uid, opId);
  if (cached) return cached as PurchaseOfferResult;

  await createInProgressReceipt(uid, opId, "purchaseOffer");

  const offer = await ensureOffer(offerId);
  const resolvedEntitlements = await resolveEntitlements(offer);

  const shouldProgressLadder = isIapPurchase && isIapOffer(offer);

  const inventoryCtx = resolveInventoryContext(uid);
  const summaryRef = inventoryCtx.summaryRef;

  const result = await runReadThenWriteWithReceipt<PurchaseOfferReadState, PurchaseOfferResult>(
    uid,
    opId,
    `purchaseOffer.${offerId}`,
    async (transaction) => {
      const nowMillis = Date.now();
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      const economyRef = db.doc(`Players/${uid}/Economy/Stats`);
      const activeRef = activeOffersRef(uid);
      const stateRef = offerStateRef(uid);

      const [statsSnap, activeSnap, flowStateSnap] = await Promise.all([
        transaction.get(economyRef),
        transaction.get(activeRef),
        transaction.get(stateRef),
      ]);

      if (!statsSnap.exists) throw new HttpsError("failed-precondition", "Economy profile missing for player.");
      if (!activeSnap.exists) throw new HttpsError("failed-precondition", "Active offers not initialized.");

      const activeState = normaliseActiveOffers(activeSnap.data());
      const flowState = normaliseOfferFlowState(flowStateSnap.data());
      const prunedSpecial = pruneExpiredSpecialOffers(activeState.special, nowMillis);

      const activeUpdate = ensureActiveOfferUpdate(
        offerId,
        { ...activeState, special: prunedSpecial },
        flowState,
        nowMillis,
        shouldProgressLadder,
        prunedSpecial,
      );

      const stats = statsSnap.data() ?? {};
      const gemsBefore = Number(stats.gems ?? 0);
      const coinsBefore = Number(stats.coins ?? 0);
      if (!Number.isFinite(gemsBefore) || !Number.isFinite(coinsBefore)) throw new HttpsError("failed-precondition", "Player balances are invalid.");

      const rawAmount = Number(offer.amount ?? 0);
      if (!Number.isFinite(rawAmount) || rawAmount < 0) throw new HttpsError("failed-precondition", "Offer amount must be a finite non-negative number.");

      const chargeAmount = Math.max(0, rawAmount);
      const rawCurrency = typeof offer.currency === "string" ? offer.currency.toLowerCase() : null;
      const chargeCurrency: "gems" | "coins" | null = rawCurrency === "gems" || rawCurrency === "coins" ? rawCurrency : null;

      let gemsAfter = gemsBefore;
      let coinsAfter = coinsBefore;

      if (!isIapOffer(offer)) {
        if (chargeCurrency === "gems" && chargeAmount > 0) {
          if (gemsBefore < chargeAmount) throw new HttpsError("resource-exhausted", "Insufficient gems for offer purchase.");
          gemsAfter -= chargeAmount;
        } else if (chargeCurrency === "coins" && chargeAmount > 0) {
          if (coinsBefore < chargeAmount) throw new HttpsError("resource-exhausted", "Insufficient coins for offer purchase.");
          coinsAfter -= chargeAmount;
        } else if (chargeAmount > 0 && chargeCurrency) {
          throw new HttpsError("failed-precondition", `Unsupported offer currency ${offer.currency}.`);
        }
      }

      const inventoryRefs = new Map<string, FirebaseFirestore.DocumentReference>();
      for (const entry of resolvedEntitlements) {
        if (entry.sku && !inventoryRefs.has(entry.sku.skuId)) {
          inventoryRefs.set(entry.sku.skuId, inventoryCtx.inventoryCollection.doc(entry.sku.skuId));
        }
      }

      const summarySnapPromise = transaction.get(summaryRef);
      const inventorySnapshots = inventoryRefs.size ? await transaction.getAll(...inventoryRefs.values()) : [];
      const summarySnap = await summarySnapPromise;

      const snapshotBySku = new Map<string, FirebaseFirestore.DocumentSnapshot>();
      let snapshotIndex = 0;
      for (const [skuId] of inventoryRefs) snapshotBySku.set(skuId, inventorySnapshots[snapshotIndex++] ?? null);

      const grantPlans: GrantPlan[] = [];
      for (const entry of resolvedEntitlements) {
        if (!entry.sku) {
          if (entry.entitlement.type === "gems") { gemsAfter += entry.quantity; grantPlans.push({ kind: "currency", summary: { type: "gems", quantity: entry.quantity } }); }
          else if (entry.entitlement.type === "coins") { coinsAfter += entry.quantity; grantPlans.push({ kind: "currency", summary: { type: "coins", quantity: entry.quantity } }); }
          else { grantPlans.push({ kind: "currency", summary: { type: entry.entitlement.type, quantity: entry.quantity } }); }
          continue;
        }
        const sku = entry.sku;
        const snapshot = snapshotBySku.get(sku.skuId);
        const data = snapshot?.data() ?? {};
        const parsedQty = Number(data.quantity ?? data.qty);
        const currentQty = Number.isFinite(parsedQty) && parsedQty > 0 ? Math.floor(parsedQty) : 0;
        if (sku.stackable === false && currentQty > 0) throw new HttpsError("failed-precondition", `SKU ${sku.skuId} already owned.`);

        grantPlans.push({
          kind: "sku", sku, quantity: entry.quantity, entitlementType: entry.entitlement.type,
          context: { quantity: currentQty, exists: snapshot?.exists ?? false, createdAt: data.createdAt, timestamp },
        });
      }

      const summaryState = createTxInventorySummaryState(summaryRef, summarySnap);

      return {
        timestamp, economyRef, charge: { currency: chargeCurrency, amount: chargeAmount },
        balances: { gemsBefore, gemsAfter, coinsBefore, coinsAfter }, grantPlans, summaryState,
        activeRef, stateRef, activeUpdate, activeUpdatedAt: nowMillis, flowState, isIapPurchase: shouldProgressLadder, offerId,
      };
    },
    async (transaction, reads) => {
      const grants: GrantSummary[] = [];
      const summaryChanges: Record<string, number> = {};
      const { currency: chargeCurrency, amount: chargeAmount } = reads.charge;

      for (const plan of reads.grantPlans) {
        if (plan.kind === "currency") { grants.push(plan.summary); continue; }
        const result = await incSkuQtyTx(transaction, db, uid, plan.sku.skuId, plan.quantity, plan.context);
        summaryChanges[plan.sku.skuId] = (summaryChanges[plan.sku.skuId] ?? 0) + plan.quantity;
        const grant: GrantSummary = { type: plan.entitlementType, skuId: plan.sku.skuId, itemId: plan.sku.itemId, quantity: plan.quantity, total: result.after };
        if (resolveItemType(plan.sku) === "cosmetic") grant.alreadyOwned = result.before > 0;
        grants.push(grant);
      }

      if (Object.keys(summaryChanges).length > 0) {
        await txUpdateInventorySummary(transaction, db, uid, summaryChanges, { state: reads.summaryState, timestamp: reads.timestamp });
      }

      const activeRef = reads.activeRef;
      const activeSnap = await transaction.get(activeRef);
      const activeData = activeSnap.data() as any;

      if (reads.activeUpdate.rotatingUpdate && Array.isArray(activeData.rotating)) {
        activeData.rotating[reads.activeUpdate.rotatingUpdate.index] = {
          ...activeData.rotating[reads.activeUpdate.rotatingUpdate.index],
          state: "purchase_delay",
          nextOfferAt: reads.activeUpdate.rotatingUpdate.nextOfferAt
        };
      } else if (reads.activeUpdate.slot === "special") {
        activeData.special = reads.activeUpdate.special ?? [];
      }
      activeData.updatedAt = reads.activeUpdatedAt;

      transaction.set(reads.activeRef, activeData, { merge: true });

      if (reads.isIapPurchase) {
        const flowUpdates: Partial<OfferFlowState> = {
          lastOfferPurchasedAt: reads.activeUpdatedAt,
          offersPurchased: [...reads.flowState.offersPurchased, reads.offerId],
          totalIapPurchases: reads.flowState.totalIapPurchases + 1,
          updatedAt: reads.activeUpdatedAt,
        };
        transaction.set(reads.stateRef, flowUpdates, { merge: true });
      }

      transaction.set(reads.economyRef, { gems: reads.balances.gemsAfter, coins: reads.balances.coinsAfter, updatedAt: reads.timestamp }, { merge: true });

      const purchaseResult: PurchaseOfferResult = {
        success: true, opId, offerId, currency: typeof chargeCurrency === "string" ? chargeCurrency : "gems",
        amount: chargeAmount, grants, balances: { gems: reads.balances.gemsAfter, coins: reads.balances.coinsAfter },
      };

      if (reads.activeUpdate.rotatingUpdate) {
        purchaseResult.nextOfferAt = reads.activeUpdate.rotatingUpdate.nextOfferAt;
        purchaseResult.category = reads.activeUpdate.rotatingUpdate.category;
      }
      return purchaseResult;
    },
  );

  if (result.nextOfferAt && result.category) {
    try {
      await cancelScheduledTransition(uid, result.category);
      await scheduleOfferTransition(uid, result.category, result.nextOfferAt, "purchase_delay_end");
    } catch (error) {
      logger.warn(`Failed to schedule offer transition for ${uid}`, error);
    }
  }

  return result;
});
