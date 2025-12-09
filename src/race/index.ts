import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region.js";
import { getLevelInfo } from "../shared/xp.js";
import { refreshFriendSnapshots } from "../Socials/updateSnapshots.js";
import { grantInventoryRewards } from "../shared/inventoryAwards.js";
import { maybeTriggerFlashSales } from "../triggers/flashSales.js";
import { buildBotLoadout } from "../game-systems/botLoadoutHelper.js";
import {
  DEFAULT_COIN_CONFIG,
  DEFAULT_EXP_CONFIG,
  DEFAULT_TROPHY_CONFIG,
  RaceInputsWithPrededuction,
  calculateLastPlaceDelta,
  computeRaceRewardsWithPrededuction,
  getRankForTrophies,
  RANK_LABELS,
  toMillis,
} from "./economy.js";
import { PlayerBoostersState } from "../shared/types.js";

const db = admin.firestore();

type RaceDrop = {
  type: string;
  skuId: string | null;
};

type BotDrop = {
  bot: string;
  drop: RaceDrop;
};

type RaceDropResolution = {
  playerDrop: RaceDrop;
  botDrops: BotDrop[];
};

const RACE_REWARD_TABLE: Array<{ type: string; weight: number; skuId?: string | null }> = [
  { type: "noreward", weight: 27.9, skuId: null },
  { type: "commoncrate", weight: 20, skuId: "sku_zz3twgp0wx" },
  { type: "rarecrate", weight: 7.5, skuId: "sku_72wnqwtfmx" },
  { type: "exoticcrate", weight: 5, skuId: "sku_e8e7jeba7v" },
  { type: "legendarycrate", weight: 2.5, skuId: "sku_n9hsc0wxxk" },
  { type: "mythicalcrate", weight: 1.5, skuId: "sku_kgkjadrd79" },
  { type: "commonkey", weight: 20, skuId: "sku_rjwe5tdtc4" },
  { type: "rarekey", weight: 7.5, skuId: "sku_p3yxnyhkpx" },
  { type: "exotickey", weight: 5, skuId: "sku_zqqmqz7mwb" },
  { type: "legendarykey", weight: 2.5, skuId: "sku_acxbr542j1" },
  { type: "mythicalkey", weight: 0.6, skuId: "sku_hq5ywspmr5" },
];

const TOTAL_REWARD_WEIGHT = RACE_REWARD_TABLE.reduce((sum, entry) => sum + entry.weight, 0);

const rollRaceDrop = (): RaceDrop => {
  const roll = Math.random() * TOTAL_REWARD_WEIGHT;
  let cursor = 0;
  for (const entry of RACE_REWARD_TABLE) {
    cursor += entry.weight;
    if (roll <= cursor) {
      return { type: entry.type, skuId: entry.skuId ?? null };
    }
  }
  return { type: "noreward", skuId: null };
};

const resolveRaceDrops = async (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  botNames: string[],
): Promise<RaceDropResolution> => {
  const playerDrop = rollRaceDrop();
  if (playerDrop.skuId) {
    await grantInventoryRewards(transaction, uid, [
      { skuId: playerDrop.skuId, quantity: 1 },
    ]);
  }
  const botDrops = botNames.map((bot) => ({
    bot,
    drop: rollRaceDrop(),
  }));
  return { playerDrop, botDrops };
};

const normaliseBotNames = (botNames: unknown): string[] => {
  if (!Array.isArray(botNames)) {
    return [];
  }
  return botNames
    .map((name) => (typeof name === "string" ? name.trim() : ""))
    .filter((name) => name.length > 0);
};

type LobbySnapshotEntry = {
  rating: number;
  participantId: string | null;
};

const TROPHY_CONFIG = DEFAULT_TROPHY_CONFIG;
const COIN_CONFIG = DEFAULT_COIN_CONFIG;
const EXP_CONFIG = DEFAULT_EXP_CONFIG;

const sanitizeTrophyCount = (value: unknown): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 0;
};

const rankIndex = (label: string): number => {
  const idx = RANK_LABELS.indexOf(label);
  return idx >= 0 ? idx : 0;
};

