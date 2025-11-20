import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import {
  listSkusForItem,
  resolveSkuOrThrow,
  getItemsCatalog,
  findVariantBySku,
} from "../core/config.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runReadThenWriteWithReceipt } from "../core/transactions.js";
import { db } from "../shared/firestore.js";
import { REGION } from "../shared/region.js";
import { ItemSku, BoosterSubType, PlayerBoostersState } from "../shared/types.js";
import {
  decSkuQtyOrThrowTx,
  txUpdateInventorySummary,
  createTxInventorySummaryState,
  TxSkuMutationContext,
} from "../inventory/index.js";
import { resolveInventoryContext } from "../shared/inventory.js";

interface ActivateBoosterRequest {
  opId: unknown;
  boosterId: unknown;
}

interface ActivateBoosterResult {
  success: boolean;
  error: string | null;
}

const SUCCESS_RESULT: ActivateBoosterResult = { success: true, error: null } as const;

const normalizeResult = (raw: unknown): ActivateBoosterResult => {
  if (raw && typeof raw === "object") {
    const candidate = raw as { success?: unknown; error?: unknown };
    const success =
      typeof candidate.success === "boolean"
        ? candidate.success
        : candidate.success === undefined
          ? true
          : Boolean(candidate.success);
    if (success) {
      return SUCCESS_RESULT;
    }
    const error =
      typeof candidate.error === "string" && candidate.error.trim().length > 0
        ? candidate.error
        : "Activation failed.";
    return { success: false, error };
  }
  return SUCCESS_RESULT;
};

const readRequest = (data: ActivateBoosterRequest): { opId: string; boosterId: string } => {
  if (typeof data.opId !== "string" || !data.opId.trim()) {
    throw new HttpsError("invalid-argument", "opId must be a non-empty string.");
  }
  if (typeof data.boosterId !== "string" || !data.boosterId.trim()) {
    throw new HttpsError("invalid-argument", "boosterId must be a non-empty string.");
  }
  return { opId: data.opId.trim(), boosterId: data.boosterId.trim() };
};

const resolveBoosterSku = async (boosterId: string): Promise<ItemSku> => {
  if (boosterId.startsWith("sku_")) {
    return resolveSkuOrThrow(boosterId);
  }
  const skus = await listSkusForItem(boosterId);
  if (skus.length === 0) {
    throw new HttpsError("not-found", `Booster ${boosterId} not found in catalog.`);
  }
  return skus[0];
};

const toMillis = (value: unknown): number => {
  if (typeof value === "number") {
    return value;
  }
  if (value instanceof admin.firestore.Timestamp) {
    return value.toMillis();
  }
  return 0;
};

const BOOSTER_DURATION_BY_LABEL: Record<string, number> = {
  "1h": 3600,
  "6h": 21600,
  "12h": 43200,
  "24h": 86400,
};

const BOOSTER_DURATION_BY_PRICE: Record<BoosterSubType, Record<number, number>> = {
  coin: {
    150: 3600,
    450: 21600,
    800: 43200,
    1350: 86400,
  },
  exp: {
    100: 3600,
    300: 21600,
    500: 43200,
    800: 86400,
  },
};

