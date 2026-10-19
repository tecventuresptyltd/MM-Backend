import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { getSkuRecord } from "../core/catalog.js";
import { getRotationConfig, recordRotationEvent } from "./curatedRotation.js";

type Data = Record<string, any>;

const nonnegativeInteger = (value: unknown): number => {
  const number = Number(value ?? 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
};

const eventTime = (value: string): number | null => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export async function profileRotationEvents(uid: string, before: Data, after: Data, occurredAt: number): Promise<void> {
  if (!Number.isFinite(occurredAt) || !(await getRotationConfig())) return;
  const rank = nonnegativeInteger(after.masteryRank);
  const previousRank = nonnegativeInteger(before.masteryRank);
  if (rank > previousRank) {
    await recordRotationEvent(uid, { type: "mastery", rank, previousRank, occurredAt });
  }
  const priorStreak = nonnegativeInteger(before.shopWinStreak);
  const streak = nonnegativeInteger(after.shopWinStreak);
  if (streak > priorStreak && Math.floor(streak / 3) > Math.floor(priorStreak / 3)) {
    await recordRotationEvent(uid, { type: "win_streak", occurredAt });
  }
}

const slotKey = (slot: Data): string | null => {
  const received = slot.receivedAt;
  if (typeof slot.crateSkuId !== "string" || !received ||
      !Number.isInteger(received.seconds) || !Number.isInteger(received.nanoseconds)) return null;
  return `${slot.crateSkuId}:${received.seconds}:${received.nanoseconds}`;
};

export async function crateSlotRotationEvents(uid: string, before: Data, after: Data, occurredAt: number): Promise<void> {
  if (!Number.isFinite(occurredAt) || !(await getRotationConfig())) return;
  const remaining = new Map<string, number>();
  for (const slot of Array.isArray(before.slots) ? before.slots : []) {
    const key = slot && slotKey(slot);
    if (key) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const slot of Array.isArray(after.slots) ? after.slots : []) {
    const key = slot && slotKey(slot);
    if (!key) continue;
    const count = remaining.get(key) ?? 0;
    if (count > 0) {
      remaining.set(key, count - 1);
      continue;
    }
    const sku = await getSkuRecord(slot.crateSkuId);
    if (sku?.type === "crate" && String(sku.rarity).toLowerCase() === "mythical") {
      await recordRotationEvent(uid, { type: "mythical_crate", occurredAt });
      return;
    }
  }
}

export async function inventoryRotationEvents(uid: string, skuId: string, before: Data, after: Data, occurredAt: number): Promise<void> {
  if (!skuId.startsWith("sku_") || !Number.isFinite(occurredAt) ||
      nonnegativeInteger(after.quantity ?? after.qty) <= nonnegativeInteger(before.quantity ?? before.qty) ||
      !(await getRotationConfig())) return;
  const sku = await getSkuRecord(skuId);
  if (sku?.type === "crate" && String(sku.rarity).toLowerCase() === "mythical") {
    await recordRotationEvent(uid, { type: "mythical_crate", occurredAt });
  }
}

export async function purchaseRotationEvents(before: Data | undefined, after: Data, occurredAt: number): Promise<void> {
  if (before || after.verified !== true || after.grantApplied !== true || typeof after.uid !== "string" ||
      !after.uid || !Number.isFinite(occurredAt) || !(await getRotationConfig())) return;
  await recordRotationEvent(after.uid, { type: "purchase", occurredAt });
}

export const onShopRotationProfile = onDocumentWritten({ document: "Players/{uid}/Profile/Profile", retry: true }, async event => {
  const occurredAt = eventTime(event.time);
  if (!event.data?.after.exists || occurredAt === null) return;
  await profileRotationEvents(event.params.uid, event.data.before.data() ?? {}, event.data.after.data() ?? {}, occurredAt);
});

export const onShopRotationCrateSlots = onDocumentWritten({ document: "Players/{uid}/Crates/Slots", retry: true }, async event => {
  const occurredAt = eventTime(event.time);
  if (!event.data?.after.exists || occurredAt === null) return;
  await crateSlotRotationEvents(event.params.uid, event.data.before.data() ?? {}, event.data.after.data() ?? {}, occurredAt);
});

export const onShopRotationInventory = onDocumentWritten({ document: "Players/{uid}/Inventory/{skuId}", retry: true }, async event => {
  const occurredAt = eventTime(event.time);
  if (!event.data?.after.exists || occurredAt === null) return;
  await inventoryRotationEvents(event.params.uid, event.params.skuId, event.data.before.data() ?? {}, event.data.after.data() ?? {}, occurredAt);
});

export const onShopRotationPurchase = onDocumentWritten({ document: "IapTransactions/{transactionId}", retry: true }, async event => {
  const occurredAt = eventTime(event.time);
  if (!event.data?.after.exists || occurredAt === null) return;
  await purchaseRotationEvents(event.data.before.data(), event.data.after.data() ?? {}, occurredAt);
});
