import { db } from "../shared/firestore.js";
import {
  txIncSkuQty,
  txUpdateInventorySummary,
  TxInventorySummaryState,
  TxSkuDocState,
} from "../inventory/index.js";
import { ReferralSkuReward } from "./types.js";

export interface AwardResult {
  skuId: string;
  qty: number;
  previous: number;
  next: number;
}

export interface AwardInventoryContext {
  skuStates: Map<string, TxSkuDocState>;
  summaryState: TxInventorySummaryState;
}

export const awardReferralRewards = async (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  rewards: ReferralSkuReward[],
  timestamp: FirebaseFirestore.FieldValue,
  context: AwardInventoryContext,
): Promise<AwardResult[]> => {
  if (rewards.length === 0) {
    return [];
  }
  if (!context) {
    throw new Error("awardReferralRewards requires inventory context.");
  }

  const summaryDelta: Record<string, number> = {};
  const results: AwardResult[] = [];

  for (const reward of rewards) {
    if (!reward || typeof reward.skuId !== "string") {
      continue;
    }
    const qty = Math.floor(Number(reward.qty));
    if (!Number.isFinite(qty) || qty <= 0) {
      continue;
    }

    const state = context.skuStates.get(reward.skuId);
    if (!state) {
      throw new Error(`Missing inventory state for sku ${reward.skuId}`);
    }

    const adjustment = await txIncSkuQty(transaction, db, uid, reward.skuId, qty, {
      state,
      timestamp,
    });

    summaryDelta[reward.skuId] = (summaryDelta[reward.skuId] ?? 0) + qty;
    results.push({
      skuId: reward.skuId,
      qty,
      previous: adjustment.previous,
      next: adjustment.next,
    });
  }

  if (Object.keys(summaryDelta).length > 0) {
    await txUpdateInventorySummary(transaction, db, uid, summaryDelta, {
      state: context.summaryState,
      timestamp,
    });
  }

  return results;
};
