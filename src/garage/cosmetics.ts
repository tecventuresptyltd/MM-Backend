import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { REGION } from "../shared/region.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runReadThenWriteWithReceipt } from "../core/transactions.js";
import { getCratesCatalogDoc, getItemSkusCatalog, resolveSkuOrThrow } from "../core/config.js";
import { resolveInventoryContext } from "../shared/inventory.js";
import {
  incSkuQtyTx,
  txUpdateInventorySummary,
  createTxInventorySummaryState,
  TxSkuMutationContext,
} from "../inventory/index.js";
import { ItemSku } from "../shared/types.js";
import { purchaseShopSkuInternal } from "../shop/purchaseShopSku.js";

const db = admin.firestore();

type CosmeticSlot = "wheels" | "decal" | "spoiler" | "underglow" | "boost";

const SLOT_FIELD_MAP: Record<CosmeticSlot, { skuField: string; itemField: string }> = {
  wheels: { skuField: "wheelsSkuId", itemField: "wheelsItemId" },
  decal: { skuField: "decalSkuId", itemField: "decalItemId" },
  spoiler: { skuField: "spoilerSkuId", itemField: "spoilerItemId" },
  underglow: { skuField: "underglowSkuId", itemField: "underglowItemId" },
  boost: { skuField: "boostSkuId", itemField: "boostItemId" },
};

const normalizeSlot = (slot: string): CosmeticSlot => {
  switch (slot) {
    case "wheels":
      return "wheels";
    case "decal":
    case "decals":
      return "decal";
    case "spoiler":
    case "spoilers":
      return "spoiler";
    case "underglow":
      return "underglow";
    case "boost":
      return "boost";
    default:
      throw new HttpsError("invalid-argument", `Unsupported cosmetic slot "${slot}".`);
  }
};

const ensureCosmeticSlot = (
  sku: ItemSku,
  slot: EquipCosmeticRequest["slot"],
): CosmeticSlot => {
  if (sku.type !== "cosmetic") {
    throw new HttpsError("failed-precondition", `SKU ${sku.skuId} is not a cosmetic item.`);
  }
  const requested = normalizeSlot(slot);
  if (sku.subType) {
    const skuSlot = normalizeSlot(sku.subType);
    if (skuSlot !== requested) {
      throw new HttpsError(
        "failed-precondition",
        `Cosmetic slot mismatch: SKU ${sku.skuId} expects slot "${skuSlot}" but "${requested}" was requested.`,
      );
    }
  }
  return requested;
};

// --- Equip Cosmetic ---

interface EquipCosmeticRequest {
  skuId: string;
  slot: "wheels" | "decals" | "spoilers" | "underglow" | "boost";
  loadoutId: string;
  opId: string;
}

interface EquipCosmeticResponse {
  success: boolean;
  opId: string;
}

