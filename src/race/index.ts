import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region.js";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { getLevelInfo } from "../shared/xp.js";
import { refreshFriendSnapshots } from "../Socials/updateSnapshots.js";
import { grantInventoryRewards } from "../shared/inventoryAwards.js";
import { maybeTriggerFlashSales } from "../triggers/flashSales.js";
import { maybeGenerateStarterOffer } from "../shop/offers.js";
import { STARTER_RACE_THRESHOLD } from "../shop/offerState.js";
import { buildBotLoadout } from "../game-systems/botLoadoutHelper.js";
import { applyClanTrophyDelta, playerClanStateRef, clanMembersCollection, clanRef, updateClanMemberSnapshot } from "../clan/helpers.js";
import { getSpellEvolutionV2Catalog, getCrateSlotsConfig, getUnlockDurationForRarity, getMasteryConfig, getMasteryRank, getMasteryProgress, getXpCapForCar } from "../core/configV2.js";
import { CrateSlotEntry, UserCrateSlotsDoc } from "../shared/typesV2.js";
import { updatePlayerLeaderboardEntry } from "../Socials/liveLeaderboard.js";
import { updateClanLeaderboardEntry } from "../clan/liveLeaderboard.js";
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
  getCoinConfigForGameMode,
  getExpConfigForGameMode,
} from "./economy.js";
import { PlayerBoostersState } from "../shared/types.js";
import { LeaderboardMetric } from "../Socials/types.js";
import { GameMode, resolveGameMode, getTrophyFields, shouldSyncClanTrophies, shouldModifyTrophies, hasLeaderboard } from "../shared/gamemode.js";
import { getTrophyConfigForGameMode } from "./economy.js";

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
];

const TOTAL_REWARD_WEIGHT = RACE_REWARD_TABLE.reduce((sum, entry) => sum + entry.weight, 0);

// Map drop types to crate rarity for slot placement
const CRATE_DROP_RARITY_MAP: Record<string, string> = {
  commoncrate: "common",
  rarecrate: "rare",
  exoticcrate: "exotic",
  legendarycrate: "legendary",
  mythicalcrate: "mythical",
};

const isCrateDrop = (drop: RaceDrop): boolean => drop.type in CRATE_DROP_RARITY_MAP;

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
  // Only grant non-crate drops to inventory (keys, etc.)
  // Crates will be placed into crate slots separately
  if (playerDrop.skuId && !isCrateDrop(playerDrop)) {
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

  if (!Array.isArray(finishOrderInput) || finishOrderInput.length !== total) {
    throw new HttpsError(
      "invalid-argument",
      "finishOrder must include every participant exactly once in final placement order.",
    );
  }

  const parseTokenToIndex = (token: unknown): number => {
    if (typeof token === "number" && Number.isInteger(token)) {
      return token;
    }
    if (typeof token === "string" && token.trim().length > 0) {
      const byId = participantIndexById.get(token);
      if (typeof byId === "number") {
        return byId;
      }
      const parsed = Number(token);
      if (Number.isInteger(parsed)) {
        return parsed;
      }
    }
    if (typeof token === "object" && token !== null) {
      const record = token as Record<string, unknown>;
      const candidate =
        typeof record.participantId === "string"
          ? record.participantId
          : typeof record.uid === "string"
            ? record.uid
            : typeof record.playerId === "string"
              ? record.playerId
              : typeof record.id === "string"
                ? record.id
                : null;
      if (candidate) {
        const byId = participantIndexById.get(candidate);
        if (typeof byId === "number") {
          return byId;
        }
      }
    }
    throw new HttpsError(
      "invalid-argument",
      "finishOrder entries must be participant indexes or ids from the lobby snapshot.",
    );
  };

  const resolved: number[] = [];
  const seen = new Set<number>();
  finishOrderInput.forEach((token) => {
    const idx = parseTokenToIndex(token);
    if (idx < 0 || idx >= total) {
      throw new HttpsError(
        "invalid-argument",
        `finishOrder contains an index outside lobby bounds (index ${idx}, size ${total}).`,
      );
    }
    if (seen.has(idx)) {
      throw new HttpsError(
        "invalid-argument",
        `finishOrder must not contain duplicates; participant index ${idx} was repeated.`,
      );
    }
    resolved.push(idx);
    seen.add(idx);
  });

  if (!seen.has(playerIndex)) {
    throw new HttpsError(
      "invalid-argument",
      "finishOrder must include the calling player's participant entry.",
    );
  }

  return resolved;
};

