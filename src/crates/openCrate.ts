import { createHash } from "node:crypto";

import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import {
  getCratesCatalogDoc,
  getItemSkusCatalog,
  listSkusForItem,
  resolveSkuOrThrow,
} from "../core/config.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runReadThenWriteWithReceipt } from "../core/transactions.js";
import { db } from "../shared/firestore.js";
import { REGION } from "../shared/region.js";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { CrateDefinition, ItemSku } from "../shared/types.js";
import {
  decSkuQtyOrThrowTx,
  incSkuQtyTx,
  txUpdateInventorySummary,
  createTxInventorySummaryState,
  TxSkuMutationContext,
} from "../inventory/index.js";
import { resolveInventoryContext } from "../shared/inventory.js";
import { maybeTriggerFlashSales } from "../triggers/flashSales.js";

interface OpenCrateRequest {
  opId: unknown;
  crateId: unknown;
}

interface DropRollMetadata {
  weight: number;
  totalWeight: number;
  roll: number;
  variantRoll?: number;
  sourceItemId?: string | null;
  rarity?: string;
  poolSize?: number;
}

interface PickedReward {
  sku: ItemSku;
  quantity: number;
  metadata: DropRollMetadata;
  sourceItemId: string | null;
}

interface OpenCrateResult {
  success: true;
  opId: string;
  crateId: string;
  crateSkuId: string;
  awarded: {
    skuId: string;
    itemId: string;
    type: ItemSku["type"];
    rarity: string;
    quantity: number;
    alreadyOwned: boolean;
    metadata: DropRollMetadata;
  };
  counts: Record<string, number>;
}

const normaliseWeightValue = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return parsed;
};

const normaliseSkuList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      ids.push(entry.trim());
    }
  }
  return ids;
};

interface RarityPoolEntry {
  rarity: string;
  weight: number;
  pool: string[];
}

const isDefaultSku = (sku: ItemSku | undefined): boolean =>
  Boolean(sku?.displayName && sku.displayName.toLowerCase().includes("default"));

const isCosmeticSku = (sku: ItemSku | undefined): boolean => sku?.type === "cosmetic";

const extractRarityPoolEntries = (crate: CrateDefinition): RarityPoolEntry[] => {
  const weights = crate.rarityWeights ?? {};
  const pools = crate.poolsByRarity ?? {};
  if (!weights || !pools) {
    return [];
  }
  const entries: RarityPoolEntry[] = [];
  for (const [rarity, weightValue] of Object.entries(weights)) {
    const weight = normaliseWeightValue(weightValue);
    if (weight <= 0) {
      continue;
    }
    const pool = normaliseSkuList(pools[rarity as keyof typeof pools]);
    if (pool.length === 0) {
      continue;
    }
    entries.push({
      rarity,
      weight,
      pool,
    });
  }
  return entries;
};

const pickFromRarityPools = async (
  crate: CrateDefinition,
  seed: Buffer,
  entries: RarityPoolEntry[],
): Promise<PickedReward> => {
  if (entries.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      `Crate ${crate.crateId} has no rarity pools configured.`,
    );
  }

  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) {
    throw new HttpsError(
      "failed-precondition",
      `Crate ${crate.crateId} has invalid rarity weights.`,
    );
  }

  const baseRoll = seed.readUInt32BE(0);
  const roll = (baseRoll / 0x100000000) * totalWeight;

  let selected = entries[entries.length - 1];
  let cursor = 0;
  for (const entry of entries) {
    cursor += entry.weight;
    if (roll < cursor) {
      selected = entry;
      break;
    }
  }

  const poolSeed = createHash("sha256")
    .update(seed)
    .update(`:${crate.crateId}:${selected.rarity}`)
    .digest();
  const poolRoll = poolSeed.readUInt32BE(0);
  const selectedIndex = poolRoll % selected.pool.length;
  const selectedSkuId = selected.pool[selectedIndex];
  const sku = await resolveSkuOrThrow(selectedSkuId);
  const sourceItemId = sku.itemId ?? null;

  return {
    sku,
    quantity: 1,
    sourceItemId,
    metadata: {
      weight: selected.weight,
      totalWeight,
      roll,
      variantRoll: poolRoll,
      sourceItemId,
      rarity: selected.rarity,
      poolSize: selected.pool.length,
    },
  };
};

const readRequest = (data: OpenCrateRequest): { opId: string; crateId: string } => {
  if (typeof data.opId !== "string" || !data.opId.trim()) {
    throw new HttpsError("invalid-argument", "opId must be a non-empty string.");
  }
  if (typeof data.crateId !== "string" || !data.crateId.trim()) {
    throw new HttpsError("invalid-argument", "crateId must be a non-empty string.");
  }
  return { opId: data.opId.trim(), crateId: data.crateId.trim() };
};

