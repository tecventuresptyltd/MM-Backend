import {
  getBotConfig,
  getCarsCatalog,
  getSpellsCatalog,
  getItemSkusCatalog,
} from "../core/config.js";

export interface GeneratedBotLoadout {
  carId: string;
  cosmetics: {
    wheels: string | null;
    decals: string | null;
    spoilers: string | null;
    underglow: string | null;
    boost: string | null;
  };
  spellDeck: Array<{ spellId: string; level: number }>;
  difficulty: {
    aiLevel: number;
  };
}

const COSMETIC_SLOTS: Array<{ slot: keyof GeneratedBotLoadout["cosmetics"]; subType: string }> = [
  { slot: "wheels", subType: "wheels" },
  { slot: "decals", subType: "decal" },
  { slot: "spoilers", subType: "spoiler" },
  { slot: "underglow", subType: "underglow" },
  { slot: "boost", subType: "boost" },
];

let cachedCarIds: string[] | null = null;
let cachedSpellIds: string[] | null = null;
let cachedCosmeticPools: Record<string, string[]> | null = null;

const randomOf = <T>(arr: T[]): T | null => {
  if (!arr.length) {
    return null;
  }
  const idx = Math.floor(Math.random() * arr.length);
  return arr[idx] ?? null;
};

const DEFAULT_TROPHY_BREAKS = [
  0, 1400, 2000, 2600, 3200,
  3800, 4400, 5000, 5600, 6000,
  6300, 6600, 6800, 6900, 7000,
];

const ensureCatalogCaches = async (): Promise<void> => {
  if (!cachedCarIds) {
    const cars = await getCarsCatalog();
    cachedCarIds = Object.keys(cars);
  }
  if (!cachedSpellIds) {
    const spells = await getSpellsCatalog();
    cachedSpellIds = Object.keys(spells);
  }
  if (!cachedCosmeticPools) {
    const pools: Record<string, string[]> = {};
    COSMETIC_SLOTS.forEach(({ slot }) => {
      pools[slot] = [];
    });
    const skus = await getItemSkusCatalog();
    Object.values(skus).forEach((sku) => {
      if (!sku || sku.category !== "cosmetic") {
        return;
      }
      const sub = typeof sku.subType === "string" ? sku.subType.toLowerCase() : "";
      const entry = COSMETIC_SLOTS.find(
        ({ subType }) => subType.toLowerCase() === sub,
      );
      if (!entry || typeof sku.skuId !== "string") {
        return;
      }
      pools[entry.slot].push(sku.skuId);
    });
    cachedCosmeticPools = pools;
  }
};

const pickCosmetics = (): GeneratedBotLoadout["cosmetics"] => {
  if (!cachedCosmeticPools) {
    return {
      wheels: null,
      decals: null,
      spoilers: null,
      underglow: null,
      boost: null,
    };
  }
  const cosmetics: Partial<GeneratedBotLoadout["cosmetics"]> = {};
  for (const { slot } of COSMETIC_SLOTS) {
    const pool = cachedCosmeticPools[slot] ?? [];
    cosmetics[slot] = randomOf(pool);
  }
  return cosmetics as GeneratedBotLoadout["cosmetics"];
};

const buildSpellDeck = async (trophyCount: number): Promise<GeneratedBotLoadout["spellDeck"]> => {
  if (!cachedSpellIds || cachedSpellIds.length === 0) {
    return [];
  }

  // Get bot config for spell level bands
  const botConfig = await getBotConfig().catch(() => null);
  const normalizedTrophies = Math.max(0, Math.min(7000, Math.floor(trophyCount)));

  // Find appropriate spell level band
  const band = botConfig?.spellLevelBands?.find(
    (b: any) => normalizedTrophies >= b.minTrophies && normalizedTrophies <= b.maxTrophies
  ) || { minLevel: 1, maxLevel: 2 }; // Fallback to rookie tier

  const deckSize = Math.min(5, cachedSpellIds.length);
  const deck: Array<{ spellId: string; level: number }> = [];
  const shuffled = [...cachedSpellIds].sort(() => Math.random() - 0.5); // Shuffle

  for (let i = 0; i < deckSize; i++) {
    const spellId = shuffled[i];
    if (!spellId) break;

    // Random level within band range
    const level = Math.floor(Math.random() * (band.maxLevel - band.minLevel + 1)) + band.minLevel;
    deck.push({ spellId, level });
  }
  return deck;
};

export const buildBotLoadout = async (trophyCount: number): Promise<GeneratedBotLoadout> => {
  await ensureCatalogCaches();

  const botConfig = await getBotConfig().catch(() => null);

  const pickCarId = (): string => {
    const fallback =
      cachedCarIds && cachedCarIds.length > 0
        ? cachedCarIds[Math.floor(Math.random() * cachedCarIds.length)]
        : "car_default";

    const buildThresholds = (): Array<{ carId: string; trophies: number }> => {
      if (botConfig && Array.isArray(botConfig.carUnlockThresholds) && botConfig.carUnlockThresholds.length > 0) {
        return [...botConfig.carUnlockThresholds].filter(
          (t) => t && typeof t.carId === "string" && typeof t.trophies === "number",
        );
      }
      // Fallback: align cached carIds with default trophy breaks
      const cars = cachedCarIds ? [...cachedCarIds].sort() : [];
      return DEFAULT_TROPHY_BREAKS.slice(0, cars.length).map((trophies, idx) => ({
        carId: cars[idx] ?? fallback,
        trophies,
      }));
    };

    const thresholds = buildThresholds();
    if (thresholds.length === 0) {
      return fallback;
    }

    thresholds.sort((a, b) => a.trophies - b.trophies);
    const clampedTrophies = Math.max(0, Math.floor(trophyCount));

    // Find the highest unlocked car (last threshold where trophies <= clampedTrophies)
    let idx = 0;
    for (let i = thresholds.length - 1; i >= 0; i--) {
      if (thresholds[i].trophies <= clampedTrophies) {
        idx = i;
        break;
      }
    }

    // ±1 variance for variety
    const variance = Math.round(Math.random() * 2 - 1); // -1,0,1
    idx = Math.max(0, Math.min(thresholds.length - 1, idx + variance));

    const candidate = thresholds[idx]?.carId;
    const exists = cachedCarIds?.includes(candidate ?? "") ?? false;
    return exists ? (candidate as string) : fallback;
  };

  const carId = pickCarId();

  const cosmetics = pickCosmetics();
  const spellDeck = await buildSpellDeck(trophyCount);
  const aiLevel = Math.min(10, Math.max(1, Math.floor(trophyCount / 100) + 1));

  return {
    carId,
    cosmetics,
    spellDeck,
    difficulty: { aiLevel },
  };
};
