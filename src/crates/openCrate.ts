/**
 * openCrate — Instant Crate Open (No Keys, No Timers)
 *
 * Flow:
 *  1. Player purchases a crate from the shop (crate SKU lands in inventory).
 *  2. Player calls openCrate({ opId, crateId }).
 *  3. Server consumes 1 crate SKU from inventory.
 *  4. Rolls rewards using CrateRewardsConfig:
 *     - N random cosmetics matching the crate's rarity
 *     - M random catalog items (coins, gems, boosters, speed-ups)
 *  5. Grants all rewards instantly (inventory + economy).
 *  6. Returns the full list of awarded items.
 */

import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import {
  getCratesCatalogDoc,
  listSkusByFilter,
} from "../core/config.js";
import {
  getCrateRewardsConfig,
} from "../core/configV2.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import { db } from "../shared/firestore.js";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { CrateDefinition } from "../shared/types.js";
import {
  AwardedItem,
  CrateRewardItem,
} from "../shared/typesV2.js";
import { grantInventoryRewards } from "../shared/inventoryAwards.js";
import {
  decSkuQtyOrThrowTx,
} from "../inventory/index.js";
import { maybeTriggerFlashSales } from "../triggers/flashSales.js";

// =============================================================================
// TYPES
// =============================================================================

const MAX_CRATE_QUANTITY = 50;

interface OpenCrateRequest {
  opId: unknown;
  crateId: unknown;
  quantity?: unknown;
}

interface OpenCrateResult {
  success: true;
  opId: string;
  crateId: string;
  crateSkuId: string;
  quantity: number;
  cratesOpened: number;
  awarded: AwardedItem[];
  economyChanges: {
    coins?: number;
    gems?: number;
  };
}

// =============================================================================
// INPUT VALIDATION
// =============================================================================

const readRequest = (data: OpenCrateRequest): { opId: string; crateId: string; quantity: number } => {
  if (typeof data.opId !== "string" || !data.opId.trim()) {
    throw new HttpsError("invalid-argument", "opId must be a non-empty string.");
  }
  if (typeof data.crateId !== "string" || !data.crateId.trim()) {
    throw new HttpsError("invalid-argument", "crateId must be a non-empty string.");
  }
  let quantity = 1;
  if (data.quantity !== undefined && data.quantity !== null) {
    const parsed = Math.floor(Number(data.quantity));
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new HttpsError("invalid-argument", "quantity must be a positive integer.");
    }
    quantity = Math.min(parsed, MAX_CRATE_QUANTITY);
  }
  return { opId: data.opId.trim(), crateId: data.crateId.trim(), quantity };
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

// =============================================================================
// REWARD HELPERS
// =============================================================================

/** Fisher-Yates shuffle (in-place) */
function shuffleArray<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Weighted random pick from a reward pool */
function weightedRandomPick(pool: CrateRewardItem[]): CrateRewardItem | null {
  if (pool.length === 0) return null;
  const totalWeight = pool.reduce((sum, item) => sum + item.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const item of pool) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return pool[pool.length - 1];
}

// =============================================================================
// MAIN FUNCTION
// =============================================================================