export const startRace = onCall(callableOptions({ minInstances: getMinInstances(false), memory: "512MiB", cpu: 1, concurrency: 80 }, true), async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User is not authenticated.");
  }

  const { lobbyRatings, playerIndex, gamemode: rawGamemode } = request.data;
  const gamemode: GameMode = resolveGameMode(rawGamemode);
  const trophyConfig = getTrophyConfigForGameMode(gamemode);
  const trophyFields = getTrophyFields(gamemode);

  if (typeof playerIndex !== "number") {
    throw new HttpsError("invalid-argument", "playerIndex must be a number.");
  }

  const lobbySnapshot = normalizeLobbySnapshot(lobbyRatings, uid, playerIndex);
  const ratingVector = lobbySnapshot.map((entry) => entry.rating);

  const raceId = db.collection("Races").doc().id;
  // NOTE: Trophy pre-deduction is handled by prepareRace, NOT startRace
  // This function only creates the race and participant documents
  const preDeductedTrophies = calculateLastPlaceDelta(playerIndex, ratingVector, trophyConfig);

  const result = await db.runTransaction(async (transaction) => {
    const profileRef = db.doc(`/Players/${uid}/Profile/Profile`);
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    // Read profile to verify it exists (no trophy modification here - prepareRace handles it)
    const profileSnap = await transaction.get(profileRef);
    if (!profileSnap.exists) {
      throw new HttpsError("failed-precondition", "Player profile not found.");
    }

    const currentTrophies = sanitizeTrophyCount(profileSnap.data()?.[trophyFields.current]);
    const appliedPreDeduction =
      preDeductedTrophies < 0 ? Math.max(preDeductedTrophies, -currentTrophies) : preDeductedTrophies;

    // Debug logging - NO trophy deduction happens here, prepareRace already did it
    logger.info("[startRace] Race setup (no trophy deduction - handled by prepareRace)", {
      uid,
      raceId,
      currentTrophiesFromProfile: currentTrophies,
      calculatedPreDeduction: preDeductedTrophies,
      appliedPreDeduction,
      gamemode,
    });

    // Create Race document
    const raceRef = db.doc(`/Races/${raceId}`);
    transaction.set(raceRef, {
      status: "pending",
      gamemode,
      createdAt: timestamp,
      updatedAt: timestamp,
      lobbySnapshot: lobbySnapshot.map((entry) => ({
        rating: entry.rating,
        participantId: entry.participantId,
      })),
    });

    // Create Participant document
    // IMPORTANT: Use preDeductedTrophies (raw ELO calculation), NOT appliedPreDeduction
    // prepareRace already applied the cap and deducted from profile, so currentTrophies is already reduced
    // We need to store the ORIGINAL pre-deduction value for recordRaceResult to settle correctly
    const participantRef = db.doc(`/Races/${raceId}/Participants/${uid}`);
    transaction.set(participantRef, {
      gamemode,
      preDeductedTrophies: preDeductedTrophies, // Use raw ELO value, not re-capped value
      playerIndex,
      createdAt: timestamp,
    });

    return { success: true, raceId, preDeductedTrophies: preDeductedTrophies };
  });

  logger.info("[startRace] Race created", {
    uid,
    raceId: result.raceId,
    preDeductedTrophies: result.preDeductedTrophies,
  });

  await refreshFriendSnapshots(uid);
  return result;
});