const coerceLobbyEntry = (entry: unknown): LobbySnapshotEntry => {
  if (typeof entry === "number") {
    return { rating: Math.round(entry), participantId: null };
  }
  if (typeof entry === "string" && entry.trim().length > 0) {
    const parsed = Number(entry);
    if (!Number.isNaN(parsed)) {
      return { rating: Math.round(parsed), participantId: null };
    }
  }
  if (typeof entry === "object" && entry !== null) {
    const entity = entry as Record<string, unknown>;
    const ratingSource =
      entity.rating ??
      entity.trophies ??
      entity.mmr ??
      entity.value ??
      entity.score ??
      0;
    const ratingNumber = Number(ratingSource);
    const participantId =
      typeof entity.participantId === "string"
        ? entity.participantId
        : typeof entity.uid === "string"
          ? entity.uid
          : typeof entity.playerId === "string"
            ? entity.playerId
            : typeof entity.id === "string"
              ? entity.id
              : null;
    return {
      rating: Number.isFinite(ratingNumber) ? Math.round(ratingNumber) : 0,
      participantId,
    };
  }
  throw new HttpsError("invalid-argument", "Each lobbyRatings entry must be numeric or object-like.");
};

const normalizeLobbySnapshot = (raw: unknown, uid: string, playerIndex: number): LobbySnapshotEntry[] => {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpsError("invalid-argument", "lobbyRatings must be a non-empty array.");
  }
  if (!Number.isInteger(playerIndex) || playerIndex < 0 || playerIndex >= raw.length) {
    throw new HttpsError("invalid-argument", "playerIndex is out of range for lobbyRatings.");
  }
  const normalized = raw.map((entry) => coerceLobbyEntry(entry));
  normalized[playerIndex] = {
    rating: normalized[playerIndex].rating,
    participantId: uid,
  };
  return normalized;
};

const buildFinishOrderIndexes = (
  finishOrderInput: unknown,
  snapshot: LobbySnapshotEntry[],
  uid: string,
  playerIndex: number,
): number[] => {
  const total = snapshot.length;
  const participantIndexById = new Map<string, number>();
  snapshot.forEach((entry, idx) => {
    if (entry.participantId) {
      participantIndexById.set(entry.participantId, idx);
    }
  });
  participantIndexById.set(uid, playerIndex);

  const resolved: number[] = [];
  const seen = new Set<number>();
  const pushIndex = (idx: number | null) => {
    if (idx === null) return;
    if (idx < 0 || idx >= total || seen.has(idx)) return;
    resolved.push(idx);
    seen.add(idx);
  };

  const tokens = Array.isArray(finishOrderInput) ? finishOrderInput : [];
  tokens.forEach((token) => {
    let idx: number | null = null;
    if (typeof token === "number" && Number.isInteger(token)) {
      idx = token;
    } else if (typeof token === "string") {
      if (participantIndexById.has(token)) {
        idx = participantIndexById.get(token)!;
      } else {
        const parsed = Number(token);
        if (Number.isInteger(parsed)) {
          idx = parsed;
        }
      }
    } else if (typeof token === "object" && token !== null) {
      const record = token as Record<string, unknown>;
      const candidate =
        typeof record.participantId === "string"
          ? record.participantId
          : typeof record.uid === "string"
            ? record.uid
            : typeof record.id === "string"
              ? record.id
              : null;
      if (typeof candidate === "string" && participantIndexById.has(candidate)) {
        idx = participantIndexById.get(candidate)!;
      }
    }
    pushIndex(idx);
  });

  for (let i = 0; i < total; i += 1) {
    if (!seen.has(i)) {
      resolved.push(i);
      seen.add(i);
    }
  }
  return resolved;
};

