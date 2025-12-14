import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { SeededRNG } from "../src/race/lib/random";
import { resolveCarStats } from "../src/race/lib/stats";
import type { CarLevel, CarTuningConfig, ItemSku } from "../src/shared/types";

type CarCatalog = Record<string, { carId: string; levels: Record<string, CarLevel> }>;
type SpellsCatalog = Record<string, any>;

const repoRoot = path.join(__dirname, "..");

const loadJson = <T>(relative: string): T =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, relative), "utf8")) as T;

const carsCatalog = loadJson<{ cars: CarCatalog }>("seeds/Atul-Final-Seeds/CarsCatalog.json").cars;
const spellsCatalog = loadJson<{ spells: SpellsCatalog }>("seeds/Atul-Final-Seeds/SpellsCatalog.json").spells;
const itemSkus = loadJson<{ skus: Record<string, ItemSku> }>("seeds/Atul-Final-Seeds/ItemSkusCatalog.json").skus;
const botNamesConfig = loadJson<{ data: { names: string[] } }>("seeds/Atul-Final-Seeds/BotNamesConfig.json").data.names;

const tuningConfig: CarTuningConfig = {
  valueScale: { min: 1, max: 16, step: 1 },
  player: {
    topSpeed: { min: 90, max: 220 },
    acceleration: { min: 8, max: 28 },
    handling: { min: 5, max: 32 },
    boostRegen: { min: 5, max: 25 },
    boostPower: { min: 40, max: 120 },
  },
  bot: {
    topSpeed: { min: 85, max: 215 },
    acceleration: { min: 7, max: 26 },
    handling: { min: 4, max: 30 },
    boostRegen: { min: 5, max: 24 },
    boostPower: { min: 36, max: 110 },
  },
  notes: "QA verification tuning",
  updatedAt: Date.now(),
};

const botConfig = {
  carUnlockThresholds: [
    { carId: "car_h4ayzwf31g", trophies: 0 },
    { carId: "car_2n5hnes4", trophies: 1200 },
  ],
  cosmeticRarityWeights: {
    "0-999": { common: 85, rare: 14, epic: 1, legendary: 0 },
    "1000-1999": { common: 70, rare: 22, epic: 6, legendary: 2 },
    "2000-4000": { common: 55, rare: 30, epic: 10, legendary: 5 },
  },
  spellLevelBands: [
    { minTrophies: 0, maxTrophies: 999, minLevel: 1, maxLevel: 2 },
    { minTrophies: 1000, maxTrophies: 2499, minLevel: 2, maxLevel: 3 },
    { minTrophies: 2500, maxTrophies: 4999, minLevel: 4, maxLevel: 5 },
    { minTrophies: 5000, maxTrophies: 99999, minLevel: 5, maxLevel: 5 },
  ],
};

const resolveCarLevel = (car: { levels: Record<string, CarLevel> }, targetLevel: number): CarLevel => {
  const normalized = Math.max(0, Math.floor(Number.isFinite(targetLevel) ? targetLevel : 0));
  const direct = car.levels[String(normalized)];
  if (direct) return direct;
  if (normalized > 0 && car.levels[String(normalized - 1)]) {
    return car.levels[String(normalized - 1)];
  }
  return car.levels["0"] ?? Object.values(car.levels)[0];
};

const pickRarityBand = (weightsByBand: Record<string, Record<string, number>>, trophies: number) => {
  const key =
    Object.keys(weightsByBand).find((band) => {
      const [min, max] = band.split("-").map((v) => Number(v));
      return trophies >= min && trophies <= max;
    }) ?? Object.keys(weightsByBand)[0];
  return weightsByBand[key];
};

const weightedChoice = <T extends string>(weights: Record<T, number>, rng: SeededRNG): T => {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng.nextFloat(0, total);
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll <= 0) {
      return value;
    }
  }
  return entries[entries.length - 1][0];
};

const pickSkuForRarity = (pool: ItemSku[], rarity: string, rng: SeededRNG): ItemSku | null => {
  const filtered = pool.filter((sku) => sku.rarity?.toLowerCase() === rarity.toLowerCase());
  const source = filtered.length > 0 ? filtered : pool;
  if (source.length === 0) {
    return null;
  }
  return rng.choice(source) ?? null;
};

const resolveSpellAttrs = (spellDef: any, level: number) => {
  if (!spellDef) return {};
  if (spellDef.baseStats && Object.keys(spellDef.baseStats).length > 0) {
    return spellDef.baseStats;
  }
  const attributes = Array.isArray(spellDef.attributes) ? spellDef.attributes : [];
  const normalized: Record<string, unknown> = {};
  for (const attr of attributes) {
    if (!attr || typeof attr.name !== "string") continue;
    const values = Array.isArray(attr.values) ? attr.values : [];
    const idx = Math.min(Math.max(level - 1, 0), values.length > 0 ? values.length - 1 : 0);
    normalized[attr.name] = values.length > 0 ? values[idx] ?? values[values.length - 1] : null;
  }
  return normalized;
};

