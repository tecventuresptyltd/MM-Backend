import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region.js";
import { checkIdempotency, createInProgressReceipt, completeOperation, sanitizeForFirestore } from "../core/idempotency.js";
import {
  getCarsCatalog,
  getSpellsCatalog,
  getCarTuningConfig,
  getBotConfig,
  listSkusByFilter,
  getBotNamesConfig,
  getItemSkusCatalog,
} from "../core/config.js";
import { ItemSku, CarLevel } from "../shared/types.js";
import { SeededRNG } from "./lib/random.js";
import { resolveCarStats, calculateBotStatsFromTrophies } from "./lib/stats.js";
import { calculateLastPlaceDelta, DEFAULT_TROPHY_CONFIG } from "./economy.js";
import * as crypto from "crypto";

const db = admin.firestore();

type CosmeticSlot = "wheels" | "decal" | "spoiler" | "underglow" | "boost";

const COSMETIC_SLOTS: CosmeticSlot[] = ["wheels", "decal", "spoiler", "underglow", "boost"];

const DEFAULT_BOT_COSMETIC_SKUS: Record<CosmeticSlot, string> = {
  wheels: "sku_7d5rvqx6",
  decal: "sku_7ad7grzz",
  spoiler: "sku_agyhv8pk",
  boost: "sku_rwt6nbsq",
  underglow: "sku_z9tnvvdsrn",
};

const COSMETIC_SLOT_FIELDS: Record<CosmeticSlot, { skuField: string; itemField: string }> = {
  wheels: { skuField: "wheelsSkuId", itemField: "wheelsItemId" },
  decal: { skuField: "decalSkuId", itemField: "decalItemId" },
  spoiler: { skuField: "spoilerSkuId", itemField: "spoilerItemId" },
  underglow: { skuField: "underglowSkuId", itemField: "underglowItemId" },
  boost: { skuField: "boostSkuId", itemField: "boostItemId" },
};

const resolveCarLevel = (
  car: { levels?: Record<string, CarLevel> } | null | undefined,
  targetLevel: number,
): Partial<CarLevel> | null => {
  if (!car || typeof car !== "object") {
    return null;
  }
  const levels = (car as { levels?: Record<string, CarLevel> }).levels;
  if (!levels || typeof levels !== "object") {
    return null;
  }
  const normalizedLevel = Math.max(0, Math.floor(Number.isFinite(targetLevel) ? targetLevel : 0));
  const direct = levels[String(normalizedLevel)];
  if (direct) {
    return direct;
  }
  if (normalizedLevel > 0) {
    const fallback = levels[String(normalizedLevel - 1)];
    if (fallback) {
      return fallback;
    }
  }
  const firstAvailable = levels["0"] ?? Object.values(levels)[0];
  return firstAvailable ?? null;
};

function hmacSign(payload: any): string {
  const secret = process.env.RACE_HMAC_SECRET || "sandbox-secret";
  const str = JSON.stringify(payload);
  return crypto.createHmac("sha256", secret).update(str).digest("hex");
}

function pickRarityBand(weightsByBand: Record<string, Record<string, number>>, trophies: number) {
  const key = Object.keys(weightsByBand).find((band) => {
    const [a, b] = band.split("-").map((x) => Number(x));
    return trophies >= a && trophies <= b;
  }) || Object.keys(weightsByBand)[0];
  return weightsByBand[key];
}

