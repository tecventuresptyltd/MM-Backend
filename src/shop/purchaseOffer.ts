import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import {
  getOffersCatalog,
  listSkusForItem,
  resolveSkuOrThrow,
} from "../core/config.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runReadThenWriteWithReceipt } from "../core/transactions.js";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import { Offer, OfferEntitlement, ItemSku } from "../shared/types.js";
import {
  incSkuQtyTx,
  txUpdateInventorySummary,
  createTxInventorySummaryState,
  TxInventorySummaryState,
  TxSkuMutationContext,
} from "../inventory/index.js";
import { resolveInventoryContext } from "../shared/inventory.js";

interface PurchaseOfferRequest {
  opId: unknown;
  offerId: unknown;
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
}

const ensureOfferRequest = (request: PurchaseOfferRequest): { opId: string; offerId: string } => {
  const { opId, offerId } = request;
  if (typeof opId !== "string" || !opId.trim()) {
    throw new HttpsError("invalid-argument", "opId must be a non-empty string.");
  }
  if (typeof offerId !== "string" || !offerId.trim()) {
    throw new HttpsError("invalid-argument", "offerId must be a non-empty string.");
  }
  return { opId: opId.trim(), offerId: offerId.trim() };
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

export const purchaseOffer = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const { opId, offerId } = ensureOfferRequest(request.data as PurchaseOfferRequest);

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as PurchaseOfferResult;
  }

  await createInProgressReceipt(uid, opId, "purchaseOffer");

  const offer = await ensureOffer(offerId);
  const resolvedEntitlements = await resolveEntitlements(offer);

  const inventoryCtx = resolveInventoryContext(uid);
  const summaryRef = inventoryCtx.summaryRef;

  const result = await runReadThenWriteWithReceipt<PurchaseOfferReadState, PurchaseOfferResult>(
    uid,
    opId,
    `purchaseOffer.${offerId}`,
    async (transaction) => {
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      const economyRef = db.doc(`Players/${uid}/Economy/Stats`);
      const statsSnap = await transaction.get(economyRef);
      if (!statsSnap.exists) {
        throw new HttpsError("failed-precondition", "Economy profile missing for player.");
      }

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
      } else if (chargeAmount > 0) {
        throw new HttpsError(
          "failed-precondition",
          `Unsupported offer currency ${offer.currency}.`,
        );
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

      transaction.set(
        reads.economyRef,
        {
          gems: reads.balances.gemsAfter,
          coins: reads.balances.coinsAfter,
          updatedAt: reads.timestamp,
        },
        { merge: true },
      );
      return {
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
    },
  );

  return result;
});