export const equipCosmetic = onCall({ region: REGION }, async (request) => {
  const { skuId, slot, loadoutId, opId } = request.data as EquipCosmeticRequest;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (typeof skuId !== "string" || !skuId.trim()) {
    throw new HttpsError("invalid-argument", "skuId is required.");
  }
  if (typeof loadoutId !== "string" || !loadoutId.trim()) {
    throw new HttpsError("invalid-argument", "loadoutId is required.");
  }
  if (typeof opId !== "string" || !opId.trim()) {
    throw new HttpsError("invalid-argument", "opId is required.");
  }

  let skuGameData: ItemSku;
  try {
    skuGameData = await resolveSkuOrThrow(skuId);
  } catch (error) {
    throw new HttpsError("not-found", `SKU ${skuId} not found in ItemSkusCatalog.`);
  }

  const cosmeticSlot = ensureCosmeticSlot(skuGameData, slot);
  const slotFields = SLOT_FIELD_MAP[cosmeticSlot];
  const itemId = skuGameData.itemId;

  try {
    const idempotencyResult = await checkIdempotency(uid, opId);
    if (idempotencyResult) {
      return idempotencyResult;
    }

    await createInProgressReceipt(uid, opId, "equipCosmetic");

    const inventoryCtx = resolveInventoryContext(uid);
    const inventoryRef = inventoryCtx.inventoryCollection.doc(skuId);

    return await runReadThenWriteWithReceipt<{
      timestamp: FirebaseFirestore.FieldValue;
      playerLoadoutRef: FirebaseFirestore.DocumentReference;
      updatedCosmetics: Record<string, unknown>;
    }, EquipCosmeticResponse>(
      uid,
      opId,
      "equipCosmetic",
      async (transaction) => {
        const playerLoadoutRef = db.doc(`/Players/${uid}/Loadouts/${loadoutId}`);
        const timestamp = admin.firestore.FieldValue.serverTimestamp();
        const [playerLoadoutDoc, inventoryDoc] = await Promise.all([
          transaction.get(playerLoadoutRef),
          transaction.get(inventoryRef),
        ]);

        if (!playerLoadoutDoc.exists) {
          throw new HttpsError("not-found", "Player loadout not found.");
        }

        const inventoryData = inventoryDoc.data() ?? {};
        const rawQty = inventoryData.quantity ?? inventoryData.qty;
        const ownedQuantity =
          Number.isFinite(Number(rawQty)) && Number(rawQty) > 0
            ? Math.floor(Number(rawQty))
            : 0;
        if (ownedQuantity < 1) {
          throw new HttpsError("failed-precondition", "Player does not own this cosmetic.");
        }

        const loadoutData = playerLoadoutDoc.data() ?? {};
        const currentCosmetics = (loadoutData.cosmetics ?? {}) as Record<string, unknown>;
        const updatedCosmetics: Record<string, unknown> = {
          ...currentCosmetics,
          [slotFields.skuField]: skuId,
          [slotFields.itemField]: itemId,
        };
        updatedCosmetics[cosmeticSlot] = skuId;

        return {
          timestamp,
          playerLoadoutRef,
          updatedCosmetics,
        };
      },
      async (transaction, reads) => {
        transaction.set(
          reads.playerLoadoutRef,
          {
            cosmetics: reads.updatedCosmetics,
            updatedAt: reads.timestamp,
          },
          { merge: true },
        );

        return {
          success: true,
          opId,
        };
      },
    );
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    throw new HttpsError("internal", message, error as Error);
  }
});

// --- Grant Item ---

interface GrantItemRequest {
  skuId: string;
  quantity: number;
  opId: string;
  reason: string;
}

interface GrantItemResponse {
  success: boolean;
  opId: string;
}

export const grantItem = onCall({ region: REGION }, async (request) => {
  const { skuId, quantity, opId, reason } = request.data as GrantItemRequest;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (typeof skuId !== "string" || !skuId.trim()) {
    throw new HttpsError("invalid-argument", "skuId is required.");
  }
  if (typeof opId !== "string" || !opId.trim()) {
    throw new HttpsError("invalid-argument", "opId is required.");
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new HttpsError("invalid-argument", "reason is required.");
  }
  if (typeof quantity !== "number" || quantity <= 0) {
    throw new HttpsError("invalid-argument", "Missing or invalid parameters.");
  }

  try {
    const idempotencyResult = await checkIdempotency(uid, opId);
    if (idempotencyResult) {
      return idempotencyResult;
    }

    let skuGameData: ItemSku;
    try {
      skuGameData = await resolveSkuOrThrow(skuId);
    } catch (error) {
      throw new HttpsError("not-found", `SKU ${skuId} not found in ItemSkusCatalog.`);
    }

    await createInProgressReceipt(uid, opId, reason);

    const inventoryCtx = resolveInventoryContext(uid);
    const inventoryRef = inventoryCtx.inventoryCollection.doc(skuId);
    const summaryRef = inventoryCtx.summaryRef;

    return await runReadThenWriteWithReceipt<{
      timestamp: FirebaseFirestore.FieldValue;
      summaryState: ReturnType<typeof createTxInventorySummaryState>;
      skuContext: TxSkuMutationContext;
      summaryDelta: number;
    }, GrantItemResponse>(
      uid,
      opId,
      reason,
      async (transaction) => {
        const timestamp = admin.firestore.FieldValue.serverTimestamp();
        const [summarySnap, skuSnap] = await Promise.all([
          transaction.get(summaryRef),
          transaction.get(inventoryRef),
        ]);

        const data = skuSnap.data() ?? {};
        const rawQty = data.quantity ?? data.qty;
        const currentQty =
          Number.isFinite(Number(rawQty)) && Number(rawQty) > 0
            ? Math.floor(Number(rawQty))
            : 0;

        if (skuGameData.stackable === false && currentQty > 0) {
          throw new HttpsError(
            "failed-precondition",
            `Non-stackable SKU ${skuId} cannot be granted multiple times.`,
          );
        }

        const summaryDelta =
          skuGameData.stackable === false
            ? currentQty > 0
              ? 0
              : 1
            : quantity;

        const skuContext: TxSkuMutationContext = {
          quantity: currentQty,
          exists: skuSnap.exists,
          createdAt: data.createdAt,
          timestamp,
        };

        const summaryState = createTxInventorySummaryState(summaryRef, summarySnap);

        return {
          timestamp,
          summaryState,
          skuContext,
          summaryDelta,
        };
      },
      async (transaction, reads) => {
        await incSkuQtyTx(
          transaction,
          db,
          uid,
          skuId,
          quantity,
          reads.skuContext,
        );

        if (reads.summaryDelta !== 0) {
          await txUpdateInventorySummary(
            transaction,
            db,
            uid,
            { [skuId]: reads.summaryDelta },
            { state: reads.summaryState, timestamp: reads.timestamp },
          );
        }

        return {
          success: true,
          opId,
        };
      },
    );
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    console.error("[grantItem] Failed to grant SKU:", error);
    throw new HttpsError("internal", "Failed to grant item.");
  }
});

