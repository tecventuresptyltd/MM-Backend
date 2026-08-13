import * as admin from "firebase-admin";

import { db } from "./firestore.js";
import {
  InventoryGrant,
  InventoryGrantPlan,
  applyInventoryGrants,
  prepareInventoryGrants,
} from "./inventoryAwards.js";
import { GrantedReward, RewardKind, RewardLine, describeRewardLines } from "./rewardLines.js";

export type { RewardKind, RewardLine, GrantedReward };
export { describeRewardLines, normaliseRewardLines } from "./rewardLines.js";

export interface RewardBundlePlan {
  coins: number;
  gems: number;
  inventory: InventoryGrantPlan;
  economyRef: FirebaseFirestore.DocumentReference;
  economyBefore: { coins: number; gems: number };
  lines: RewardLine[];
}

export interface RewardBundleResult {
  rewards: GrantedReward[];
  coins: { before: number; after: number };
  gems: { before: number; after: number };
}

/**
 * READ PHASE. Loads the economy doc and every inventory doc the bundle touches.
 */
export const prepareRewardBundle = async (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  lines: RewardLine[],
): Promise<RewardBundlePlan> => {
  const economyRef = db.doc(`Players/${uid}/Economy/Stats`);
  const economySnap = await transaction.get(economyRef);
  const economyData = economySnap.exists ? economySnap.data() ?? {} : {};

  let coins = 0;
  let gems = 0;
  const inventoryGrants: InventoryGrant[] = [];

  for (const line of lines) {
    if (line.kind === "coins") {
      coins += line.quantity;
    } else if (line.kind === "gems") {
      gems += line.quantity;
    } else {
      inventoryGrants.push({ skuId: line.skuId!, quantity: line.quantity });
    }
  }

  const inventory = await prepareInventoryGrants(transaction, uid, inventoryGrants);

  return {
    coins,
    gems,
    inventory,
    economyRef,
    economyBefore: {
      coins: Number(economyData.coins ?? 0),
      gems: Number(economyData.gems ?? 0),
    },
    lines,
  };
};

/**
 * WRITE PHASE. Applies a plan produced by `prepareRewardBundle`. Issues no reads.
 */
export const applyRewardBundle = async (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  plan: RewardBundlePlan,
  options?: { timestamp?: FirebaseFirestore.FieldValue },
): Promise<RewardBundleResult> => {
  const timestamp = options?.timestamp ?? admin.firestore.FieldValue.serverTimestamp();

  if (plan.coins > 0 || plan.gems > 0) {
    // set+merge rather than update: a player whose Economy/Stats doc is somehow
    // missing should still receive the reward instead of hitting NOT_FOUND.
    transaction.set(
      plan.economyRef,
      {
        ...(plan.coins > 0 ? { coins: admin.firestore.FieldValue.increment(plan.coins) } : {}),
        ...(plan.gems > 0 ? { gems: admin.firestore.FieldValue.increment(plan.gems) } : {}),
        updatedAt: timestamp,
      },
      { merge: true },
    );
  }

  await applyInventoryGrants(transaction, uid, plan.inventory, { timestamp });

  return {
    rewards: describeRewardLines(plan.lines),
    coins: { before: plan.economyBefore.coins, after: plan.economyBefore.coins + plan.coins },
    gems: { before: plan.economyBefore.gems, after: plan.economyBefore.gems + plan.gems },
  };
};