export const activateBooster = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const { opId, boosterId } = readRequest(request.data as ActivateBoosterRequest);

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return normalizeResult(cached);
  }

  await createInProgressReceipt(uid, opId, "activateBooster");

  const boosterSku = await resolveBoosterSku(boosterId);
  if (boosterSku.type !== "booster") {
    throw new HttpsError("failed-precondition", `SKU ${boosterSku.skuId} is not a booster.`);
  }
  const variantInfo = await findVariantBySku(boosterSku.skuId);
  const boosterVariant = variantInfo.variant;
  if (!boosterVariant) {
    throw new HttpsError("failed-precondition", `Booster ${boosterSku.skuId} is missing variant data.`);
  }
  const boosterSubTypeRaw =
    (boosterVariant.subType ?? boosterSku.subType ?? "").toLowerCase();
  if (boosterSubTypeRaw !== "coin" && boosterSubTypeRaw !== "exp") {
    throw new HttpsError("failed-precondition", `Booster ${boosterSku.skuId} has invalid subtype.`);
  }
  let durationSeconds = Number(
    boosterVariant.durationSeconds ?? boosterSku.durationSeconds ?? 0,
  );
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    const { items } = await getItemsCatalog();
    const boosterItem = items?.[boosterSku.itemId];
    const inherentDuration =
      boosterItem && boosterItem.type === "booster"
        ? boosterItem.durationSeconds
        : undefined;
    const fallbackDuration = Number(
      inherentDuration ??
        (boosterItem?.metadata as Record<string, unknown> | undefined)?.durationSeconds ??
        0,
    );
    if (Number.isFinite(fallbackDuration) && fallbackDuration > 0) {
      durationSeconds = fallbackDuration;
    }
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    const label = (
      (boosterVariant.variant as { durationLabel?: unknown } | undefined)?.durationLabel ??
      boosterVariant.displayName ??
      ""
    )
      .toString()
      .toLowerCase();
    if (BOOSTER_DURATION_BY_LABEL[label]) {
      durationSeconds = BOOSTER_DURATION_BY_LABEL[label];
    }
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    const price = Number(boosterVariant.gemPrice ?? boosterSku.gemPrice ?? 0);
    const priceMap = BOOSTER_DURATION_BY_PRICE[boosterSubTypeRaw];
    if (priceMap && Number.isFinite(price) && price > 0 && priceMap[price]) {
      durationSeconds = priceMap[price];
    }
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new HttpsError("failed-precondition", `Booster ${boosterSku.skuId} has invalid duration.`);
  }
  const boosterSubType = boosterSubTypeRaw as BoosterSubType;

  const inventoryCtx = resolveInventoryContext(uid);
  const boosterRef = inventoryCtx.inventoryCollection.doc(boosterSku.skuId);
  const summaryRef = inventoryCtx.summaryRef;

  const result = await runReadThenWriteWithReceipt<{
    timestamp: FirebaseFirestore.FieldValue;
    profileRef: FirebaseFirestore.DocumentReference;
    boostersState: PlayerBoostersState;
    activeUntil: number;
    stackedCount: number;
    boosterContext: TxSkuMutationContext;
    summaryState: ReturnType<typeof createTxInventorySummaryState>;
    serverNowMs: number;
  }, ActivateBoosterResult>(
    uid,
    opId,
    `activateBooster.${boosterSubType}`,
    async (transaction) => {
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      const profileRef = db.doc(`Players/${uid}/Profile/Profile`);
      const [profileSnap, boosterSnap, summarySnap] = await Promise.all([
        transaction.get(profileRef),
        transaction.get(boosterRef),
        transaction.get(summaryRef),
      ]);

      const nowMs = Date.now();
      const durationMs = durationSeconds * 1000;
      const profileData = profileSnap.data() ?? {};
      const boostersState = (profileData.boosters ?? {}) as PlayerBoostersState;
      const currentSlot = boostersState[boosterSubType] ?? { activeUntil: 0, stackedCount: 0 };
      const base = Math.max(nowMs, toMillis(currentSlot.activeUntil));
      const activeUntil = base + durationMs;
      const stackedCount = (currentSlot.stackedCount ?? 0) + 1;

      const boosterData = boosterSnap.data() ?? {};
      const rawQty = boosterData.quantity ?? boosterData.qty;
      const parsedQty = Number(rawQty);
      const currentQty =
        Number.isFinite(parsedQty) && parsedQty > 0 ? Math.floor(parsedQty) : 0;

      const boosterContext: TxSkuMutationContext = {
        quantity: currentQty,
        exists: boosterSnap.exists,
        createdAt: boosterData.createdAt,
        timestamp,
      };

      const summaryState = createTxInventorySummaryState(summaryRef, summarySnap);

      return {
        timestamp,
        profileRef,
        boostersState,
        activeUntil,
        stackedCount,
        boosterContext,
        summaryState,
        serverNowMs: nowMs,
      };
    },
    async (transaction, reads) => {
      let adjustment;
      try {
        adjustment = await decSkuQtyOrThrowTx(
          transaction,
          db,
          uid,
          boosterSku.skuId,
          1,
          reads.boosterContext,
        );
      } catch (err) {
        if (err instanceof HttpsError) {
          throw err;
        }
        const message = err instanceof Error ? err.message : "Failed to consume booster.";
        throw new HttpsError("failed-precondition", message);
      }

      if (adjustment.after < 0) {
        throw new HttpsError("failed-precondition", "Booster inventory underflow.");
      }

      await txUpdateInventorySummary(
        transaction,
        db,
        uid,
        { [boosterSku.skuId]: -1 },
        { state: reads.summaryState, timestamp: reads.timestamp },
      );

      transaction.set(
        reads.profileRef,
        {
          boosters: {
            ...reads.boostersState,
            [boosterSubType]: {
              activeUntil: reads.activeUntil,
              stackedCount: reads.stackedCount,
            },
          } satisfies PlayerBoostersState,
          boostersServerClock: {
            serverNowMs: reads.serverNowMs,
            updatedAt: reads.timestamp,
          },
          updatedAt: reads.timestamp,
        },
        { merge: true },
      );

      return SUCCESS_RESULT;
    },
  );

  return result;
});
