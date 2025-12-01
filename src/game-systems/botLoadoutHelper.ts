import { getCarsCatalog, getSpellsCatalog, getItemSkusCatalog } from "../core/config.js";

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

const buildSpellDeck = (): GeneratedBotLoadout["spellDeck"] => {
  if (!cachedSpellIds || cachedSpellIds.length === 0) {
    return [];
  }
  const deckSize = Math.min(2, cachedSpellIds.length);
  const deck: Array<{ spellId: string; level: number }> = [];
  const available = [...cachedSpellIds];
  for (let i = 0; i < deckSize; i++) {
    const pick = randomOf(available);
    if (!pick) {
      break;
    }
    deck.push({ spellId: pick, level: Math.max(1, Math.floor(Math.random() * 3) + 1) });
    available.splice(available.indexOf(pick), 1);
  }
  return deck;
};

export const buildBotLoadout = async (trophyCount: number): Promise<GeneratedBotLoadout> => {
  await ensureCatalogCaches();

  const carId =
    cachedCarIds && cachedCarIds.length > 0
      ? cachedCarIds[Math.floor(Math.random() * cachedCarIds.length)]
      : "car_default";

  const cosmetics = pickCosmetics();
  const spellDeck = buildSpellDeck();
  const aiLevel = Math.min(10, Math.max(1, Math.floor(trophyCount / 100) + 1));

  return {
    carId,
    cosmetics,
    spellDeck,
    difficulty: { aiLevel },
  };
};
