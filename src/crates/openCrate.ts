import { createHash } from "node:crypto";

import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import {
  getCratesCatalogDoc,
  listSkusForItem,
  resolveSkuOrThrow,
} from "../core/config.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runReadThenWriteWithReceipt } from "../core/transactions.js";
import { db } from "../shared/firestore.js";
import { REGION } from "../shared/region.js";
import { CrateDefinition, ItemSku } from "../shared/types.js";
import {
  decSkuQtyOrThrowTx,
  incSkuQtyTx,
  txUpdateInventorySummary,
  createTxInventorySummaryState,
  TxSkuMutationContext,
} from "../inventory/index.js";
import { resolveInventoryContext } from "../shared/inventory.js";

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
}

interface NormalisedDropEntry {
  skuId?: string;
  itemId?: string;
  weight: number;
  quantity: number;
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

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normaliseQuantityValue = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
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

const buildDropEntries = (crate: CrateDefinition): NormalisedDropEntry[] => {
  const entries: NormalisedDropEntry[] = [];
  const pushEntry = (entry: NormalisedDropEntry) => {
    if ((!entry.skuId && !entry.itemId) || entry.weight <= 0) {
      return;
    }
    entries.push({
      skuId: entry.skuId,
      itemId: entry.itemId,
      weight: entry.weight,
      quantity: Math.max(1, entry.quantity),
    });
  };

  const rawDropTable = (crate as unknown as { dropTable?: unknown }).dropTable;
  const dropTable = Array.isArray(rawDropTable) ? rawDropTable : [];
  for (const raw of dropTable as Array<Record<string, unknown>>) {
    const weight = normaliseQuantityValue(raw?.weight, 0);
    if (weight <= 0) {
      continue;
    }
    const skuId =
      typeof raw?.skuId === "string" && raw.skuId.trim().length > 0
        ? raw.skuId.trim()
        : undefined;
    const itemId =
      typeof raw?.itemId === "string" && raw.itemId.trim().length > 0
        ? raw.itemId.trim()
        : undefined;
    const quantity = normaliseQuantityValue(raw?.quantity, 1);
    pushEntry({ skuId, itemId, weight, quantity });
  }

  const loot = (crate as unknown as { loot?: unknown }).loot;
  const ingestLootValue = (value: unknown, context: string) => {
    if (typeof value === "string" && value.trim().length > 0) {
      pushEntry({ skuId: value.trim(), weight: 1, quantity: 1 });
      return;
    }
    if (isPlainObject(value)) {
      const skuId =
        typeof value.skuId === "string" && value.skuId.trim().length > 0
          ? value.skuId.trim()
          : undefined;
      const itemId =
        typeof value.itemId === "string" && value.itemId.trim().length > 0
          ? value.itemId.trim()
          : undefined;
      const weight = normaliseQuantityValue(value.weight, 1);
      const quantity = normaliseQuantityValue(value.quantity, 1);
      pushEntry({ skuId, itemId, weight, quantity });
    }
  };

  if (Array.isArray(loot)) {
    loot.forEach((entry, index) => ingestLootValue(entry, `loot[${index}]`));
  } else if (isPlainObject(loot)) {
    for (const [key, value] of Object.entries(loot)) {
      if (key === "itemSkus" && Array.isArray(value)) {
        value.forEach((entry, index) => ingestLootValue(entry, `loot.itemSkus[${index}]`));
        continue;
      }
      ingestLootValue(value, `loot.${key}`);
    }
  }

  return entries;
};

const pickFromCrate = async (
  crate: CrateDefinition,
  seed: Buffer,
): Promise<PickedReward> => {
  const entries = buildDropEntries(crate);
  if (entries.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      `Crate ${crate.crateId} has no loot entries.`,
    );
  }

  const totalWeight = entries.reduce((sum, entry) => sum + entry.weight, 0);
  const random = seed.readUInt32BE(0);
  const roll = totalWeight > 0 ? random % totalWeight : 0;

  let selected: NormalisedDropEntry | null = null;
  let cursor = 0;
  for (const entry of entries) {
    cursor += entry.weight;
    if (roll < cursor) {
      selected = entry;
      break;
    }
  }
  if (!selected) {
    selected = entries[entries.length - 1];
  }

  const { sku, sourceItemId, variantRoll } = await resolveEntrySku(
    selected,
    seed,
  );

  return {
    sku,
    quantity: selected.quantity,
    sourceItemId,
    metadata: {
      weight: selected.weight,
      totalWeight,
      roll,
      variantRoll,
      sourceItemId,
    },
  };
};

const resolveEntrySku = async (
  entry: NormalisedDropEntry,
  seed: Buffer,
): Promise<{ sku: ItemSku; sourceItemId: string | null; variantRoll?: number }> => {
  if (entry.skuId) {
    const sku = await resolveSkuOrThrow(entry.skuId);
    const sourceItemId =
      entry.itemId && entry.itemId.length > 0 ? entry.itemId : sku.itemId;
    return { sku, sourceItemId };
  }

  if (!entry.itemId) {
    throw new HttpsError(
      "failed-precondition",
      "Crate drop entry is missing skuId and itemId.",
    );
  }

  const skus = await listSkusForItem(entry.itemId);
  if (skus.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      `Crate references unknown item ${entry.itemId}.`,
    );
  }
  if (skus.length === 1) {
    return { sku: skus[0], sourceItemId: entry.itemId };
  }

  const variantSeed = createHash("sha256")
    .update(seed)
    .update(`:${entry.itemId}`)
    .digest();
  const variantRoll = variantSeed.readUInt32BE(0);
  const selectedIndex = variantRoll % skus.length;
  return {
    sku: skus[selectedIndex],
    sourceItemId: entry.itemId,
    variantRoll,
  };
};

const applyDelta = (
  target: Record<string, number>,
  skuId: string,
  delta: number,
) => {
  target[skuId] = (target[skuId] ?? 0) + delta;
};

export const openCrate = onCall({ region: REGION }, async (request) => {
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

  return result;
});
