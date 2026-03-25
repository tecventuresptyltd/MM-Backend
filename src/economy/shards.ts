import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";

const db = admin.firestore();

// =============================================================================
// TYPES
// =============================================================================

interface ShardPackage {
  shards: number;
  gemCost: number;
}

const SHARD_PACKAGES: Record<string, ShardPackage> = {
  shards_50:   { shards: 50,   gemCost: 10 },
  shards_100:  { shards: 100,  gemCost: 10 },
  shards_500:  { shards: 500,  gemCost: 10 },
  shards_1000: { shards: 1000, gemCost: 10 },
};

interface PurchaseShardsRequest {
  opId: string;
  packageId: string;
}

interface PurchaseShardsResponse {
  success: boolean;
  opId: string;
  packageId: string;
  shardsGranted: number;
  gemsSpent: number;
  shardsBefore: number;
  shardsAfter: number;
}

// =============================================================================
// MAIN FUNCTION
// =============================================================================

export const purchaseShards = onCall(
  callableOptions({ minInstances: getMinInstances(false), memory: "256MiB" }, true),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "User must be authenticated.");
    }

    const { opId, packageId } = request.data as PurchaseShardsRequest;

    if (typeof opId !== "string" || !opId.trim()) {
      throw new HttpsError("invalid-argument", "opId must be a non-empty string.");
    }
    if (typeof packageId !== "string" || !packageId.trim()) {
      throw new HttpsError("invalid-argument", "packageId must be a non-empty string.");
    }

    const shardPackage = SHARD_PACKAGES[packageId];
    if (!shardPackage) {
      throw new HttpsError(
        "invalid-argument",
        `Invalid packageId: ${packageId}. Valid options: ${Object.keys(SHARD_PACKAGES).join(", ")}`,
      );
    }

    const existingResult = await checkIdempotency(uid, opId);
    if (existingResult !== null) {
      return existingResult as PurchaseShardsResponse;
    }

    await createInProgressReceipt(uid, opId, `Purchase ${shardPackage.shards} shards for ${shardPackage.gemCost} gems`);

    return await runTransactionWithReceipt<PurchaseShardsResponse>(
      uid,
      opId,
      "purchaseShards",
      async (transaction) => {
        const statsRef = db.doc(`/Players/${uid}/Economy/Stats`);
        const statsDoc = await transaction.get(statsRef);

        if (!statsDoc.exists) {
          throw new HttpsError("not-found", "Player economy stats not found.");
        }

        const stats = statsDoc.data()!;
        const playerGems = stats.gems ?? 0;
        const shardsBefore = stats.spellShards ?? 0;

        if (playerGems < shardPackage.gemCost) {
          throw new HttpsError(
            "failed-precondition",
            `Insufficient gems. Required: ${shardPackage.gemCost}, Available: ${playerGems}.`,
          );
        }

        const shardsAfter = shardsBefore + shardPackage.shards;

        transaction.update(statsRef, {
          gems: admin.firestore.FieldValue.increment(-shardPackage.gemCost),
          spellShards: admin.firestore.FieldValue.increment(shardPackage.shards),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
          success: true,
          opId,
          packageId,
          shardsGranted: shardPackage.shards,
          gemsSpent: shardPackage.gemCost,
          shardsBefore,
          shardsAfter,
        };
      },
    );
  },
);