const wheels = Object.values(itemSkus).filter((sku) => sku.category === "cosmetic" && sku.subType === "wheels");
const decals = Object.values(itemSkus).filter((sku) => sku.category === "cosmetic" && sku.subType === "decal");

const rng = new SeededRNG("qa-verify-bots");
const botNames = botNamesConfig.filter((name) => typeof name === "string" && name.trim().length > 0);
let botNameDeck = rng.shuffle(botNames);
let botNameCursor = 0;
const nextBotName = (): string => {
  if (botNameDeck.length === 0 || botNameCursor >= botNameDeck.length) {
    botNameDeck = rng.shuffle(botNames);
    botNameCursor = 0;
  }
  const candidate = botNameDeck[botNameCursor] ?? `BOT_${rng.int(1000, 9999)}`;
  botNameCursor += 1;
  return candidate;
};

const playerTrophies = 1500;
const playerCarId = "car_h4ayzwf31g";
const playerCar = carsCatalog[playerCarId];
const playerLevelData = resolveCarLevel(playerCar, 5);
const playerStats = resolveCarStats(playerLevelData, tuningConfig, false);

console.log("Player car stats snapshot:", playerStats.display);

const pickBotCarId = (trophies: number): string => {
  const thresholds = [...botConfig.carUnlockThresholds].sort((a, b) => a.trophies - b.trophies);
  let idx = thresholds.findIndex((threshold) => trophies < threshold.trophies) - 1;
  if (idx < 0) idx = thresholds.length - 1;
  idx = Math.max(0, Math.min(thresholds.length - 1, idx + rng.int(-1, 1)));
  return thresholds[idx].carId;
};

const allSpellIds = Object.keys(spellsCatalog || {});

const bots = Array.from({ length: 7 }).map(() => {
  const displayName = nextBotName();
  const trophyOffset = rng.int(-100, 100);
  const trophies = Math.max(0, playerTrophies + trophyOffset);
  const normalizedTrophies = Math.max(0, Math.min(7000, trophies));
  const botCarId = pickBotCarId(normalizedTrophies);
  const botCar = carsCatalog[botCarId] || playerCar;
  const botLevel = resolveCarLevel(botCar, 0);
  const botStats = resolveCarStats(botLevel, tuningConfig, true);

  const rarityWeights = pickRarityBand(botConfig.cosmeticRarityWeights, normalizedTrophies);
  const rarity = weightedChoice(rarityWeights as Record<string, number>, rng);
  const wheelsSku = pickSkuForRarity(wheels, rarity, rng);
  const decalSku = pickSkuForRarity(decals, rarity, rng);

  const band =
    botConfig.spellLevelBands.find(
      (b: any) => normalizedTrophies >= b.minTrophies && normalizedTrophies <= b.maxTrophies,
    ) || botConfig.spellLevelBands[0];
  const botSpellCount = Math.min(2, allSpellIds.length);
  const spells = [];
  for (let i = 0; i < botSpellCount; i += 1) {
    const spellId = rng.choice(allSpellIds);
    if (!spellId) continue;
    const level = rng.int(band.minLevel, band.maxLevel);
    spells.push({ spellId, level, attrs: resolveSpellAttrs(spellsCatalog[spellId], level) });
  }

  return {
    displayName,
    trophies,
    carId: botCarId,
    carStats: botStats,
    cosmetics: {
      wheelsSkuId: wheelsSku?.skuId ?? null,
      decalSkuId: decalSku?.skuId ?? null,
    },
    spells,
  };
});

console.log("\nGenerated bots:");
bots.forEach((bot, idx) => {
  console.log(`${idx + 1}. ${bot.displayName} — ${bot.trophies} trophies — wheels ${bot.cosmetics.wheelsSkuId}`);
});

bots.forEach((bot) => {
  assert.ok(
    bot.trophies >= 1400 && bot.trophies <= 1600,
    `Bot trophies ${bot.trophies} outside expected window`,
  );
  assert.equal(typeof bot.displayName, "string", "displayName must be a string");
  assert.match(bot.displayName, /^[A-Za-z0-9_.-]{4,}$/);
  Object.entries(bot.cosmetics).forEach(([slot, sku]) => {
    if (sku) {
      assert.ok(sku.startsWith("sku_"), `${slot} should contain skuId, got ${sku}`);
    }
  });
});

console.log("\n✅ Verification passed: all bots have names, valid trophies, and cosmetic skuIds.");
