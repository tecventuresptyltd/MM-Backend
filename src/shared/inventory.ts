import * as admin from "firebase-admin";
import { db } from "./firestore.js";
import { Item, ItemSku } from "./types.js";

type FirestoreTimestampLike =
  | FirebaseFirestore.Timestamp
  | number
  | FirebaseFirestore.FieldValue;

export interface InventorySummaryData {
  totalsByCategory?: Record<string, number>;
  totalsByRarity?: Record<string, number>;
  totalsBySubType?: Record<string, number>;
}

export interface SummaryAdjustment {
  skuId: string;
  itemId?: string;
  category?: string | null;
  rarity?: string | null;
  subType?: string | null;
  delta: number;
}

const applyDelta = (map: Record<string, number>, key: string | null | undefined, delta: number) => {
  if (!key || delta === 0) {
    return;
  }
  const next = (map[key] ?? 0) + delta;
  if (next <= 0) {
    delete map[key];
  } else {
    map[key] = next;
  }
};

export const mergeInventorySummary = (
  current: InventorySummaryData | undefined,
  adjustments: SummaryAdjustment[],
): InventorySummaryData => {
  const totalsByCategory = { ...(current?.totalsByCategory ?? {}) };
  const totalsByRarity = { ...(current?.totalsByRarity ?? {}) };
  const totalsBySubType = { ...(current?.totalsBySubType ?? {}) };

  adjustments.forEach((adj) => {
    applyDelta(totalsByCategory, adj.category ?? null, adj.delta);
    applyDelta(totalsByRarity, adj.rarity ?? null, adj.delta);
    applyDelta(totalsBySubType, adj.subType ?? null, adj.delta);
  });

  return { totalsByCategory, totalsByRarity, totalsBySubType };
};

const extractSubType = (
  item: Partial<Item> | Partial<ItemSku> | undefined,
): string | null => {
  if (!item) {
    return null;
  }
  if (item.type === "cosmetic" || item.type === "booster") {
    return item.subType ?? null;
  }
  return null;
};

export const summaryAdjustmentFromItem = (
  itemId: string,
  item: Partial<Item> | undefined,
  delta: number,
): SummaryAdjustment => ({
  skuId: itemId,
  itemId,
  category: item?.type ?? null,
  rarity: item?.rarity ?? null,
  subType: extractSubType(item),
  delta,
});

export const summaryAdjustmentFromSku = (
  skuId: string,
  sku: Partial<ItemSku> | undefined,
  delta: number,
): SummaryAdjustment => ({
  skuId,
  itemId: sku?.itemId ?? skuId,
  category: sku?.type ?? null,
  rarity: sku?.rarity ?? null,
  subType: extractSubType(sku),
  delta,
});

export const writeInventorySummary = (
  transaction: FirebaseFirestore.Transaction,
  summaryRef: FirebaseFirestore.DocumentReference,
  mergedSummary: InventorySummaryData,
  updatedAt: FirestoreTimestampLike,
) => {
  transaction.set(
    summaryRef,
    {
      totalsByCategory: admin.firestore.FieldValue.delete(),
      totalsByRarity: admin.firestore.FieldValue.delete(),
      totalsBySubType: admin.firestore.FieldValue.delete(),
    },
    { merge: true },
  );

  transaction.set(
    summaryRef,
    {
      totalsByCategory: mergedSummary.totalsByCategory ?? {},
      totalsByRarity: mergedSummary.totalsByRarity ?? {},
      totalsBySubType: mergedSummary.totalsBySubType ?? {},
      updatedAt,
    },
    { merge: true },
  );
};

export interface InventoryContext {
  inventoryCollection: FirebaseFirestore.CollectionReference;
  summaryRef: FirebaseFirestore.DocumentReference;
}

export const resolveInventoryContext = (uid: string): InventoryContext => {
  const inventoryCollection = db.collection("Players").doc(uid).collection("Inventory");
  return {
    inventoryCollection,
    summaryRef: inventoryCollection.doc("_summary"),
  };
};
