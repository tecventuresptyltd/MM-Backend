import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { onCall, HttpsError } from "firebase-functions/v2/https";

import { getOffersCatalog, getRanksCatalog } from "../core/config.js";
import { checkIdempotency, createInProgressReceipt, completeOperation } from "../core/idempotency.js";
import { grantInventoryRewards, InventoryGrantResult } from "../shared/inventoryAwards.js";

export const offers = onCall(
  { region: "us-central1" },
  async () => {
    logger.info("offers called");
    return await getOffersCatalog();
  }
);

export const exchangeGemsForCoins = onCall(
  { region: "us-central1" },
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
    const conversionRate = 100; // 1 gem = 100 coins
    const coinsGained = gemAmount * conversionRate;

    try {
      const result = await db.runTransaction(async (transaction) => {
        const playerEconomyRef = db.doc(`/Players/${uid}/Economy/Stats`);
        const playerEconomyDoc = await transaction.get(playerEconomyRef);

        if (!playerEconomyDoc.exists) {
          throw new HttpsError("not-found", "Player economy data not found.");
        }

        const economyData = playerEconomyDoc.data();
        if (!economyData || economyData.gems < gemAmount) {
          throw new HttpsError("resource-exhausted", "Insufficient gems.");
        }

        transaction.update(playerEconomyRef, {
          gems: admin.firestore.FieldValue.increment(-gemAmount),
          coins: admin.firestore.FieldValue.increment(coinsGained),
        });

        return { success: true, coinsGained, gemsSpent: gemAmount };
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
  { region: "us-central1" },
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
        const playerProfileRef = db.doc(`/Players/${uid}/Profile/Profile`);
        const playerProfileDoc = await transaction.get(playerProfileRef);
        const profileData = playerProfileDoc.data();
    
        if (!playerProfileDoc.exists || !profileData) {
          throw new HttpsError("not-found", "Player profile not found.");
        }
    
        const playerProgressRef = db.doc(`/Players/${uid}/Progress/ClaimedRewards`);
        const playerProgressDoc = await transaction.get(playerProgressRef);
        const progressData = playerProgressDoc.data() || {};
    
        if (progressData[rankId]) {
          throw new HttpsError("already-exists", "Rank reward already claimed.");
        }
    
        const ranksCatalog = await getRanksCatalog();
        const rankGameData = ranksCatalog.find(rank => rank.rankId === rankId);
    
        if (!rankGameData) {
          throw new HttpsError("not-found", "Rank game data not found in catalog.");
        }
    
        if ((profileData.trophies || 0) < rankGameData.minMmr) {
          throw new HttpsError("failed-precondition", "Player has not reached this rank yet.");
        }

        const playerEconomyRef = db.doc(`/Players/${uid}/Economy/Stats`);
        transaction.update(playerEconomyRef, {
          coins: admin.firestore.FieldValue.increment(rankGameData.rewards.coins || 0),
          gems: admin.firestore.FieldValue.increment(rankGameData.rewards.gems || 0),
        });

        let inventoryGrants: InventoryGrantResult[] = [];
        const inventoryRewards = Array.isArray(rankGameData.rewards.inventory)
          ? rankGameData.rewards.inventory
          : [];
        if (inventoryRewards.length > 0) {
          inventoryGrants = await grantInventoryRewards(transaction, uid, inventoryRewards);
        }

        transaction.set(playerProgressRef, {
          [rankId]: true,
        }, { merge: true });

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

export const getLeaderboard = onCall(
  { region: "us-central1" },
  async (request) => {
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