export const generateBotLoadout = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async (request) => {
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

export const recordRaceResult = onCall(callableOptions({ minInstances: getMinInstances(false), memory: "512MiB", cpu: 1, concurrency: 80 }, true), async (request) => {
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
    const garageRef = db.doc(`/Players/${uid}/Garage/Cars`);
    const spellDecksRef = db.doc(`/Players/${uid}/SpellDecks/Decks`);
    const spellLevelsRef = db.doc(`/Players/${uid}/Spells/Levels`);
    const [economyDoc, profileDoc, participantDoc, garageDoc, spellDecksDoc, spellLevelsDoc] = await transaction.getAll(
      economyRef,
      profileRef,
      participantRef,
      garageRef,
      spellDecksRef,
      spellLevelsRef,
    );

    if (!economyDoc.exists || !profileDoc.exists || !participantDoc.exists) {
      throw new HttpsError("not-found", "Player data not found.");
    }

    const profileData = profileDoc.data()!;
    const participantData = participantDoc.data() ?? {};

    // Get gamemode from participant doc (defaults to RANKED for backward compatibility)
    const gamemode: GameMode = resolveGameMode(participantData.gamemode);
    const trophyFields = getTrophyFields(gamemode);
    const trophyConfig = getTrophyConfigForGameMode(gamemode);

    const playerIndex = Number(participantData.playerIndex);
    const lastPlaceDeltaApplied = Number.isFinite(Number(participantData.preDeductedTrophies))
      ? Math.floor(Number(participantData.preDeductedTrophies))
      : 0;
    const currentTrophies = Number.isFinite(Number(profileData[trophyFields.current]))
      ? Math.floor(Number(profileData[trophyFields.current]))
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
    const hasShardBooster = toMillis(boostersState.shard?.activeUntil) > nowMs;

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

    // Get gamemode-specific configs for rewards
    const coinConfig = getCoinConfigForGameMode(gamemode);
    const expConfig = getExpConfigForGameMode(gamemode);

    const rewards = computeRaceRewardsWithPrededuction(
      rewardInput,
      trophyConfig,
      coinConfig,
      expConfig,
      gamemode,
    );

    const coinsGained = rewards.coins;
    const xpGained = rewards.exp;
    const desiredTrophiesActual = rewards.trophiesActual;

    // --- Calculate Spell Shard Reward (rank-scaled to prevent smurfing) ---
    // Formula: shards = shardBase_for_rank * positionMultiplier
    // Base scales 5 -> 25 across ranks 1 -> 50. (unranked=5)
    let shardBase = 5; // Unranked base
    if (gamemode !== "UNRANKED") {
      const currentRankNumeric = rankIndex(getRankForTrophies(trophiesBeforeRace));
      // Rank 1 (Bronze III) = ~5.4, Rank 50 (Hypersonic III) = 25
      shardBase = 5 + (20 * (Math.max(1, currentRankNumeric) / 50));
    }

    // Use the same position multipliers as XP: [1.2, 1.14, 1.09, 1.03, 0.97, 0.91, 0.86, 0.80]
    // Or Elimination: [1.2, 1.14, 1.09, 1.03, 0.84, 0.72, 0.54, 0.36]
    const shardMultiplierArray = gamemode === "ELIMINATION"
      ? [1.2, 1.14, 1.09, 1.03, 0.84, 0.72, 0.54, 0.36]
      : [1.2, 1.14, 1.09, 1.03, 0.97, 0.91, 0.86, 0.80];

    const positionMult = shardMultiplierArray[resolvedPlaceIndex] ?? 0.80;
    const baseShards = Math.round(shardBase * positionMult);

    // Apply shard booster (2x multiplier if active)
    const shardBoosterMult = hasShardBooster ? 2 : 1;
    const shardsEarned = Math.round(baseShards * shardBoosterMult);
    const boosterShards = shardsEarned - baseShards;

    // Apply a floor so trophy losses cannot push the player below zero (including pre-deducted losses).
    const appliedActualTrophiesDelta = Math.max(desiredTrophiesActual, -trophiesBeforeRace);
    const appliedTrophiesSettlement = appliedActualTrophiesDelta - lastPlaceDeltaApplied;
    const trophiesAfterSettlement = Math.max(0, currentTrophies + appliedTrophiesSettlement);
    const newHighestTrophies = Math.max(
      sanitizeTrophyCount(profileData[trophyFields.highest]),
      trophiesAfterSettlement,
    );

    const xpAfter = xpBefore + xpGained;
    const afterInfo = getLevelInfo(xpAfter);
    const levelsGained = afterInfo.level - beforeInfo.level;
    const expRequiredForNextLevel = afterInfo.expInLevel + afterInfo.expToNext;
    const expRequiredForNextLevelBefore = beforeInfo.expInLevel + beforeInfo.expToNext;

    const oldRankLabel = rewards.oldRank;
    const newRankLabel = getRankForTrophies(trophiesAfterSettlement);
    const promoted = rankIndex(newRankLabel) > rankIndex(oldRankLabel);
    const demoted = rankIndex(newRankLabel) < rankIndex(oldRankLabel);

    // Resolve loot before any other writes to keep transaction read-before-write ordering valid.
    // Skip loot for UNRANKED mode
    let drops: RaceDropResolution;
    if (gamemode === "UNRANKED") {
      drops = {
        playerDrop: { type: "noreward", skuId: null },
        botDrops: botDisplayNames.map((bot) => ({
          bot,
          drop: { type: "noreward", skuId: null },
        })),
      };
    } else {
      drops = await resolveRaceDrops(transaction, uid, botDisplayNames);
    }

    // --- Place crate into slot if the drop was a crate ---
    let crateSlotResult: { slotIndex: number | null; fallbackGranted: boolean; fallbackRewards?: { coins?: number; spellShards?: number } } | null = null;

    if (isCrateDrop(drops.playerDrop) && drops.playerDrop.skuId) {
      const slotsConfig = await getCrateSlotsConfig();
      const crateSlotsRef = db.doc(`/Players/${uid}/Crates/Slots`);
      const crateSlotsDoc = await transaction.get(crateSlotsRef);
      const nowTimestamp = admin.firestore.Timestamp.now();

      const slotsData = (
        crateSlotsDoc.exists ? crateSlotsDoc.data() : { slots: [], maxSlots: slotsConfig.maxSlots }
      ) as UserCrateSlotsDoc;

      const currentSlots = (slotsData.slots ?? []).filter((s) => s !== null);
      const maxSlots = slotsData.maxSlots ?? slotsConfig.maxSlots;
      const crateRarity = CRATE_DROP_RARITY_MAP[drops.playerDrop.type] ?? "common";

      if (currentSlots.length >= maxSlots) {
        // All slots full — grant fallback currency
        if (slotsConfig.slotFullFallback.enabled) {
          const fallbackRewards = slotsConfig.slotFullFallback.rewards;
          const fbUpdates: Record<string, FirebaseFirestore.FieldValue> = {};
          if (fallbackRewards.coins) {
            fbUpdates.coins = admin.firestore.FieldValue.increment(fallbackRewards.coins);
          }
          if (fallbackRewards.spellShards) {
            fbUpdates.spellShards = admin.firestore.FieldValue.increment(fallbackRewards.spellShards);
          }
          if (Object.keys(fbUpdates).length > 0) {
            fbUpdates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
            transaction.update(economyRef, fbUpdates);
          }
          crateSlotResult = { slotIndex: null, fallbackGranted: true, fallbackRewards };
        } else {
          crateSlotResult = { slotIndex: null, fallbackGranted: false };
        }
      } else {
        // Place crate into first empty slot
        const unlockDurationSeconds = await getUnlockDurationForRarity(crateRarity);
        const newSlotEntry: CrateSlotEntry = {
          crateSkuId: drops.playerDrop.skuId,
          crateId: drops.playerDrop.type,
          rarity: crateRarity,
          receivedAt: nowTimestamp,
          isUnlocking: false,
          startedAt: null,
          completesAt: null,
          unlockDurationSeconds,
        };

        const newSlots: (CrateSlotEntry | null)[] = [];
        let slotAssigned = false;
        let assignedSlotIndex = -1;

        for (let i = 0; i < maxSlots; i++) {
          const existingSlot = slotsData.slots?.[i] ?? null;
          if (existingSlot) {
            newSlots.push(existingSlot as CrateSlotEntry);
          } else if (!slotAssigned) {
            newSlots.push(newSlotEntry);
            slotAssigned = true;
            assignedSlotIndex = i;
          } else {
            newSlots.push(null);
          }
        }

        if (!slotAssigned) {
          newSlots.push(newSlotEntry);
          assignedSlotIndex = currentSlots.length;
        }

        if (crateSlotsDoc.exists) {
          transaction.update(crateSlotsRef, { slots: newSlots, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        } else {
          transaction.set(crateSlotsRef, { slots: newSlots, maxSlots, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        }

        crateSlotResult = { slotIndex: assignedSlotIndex, fallbackGranted: false };
        logger.info("[recordRaceResult] Crate placed in slot", { uid, slotIndex: assignedSlotIndex, rarity: crateRarity, skuId: drops.playerDrop.skuId });
      }
    }

    // Update Economy/Stats (coins + shards; spellTokens handled separately via mastery rank below)
    const economyUpdate: Record<string, admin.firestore.FieldValue> = {
      coins: admin.firestore.FieldValue.increment(coinsGained),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (shardsEarned > 0) {
      economyUpdate.spellShards = admin.firestore.FieldValue.increment(shardsEarned);
    }
    transaction.update(economyRef, economyUpdate);

    // Update Profile/Profile: trophies + race counters + career stats
    // (exp kept for backward compat; mastery fields written later after car/spell XP known)
    const profileUpdate: {
      [key: string]: number | admin.firestore.FieldValue | string;
    } = {
      exp: xpAfter,               // kept for backward compat
      careerCoins: admin.firestore.FieldValue.increment(coinsGained),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (shouldModifyTrophies(gamemode)) {
      profileUpdate[trophyFields.current] = trophiesAfterSettlement;
      profileUpdate[trophyFields.highest] = newHighestTrophies;
    }
    profileUpdate.totalRaces = admin.firestore.FieldValue.increment(1);
    if (place === 1) {
      profileUpdate.totalWins = admin.firestore.FieldValue.increment(1);
    }
    transaction.update(profileRef, profileUpdate);

    // --- Grant Car XP (same amount as player XP, per-car XP cap from CarsCatalog) ---
    const raceCarId = participantData.carId as string | undefined;
    let carXpResult: {
      carLevel: number;
      displayXp: string;
      xpAwarded: number;
      isXpCapped: boolean;
    } | null = null;
    if (raceCarId && garageDoc.exists) {
      const garageData = garageDoc.data()!;
      const carData = garageData.cars?.[raceCarId];
      if (carData) {
        // V2 per-car XP progression (CarsCatalog keys "1"-"10")
        const starLevel = carData.starLevel ?? 1;   // 1-10, matching CarsCatalog keys
        const currentXp = carData.xp ?? 0;

        // Fetch XP cap from CarsCatalog for this specific car + star level
        const xpCap = await getXpCapForCar(raceCarId, starLevel);

        let finalXpForDb: number;
        let finalIsCapped: boolean;

        // xpCap = 0 means max star level (xpToNext=0 in CarsCatalog)
        // xpCap = Infinity means missing config — treat as uncapped
        if (xpCap <= 0) {
          finalXpForDb = currentXp;
          finalIsCapped = true;
        } else if (xpCap === Infinity) {
          // Config missing — still give XP but don't cap
          finalXpForDb = currentXp + xpGained;
          finalIsCapped = false;
        } else {
          finalXpForDb = Math.min(currentXp + xpGained, xpCap);
          finalIsCapped = finalXpForDb >= xpCap;
        }

        transaction.update(garageRef, {
          [`cars.${raceCarId}.xp`]: finalXpForDb,
          [`cars.${raceCarId}.isXpCapped`]: finalIsCapped,
          [`cars.${raceCarId}.carLevel`]: starLevel, // carLevel == starLevel (1-10, 1:1)
          [`cars.${raceCarId}.updatedAt`]: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`[Race] Car ${raceCarId} (star ${starLevel}) XP: ${currentXp} -> ${finalXpForDb} / ${xpCap === Infinity ? '∞' : xpCap}`);

        carXpResult = {
          carLevel: starLevel,
          displayXp: (xpCap > 0 && xpCap !== Infinity) ? `${Math.floor(finalXpForDb)}xp / ${Math.floor(xpCap)}xp` : (xpCap <= 0 ? "Max" : `${Math.floor(finalXpForDb)}xp`),
          xpAwarded: finalXpForDb - currentXp,
          isXpCapped: finalIsCapped,
        };
      }
    }

    // --- Grant Spell XP to all equipped spells ---
    const spellXpResults: Array<{ spellId: string; xpAwarded: number; newTotalXp: number; isXpCapped: boolean; level: number; displayXp: string; isMaxLevel: boolean }> = [];
    const raceDeckIndex = participantData.deckIndex as number | undefined;
    if (spellDecksDoc.exists && raceDeckIndex !== undefined) {
      const decksData = spellDecksDoc.data();
      const levelsData = spellLevelsDoc.exists ? spellLevelsDoc.data() : {};
      const deckSpells: string[] = decksData?.decks?.[String(raceDeckIndex)]?.spells ?? [];
      // Read from nested spells.{spellId} structure, fallback to legacy levels map
      const spellsMap = (levelsData?.spells ?? {}) as Record<string, { level?: number; xp?: number; isXpCapped?: boolean }>;
      const legacyLevelsMap = (levelsData?.levels ?? {}) as Record<string, number>;

      if (deckSpells.length > 0) {
        const researchCatalog = await getSpellEvolutionV2Catalog();
        const xpConfig = researchCatalog.spellXpConfig;
        const maxSpellLevel = researchCatalog.maxSpellLevel;
        const baseXp = xpConfig.xpPerRace ?? 10;
        const winBonus = place === 1 ? (xpConfig.xpPerWin ?? 25) : 0;
        const spellXpAmount = baseXp + winBonus;

        const spellsNestedData: Record<string, { xp: number; isXpCapped: boolean; level: number }> = {};
        for (const spellId of deckSpells) {
          if (!spellId || typeof spellId !== "string") continue;
          // Read from nested structure first, fallback to legacy
          const spellData = spellsMap[spellId] ?? {};
          const currentLevel = spellData.level ?? legacyLevelsMap[spellId] ?? 1;
          const currentXp = spellData.xp ?? 0;
          const isAlreadyCapped = spellData.isXpCapped ?? false;
          const isMaxLevel = currentLevel >= maxSpellLevel;


          // If spell is at max level, no XP gain at all
          if (isMaxLevel) {
            const xpCap = xpConfig.xpCapPerLevel?.[String(currentLevel)] ?? 9999;
            const displayXp = `${currentXp}xp / ${xpCap}xp`;
            spellXpResults.push({ spellId, xpAwarded: 0, newTotalXp: currentXp, isXpCapped: isAlreadyCapped, level: currentLevel, displayXp, isMaxLevel: true });
            continue;
          }

          if (isAlreadyCapped) {
            const xpCap = xpConfig.xpCapPerLevel?.[String(currentLevel)] ?? 9999;
            const displayXp = `${currentXp}xp / ${xpCap}xp`;
            spellXpResults.push({ spellId, xpAwarded: 0, newTotalXp: currentXp, isXpCapped: true, level: currentLevel, displayXp, isMaxLevel: false });
            continue;
          }


          const xpCap = xpConfig.xpCapPerLevel?.[String(currentLevel)] ?? 9999;
          let newXp = currentXp + spellXpAmount;
          let isNowCapped = false;
          if (newXp >= xpCap) {
            newXp = xpCap;
            isNowCapped = true;
          }

          spellsNestedData[spellId] = { xp: newXp, isXpCapped: isNowCapped, level: currentLevel };

          // Create displayXp like car XP: "20xp / 100xp"
          const displayXp = `${newXp}xp / ${xpCap}xp`;

          spellXpResults.push({
            spellId,
            xpAwarded: spellXpAmount,
            newTotalXp: newXp,
            isXpCapped: isNowCapped,
            level: currentLevel,
            displayXp,
            isMaxLevel: false,
          });
        }

        if (Object.keys(spellsNestedData).length > 0) {
          if (spellLevelsDoc.exists) {
            // update() correctly interprets dot-notation as nested paths
            const dotUpdate: Record<string, unknown> = {};
            for (const [sid, sData] of Object.entries(spellsNestedData)) {
              dotUpdate[`spells.${sid}`] = sData;
            }
            dotUpdate.updatedAt = admin.firestore.FieldValue.serverTimestamp();
            transaction.update(spellLevelsRef, dotUpdate);
          } else {
            // Doc doesn't exist — use set() with real nested object
            transaction.set(spellLevelsRef, {
              spells: spellsNestedData,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
      }
    }

    // --- Mastery XP Calculation ---
    const masteryConfig = await getMasteryConfig();
    const carXpForMastery = carXpResult?.xpAwarded ?? 0;
    const totalSpellXpForMastery = spellXpResults.reduce((sum, s) => sum + s.xpAwarded, 0);
    const masteryXpGained = Math.round(
      (carXpForMastery * masteryConfig.carWeight) + (totalSpellXpForMastery * masteryConfig.spellWeight)
    );

    const currentMasteryXp = Number(profileData.masteryXp ?? 0);
    const newMasteryXp = currentMasteryXp + masteryXpGained;
    const oldMasteryRank = getMasteryRank(currentMasteryXp, masteryConfig);
    const newMasteryRank = getMasteryRank(newMasteryXp, masteryConfig);
    const masteryRankGained = newMasteryRank - oldMasteryRank;

    // Mastery progress within the new rank (for Firestore + response)
    const masteryProgress = getMasteryProgress(newMasteryXp, masteryConfig);

    // Write mastery + level fields to profile (mastery IS the player level now)
    if (masteryXpGained > 0 || masteryRankGained !== 0) {
      transaction.update(profileRef, {
        masteryXp: newMasteryXp,
        masteryRank: newMasteryRank,
        level: newMasteryRank,                                  // level = masteryRank (backward compat)
        expProgress: masteryProgress.expProgress,               // mastery XP within current rank
        expToNextLevel: masteryProgress.expToNextLevel,         // XP span for current rank
        expProgressDisplay: masteryProgress.expProgressDisplay, // human readable
      });
    }

    // Spell tokens: 1 per mastery rank gained (not old exp level)
    if (masteryRankGained > 0) {
      transaction.update(economyRef, {
        spellTokens: admin.firestore.FieldValue.increment(masteryRankGained),
      });
    }

    // Debug logging for trophy investigation
    logger.info("[recordRaceResult] Trophy calculation debug", {
      uid,
      raceId,
      place,
      currentTrophies,
      lastPlaceDeltaApplied,
      trophiesBeforeRace,
      desiredTrophiesActual,
      appliedActualTrophiesDelta,
      appliedTrophiesSettlement,
      trophiesAfterSettlement,
      newHighestTrophies,
      masteryXpGained,
      newMasteryXp,
      newMasteryRank,
    });

    transaction.update(raceRef, { status: "settled", updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    return {
      success: true,
      gamemode,
      rewards: {
        baseCoins: rewards.baseCoins,
        boosterCoins: rewards.boosterCoins,
        spellShards: shardsEarned,
        boosterShards: boosterShards,
      },
      // Unified XP progress — Mastery IS the player level (mastery-system.md)
      xpProgress: {
        xpGained: masteryXpGained,                    // mastery MP earned this race
        totalXp: newMasteryXp,                        // cumulative mastery XP
        expProgress: masteryProgress.expProgress,     // XP within current rank
        xpToNextLevel: masteryProgress.expToNextLevel,// total XP span current→next rank
        levelBefore: oldMasteryRank,                  // mastery rank before race
        levelAfter: newMasteryRank,                   // mastery rank after race
        levelUp: newMasteryRank > oldMasteryRank,     // true if ranked up
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
      carXp: carXpResult && raceCarId ? {
        carId: raceCarId,
        xpAwarded: carXpResult.xpAwarded,
        carLevel: carXpResult.carLevel,
        displayXp: carXpResult.displayXp,
        isXpCapped: carXpResult.isXpCapped,
      } : null,
      spellXp: spellXpResults.length > 0 ? spellXpResults : null,
      crateSlot: crateSlotResult,
    };
  });

  // VERIFICATION: Confirm the trophies were actually persisted
  const verifyProfile = await db.doc(`/Players/${uid}/Profile/Profile`).get();
  const verifiedTrophies = verifyProfile.data()?.trophies;
  logger.info("[recordRaceResult] POST-TRANSACTION VERIFICATION", {
    uid,
    raceId,
    returnedTrophies: result.trophySettlement?.applied,
    verifiedTrophiesInFirestore: verifiedTrophies,
    expectedTrophies: result.trophySettlement?.applied !== undefined
      ? "should match returnedTrophies calculation"
      : "unknown",
  });

  try {
    await maybeTriggerFlashSales({ uid });
  } catch (error) {
    logger.warn("Flash sale trigger failed after race result", { uid, error });
  }

  // Check for starter offer eligibility after race completion
  try {
    const profileForOffer = await db.doc(`/Players/${uid}/Profile/Profile`).get();
    const totalRaces = Number(profileForOffer.data()?.totalRaces ?? 0);
    if (totalRaces >= STARTER_RACE_THRESHOLD) {
      await maybeGenerateStarterOffer(uid);
    }
  } catch (error) {
    logger.warn("Starter offer trigger failed after race result", { uid, error });
  }

  // Sync clan member trophies with post-race profile trophies (SET, not INCREMENT, to prevent drift)
  // Only sync for RANKED mode - ELIMINATION does not affect clan trophies
  let clanIdForLiveUpdate: string | null = null;
  if (shouldSyncClanTrophies(result.gamemode)) {
    try {
      const clanStateSnap = await playerClanStateRef(uid).get();
      const clanId = clanStateSnap.data()?.clanId;
      if (typeof clanId === "string" && clanId.length > 0) {
        // Read the actual post-race trophies from profile (always ranked trophies for clan)
        const profileSnap = await db.doc(`/Players/${uid}/Profile/Profile`).get();
        const finalTrophies = Number(profileSnap.data()?.trophies ?? 0);

        // SET clan member trophies to match profile (not increment - prevents drift)
        await updateClanMemberSnapshot(uid, { trophies: finalTrophies });
        clanIdForLiveUpdate = clanId;

        logger.info("[recordRaceResult] Synced clan member trophies", {
          uid,
          raceId,
          finalTrophies,
          clanId,
        });
      }
    } catch (error) {
      logger.warn("Failed to sync clan member trophies after race", { uid, raceId, error });
    }
  }

  await refreshFriendSnapshots(uid);

  // Update leaderboards (skip for UNRANKED mode)
  if (hasLeaderboard(result.gamemode)) {
    try {
      const profileSnapshot = await db.doc(`/Players/${uid}/Profile/Profile`).get();
      if (profileSnapshot.exists) {
        const profileData = profileSnapshot.data() ?? {};
        const flags = profileData.top100Flags ?? {};
        const updates: Array<{ metric: LeaderboardMetric; value: number }> = [];

        // Ranked trophies leaderboard
        if (flags?.trophies === true) {
          updates.push({ metric: "trophies", value: Number(profileData.trophies ?? 0) });
        }
        // Elimination trophies leaderboard
        if (flags?.eliminationTrophies === true) {
          updates.push({ metric: "eliminationTrophies", value: Number(profileData.eliminationTrophies ?? 0) });
        }
        if (flags?.careerCoins === true) {
          updates.push({ metric: "careerCoins", value: Number(profileData.careerCoins ?? 0) });
        }
        if (flags?.totalWins === true) {
          updates.push({ metric: "totalWins", value: Number(profileData.totalWins ?? 0) });
        }

        if (updates.length > 0) {
          await Promise.all(
            updates.map(({ metric, value }) =>
              updatePlayerLeaderboardEntry(metric, uid, Number.isFinite(value) ? value : 0),
            ),
          );
        }
      }
    } catch (error) {
      logger.warn("Failed to update player live leaderboard entry", { uid, raceId, error });
    }

    if (clanIdForLiveUpdate) {
      try {
        await updateClanLeaderboardEntry(clanIdForLiveUpdate);
      } catch (error) {
        logger.warn("Failed to update clan leaderboard live entry", { uid, raceId, clanId: clanIdForLiveUpdate, error });
      }
    }
  }

  return result;
});