function weightedChoice<T extends string>(weights: Record<T, number>, rng: SeededRNG): T {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng.float(0, total);
  for (const [k, w] of entries) {
    if ((r -= w) <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

export const prepareRace = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "User must be authenticated.");

  const { opId, laps = 3, botCount = 7, seed, trophyHint, trackId } = request.data ?? {};
  if (typeof opId !== "string" || !opId) throw new HttpsError("invalid-argument", "opId is required.");
  if (typeof laps !== "number" || laps < 1) throw new HttpsError("invalid-argument", "laps must be >= 1");
  if (typeof botCount !== "number" || botCount < 0 || botCount > 15) throw new HttpsError("invalid-argument", "botCount out of range");

  const existing = await checkIdempotency(uid, opId);
  if (existing) return existing;
  await createInProgressReceipt(uid, opId, "prepareRace");

  try {
    // Fetch player docs in batch
    const profileRef = db.doc(`/Players/${uid}/Profile/Profile`);
    const loadoutRef = db.doc(`/Players/${uid}/Loadouts/Active`);
    const spellsLevelsRef = db.doc(`/Players/${uid}/Spells/Levels`);
    const garageRef = db.doc(`/Players/${uid}/Garage/Cars`);
    const decksRef = db.doc(`/Players/${uid}/SpellDecks/Decks`);
    const [profileDoc, loadoutDoc, spellsDoc, garageDoc, decksDoc] = await db.getAll(
      profileRef,
      loadoutRef,
      spellsLevelsRef,
      garageRef,
      decksRef,
    );
    if (!profileDoc.exists) throw new HttpsError("not-found", "Profile not found");
    if (!loadoutDoc.exists) throw new HttpsError("not-found", "Loadout not found");
    if (!garageDoc.exists) throw new HttpsError("not-found", "Garage not found");
    if (!spellsDoc.exists) throw new HttpsError("not-found", "Spells/Levels not found");

    const profile = profileDoc.data() || {};
    const loadout = loadoutDoc.data() || {};
    const garage = garageDoc.data() || {};
    const playerTrophies: number = typeof trophyHint === "number" ? trophyHint : Number(profile.trophies || 0);

    // Fetch catalogs (cached by config.ts)
    const [
      carsCatalog,
      spellsCatalog,
      tuning,
      botConfig,
      wheelSkus,
      decalSkus,
      spoilerSkus,
      underglowSkus,
      boostSkus,
      botNames,
      itemSkusCatalog,
    ] = await Promise.all([
      getCarsCatalog(),
      getSpellsCatalog(),
      getCarTuningConfig(),
      getBotConfig(),
      listSkusByFilter({ category: "cosmetic", subType: "wheels" }),
      listSkusByFilter({ category: "cosmetic", subType: "decal" }),
      listSkusByFilter({ category: "cosmetic", subType: "spoiler" }),
      listSkusByFilter({ category: "cosmetic", subType: "underglow" }),
      listSkusByFilter({ category: "cosmetic", subType: "boost" }),
      getBotNamesConfig(),
      getItemSkusCatalog(),
    ]);

    // Extract AI difficulty configuration from BotConfig.statRanges
    const aiDifficultyConfig = {
      minSpeed: botConfig.statRanges?.aiSpeed?.min ?? 100,
      maxSpeed: botConfig.statRanges?.aiSpeed?.max ?? 800,
      boostPowerMin: botConfig.statRanges?.aiBoostPower?.min ?? 0.10,
      boostPowerMax: botConfig.statRanges?.aiBoostPower?.max ?? 0.30,
      endGameDifficulty: botConfig.statRanges?.endGameDifficulty ?? 100,
      minAcceleration: botConfig.statRanges?.aiAcceleration?.min ?? 8,
      maxAcceleration: botConfig.statRanges?.aiAcceleration?.max ?? 15
    };

    // Warn if using fallbacks (indicates BotConfig seed may not be deployed)
    if (!botConfig.statRanges?.aiSpeed) {
      console.warn('[prepareRace] BotConfig missing aiSpeed field, using defaults');
    }
    if (!botConfig.statRanges?.aiBoostPower) {
      console.warn('[prepareRace] BotConfig missing aiBoostPower field, using defaults');
    }
    if (!botConfig.statRanges?.aiAcceleration) {
      console.warn('[prepareRace] BotConfig missing aiAcceleration field, using defaults');
    }
    if (botConfig.statRanges?.endGameDifficulty === undefined) {
      console.warn('[prepareRace] BotConfig missing endGameDifficulty field, using default (100)');
    }

    // Resolve player car and stats
    const carId: string = loadout.carId || Object.keys(carsCatalog)[0];
    const playerCar = carsCatalog[carId];
    if (!playerCar) throw new HttpsError("failed-precondition", "Active car not found in catalog");
    const level = Number((garage.cars ?? {})[carId]?.upgradeLevel ?? 0);
    const playerCarLevelData = resolveCarLevel(playerCar, level);
    const playerStats = resolveCarStats(playerCarLevelData, tuning, false);
    
    // Debug logging for player stats
    console.log('[prepareRace] Player Stats Debug:');
    console.log(`  Car ID: ${carId}, Level: ${level}`);
    console.log(`  Car Level Data:`, playerCarLevelData);
    console.log(`  Tuning Config:`, { valueScale: tuning.valueScale, player: tuning.player });
    console.log(`  Display Stats:`, playerStats.display);
    console.log(`  Real Stats:`, playerStats.real);

    const rawCosmetics = (loadout.cosmetics ?? {}) as Record<string, string | null>;
    const resolveCosmeticItemId = (slot: string): string | null =>
      rawCosmetics[`${slot}ItemId`] ?? rawCosmetics[slot] ?? null;
    const resolveCosmeticSkuId = (slot: string): string | null =>
      rawCosmetics[`${slot}SkuId`] ?? null;
    const playerCosmetics = {
      wheelsItemId: resolveCosmeticItemId("wheels"),
      wheelsSkuId: resolveCosmeticSkuId("wheels"),
      decalItemId: resolveCosmeticItemId("decal"),
      decalSkuId: resolveCosmeticSkuId("decal"),
      spoilerItemId: resolveCosmeticItemId("spoiler"),
      spoilerSkuId: resolveCosmeticSkuId("spoiler"),
      underglowItemId: resolveCosmeticItemId("underglow"),
      underglowSkuId: resolveCosmeticSkuId("underglow"),
      boostItemId: resolveCosmeticItemId("boost"),
      boostSkuId: resolveCosmeticSkuId("boost"),
    };

    const cosmeticPools: Record<CosmeticSlot, ItemSku[]> = {
      wheels: wheelSkus,
      decal: decalSkus,
      spoiler: spoilerSkus,
      underglow: underglowSkus,
      boost: boostSkus,
    };

    const pickDefaultCosmetic = (slot: CosmeticSlot): { skuId: string; itemId: string } => {
      const pool = cosmeticPools[slot] ?? [];
      const expectedDefaultId = DEFAULT_BOT_COSMETIC_SKUS[slot];
      const defaultFromPool =
        pool.find((sku) => sku.skuId === expectedDefaultId) ||
        pool.find((sku) => sku.rarity === "Default") ||
        pool[0];
      if (defaultFromPool) {
        return { skuId: defaultFromPool.skuId, itemId: defaultFromPool.itemId };
      }
      if (expectedDefaultId && itemSkusCatalog[expectedDefaultId]) {
        const sku = itemSkusCatalog[expectedDefaultId];
        return { skuId: sku.skuId, itemId: sku.itemId };
      }
      const playerCosmeticsRecord = playerCosmetics as Record<string, string | null>;
      const slotFields = COSMETIC_SLOT_FIELDS[slot];
      const playerSkuId = playerCosmeticsRecord[slotFields.skuField];
      const playerItemId = playerCosmeticsRecord[slotFields.itemField];
      if (playerSkuId && playerItemId) {
        return { skuId: playerSkuId, itemId: playerItemId };
      }
      return {
        skuId: expectedDefaultId || `default_${slot}`,
        itemId: expectedDefaultId || `default_${slot}`,
      };
    };

    const fallbackBotCosmetics = COSMETIC_SLOTS.reduce<Record<CosmeticSlot, { skuId: string; itemId: string }>>(
      (acc, slot) => {
        acc[slot] = pickDefaultCosmetic(slot);
        return acc;
      },
      {} as Record<CosmeticSlot, { skuId: string; itemId: string }>,
    );

    const pickBotCosmeticForSlot = (slot: CosmeticSlot, rarity: string): { skuId: string; itemId: string } => {
      const pool = cosmeticPools[slot] ?? [];
      const chosen = pool.length > 0 ? pickSkuForRarity(pool, rarity as ItemSku["rarity"]) : null;
      const resolved = chosen ?? fallbackBotCosmetics[slot];
      return {
        skuId: resolved.skuId,
        itemId: resolved.itemId,
      };
    };

    // Resolve player spells
    const deckIndex = Number(loadout.activeSpellDeck ?? 1);
    const deckSpells: string[] = decksDoc.exists ? (decksDoc.data()?.decks?.[String(deckIndex)]?.spells ?? []) : [];
    const levelMap = (spellsDoc.data()?.levels ?? {}) as Record<string, number>;
    const resolveSpellAttrs = (spellDef: any, level: number) => {
      if (!spellDef) return {};
      if (spellDef.baseStats && Object.keys(spellDef.baseStats).length > 0) {
        return spellDef.baseStats;
      }
      const attributes = Array.isArray(spellDef.attributes) ? spellDef.attributes : [];
      const normalized: Record<string, { unit: string; value: unknown; values: unknown[] }> = {};
      for (const attr of attributes) {
        if (!attr || typeof attr.name !== "string") continue;
        const values = Array.isArray(attr.values) ? attr.values : [];
        const idx = Math.min(Math.max(level - 1, 0), values.length > 0 ? values.length - 1 : 0);
        normalized[attr.name] = {
          unit: typeof attr.unit === "string" ? attr.unit : "",
          value: values.length > 0 ? values[idx] ?? values[values.length - 1] : null,
          values,
        };
      }
      return normalized;
    };

    const playerSpells = deckSpells.filter((id) => typeof id === "string" && id.length > 0).map((spellId) => {
      const level = Number(levelMap[spellId] ?? 1);
      const spellDef = (spellsCatalog as any)[spellId] || {};
      return { spellId, level, attrs: resolveSpellAttrs(spellDef, level) };
    });

    // Seeded RNG
    const resolvedSeed = seed || `race:${uid}:${Date.now()}`;
    const rng = new SeededRNG(resolvedSeed);
    const botNamePool = (Array.isArray(botNames) ? botNames : [])
      .map((name) => (typeof name === "string" ? name.trim() : ""))
      .filter((name) => name.length > 0);
    const effectiveBotNamePool = botNamePool.length > 0 ? botNamePool : ["MysticBot"];
    let botNameDeck = rng.shuffle(effectiveBotNamePool);
    let botNameCursor = 0;
    const usedBotNames = new Set<string>();
    const fallbackBase = rng.int(1000, 9999);
    const nextBotName = (): string => {
      if (effectiveBotNamePool.length === 0) {
        const synthetic = `MysticBot_${fallbackBase}_${usedBotNames.size + 1}`;
        usedBotNames.add(synthetic);
        return synthetic;
      }
      let safety = effectiveBotNamePool.length * 2;
      while (safety > 0) {
        if (botNameDeck.length === 0 || botNameCursor >= botNameDeck.length) {
          botNameDeck = rng.shuffle(effectiveBotNamePool);
          botNameCursor = 0;
        }
        const candidate = botNameDeck[botNameCursor] ?? "";
        botNameCursor += 1;
        if (candidate && !usedBotNames.has(candidate)) {
          usedBotNames.add(candidate);
          return candidate;
        }
        safety -= 1;
      }
      const fallback = `MysticBot_${fallbackBase}_${usedBotNames.size + 1}`;
      usedBotNames.add(fallback);
      return fallback;
    };

    // Helper: pick bot car by thresholds
    function pickBotCarId(tr: number): string {
      const thresholds = [...botConfig.carUnlockThresholds].sort((a, b) => a.trophies - b.trophies);
      let idx = thresholds.findIndex((t) => tr < t.trophies) - 1;
      if (idx < 0) idx = thresholds.length - 1;
      // ±1 variance
      const variance = rng.int(-1, 1);
      idx = Math.max(0, Math.min(thresholds.length - 1, idx + variance));
      return thresholds[idx].carId;
    }

    const pickSkuForRarity = (pool: ItemSku[], rarity: string): ItemSku | null => {
      const filtered = pool.filter((sku) => sku.rarity === rarity);
      const source = filtered.length > 0 ? filtered : pool;
      return source.length > 0 ? rng.choice(source) ?? null : null;
    };

    // Build bots
    const bots = Array.from({ length: botCount }).map(() => {
      const botDisplayName = nextBotName();
      
      // Fixed trophy distribution: ensure equal distribution even at low trophy counts
      const trophyRange = 100;
      const minTrophies = Math.max(0, playerTrophies - trophyRange);
      const maxTrophies = playerTrophies + trophyRange;
      const botTrophies = rng.int(minTrophies, maxTrophies);
      const normalizedTrophies = Math.max(0, Math.min(7000, botTrophies));
      
      const botCarId = pickBotCarId(normalizedTrophies);
      const botCar = carsCatalog[botCarId] || playerCar;
      
      // Get car level data (using level 0 for display values only)
      const botCarLevelData = resolveCarLevel(botCar, 0);

      // Calculate bot stats from trophy percentage using BotConfig.statRanges
      const botStats = calculateBotStatsFromTrophies(
        normalizedTrophies,
        {
          aiSpeed: { min: aiDifficultyConfig.minSpeed, max: aiDifficultyConfig.maxSpeed },
          aiBoostPower: { min: aiDifficultyConfig.boostPowerMin, max: aiDifficultyConfig.boostPowerMax },
          aiAcceleration: { min: aiDifficultyConfig.minAcceleration, max: aiDifficultyConfig.maxAcceleration },
          endGameDifficulty: aiDifficultyConfig.endGameDifficulty
        },
        botCarLevelData,
      );

      // ==========================================
      // AI DIFFICULTY SYSTEM
      // ==========================================
      // Calculate aiLevel as percentage (0-100) based on normalized trophies
      const trophyPercentage = normalizedTrophies / 7000;
      (botStats.real as any).aiLevel = Math.round((trophyPercentage * 100) * 100) / 100;

      // Add performanceRanges from BotConfig for Unity's AI controller
      (botStats.real as any).performanceRanges = {
        minSpeed: aiDifficultyConfig.minSpeed,
        maxSpeed: aiDifficultyConfig.maxSpeed,
        boostPowerMin: aiDifficultyConfig.boostPowerMin,
        boostPowerMax: aiDifficultyConfig.boostPowerMax,
        endGameDifficulty: aiDifficultyConfig.endGameDifficulty,
        minAcceleration: aiDifficultyConfig.minAcceleration,
        maxAcceleration: aiDifficultyConfig.maxAcceleration
      };

      // Validation: ensure aiLevel is valid
      if (typeof (botStats.real as any).aiLevel !== 'number' || !Number.isFinite((botStats.real as any).aiLevel)) {
        console.error(`[prepareRace] Invalid aiLevel for bot ${botDisplayName}:`, (botStats.real as any).aiLevel);
        (botStats.real as any).aiLevel = 0; // Safe fallback
      }
      if ((botStats.real as any).aiLevel < 0) {
        console.warn(`[prepareRace] Negative aiLevel for bot ${botDisplayName}, clamping to 0`);
        (botStats.real as any).aiLevel = 0;
      }
      // ==========================================

      const rarityWeights = pickRarityBand(botConfig.cosmeticRarityWeights, normalizedTrophies);
      const rarity = weightedChoice(rarityWeights as any, rng);
      const wheelsCosmetic = pickBotCosmeticForSlot("wheels", rarity);
      const decalCosmetic = pickBotCosmeticForSlot("decal", rarity);
      const spoilerCosmetic = pickBotCosmeticForSlot("spoiler", rarity);
      const underglowCosmetic = pickBotCosmeticForSlot("underglow", rarity);
      const boostCosmetic = pickBotCosmeticForSlot("boost", rarity);

      // Spells: select 5 unique spells from catalog
      const allSpellIds = Object.keys(spellsCatalog || {});
      const band =
        botConfig.spellLevelBands.find(
          (b: any) => normalizedTrophies >= b.minTrophies && normalizedTrophies <= b.maxTrophies,
        ) || botConfig.spellLevelBands[0];
      const shuffledSpellIds = rng.shuffle([...allSpellIds]);
      const botSpellCount = Math.min(5, shuffledSpellIds.length);
      const botSpells: Array<{ spellId: string; level: number; attrs: Record<string, unknown> }> = [];
      for (let i = 0; i < botSpellCount; i += 1) {
        const sid = shuffledSpellIds[i];
        const level = rng.int(band.minLevel, band.maxLevel);
        botSpells.push({
          spellId: sid,
          level,
          attrs: resolveSpellAttrs((spellsCatalog as any)[sid], level),
        });
      }

      return {
        displayName: botDisplayName,
        trophies: botTrophies,
        carId: botCarId,
        carStats: { real: botStats.real, display: botStats.display },
        cosmetics: {
          wheelsItemId: wheelsCosmetic.itemId,
          wheelsSkuId: wheelsCosmetic.skuId,
          decalItemId: decalCosmetic.itemId,
          decalSkuId: decalCosmetic.skuId,
          spoilerItemId: spoilerCosmetic.itemId,
          spoilerSkuId: spoilerCosmetic.skuId,
          underglowItemId: underglowCosmetic.itemId,
          underglowSkuId: underglowCosmetic.skuId,
          boostItemId: boostCosmetic.itemId,
          boostSkuId: boostCosmetic.skuId,
        },
        spells: botSpells,
      };
    });

    // Final validation: log summary of bot AI difficulty values
    console.log('[prepareRace] Bot generation complete - AI Difficulty Summary:');
    console.log(`  Total bots: ${bots.length}`);
    console.log(`  All have aiLevel: ${bots.every(b => typeof (b.carStats?.real as any)?.aiLevel === 'number')}`);
    console.log(`  All have performanceRanges: ${bots.every(b => !!(b.carStats?.real as any)?.performanceRanges)}`);
    console.log(`  Sample aiLevels: [${bots.slice(0, 3).map(b => (b.carStats.real as any).aiLevel).join(', ')}]`);

    const lobbyRatings: number[] = [playerTrophies, ...bots.map((bot) => bot.trophies)];
    const rawPreDeduct = calculateLastPlaceDelta(0, lobbyRatings, DEFAULT_TROPHY_CONFIG);
    const normalizedPlayerTrophies = Math.max(
      0,
      Math.floor(Number.isFinite(playerTrophies) ? playerTrophies : 0),
    );
    const preDeductedTrophies = rawPreDeduct < 0 ? Math.max(rawPreDeduct, -normalizedPlayerTrophies) : rawPreDeduct;

    const raceId = `race_${Math.random().toString(36).slice(2, 10)}`;
    const issuedAt = Date.now();
    const payload = {
      raceId,
      issuedAt,
      seed: resolvedSeed,
      laps,
      trackId: trackId || "track_01",
      player: {
        uid,
        trophies: playerTrophies,
        carId,
        carStats: { display: playerStats.display, real: playerStats.real },
        cosmetics: playerCosmetics,
        spells: playerSpells,
        deckIndex,
      },
      bots,
      preDeductedTrophies,
    };
    const proof = { hmac: hmacSign(payload) };
    const result = { ...payload, proof };
    const sanitisedResult = sanitizeForFirestore(result);

    await completeOperation(uid, opId, sanitisedResult);
    return sanitisedResult;
  } catch (e) {
    const err = e as Error;
    throw new HttpsError("internal", err.message, err);
  }
});
