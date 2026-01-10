import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";

import { getOffersCatalog, getRanksCatalog, resolveSkuOrThrow } from "../core/config.js";
import { checkIdempotency, createInProgressReceipt, completeOperation } from "../core/idempotency.js";
import { grantInventoryRewards, InventoryGrantResult } from "../shared/inventoryAwards.js";
import { calculateGemConversionRate } from "./rates.js";

export const offers = onCall(
  { region: "us-central1" },
  async () => {
    logger.info("offers called");
    return await getOffersCatalog();
  }
);

export const exchangeGemsForCoins = onCall(
  callableOptions({ minInstances: getMinInstances(true), memory: "256MiB" }, true),
  async (request) => {
    const { data, auth } = request;
    const uid = auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "User is not authenticated.");
    }

    const { opId, gemAmount } = data as { opId: string; gemAmount: number };
    if (typeof opId !== "string") {
      throw new HttpsError("invalid-argument", "opId must be a string.");
    }
    if (typeof gemAmount !== "number" || gemAmount <= 0) {
      throw new HttpsError("invalid-argument", "gemAmount must be a positive number.");
    }

    // Check for existing operation
    const existingResult = await checkIdempotency(uid, opId);
    if (existingResult !== null) {
      return existingResult;
    }

    // Create in-progress receipt
    await createInProgressReceipt(uid, opId, `Exchange ${gemAmount} gems for coins`);

    const db = admin.firestore();

    try {
      const result = await db.runTransaction(async (transaction) => {
        const playerEconomyRef = db.doc(`/Players/${uid}/Economy/Stats`);
        const playerProfileRef = db.doc(`/Players/${uid}/Profile/Profile`);

        const [playerEconomyDoc, playerProfileDoc] = await Promise.all([
          transaction.get(playerEconomyRef),
          transaction.get(playerProfileRef),
        ]);

        if (!playerEconomyDoc.exists) {
          throw new HttpsError("not-found", "Player economy data not found.");
        }
        if (!playerProfileDoc.exists) {
          throw new HttpsError("not-found", "Player profile data not found.");
        }

        const economyData = playerEconomyDoc.data();
        if (!economyData || economyData.gems < gemAmount) {
          throw new HttpsError("resource-exhausted", "Insufficient gems.");
        }

        const trophies = Number(playerProfileDoc.data()?.trophies ?? 0);
        const conversionRate = calculateGemConversionRate(trophies);
        const coinsGained = gemAmount * conversionRate;

        transaction.update(playerEconomyRef, {
          gems: admin.firestore.FieldValue.increment(-gemAmount),
          coins: admin.firestore.FieldValue.increment(coinsGained),
        });

        return { success: true, coinsGained, gemsSpent: gemAmount, conversionRate };
      });

      // Complete the operation with result
      await completeOperation(uid, opId, result);
      logger.info(`exchangeGemsForCoins called for user ${uid}`);
      return result;
    } catch (error) {
      // If transaction failed, we leave the in-progress receipt as is
      // The next retry will create a new operation since this one failed
      throw error;
    }
  }
);

export const claimRankUpReward = onCall(
  callableOptions({ minInstances: getMinInstances(true), memory: "256MiB" }, true),
  async (request) => {
    const { data, auth } = request;
    const uid = auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "User is not authenticated.");
    }

    const { opId, rankId } = data as { opId: string; rankId: string };
    if (typeof opId !== "string") {
      throw new HttpsError("invalid-argument", "opId must be a string.");
    }
    if (typeof rankId !== "string") {
      throw new HttpsError("invalid-argument", "rankId must be a string.");
    }

    // Load catalog once and validate rank + reward SKUs before entering the transaction.
    const ranksCatalog = await getRanksCatalog();
    const rankGameData = ranksCatalog.find((rank) => rank.rankId === rankId);
    if (!rankGameData) {
      throw new HttpsError("not-found", `Rank game data not found for ${rankId}.`);
    }
    const inventoryRewards = Array.isArray(rankGameData.rewards.inventory)
      ? rankGameData.rewards.inventory
      : [];
    try {
      await Promise.all(inventoryRewards.map((grant) => resolveSkuOrThrow(grant.skuId)));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpsError("failed-precondition", `Invalid reward SKU: ${message}`);
    }

    // Check for existing operation
    const existingResult = await checkIdempotency(uid, opId);
    if (existingResult !== null) {
      return existingResult;
    }

    // Create in-progress receipt
    await createInProgressReceipt(uid, opId, `Claim rank up reward ${rankId}`);

    const db = admin.firestore();

    try {
      const result = await db.runTransaction(async (transaction) => {
        // Reads first
        const playerProfileRef = db.doc(`/Players/${uid}/Profile/Profile`);
        const playerProgressRef = db.doc(`/Players/${uid}/Progress/ClaimedRewards`);
        const playerEconomyRef = db.doc(`/Players/${uid}/Economy/Stats`);

        const [playerProfileDoc, playerProgressDoc, playerEconomyDoc] = await Promise.all([
          transaction.get(playerProfileRef),
          transaction.get(playerProgressRef),
          transaction.get(playerEconomyRef),
        ]);

        const profileData = playerProfileDoc.data();
        if (!playerProfileDoc.exists || !profileData) {
          throw new HttpsError("not-found", "Player profile not found.");
        }

        const progressData = playerProgressDoc.data() || {};
        if (progressData[rankId]) {
          throw new HttpsError("already-exists", "Rank reward already claimed.");
        }

        if ((profileData.trophies || 0) < rankGameData.minMmr) {
          throw new HttpsError("failed-precondition", "Player has not reached this rank yet.");
        }

        // Inventory writes (includes its own reads) happen before any other writes.
        let inventoryGrants: InventoryGrantResult[] = [];
        if (inventoryRewards.length > 0) {
          inventoryGrants = await grantInventoryRewards(transaction, uid, inventoryRewards);
        }

        // Economy write(s)
        if (!playerEconomyDoc.exists) {
          transaction.set(
            playerEconomyRef,
            {
              coins: 0,
              gems: 0,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
        }
        transaction.update(playerEconomyRef, {
          coins: admin.firestore.FieldValue.increment(rankGameData.rewards.coins || 0),
          gems: admin.firestore.FieldValue.increment(rankGameData.rewards.gems || 0),
        });

        // Mark reward claimed
        transaction.set(
          playerProgressRef,
          {
            [rankId]: true,
          },
          { merge: true },
        );

        return { success: true, rewards: rankGameData.rewards, inventoryGrants };
      });

      // Complete the operation with result
      await completeOperation(uid, opId, result);
      logger.info(`claimRankUpReward called for user ${uid}`);
      return result;
    } catch (error) {
      // If transaction failed, we leave the in-progress receipt as is
      // The next retry will create a new operation since this one failed
      throw error;
    }
  }
);

export const getLeaderboard = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async (request) => {
  const { data } = request;
  const { leaderboardType, pageSize, startAfter } = data as { leaderboardType: string, pageSize: number, startAfter?: unknown };

  if (typeof leaderboardType !== "string" || typeof pageSize !== "number") {
    throw new HttpsError("invalid-argument", "leaderboardType must be a string and pageSize must be a number.");
  }

  const db = admin.firestore();
  let query = db.collection("Players").orderBy(leaderboardType, "desc").limit(pageSize);

  if (startAfter) {
    query = query.startAfter(startAfter);
  }

  const snapshot = await query.get();
  const players = snapshot.docs.map((doc) => doc.data());
  const nextPageToken = snapshot.docs[snapshot.docs.length - 1];

  logger.info("getLeaderboard called");
  return { players, nextPageToken };
}
);
