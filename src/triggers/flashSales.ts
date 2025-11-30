import * as admin from "firebase-admin";

import { db } from "../shared/firestore.js";
import { ActiveSpecialOffer, SpecialOfferTriggerType } from "../shared/types.js";
import { activeOffersRef, normaliseActiveOffers, pruneExpiredSpecialOffers } from "../shop/offerState.js";
import { loadOfferLadderIndex } from "../shop/offerCatalog.js";

const MYTHICAL_CRATE_SKU = "sku_kgkjadrd79";
const MYTHICAL_KEY_SKU = "sku_hq5ywspmr5";
const FLASH_DURATION_MS = 15 * 60 * 1000;
const FLASH_COOLDOWN_MS = 72 * 60 * 60 * 1000;

type InventorySnapshot = {
  mythicalCrates?: number;
  mythicalKeys?: number;
};

export interface FlashSaleTriggerOptions {
  uid: string;
  inventory?: InventorySnapshot;
  now?: number;
  transaction?: FirebaseFirestore.Transaction;
}

export interface FlashSaleTriggerResult {
  triggered: ActiveSpecialOffer[];
}

const needsKey = (snapshot: InventorySnapshot): boolean =>
  (snapshot.mythicalCrates ?? 0) > 0 && (snapshot.mythicalKeys ?? 0) === 0;

const needsCrate = (snapshot: InventorySnapshot): boolean =>
  (snapshot.mythicalKeys ?? 0) > 0 && (snapshot.mythicalCrates ?? 0) === 0;

const getInventoryQty = async (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  skuId: string,
): Promise<number> => {
  const ref = db.doc(`Players/${uid}/Inventory/${skuId}`);
  const snapshot = await transaction.get(ref);
  const data = snapshot.data() ?? {};
  const raw = Number(data.quantity ?? data.qty);
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.floor(raw));
};

const resolveInventoryState = async (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  override?: InventorySnapshot,
): Promise<InventorySnapshot> => {
  if (override) {
    return {
      mythicalCrates: Math.max(0, Math.floor(override.mythicalCrates ?? 0)),
      mythicalKeys: Math.max(0, Math.floor(override.mythicalKeys ?? 0)),
    };
  }
  const [crates, keys] = await Promise.all([
    getInventoryQty(transaction, uid, MYTHICAL_CRATE_SKU),
    getInventoryQty(transaction, uid, MYTHICAL_KEY_SKU),
  ]);
  return { mythicalCrates: crates, mythicalKeys: keys };
};

const historyRef = (uid: string) => db.doc(`Players/${uid}/Offers/History`);

const canTrigger = (
  trigger: SpecialOfferTriggerType,
  lastTriggerAt: Record<string, number> | undefined,
  now: number,
): boolean => {
  const last = Number(lastTriggerAt?.[trigger] ?? 0);
  return !Number.isFinite(last) || last <= 0 || last + FLASH_COOLDOWN_MS <= now;
};

const runWithTransaction = async (
  options: FlashSaleTriggerOptions,
  ladderIndexOfferIds: Partial<Record<SpecialOfferTriggerType, string>>,
): Promise<FlashSaleTriggerResult | null> => {
  const now = options.now ?? Date.now();
  const work = async (
    transaction: FirebaseFirestore.Transaction,
  ): Promise<FlashSaleTriggerResult | null> => {
    const inventory = await resolveInventoryState(transaction, options.uid, options.inventory);
    const triggers: SpecialOfferTriggerType[] = [];
    if (needsKey(inventory)) {
      triggers.push("flash_missing_key");
    }
    if (needsCrate(inventory)) {
      triggers.push("flash_missing_crate");
    }
    if (triggers.length === 0) {
      return null;
    }

    const activeRef = activeOffersRef(options.uid);
    const [activeSnap, historySnap] = await Promise.all([
      transaction.get(activeRef),
      transaction.get(historyRef(options.uid)),
    ]);
    const state = normaliseActiveOffers(activeSnap.data());
    state.special = pruneExpiredSpecialOffers(state.special, now);
    const lastTriggerAt = (historySnap.data()?.lastTriggerAt ?? {}) as Record<string, number>;

    const triggeredOffers: ActiveSpecialOffer[] = [];
    let specialUpdated = false;
    let historyUpdated = false;

    triggers.forEach((trigger) => {
      if (!canTrigger(trigger, lastTriggerAt, now)) {
        return;
      }
      const offerId = ladderIndexOfferIds[trigger];
      if (!offerId) {
        return;
      }
      if (state.special.some((entry) => entry.triggerType === trigger && entry.expiresAt > now)) {
        return;
      }
      const expiresAt = now + FLASH_DURATION_MS;
      state.special = [
        ...pruneExpiredSpecialOffers(state.special, now),
        { offerId, triggerType: trigger, expiresAt },
      ];
      triggeredOffers.push({ offerId, triggerType: trigger, expiresAt });
      lastTriggerAt[trigger] = now;
      specialUpdated = true;
      historyUpdated = true;
    });

    if (!triggeredOffers.length) {
      return null;
    }

    if (specialUpdated) {
      transaction.set(
        activeRef,
        {
          special: state.special,
          updatedAt: now,
        },
        { merge: true },
      );
    }

    if (historyUpdated) {
      transaction.set(
        historyRef(options.uid),
        {
          lastTriggerAt,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    return { triggered: triggeredOffers };
  };

  if (options.transaction) {
    return await work(options.transaction);
  }
  return await db.runTransaction(work);
};

export const maybeTriggerFlashSales = async (
  options: FlashSaleTriggerOptions,
): Promise<FlashSaleTriggerResult | null> => {
  const ladderIndex = await loadOfferLadderIndex();
  if (
    !ladderIndex.flashOfferIds.flash_missing_crate &&
    !ladderIndex.flashOfferIds.flash_missing_key
  ) {
    return null;
  }
  return runWithTransaction(options, ladderIndex.flashOfferIds);
};
