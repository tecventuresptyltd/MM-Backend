import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region.js";
import { checkIdempotency, createInProgressReceipt, completeOperation } from "../core/idempotency.js";
import {
  getCarsCatalog,
  getSpellsCatalog,
  getCarTuningConfig,
  getBotConfig,
  listSkusByFilter,
  getBotNamesConfig,
} from "../core/config.js";
import { ItemSku, CarLevel } from "../shared/types.js";
import { SeededRNG } from "./lib/random.js";
import { resolveCarStats } from "./lib/stats.js";
import { calculateLastPlaceDelta, DEFAULT_TROPHY_CONFIG } from "./economy.js";
import * as crypto from "crypto";

const db = admin.firestore();

const resolveCarLevel = (car: Record<string, unknown> | undefined, targetLevel: number): Partial<CarLevel> | null => {
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
    const [carsCatalog, spellsCatalog, tuning, botConfig, wheelSkus, decalSkus, botNames] = await Promise.all([
      getCarsCatalog(),
      getSpellsCatalog(),
      getCarTuningConfig(),
      getBotConfig(),
      listSkusByFilter({ category: "cosmetic", subType: "wheels" }),
      listSkusByFilter({ category: "cosmetic", subType: "decal" }),
      getBotNamesConfig(),
    ]);

    // Resolve player car and stats
    const carId: string = loadout.carId || Object.keys(carsCatalog)[0];
    const playerCar = carsCatalog[carId];
    if (!playerCar) throw new HttpsError("failed-precondition", "Active car not found in catalog");
    const level = Number((garage.cars ?? {})[carId]?.upgradeLevel ?? 0);
    const playerStats = resolveCarStats(playerCar as any, level, tuning, false);

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
      const trophyOffset = rng.int(-100, 100);
      const botTrophies = Math.max(0, playerTrophies + trophyOffset);
      const normalizedTrophies = Math.max(0, Math.min(7000, botTrophies));
      const botCarId = pickBotCarId(normalizedTrophies);
      const botCar = carsCatalog[botCarId] || playerCar;
      const botStats = resolveCarStats(botCar as any, 0, tuning, true);

      const rarityWeights = pickRarityBand(botConfig.cosmeticRarityWeights, normalizedTrophies);
      const rarity = weightedChoice(rarityWeights as any, rng);
      const wheelsSku = pickSkuForRarity(wheelSkus, rarity);
      const decalSku = pickSkuForRarity(decalSkus, rarity);

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
          wheelsItemId: wheelsSku?.itemId ?? null,
          wheelsSkuId: wheelsSku?.skuId ?? null,
          decalItemId: decalSku?.itemId ?? null,
          decalSkuId: decalSku?.skuId ?? null,
        },
        spells: botSpells,
      };
    });

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

    await completeOperation(uid, opId, result);
    return result;
  } catch (e) {
    const err = e as Error;
    throw new HttpsError("internal", err.message, err);
  }
});
