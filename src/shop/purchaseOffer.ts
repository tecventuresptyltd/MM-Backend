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
  MAX_TIER,
} from "./offerState.js";
import { scheduleOfferTransition, cancelScheduledTransition } from "./offerScheduler.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface PurchaseOfferRequest {
  opId: unknown;
  offerId: unknown;
  /** If true, this is an IAP-verified purchase that affects ladder progression */
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
  balances: {
    gems?: number;
    coins?: number;
  };
  /** New tier after this purchase (if ladder progression occurred) */
  newTier?: number;
  /** When next offer will be available (if in purchase_delay) */
  nextOfferAt?: number;
}

interface ResolvedSkuEntitlement {
  entitlement: OfferEntitlement;
  sku: ItemSku | null;
  quantity: number;
}

type GrantPlan =
  | {
    kind: "currency";
    summary: GrantSummary;
  }
  | {
    kind: "sku";
    sku: ItemSku;
    quantity: number;
    entitlementType: OfferEntitlement["type"];
    context: TxSkuMutationContext;
  };

type ActiveOfferSlot =
  | { kind: "main" }
  | { kind: "daily" }
  | { kind: "starter" }
  | { kind: "special"; index: number };

interface MainOfferUpdate {
  newTier: number;
  nextOfferAt: number;
  isStarter: boolean;
}

interface ActiveOfferUpdate {
  slot: ActiveOfferSlot["kind"];
  special?: ActiveSpecialOffer[];
  /** New main offer update for IAP purchases */
  mainUpdate?: MainOfferUpdate;
}

interface PurchaseOfferReadState {
  timestamp: FirebaseFirestore.FieldValue;
  economyRef: FirebaseFirestore.DocumentReference;
  charge: { currency: "gems" | "coins" | null; amount: number };
  balances: {
    gemsBefore: number;
    gemsAfter: number;
    coinsBefore: number;
    coinsAfter: number;
  };
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ensureOfferRequest = (request: PurchaseOfferRequest): {
  opId: string;
  offerId: string;
  isIapPurchase: boolean;
} => {
  const { opId, offerId, isIapPurchase } = request;
  if (typeof opId !== "string" || !opId.trim()) {
    throw new HttpsError("invalid-argument", "opId must be a non-empty string.");
  }
  if (typeof offerId !== "string" || !offerId.trim()) {
    throw new HttpsError("invalid-argument", "offerId must be a non-empty string.");
  }
  return {
    opId: opId.trim(),
    offerId: offerId.trim(),
    isIapPurchase: Boolean(isIapPurchase),
  };
};

const ensureOffer = async (offerId: string): Promise<Offer> => {
  const offers = await getOffersCatalog();
  const offer = offers[offerId];
  if (!offer) {
    throw new HttpsError("not-found", `Offer ${offerId} not found in catalog.`);
  }
  if (!Array.isArray(offer.entitlements) || offer.entitlements.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      `Offer ${offerId} has no entitlements.`,
    );
  }
  return offer;
};

/**
 * Check if an offer is an IAP offer based on its configuration.
 * IAP offers have a productId (for app stores) and use USD currency.
 */
const isIapOffer = (offer: Offer): boolean => {
  return Boolean(offer.productId) && offer.currency === "USD";
};

/**
 * Check if an offer is a main-slot offer (starter, daily, or ladder).
 * offerType 0 = starter, 1-4 = daily, 5-8 = ladder
 */
const isMainSlotOffer = (offer: Offer): boolean => {
  const type = offer.offerType ?? -1;
  return type >= 0 && type <= 8;
};

const resolveEntitlementSku = async (
  entitlement: OfferEntitlement,
): Promise<ItemSku | null> => {
  const type = entitlement.type;
  if (type === "gems") {
    return null;
  }
  const targetId = typeof entitlement.id === "string" ? entitlement.id.trim() : "";
  if (!targetId) {
    throw new HttpsError(
      "failed-precondition",
      "Offer entitlement is missing an id.",
    );
  }
  if (targetId.startsWith("sku_")) {
    return await resolveSkuOrThrow(targetId);
  }
  const skus = await listSkusForItem(targetId);
  if (skus.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      `Offer entitlement references unknown item ${targetId}.`,
    );
  }
  return skus[0];
};

const resolveEntitlements = async (
  offer: Offer,
): Promise<ResolvedSkuEntitlement[]> => {
  const resolved: ResolvedSkuEntitlement[] = [];
  for (const entitlement of offer.entitlements) {
    const quantity = Number(entitlement.quantity ?? 0);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new HttpsError(
        "failed-precondition",
        "Offer amount must be positive.",
      );
    }
    const sku = await resolveEntitlementSku(entitlement);
    if (sku && sku.stackable === false && quantity > 1) {
      throw new HttpsError(
        "failed-precondition",
        `Entitlement for ${sku.skuId} cannot grant quantity ${quantity}; item is not stackable.`,
      );
    }
    resolved.push({ entitlement, sku, quantity });
  }
  return resolved;
};