export const openCrate = onCall(
  callableOptions(
    { minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 },
    true,
  ),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "User must be authenticated.");
    }

    const { opId, crateId, quantity } = readRequest(request.data as OpenCrateRequest);

    // ── Idempotency ──
    const cached = await checkIdempotency(uid, opId);
    if (cached) {
      return cached as OpenCrateResult;
    }
    await createInProgressReceipt(uid, opId, "openCrate");

    // ── Load configs (outside transaction) ──
    const [cratesDoc, crateRewardsConfig, cosmeticSkus] = await Promise.all([
      getCratesCatalogDoc(),
      getCrateRewardsConfig(),
      listSkusByFilter({ category: "cosmetic" }),
    ]);

    const crate = ensureCrate(cratesDoc, crateId);
    const crateSkuId =
      (typeof crate.crateSkuId === "string" && crate.crateSkuId.trim()) ||
      (typeof crate.skuId === "string" && crate.skuId.trim()) ||
      null;

    if (!crateSkuId) {
      throw new HttpsError(
        "failed-precondition",
        `Crate ${crateId} is missing a crateSkuId / skuId.`,
      );
    }

    const crateRarity = (crate.rarity ?? "common").toLowerCase();

    // ── Determine reward pool ──
    const rewardPool =
      crateRewardsConfig?.rewardsByRarity?.[crateRarity] ??
      crateRewardsConfig?.rewardsByRarity?.["common"];

    if (!rewardPool) {
      throw new HttpsError("internal", `No reward pool configured for rarity: ${crateRarity}`);
    }

    // ── Roll rewards for ALL crates ──
    const matchingCosmetics = cosmeticSkus.filter(
      (sku) => (sku.rarity?.toLowerCase() ?? "") === crateRarity,
    );

    const awardedItems: AwardedItem[] = [];
    const inventoryGrants: Array<{ skuId: string; quantity: number }> = [];
    const economyChanges: { coins: number; gems: number } = { coins: 0, gems: 0 };

    for (let c = 0; c < quantity; c++) {
      // 1. Pick random cosmetics of this rarity (fresh shuffle per crate)
      const cosmeticsToAward = Math.min(rewardPool.cosmeticCount, matchingCosmetics.length);
      const selectedCosmetics = shuffleArray([...matchingCosmetics]).slice(0, cosmeticsToAward);

      for (const cosmetic of selectedCosmetics) {
        awardedItems.push({
          type: "cosmetic",
          displayName: cosmetic.displayName ?? cosmetic.itemDisplayName ?? cosmetic.skuId,
          quantity: 1,
          rarity: cosmetic.rarity ?? crateRarity,
          skuId: cosmetic.skuId,
          itemId: cosmetic.itemId,
        });
        inventoryGrants.push({ skuId: cosmetic.skuId, quantity: 1 });
      }

      // 2. Pick random catalog items (coins, gems, boosters, speed-ups)
      for (let i = 0; i < rewardPool.catalogItemCount; i++) {
        const picked = weightedRandomPick(rewardPool.rewardPool);
        if (!picked) continue;

        const item: AwardedItem = {
          type: picked.type,
          displayName: picked.displayName,
          quantity: picked.quantity,
        };

        if (picked.durationHours) {
          item.durationHours = picked.durationHours;
        }

        if (picked.type === "coins") {
          economyChanges.coins += picked.quantity;
        } else if (picked.type === "gems") {
          economyChanges.gems += picked.quantity;
        } else if (picked.skuId) {
          item.skuId = picked.skuId;
          inventoryGrants.push({ skuId: picked.skuId, quantity: picked.quantity });
        }

        awardedItems.push(item);
      }
    }

    // ── Transaction: consume crates + grant everything ──
    //
    // IMPORTANT: Firestore requires ALL reads before ANY writes.
    // Order: 1. Pre-read crate doc (READ)
    //        2. grantInventoryRewards — reads reward docs + summary (READS), then writes them (WRITES)
    //        3. decSkuQtyOrThrowTx with pre-read context — write only (WRITE)
    //        4. Economy update — write only (WRITE)
    //
    const result = await runTransactionWithReceipt<OpenCrateResult>(
      uid,
      opId,
      "openCrate",
      async (transaction) => {
        const timestamp = admin.firestore.FieldValue.serverTimestamp();
        const economyRef = db.doc(`/Players/${uid}/Economy/Stats`);
        const inventoryCtx = db.doc(`/Players/${uid}/Inventory/${crateSkuId}`);

        // ── PHASE 1: PRE-READ the crate doc (before any writes happen) ──
        const crateSnap = await transaction.get(inventoryCtx);
        const crateData = crateSnap.data() ?? {};
        const crateQty = Math.floor(Number(crateData.quantity ?? crateData.qty ?? 0));

        if (!Number.isFinite(crateQty) || crateQty < quantity) {
          throw new HttpsError(
            "failed-precondition",
            `Insufficient quantity: need ${quantity}, have ${crateQty} of crate SKU ${crateSkuId}.`,
          );
        }

        // ── PHASE 2: grantInventoryRewards (reads reward docs + summary, then writes them) ──
        if (inventoryGrants.length > 0) {
          await grantInventoryRewards(transaction, uid, inventoryGrants, { timestamp });
        }

        // ── PHASE 3: Decrement crate with pre-read context (WRITE ONLY, no read needed) ──
        await decSkuQtyOrThrowTx(transaction, db, uid, crateSkuId, quantity, {
          quantity: crateQty,
          exists: crateSnap.exists,
          createdAt: crateData.createdAt,
          timestamp,
        });

        // ── PHASE 4: Economy changes (WRITE ONLY) ──
        if (economyChanges.coins > 0 || economyChanges.gems > 0) {
          const economyUpdate: Record<string, FirebaseFirestore.FieldValue> = {
            updatedAt: timestamp,
          };
          if (economyChanges.coins > 0) {
            economyUpdate.coins = admin.firestore.FieldValue.increment(economyChanges.coins);
          }
          if (economyChanges.gems > 0) {
            economyUpdate.gems = admin.firestore.FieldValue.increment(economyChanges.gems);
          }
          transaction.update(economyRef, economyUpdate);
        }

        return {
          success: true as const,
          opId,
          crateId,
          crateSkuId,
          quantity,
          cratesOpened: quantity,
          awarded: awardedItems,
          economyChanges: {
            ...(economyChanges.coins > 0 ? { coins: economyChanges.coins } : {}),
            ...(economyChanges.gems > 0 ? { gems: economyChanges.gems } : {}),
          },
        };
      },
    );

    // Fire-and-forget: check flash sale triggers
    try {
      await maybeTriggerFlashSales({ uid });
    } catch (error) {
      logger.warn("Flash sale trigger failed after crate open", { uid, error });
    }

    return result;
  },
);