// --- Purchase Crate or Key ---

type PurchaseKind = "crate" | "key";

interface PurchaseCrateItemRequest {
  crateId: string;
  kind: PurchaseKind;
  quantity: number;
  opId: string;
}

interface PurchaseCrateItemResponse {
  success: boolean;
  opId: string;
  crateId: string;
  kind: PurchaseKind;
  skuId: string;
  quantity: number;
  totalCostGems: number;
  totalCostCoins?: number;
  gemsBefore: number;
  gemsAfter: number;
  coinsBefore?: number;
  coinsAfter?: number;
}

const VALID_PURCHASE_KINDS: PurchaseKind[] = ["crate", "key"];

export const purchaseCrateItem = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const { crateId, kind, quantity, opId } = request.data as PurchaseCrateItemRequest;

  if (typeof opId !== "string" || !opId) {
    throw new HttpsError("invalid-argument", "opId is required.");
  }
  if (typeof crateId !== "string" || !crateId) {
    throw new HttpsError("invalid-argument", "crateId is required.");
  }
  if (!VALID_PURCHASE_KINDS.includes(kind)) {
    throw new HttpsError("invalid-argument", "kind must be either 'crate' or 'key'.");
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new HttpsError("invalid-argument", "quantity must be a positive integer.");
  }

  const itemSkusCatalog = await getItemSkusCatalog();
  const cratesDoc = await getCratesCatalogDoc();
  const crate = cratesDoc.crates?.[crateId];
  if (!crate) {
    throw new HttpsError("not-found", `Crate ${crateId} not found.`);
  }

  const targetSkuId =
    kind === "crate"
      ? crate.crateSkuId ?? crate.skuId ?? crate.crateId
      : crate.keySkuId ?? null;
  if (!targetSkuId) {
    throw new HttpsError("failed-precondition", `Crate ${crateId} does not define a ${kind} SKU.`);
  }

  const skuGameData = itemSkusCatalog[targetSkuId];
  if (!skuGameData) {
    throw new HttpsError(
      "failed-precondition",
      `SKU ${targetSkuId} is not present in ItemSkusCatalog.`,
    );
  }

  const reason = `purchase.${kind}.${crateId}`;

  const result = await purchaseShopSkuInternal(
    { uid, opId, skuId: targetSkuId, quantity },
    { reason, catalog: itemSkusCatalog },
  );

  return {
    success: true,
    opId,
    crateId,
    kind,
    skuId: targetSkuId,
    quantity,
    totalCostGems: result.currency === "gems" ? result.totalCost : undefined,
    totalCostCoins: result.currency === "coins" ? result.totalCost : undefined,
    gemsBefore: result.gemsBefore,
    gemsAfter: result.gemsAfter,
    coinsBefore: result.currency === "coins" ? result.coinsBefore : undefined,
    coinsAfter: result.currency === "coins" ? result.coinsAfter : undefined,
  };
});
