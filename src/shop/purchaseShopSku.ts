import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { findVariantBySku } from "../core/config.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runReadThenWriteWithReceipt } from "../core/transactions.js";
import { db } from "../shared/firestore.js";
import { REGION } from "../shared/region.js";
import { getMinInstances } from "../shared/callableOptions.js";
import {
  createTxInventorySummaryState,
  createTxSkuDocState,
  txIncSkuQty,
  txUpdateInventorySummary,
} from "../inventory/index.js";
import { resolveInventoryContext } from "../shared/inventory.js";
import { ItemSku } from "../shared/types.js";

interface PurchaseShopSkuRequest {
  opId: unknown;
  skuId: unknown;
  quantity?: unknown;
}

interface PurchaseShopSkuParams {
  uid: string;
  opId: string;
  skuId: string;
  quantity: number;
}

interface PurchaseShopSkuOptions {
  reason?: string;
  catalog?: Record<string, ItemSku>;
}

export interface PurchaseShopSkuResult {
  success: true;
  skuId: string;
  quantity: number;
  currency: "gems" | "coins";
  unitCost: number;
  totalCost: number;
  gemsBefore: number;
  gemsAfter: number;
  coinsBefore: number;
  coinsAfter: number;
  totalCostGems?: number;
  totalCostCoins?: number;
}

const ensurePositiveInteger = (value: unknown, fieldName: string): number => {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new HttpsError("invalid-argument", `${fieldName} must be a positive integer.`);
  }
  return value as number;
};

export async function purchaseShopSkuInternal(
  params: PurchaseShopSkuParams,
  options: PurchaseShopSkuOptions = {},
): Promise<PurchaseShopSkuResult> {
  const { uid, opId, skuId } = params;
  const quantity = ensurePositiveInteger(params.quantity, "quantity");

  const variantInfo = await findVariantBySku(skuId);
  const sku = variantInfo.sku;
  const variant = variantInfo.variant;

  if (!sku) {
    throw new HttpsError("not-found", `SKU ${skuId} not found in ItemSkusCatalog.`);
  }

  if (quantity > 1 && sku.stackable === false) {
    throw new HttpsError(
      "failed-precondition",
      `SKU ${skuId} is not stackable; quantity must be 1.`,
    );
  }

  if (!variant || variant.purchasable !== true) {
    throw new HttpsError(
      "failed-precondition",
      `SKU ${skuId} is not purchasable via purchaseShopSku.`,
    );
  }

  const gemPrice = Number(variant.gemPrice);
  if (!Number.isFinite(gemPrice) || gemPrice <= 0) {
    throw new HttpsError(
      "failed-precondition",
      `SKU ${skuId} has an invalid gem price.`,
    );
  }

  const unitCost = gemPrice;
  const totalCost = unitCost * quantity;
  const reason = options.reason ?? `purchase.sku.${skuId}`;

  const cachedResult = await checkIdempotency(uid, opId);
  if (cachedResult) {
    return cachedResult as PurchaseShopSkuResult;
  }

  await createInProgressReceipt(uid, opId, reason);

  try {
    return await runReadThenWriteWithReceipt(
      uid,
      opId,
      reason,
      async (transaction) => {
        const statsRef = db.doc(`/Players/${uid}/Economy/Stats`);
        const inventoryCtx = resolveInventoryContext(uid);
        const skuRef = inventoryCtx.inventoryCollection.doc(skuId);
        const summaryRef = inventoryCtx.summaryRef;

        const [statsSnap, skuSnap, summarySnap] = await Promise.all([
          transaction.get(statsRef),
          transaction.get(skuRef),
          transaction.get(summaryRef),
        ]);

        if (!statsSnap.exists) {
          throw new HttpsError("not-found", "Player economy stats not found.");
        }

        const stats = statsSnap.data() ?? {};
        const gemsBefore = Number(stats.gems ?? 0);
        const coinsBefore = Number(stats.coins ?? 0);
        if (!Number.isFinite(gemsBefore) || !Number.isFinite(coinsBefore)) {
          throw new HttpsError("failed-precondition", "Player balances are invalid.");
        }

        const currency: "gems" = "gems";
        if (gemsBefore < totalCost) {
          throw new HttpsError("resource-exhausted", "Insufficient gems.");
        }

        const skuState = createTxSkuDocState(db, uid, skuId, skuSnap);
        if (!Number.isFinite(skuState.quantity) || skuState.quantity < 0) {
          throw new HttpsError(
            "failed-precondition",
            `Inventory for SKU ${skuId} is corrupt.`,
          );
        }
        if (sku.stackable === false && skuState.quantity > 0) {
          throw new HttpsError(
            "failed-precondition",
            `SKU ${skuId} already owned; non-stackable items cannot be repurchased.`,
          );
        }

        const summaryState = createTxInventorySummaryState(summaryRef, summarySnap);
        const now = admin.firestore.FieldValue.serverTimestamp();
        const gemsAfter = gemsBefore - totalCost;
        const coinsAfter = coinsBefore;
        const balanceUpdates: Record<string, admin.firestore.FieldValue> = {
          updatedAt: now,
          gems: admin.firestore.FieldValue.increment(-totalCost),
        };

        return {
          statsRef,
          skuState,
          summaryState,
          gemsBefore,
          coinsBefore,
          gemsAfter,
          coinsAfter,
          balanceUpdates,
          now,
          currency,
        };
      },
      async (transaction, reads) => {
        const {
          statsRef,
          skuState,
          summaryState,
          gemsBefore,
          coinsBefore,
          gemsAfter,
          coinsAfter,
          balanceUpdates,
          now,
          currency,
        } = reads;

        // READS ABOVE, WRITES BELOW. DO NOT MOVE/ADD tx.get AFTER THIS LINE.

        await txIncSkuQty(transaction, db, uid, skuId, quantity, {
          state: skuState,
          timestamp: now,
        });

        await txUpdateInventorySummary(
          transaction,
          db,
          uid,
          { [skuId]: quantity },
          { state: summaryState, timestamp: now },
        );

        transaction.update(statsRef, balanceUpdates);

        const baseResult: Omit<PurchaseShopSkuResult, "totalCostGems" | "totalCostCoins"> = {
          success: true,
          skuId,
          quantity,
          currency,
          unitCost,
          totalCost,
          gemsBefore,
          gemsAfter,
          coinsBefore,
          coinsAfter,
        };

        return {
          ...baseResult,
          totalCostGems: totalCost,
        };
      },
    );
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    console.error("[purchaseShopSku] Failed to purchase SKU:", error);
    throw new HttpsError("internal", "Failed to purchase SKU.");
  }
}

export const purchaseShopSku = onCall({ region: REGION, minInstances: getMinInstances(true), memory: "256MiB" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const { opId, skuId, quantity = 1 } = request.data as PurchaseShopSkuRequest;

  if (typeof opId !== "string" || !opId.trim()) {
    throw new HttpsError("invalid-argument", "opId must be a non-empty string.");
  }
  if (typeof skuId !== "string" || !skuId.trim()) {
    throw new HttpsError("invalid-argument", "skuId must be a non-empty string.");
  }
  if (quantity !== undefined && typeof quantity !== "number") {
    throw new HttpsError("invalid-argument", "quantity must be a number if provided.");
  }

  return await purchaseShopSkuInternal(
    { uid, opId, skuId, quantity: quantity ?? 1 },
    {},
  );
});