export const startRace = onCall({ enforceAppCheck: false, region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User is not authenticated.");
  }

  const { lobbyRatings, playerIndex } = request.data;
  if (typeof playerIndex !== "number") {
    throw new HttpsError("invalid-argument", "playerIndex must be a number.");
  }

  const lobbySnapshot = normalizeLobbySnapshot(lobbyRatings, uid, playerIndex);
  const ratingVector = lobbySnapshot.map((entry) => entry.rating);

  const raceId = db.collection("Races").doc().id;
  const preDeductedTrophies = calculateLastPlaceDelta(playerIndex, ratingVector, TROPHY_CONFIG);

  const result = await db.runTransaction(async (transaction) => {
    const profileRef = db.doc(`/Players/${uid}/Profile/Profile`);
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    const profileSnap = await transaction.get(profileRef);
    if (!profileSnap.exists) {
      throw new HttpsError("failed-precondition", "Player profile not found.");
    }
    const currentTrophies = sanitizeTrophyCount(profileSnap.data()?.trophies);
    const appliedPreDeduction =
      // Never remove more trophies up front than the player currently has.
      preDeductedTrophies < 0 ? Math.max(preDeductedTrophies, -currentTrophies) : preDeductedTrophies;
    const trophiesAfterPreDeduct = Math.max(0, currentTrophies + appliedPreDeduction);

    transaction.update(profileRef, {
      trophies: trophiesAfterPreDeduct,
      updatedAt: timestamp,
    });

    const raceRef = db.doc(`/Races/${raceId}`);
    transaction.set(raceRef, {
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
      lobbySnapshot: lobbySnapshot.map((entry) => ({
        rating: entry.rating,
        participantId: entry.participantId,
      })),
    });

    const participantRef = db.doc(`/Races/${raceId}/Participants/${uid}`);
    transaction.set(participantRef, {
      preDeductedTrophies: appliedPreDeduction,
      playerIndex,
      createdAt: timestamp,
    });

    return { success: true, raceId, preDeductedTrophies: appliedPreDeduction };
  });

  await refreshFriendSnapshots(uid);
  return result;
});

export const generateBotLoadout = onCall({ region: REGION }, async (request) => {
  const { trophyCount } = request.data ?? {};
  if (typeof trophyCount !== "number" || trophyCount < 0) {
    throw new HttpsError("invalid-argument", "trophyCount must be a non-negative number.");
  }

  const loadout = await buildBotLoadout(trophyCount);
  return {
    carId: loadout.carId,
    cosmetics: loadout.cosmetics,
    spellDeck: loadout.spellDeck,
    difficulty: loadout.difficulty,
  };
});