const resolveItemType = (sku: ItemSku): ItemSku["type"] => {
  if (sku.type) {
    return sku.type;
  }
  throw new HttpsError(
    "failed-precondition",
    `SKU ${sku.skuId} is missing type metadata.`,
  );
};

/**
 * Resolve which slot an offer belongs to.
 * Supports both new main-slot format and legacy starter/daily format.
 */
const resolveActiveOfferSlot = (
  offerId: string,
  state: ActiveOffers,
  now: number,
): ActiveOfferSlot | null => {
  // Check new main slot first
  if (state.main && state.main.offerId === offerId) {
    if (state.main.state === "active" && state.main.expiresAt > now) {
      return { kind: "main" };
    }
    return null;
  }

  // Legacy: check starter
  if (state.starter && state.starter.offerId === offerId) {
    if (state.starter.expiresAt > now) {
      return { kind: "starter" };
    }
    return null;
  }

  // Legacy: check daily
  if (state.daily?.offerId === offerId && (state.daily.expiresAt ?? 0) > now) {
    return { kind: "daily" };
  }

  // Check special offers (milestones, flash sales)
  const specialIndex = state.special.findIndex(
    (entry) => entry.offerId === offerId && entry.expiresAt > now,
  );
  if (specialIndex >= 0) {
    return { kind: "special", index: specialIndex };
  }

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
  if (!slot) {
    throw new HttpsError(
      "failed-precondition",
      `Offer ${offerId} is not active for this player.`,
    );
  }

  // Legacy daily check
  if (slot.kind === "daily" && state.daily?.isPurchased) {
    throw new HttpsError(
      "failed-precondition",
      "Daily offer has already been purchased.",
    );
  }

  // Special offers (milestones, flash sales) - just remove from list
  if (slot.kind === "special") {
    const base = prunedSpecial ?? state.special;
    const filtered = base.filter((_, index) => index !== slot.index);
    return { slot: "special", special: filtered };
  }

  // For main slot purchases, ALWAYS create state transition
  // This prevents duplicate purchases while preserving tier progression for IAP only
  let mainUpdate: MainOfferUpdate | undefined;
  if (slot.kind === "main" || slot.kind === "starter" || slot.kind === "daily") {
    const currentTier = state.main?.tier ?? flowState.tier ?? 0;

    // Only advance tier if this is an IAP purchase (ladder progression)
    // Non-IAP purchases keep same tier but still get 30-min delay
    const newTier = isIapPurchase
      ? resolveNextTierOnPurchase(currentTier)
      : currentTier;

    mainUpdate = {
      newTier,
      nextOfferAt: now + POST_PURCHASE_DELAY_MS,
      isStarter: slot.kind === "starter" || Boolean(state.main?.isStarter),
    };
  }

  const update: ActiveOfferUpdate = { slot: slot.kind };
  if (prunedSpecial && prunedSpecial.length !== state.special.length) {
    update.special = prunedSpecial;
  }
  if (mainUpdate) {
    update.mainUpdate = mainUpdate;
  }

  return update;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export const purchaseOffer = onCall(callableOptions({ minInstances: getMinInstances(true), memory: "256MiB" }, true), async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const { opId, offerId, isIapPurchase } = ensureOfferRequest(request.data as PurchaseOfferRequest);

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as PurchaseOfferResult;
  }

  await createInProgressReceipt(uid, opId, "purchaseOffer");

  const offer = await ensureOffer(offerId);
  const resolvedEntitlements = await resolveEntitlements(offer);

  // Determine if this should affect ladder progression
  // Only IAP purchases on main-slot offers trigger progression
  const shouldProgressLadder = isIapPurchase && isIapOffer(offer) && isMainSlotOffer(offer);

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

      if (!statsSnap.exists) {
        throw new HttpsError("failed-precondition", "Economy profile missing for player.");
      }
      if (!activeSnap.exists) {
        throw new HttpsError(
          "failed-precondition",
          "Active offers not initialized. Call getDailyOffers before purchasing offers.",
        );
      }

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
      if (!Number.isFinite(gemsBefore) || !Number.isFinite(coinsBefore)) {
        throw new HttpsError("failed-precondition", "Player balances are invalid.");
      }

      const rawAmount = Number(offer.amount ?? 0);
      if (!Number.isFinite(rawAmount)) {
        throw new HttpsError("failed-precondition", "Offer amount must be a finite number.");
      }
      if (rawAmount < 0) {
        throw new HttpsError("failed-precondition", "Offer amount must be non-negative.");
      }

      const chargeAmount = Math.max(0, rawAmount);
      const rawCurrency =
        typeof offer.currency === "string" ? offer.currency.toLowerCase() : null;
      const chargeCurrency: "gems" | "coins" | null =
        rawCurrency === "gems" || rawCurrency === "coins" ? rawCurrency : null;

      let gemsAfter = gemsBefore;
      let coinsAfter = coinsBefore;

      // For IAP offers, we don't charge in-game currency
      if (!isIapOffer(offer)) {
        if (chargeCurrency === "gems" && chargeAmount > 0) {
          if (gemsBefore < chargeAmount) {
            throw new HttpsError("resource-exhausted", "Insufficient gems for offer purchase.");
          }
          gemsAfter -= chargeAmount;
        } else if (chargeCurrency === "coins" && chargeAmount > 0) {
          if (coinsBefore < chargeAmount) {
            throw new HttpsError("resource-exhausted", "Insufficient coins for offer purchase.");
          }
          coinsAfter -= chargeAmount;
        } else if (chargeAmount > 0 && chargeCurrency) {
          throw new HttpsError(
            "failed-precondition",
            `Unsupported offer currency ${offer.currency}.`,
          );
        }
      }

      const inventoryRefs = new Map<string, FirebaseFirestore.DocumentReference>();
      for (const entry of resolvedEntitlements) {
        if (entry.sku) {
          if (!inventoryRefs.has(entry.sku.skuId)) {
            inventoryRefs.set(
              entry.sku.skuId,
              inventoryCtx.inventoryCollection.doc(entry.sku.skuId),
            );
          }
        }
      }

      const summarySnapPromise = transaction.get(summaryRef);
      const inventorySnapshots = inventoryRefs.size
        ? await transaction.getAll(...inventoryRefs.values())
        : [];
      const summarySnap = await summarySnapPromise;

      const snapshotBySku = new Map<string, FirebaseFirestore.DocumentSnapshot>();
      let snapshotIndex = 0;
      for (const [skuId] of inventoryRefs) {
        snapshotBySku.set(skuId, inventorySnapshots[snapshotIndex++] ?? null);
      }

      const grantPlans: GrantPlan[] = [];
      for (const entry of resolvedEntitlements) {
        if (!entry.sku) {
          if (entry.entitlement.type === "gems") {
            gemsAfter += entry.quantity;
            grantPlans.push({
              kind: "currency",
              summary: {
                type: "gems",
                quantity: entry.quantity,
              },
            });
          } else if (entry.entitlement.type === "coins") {
            coinsAfter += entry.quantity;
            grantPlans.push({
              kind: "currency",
              summary: {
                type: "coins",
                quantity: entry.quantity,
              },
            });
          } else {
            grantPlans.push({
              kind: "currency",
              summary: {
                type: entry.entitlement.type,
                quantity: entry.quantity,
              },
            });
          }
          continue;
        }

        const sku = entry.sku;
        const snapshot = snapshotBySku.get(sku.skuId);
        const data = snapshot?.data() ?? {};
        const rawQty = data.quantity ?? data.qty;
        const parsedQty = Number(rawQty);
        const currentQty =
          Number.isFinite(parsedQty) && parsedQty > 0 ? Math.floor(parsedQty) : 0;
        if (sku.stackable === false && currentQty > 0) {
          throw new HttpsError(
            "failed-precondition",
            `SKU ${sku.skuId} already owned; non-stackable entitlements cannot grant quantity ${entry.quantity}.`,
          );
        }

        const context: TxSkuMutationContext = {
          quantity: currentQty,
          exists: snapshot?.exists ?? false,
          createdAt: data.createdAt,
          timestamp,
        };

        grantPlans.push({
          kind: "sku",
          sku,
          quantity: entry.quantity,
          entitlementType: entry.entitlement.type,
          context,
        });
      }

      const summaryState = createTxInventorySummaryState(summaryRef, summarySnap);

      const readState: PurchaseOfferReadState = {
        timestamp,
        economyRef,
        charge: {
          currency: chargeCurrency,
          amount: chargeAmount,
        },
        balances: {
          gemsBefore,
          gemsAfter,
          coinsBefore,
          coinsAfter,
        },
        grantPlans,
        summaryState,
        activeRef,
        stateRef,
        activeUpdate,
        activeUpdatedAt: nowMillis,
        flowState,
        isIapPurchase: shouldProgressLadder,
        offerId,
      };
      return readState;
    },
    async (transaction, reads) => {
      const grants: GrantSummary[] = [];
      const summaryChanges: Record<string, number> = {};
      const { currency: chargeCurrency, amount: chargeAmount } = reads.charge;

      for (const plan of reads.grantPlans) {
        if (plan.kind === "currency") {
          grants.push(plan.summary);
          continue;
        }

        const result = await incSkuQtyTx(
          transaction,
          db,
          uid,
          plan.sku.skuId,
          plan.quantity,
          plan.context,
        );
        summaryChanges[plan.sku.skuId] =
          (summaryChanges[plan.sku.skuId] ?? 0) + plan.quantity;

        const grant: GrantSummary = {
          type: plan.entitlementType,
          skuId: plan.sku.skuId,
          itemId: plan.sku.itemId,
          quantity: plan.quantity,
          total: result.after,
        };
        if (resolveItemType(plan.sku) === "cosmetic") {
          grant.alreadyOwned = result.before > 0;
        }
        grants.push(grant);
      }

      if (Object.keys(summaryChanges).length > 0) {
        await txUpdateInventorySummary(transaction, db, uid, summaryChanges, {
          state: reads.summaryState,
          timestamp: reads.timestamp,
        });
      }

      // Update active offers document
      const activePayload: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> = {
        updatedAt: reads.activeUpdatedAt,
      };

      // Handle main slot update for new format
      if (reads.activeUpdate.mainUpdate) {
        // For IAP purchases: REMOVE the offer completely (one-time purchase)
        // Scheduler will create new offer (next tier) after 30min delay
        activePayload.main = admin.firestore.FieldValue.delete();
        // Clear legacy fields
        activePayload.starter = admin.firestore.FieldValue.delete();
        activePayload.daily = admin.firestore.FieldValue.delete();
      } else {
        // Handle legacy format updates
        switch (reads.activeUpdate.slot) {
          case "main":
            // Non-IAP main purchase - remove offer
            activePayload.main = admin.firestore.FieldValue.delete();
            break;
          case "daily":
            activePayload["daily.isPurchased"] = true;
            break;
          case "starter":
            activePayload.starter = admin.firestore.FieldValue.delete();
            break;
          case "special":
            activePayload.special = reads.activeUpdate.special ?? [];
            break;
        }
      }

      // Update special offers if pruned
      if (
        reads.activeUpdate.special &&
        reads.activeUpdate.slot !== "special"
      ) {
        activePayload.special = reads.activeUpdate.special;
      }

      transaction.set(reads.activeRef, activePayload, { merge: true });

      // Update flow state for IAP purchases
      if (reads.isIapPurchase && reads.activeUpdate.mainUpdate) {
        const flowUpdates: Partial<OfferFlowState> = {
          tier: reads.activeUpdate.mainUpdate.newTier,
          lastOfferPurchasedAt: reads.activeUpdatedAt,
          offersPurchased: [...reads.flowState.offersPurchased, reads.offerId],
          totalIapPurchases: reads.flowState.totalIapPurchases + 1,
          updatedAt: reads.activeUpdatedAt,
        };
        if (reads.activeUpdate.mainUpdate.isStarter) {
          flowUpdates.starterPurchased = true;
        }
        transaction.set(reads.stateRef, flowUpdates, { merge: true });
      }

      // Update economy
      transaction.set(
        reads.economyRef,
        {
          gems: reads.balances.gemsAfter,
          coins: reads.balances.coinsAfter,
          updatedAt: reads.timestamp,
        },
        { merge: true },
      );

      const purchaseResult: PurchaseOfferResult = {
        success: true,
        opId,
        offerId,
        currency:
          typeof offer.currency === "string"
            ? offer.currency
            : chargeCurrency ?? "gems",
        amount: chargeAmount,
        grants,
        balances: {
          gems: reads.balances.gemsAfter,
          coins: reads.balances.coinsAfter,
        },
      };

      // Include tier progression info for IAP purchases
      if (reads.activeUpdate.mainUpdate) {
        purchaseResult.newTier = reads.activeUpdate.mainUpdate.newTier;
        purchaseResult.nextOfferAt = reads.activeUpdate.mainUpdate.nextOfferAt;
      }

      return purchaseResult;
    },
  );

  // Schedule transition for IAP purchases (outside transaction for efficiency)
  if (result.newTier !== undefined && result.nextOfferAt) {
    try {
      // CRITICAL: Cancel any existing queue entry first to prevent conflicts
      await cancelScheduledTransition(uid);

      // Then schedule new transition
      await scheduleOfferTransition(
        uid,
        result.nextOfferAt,
        "purchase_delay_end",
        result.newTier,
      );
    } catch (error) {
      // Non-critical - scheduler will still work via getDailyOffers fallback
      logger.warn(`Failed to schedule offer transition for ${uid}`, error);
    }
  }

  return result;
});
