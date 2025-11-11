import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region.js";
import { getRanksCatalog } from "../core/config.js";
import { getLevelInfo } from "../shared/xp.js";

const db = admin.firestore();

export const startRace = onCall({ enforceAppCheck: false, region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User is not authenticated.");
  }

  const { lobbyRatings, playerIndex } = request.data;
  if (!Array.isArray(lobbyRatings) || typeof playerIndex !== "number") {
    throw new HttpsError("invalid-argument", "Invalid arguments provided.");
  }

  const raceId = db.collection("Races").doc().id;
  const preDeductedTrophies = -5; // Simplified penalty

  return db.runTransaction(async (transaction) => {
    const profileRef = db.doc(`/Players/${uid}/Profile/Profile`);
    
    transaction.update(profileRef, {
      trophies: admin.firestore.FieldValue.increment(preDeductedTrophies),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const raceRef = db.doc(`/Races/${raceId}`);
    transaction.set(raceRef, {
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const participantRef = db.doc(`/Races/${raceId}/Participants/${uid}`);
    transaction.set(participantRef, { preDeductedTrophies });

    return { success: true, raceId, preDeductedTrophies };
  });
});

export const generateBotLoadout = onCall({ region: REGION }, async (request) => {
  const { trophyCount } = request.data;
  if (typeof trophyCount !== "number") {
    throw new HttpsError("invalid-argument", "trophyCount must be a number.");
  }

  const carId = "bot_car";
  const cosmetics = { wheels: "bot_wheels" };
  const spellDeck = ["bot_spell1", "bot_spell2"];
  const difficulty = { aiLevel: Math.min(10, Math.floor(trophyCount / 100)) };

  return { carId, cosmetics, spellDeck, difficulty };
});

export const recordRaceResult = onCall({ enforceAppCheck: false, region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User is not authenticated.");
  }

  const { raceId, finishOrder } = request.data;
  if (typeof raceId !== "string" || !Array.isArray(finishOrder)) {
    throw new HttpsError("invalid-argument", "Invalid arguments provided.");
  }

  return db.runTransaction(async (transaction) => {
    const raceRef = db.doc(`/Races/${raceId}`);
    const raceDoc = await transaction.get(raceRef);

    if (!raceDoc.exists || raceDoc.data()?.status !== "pending") {
      throw new HttpsError("failed-precondition", "Race is not pending or does not exist.");
    }

    const economyRef = db.doc(`/Players/${uid}/Economy/Stats`);
    const profileRef = db.doc(`/Players/${uid}/Profile/Profile`);
    const [economyDoc, profileDoc] = await transaction.getAll(economyRef, profileRef);

    if (!economyDoc.exists || !profileDoc.exists) {
      throw new HttpsError("not-found", "Player data not found.");
    }

    const playerPosition = finishOrder.indexOf(uid);
    const isFirstPlace = playerPosition === 0;

    const profileData = profileDoc.data()!;

    // Simplified reward calculation based on rank
    const ranksCatalog = await getRanksCatalog();
    const playerRank = ranksCatalog.find(rank => rank.minMmr <= (profileData.trophies || 0));
    const trophiesGained = playerRank ? 20 - playerRank.minMmr / 100 : 10;
    const coinsGained = playerRank ? 100 + playerRank.minMmr / 10 : 50;
    const xpGained = playerRank ? 50 + playerRank.minMmr / 20 : 25;
    
    const newTrophies = (profileData.trophies || 0) + trophiesGained;
    const newHighestTrophies = Math.max(profileData.highestTrophies || 0, newTrophies);
    const xpBefore = Number(profileData.exp ?? 0);
    const xpAfter = xpBefore + xpGained;
    const beforeInfo = getLevelInfo(xpBefore);
    const afterInfo = getLevelInfo(xpAfter);
    const levelsGained = afterInfo.level - beforeInfo.level;

    // Update Economy/Stats (no trophies here)
    const economyUpdate: Record<string, admin.firestore.FieldValue> = {
      coins: admin.firestore.FieldValue.increment(coinsGained),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (levelsGained > 0) {
      economyUpdate.spellTokens = admin.firestore.FieldValue.increment(levelsGained);
    }
    transaction.update(economyRef, economyUpdate);

    // Update Profile/Profile (trophies belong here)
    const profileUpdate: { [key: string]: number | admin.firestore.FieldValue } = {
        trophies: admin.firestore.FieldValue.increment(trophiesGained),
        exp: xpAfter,
        level: afterInfo.level,
        expProgress: afterInfo.expInLevel,
        expToNextLevel: afterInfo.expToNext,
        careerCoins: admin.firestore.FieldValue.increment(coinsGained),
        highestTrophies: newHighestTrophies,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    // Increment race counters
    profileUpdate.totalRaces = admin.firestore.FieldValue.increment(1);
    if (isFirstPlace) {
      profileUpdate.totalWins = admin.firestore.FieldValue.increment(1);
    }
    transaction.update(profileRef, profileUpdate);

    transaction.update(raceRef, { status: "settled", updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    return {
      success: true,
      rewards: {
        trophies: trophiesGained,
        coins: coinsGained,
        xp: xpGained,
      },
      xpProgress: {
        xpBefore,
        xpAfter,
        levelBefore: beforeInfo.level,
        levelAfter: afterInfo.level,
        expInLevelBefore: beforeInfo.expInLevel,
        expInLevelAfter: afterInfo.expInLevel,
        expToNextLevel: afterInfo.expToNext,
      },
    };
  });
});