export const recordRaceResult = onCall({ enforceAppCheck: false, region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User is not authenticated.");
  }

  const { raceId, finishOrder, botNames } = request.data;
  if (typeof raceId !== "string" || !Array.isArray(finishOrder)) {
    throw new HttpsError("invalid-argument", "Invalid arguments provided.");
  }
  const botDisplayNames = normaliseBotNames(botNames);

  const result = await db.runTransaction(async (transaction) => {
    const raceRef = db.doc(`/Races/${raceId}`);
    const raceDoc = await transaction.get(raceRef);

    if (!raceDoc.exists || raceDoc.data()?.status !== "pending") {
      throw new HttpsError("failed-precondition", "Race is not pending or does not exist.");
    }

    const economyRef = db.doc(`/Players/${uid}/Economy/Stats`);
    const profileRef = db.doc(`/Players/${uid}/Profile/Profile`);
    const participantRef = db.doc(`/Races/${raceId}/Participants/${uid}`);
    const [economyDoc, profileDoc, participantDoc] = await transaction.getAll(
      economyRef,
      profileRef,
      participantRef,
    );

    if (!economyDoc.exists || !profileDoc.exists || !participantDoc.exists) {
      throw new HttpsError("not-found", "Player data not found.");
    }

    const profileData = profileDoc.data()!;
    const participantData = participantDoc.data() ?? {};
    const playerIndex = Number(participantData.playerIndex);
    const lastPlaceDeltaApplied = Number.isFinite(Number(participantData.preDeductedTrophies))
      ? Math.floor(Number(participantData.preDeductedTrophies))
      : 0;
    const currentTrophies = Number.isFinite(Number(profileData.trophies))
      ? Math.floor(Number(profileData.trophies))
      : 0;
    const trophiesBeforeRace = Math.max(0, currentTrophies - lastPlaceDeltaApplied);
    if (!Number.isInteger(playerIndex)) {
      throw new HttpsError("failed-precondition", "Player index missing for race participant.");
    }

    const lobbySnapshotRaw = raceDoc.data()?.lobbySnapshot;
    if (!Array.isArray(lobbySnapshotRaw) || lobbySnapshotRaw.length === 0) {
      throw new HttpsError("failed-precondition", "Race lobby snapshot missing.");
    }
    if (playerIndex < 0 || playerIndex >= lobbySnapshotRaw.length) {
      throw new HttpsError("failed-precondition", "Player index is out of lobby snapshot range.");
    }

    const lobbySnapshot: LobbySnapshotEntry[] = lobbySnapshotRaw.map((entry: any, idx: number) => {
      const ratingValue = Number(entry?.rating ?? 0);
      const participantId =
        typeof entry?.participantId === "string"
          ? entry.participantId
          : idx === playerIndex
            ? uid
            : null;
      return {
        rating: Number.isFinite(ratingValue) ? Math.round(ratingValue) : 0,
        participantId,
      };
    });
    lobbySnapshot[playerIndex] = {
      rating: lobbySnapshot[playerIndex]?.rating ?? 0,
      participantId: uid,
    };

    const ratingsVector = lobbySnapshot.map((entry) => entry.rating);
    const finishOrderIndexes = buildFinishOrderIndexes(finishOrder, lobbySnapshot, uid, playerIndex);
    const placeIndex = finishOrderIndexes.indexOf(playerIndex);
    const resolvedPlaceIndex = placeIndex >= 0 ? placeIndex : finishOrderIndexes.length - 1;
    const place = resolvedPlaceIndex + 1;
    const totalPositions = ratingsVector.length;

    if (totalPositions === 0) {
      throw new HttpsError("failed-precondition", "Lobby snapshot is empty.");
    }

    const boostersState = (profileData.boosters ?? {}) as PlayerBoostersState;
    const nowMs = Date.now();
    const hasCoinBooster = toMillis(boostersState.coin?.activeUntil) > nowMs;
    const hasExpBooster = toMillis(boostersState.exp?.activeUntil) > nowMs;

    const xpBefore = Number(profileData.exp ?? 0);
    const beforeInfo = getLevelInfo(xpBefore);

    const rewardInput: RaceInputsWithPrededuction = {
      playerIndex,
      finishOrder: finishOrderIndexes,
      ratings: ratingsVector,
      place,
      totalPositions,
      hasCoinBooster,
      hasExpBooster,
      lastPlaceDeltaApplied,
      placeIndexForI: resolvedPlaceIndex,
    };
    const rewards = computeRaceRewardsWithPrededuction(
      rewardInput,
      TROPHY_CONFIG,
      COIN_CONFIG,
      EXP_CONFIG,
    );

    const coinsGained = rewards.coins;
    const xpGained = rewards.exp;
    const desiredTrophiesActual = rewards.trophiesActual;

    // Apply a floor so trophy losses cannot push the player below zero (including pre-deducted losses).
    const appliedActualTrophiesDelta = Math.max(desiredTrophiesActual, -trophiesBeforeRace);
    const appliedTrophiesSettlement = appliedActualTrophiesDelta - lastPlaceDeltaApplied;
    const trophiesAfterSettlement = Math.max(0, currentTrophies + appliedTrophiesSettlement);
    const newHighestTrophies = Math.max(
      sanitizeTrophyCount(profileData.highestTrophies),
      trophiesAfterSettlement,
    );

    const xpAfter = xpBefore + xpGained;
    const afterInfo = getLevelInfo(xpAfter);
    const levelsGained = afterInfo.level - beforeInfo.level;

    const oldRankLabel = rewards.oldRank;
    const newRankLabel = getRankForTrophies(trophiesAfterSettlement);
    const promoted = rankIndex(newRankLabel) > rankIndex(oldRankLabel);
    const demoted = rankIndex(newRankLabel) < rankIndex(oldRankLabel);

    // Resolve loot before any other writes to keep transaction read-before-write ordering valid.
    const drops = await resolveRaceDrops(transaction, uid, botDisplayNames);

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
      trophies: trophiesAfterSettlement,
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
    if (place === 1) {
      profileUpdate.totalWins = admin.firestore.FieldValue.increment(1);
    }
    transaction.update(profileRef, profileUpdate);

    transaction.update(raceRef, { status: "settled", updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    return {
      success: true,
      rewards: {
        trophies: appliedActualTrophiesDelta,
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
      rank: {
        old: oldRankLabel,
        new: newRankLabel,
        promoted,
        demoted,
      },
      trophySettlement: {
        applied: appliedTrophiesSettlement,
        preDeducted: lastPlaceDeltaApplied,
      },
      drops: {
        player: drops.playerDrop,
        bots: drops.botDrops,
      },
    };
  });

  try {
    await maybeTriggerFlashSales({ uid });
  } catch (error) {
    logger.warn("Flash sale trigger failed after race result", { uid, error });
  }

  await refreshFriendSnapshots(uid);
  return result;
});