const ensureCrate = (
  cratesDoc: { crates: Record<string, CrateDefinition> },
  crateId: string,
): CrateDefinition => {
  const crate = cratesDoc.crates[crateId];
  if (!crate) {
    throw new HttpsError("not-found", `Crate ${crateId} not found.`);
  }
  return crate;
};

const resolveCrateSkuId = async (
  crate: CrateDefinition,
): Promise<string> => {
  const candidateCrateSku =
    typeof crate.crateSkuId === "string" && crate.crateSkuId.trim().length > 0
      ? crate.crateSkuId.trim()
      : null;
  if (candidateCrateSku) {
    await resolveSkuOrThrow(candidateCrateSku);
    return candidateCrateSku;
  }
  const candidate = typeof crate.skuId === "string" && crate.skuId.trim().length > 0
    ? crate.skuId.trim()
    : null;
  if (candidate) {
    await resolveSkuOrThrow(candidate);
    return candidate;
  }

  const legacyId = typeof crate.crateId === "string" ? crate.crateId.trim() : "";
  if (!legacyId) {
    throw new HttpsError(
      "failed-precondition",
      `Crate ${crate.crateId} is missing a skuId.`,
    );
  }

  const skus = await listSkusForItem(legacyId);
  if (skus.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      `Crate ${crate.crateId} references unknown item ${legacyId}.`,
    );
  }
  return skus[0].skuId;
};

const resolveKeySkuId = async (
  crate: CrateDefinition,
): Promise<string | null> => {
  const direct = typeof crate.keySkuId === "string" ? crate.keySkuId.trim() : "";
  if (direct) {
    await resolveSkuOrThrow(direct);
    return direct;
  }
  const legacy = typeof crate.keyItemId === "string" ? crate.keyItemId.trim() : "";
  if (!legacy) {
    return null;
  }
  const skus = await listSkusForItem(legacy);
  if (skus.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      `Crate ${crate.crateId} references unknown key item ${legacy}.`,
    );
  }
  return skus[0].skuId;
};

const pickFromCrate = async (
  crate: CrateDefinition,
  seed: Buffer,
): Promise<PickedReward> => {
  const rarityEntries = extractRarityPoolEntries(crate);
  const itemSkusCatalog = await getItemSkusCatalog();
  const filteredEntries = rarityEntries
    .map((entry) => ({
      ...entry,
      pool: entry.pool.filter((skuId) => {
        const sku = itemSkusCatalog[skuId];
        if (!sku) {
          return false;
        }
        if (isDefaultSku(sku)) {
          return false;
        }
        return isCosmeticSku(sku);
      }),
    }))
    .filter((entry) => entry.pool.length > 0);
  if (filteredEntries.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      `Crate ${crate.crateId} has no cosmetic rarity-weighted pools configured.`,
    );
  }
  return pickFromRarityPools(crate, seed, filteredEntries);
};

const applyDelta = (
  target: Record<string, number>,
  skuId: string,
  delta: number,
) => {
  target[skuId] = (target[skuId] ?? 0) + delta;
};

export const openCrate = onCall(callableOptions({ minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true), async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const { opId, crateId } = readRequest(request.data as OpenCrateRequest);

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as OpenCrateResult;
  }

  await createInProgressReceipt(uid, opId, "openCrate");

  const cratesDoc = await getCratesCatalogDoc();
  const crate = ensureCrate(cratesDoc, crateId);
  const crateSkuId = await resolveCrateSkuId(crate);
  const keySkuId = await resolveKeySkuId(crate);

  const seed = createHash("sha256")
    .update(`${uid}:${opId}:${crateId}`)
    .digest();
  const reward = await pickFromCrate(crate, seed);

  const inventoryCtx = resolveInventoryContext(uid);
  const crateRef = inventoryCtx.inventoryCollection.doc(crateSkuId);
  const keyRef = keySkuId ? inventoryCtx.inventoryCollection.doc(keySkuId) : null;
  const rewardRef = inventoryCtx.inventoryCollection.doc(reward.sku.skuId);
  const summaryRef = inventoryCtx.summaryRef;

  const result = await runReadThenWriteWithReceipt<{
    timestamp: FirebaseFirestore.FieldValue;
    crateContext: TxSkuMutationContext;
    keyContext?: TxSkuMutationContext;
    rewardContext: TxSkuMutationContext;
    summaryState: ReturnType<typeof createTxInventorySummaryState>;
    existingRewardQty: number;
  }, OpenCrateResult>(
    uid,
    opId,
    `openCrate.${crateId}`,
    async (transaction) => {
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      const readRefs: Array<Promise<FirebaseFirestore.DocumentSnapshot>> = [
        transaction.get(crateRef),
      ];
      if (keyRef) {
        readRefs.push(transaction.get(keyRef));
      }
      readRefs.push(transaction.get(rewardRef));
      readRefs.push(transaction.get(summaryRef));

      const snapshots = await Promise.all(readRefs);
      let index = 0;
      const crateSnap = snapshots[index++];
      const keySnap =
        keyRef !== null ? snapshots[index++] : null;
      const rewardSnap = snapshots[index++];
      const summarySnap = snapshots[index++];

      const readQuantity = (
        snap: FirebaseFirestore.DocumentSnapshot,
      ): number => {
        const data = snap.data() ?? {};
        const value = data.quantity ?? data.qty;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return 0;
        }
        return Math.floor(parsed);
      };

      const crateContext: TxSkuMutationContext = {
        quantity: readQuantity(crateSnap),
        exists: crateSnap.exists,
        createdAt: (crateSnap.data() ?? {}).createdAt,
        timestamp,
      };

      let keyContext: TxSkuMutationContext | undefined;
      if (keyRef && keySnap) {
        keyContext = {
          quantity: readQuantity(keySnap),
          exists: keySnap.exists,
          createdAt: (keySnap.data() ?? {}).createdAt,
          timestamp,
        };
      }

      const rewardQty = readQuantity(rewardSnap);
      if (reward.sku.stackable === false && rewardQty > 0) {
        throw new HttpsError(
          "failed-precondition",
          `SKU ${reward.sku.skuId} already owned; non-stackable rewards cannot be granted again.`,
        );
      }

      const rewardContext: TxSkuMutationContext = {
        quantity: rewardQty,
        exists: rewardSnap.exists,
        createdAt: (rewardSnap.data() ?? {}).createdAt,
        timestamp,
      };

      const summaryState = createTxInventorySummaryState(summaryRef, summarySnap);

      return {
        timestamp,
        crateContext,
        keyContext,
        rewardContext,
        summaryState,
        existingRewardQty: rewardQty,
      };
    },
    async (transaction, reads) => {
      const rewardMetadata = {
        weight: reward.metadata.weight,
        totalWeight: reward.metadata.totalWeight,
        roll: reward.metadata.roll,
        sourceItemId: reward.metadata.sourceItemId ?? null,
        ...(reward.metadata.variantRoll !== undefined
          ? { variantRoll: reward.metadata.variantRoll }
          : {}),
      };

      const summaryChanges: Record<string, number> = {};
      const countsAfter: Record<string, number> = {};

      let crateAdj;
      try {
        crateAdj = await decSkuQtyOrThrowTx(
          transaction,
          db,
          uid,
          crateSkuId,
          1,
          reads.crateContext,
        );
      } catch (error) {
        const rawMessage =
          error instanceof Error && typeof error.message === "string" && error.message.trim().length > 0
            ? error.message
            : String(error ?? "Insufficient quantity");
        const normalizedMessage = /Insufficient quantity/i.test(rawMessage)
          ? rawMessage
          : "Insufficient quantity";
        if (/Insufficient quantity/i.test(normalizedMessage)) {
          throw new HttpsError("failed-precondition", normalizedMessage);
        }
        throw error;
      }
      countsAfter[crateSkuId] = crateAdj.after;
      applyDelta(summaryChanges, crateSkuId, -1);

      if (keySkuId && reads.keyContext) {
        let keyAdj;
        try {
          keyAdj = await decSkuQtyOrThrowTx(
            transaction,
            db,
            uid,
            keySkuId,
            1,
            reads.keyContext,
          );
        } catch (error) {
          const rawMessage =
            error instanceof Error && typeof error.message === "string" && error.message.trim().length > 0
              ? error.message
              : String(error ?? "Insufficient quantity");
          const normalizedMessage = /Insufficient quantity/i.test(rawMessage)
            ? rawMessage
            : "Insufficient quantity";
          if (/Insufficient quantity/i.test(normalizedMessage)) {
            throw new HttpsError("failed-precondition", normalizedMessage);
          }
          throw error;
        }
        countsAfter[keySkuId] = keyAdj.after;
        applyDelta(summaryChanges, keySkuId, -1);
      }

      const rewardAdj = await incSkuQtyTx(
        transaction,
        db,
        uid,
        reward.sku.skuId,
        reward.quantity,
        reads.rewardContext,
      );
      countsAfter[reward.sku.skuId] = rewardAdj.after;
      applyDelta(summaryChanges, reward.sku.skuId, reward.quantity);

      if (Object.keys(summaryChanges).length > 0) {
        await txUpdateInventorySummary(transaction, db, uid, summaryChanges, {
          state: reads.summaryState,
          timestamp: reads.timestamp,
        });
      }

      const alreadyOwned = reads.existingRewardQty > 0;

      return {
        success: true,
        opId,
        crateId,
        crateSkuId,
        awarded: {
          skuId: reward.sku.skuId,
          itemId: reward.sku.itemId,
          type: reward.sku.type,
          rarity: reward.sku.rarity,
          quantity: reward.quantity,
          alreadyOwned,
          metadata: rewardMetadata,
        },
        counts: countsAfter,
      };
    },
  );

  try {
    await maybeTriggerFlashSales({ uid });
  } catch (error) {
    logger.warn("Flash sale trigger failed after crate open", { uid, error });
  }

  return result;
});
