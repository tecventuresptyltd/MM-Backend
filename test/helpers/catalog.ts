import {
  getCarsCatalog,
  getCratesCatalogDoc,
  getItemsCatalogDoc,
  listSkusByFilter,
} from "../../src/core/config.js";
import { loadStarterRewards } from "../../src/shared/starterRewards.js";
import type { ItemSku } from "../../src/shared/types.js";

export interface StarterCrateInfo {
  crateId: string;
  crateItemId: string;
  crateSkuId: string;
  keyItemId: string;
  keySkuId: string;
}

export const loadStarterCrateAndKey = async (): Promise<StarterCrateInfo> => {
  const rewards = await loadStarterRewards();
  return {
    crateId: rewards.crateId,
    crateItemId: rewards.crateItemId,
    crateSkuId: rewards.crateSkuId,
    keyItemId: rewards.keyItemId,
    keySkuId: rewards.keySkuId,
  };
};

export const pickCosmeticSku = async (params: {
  subType?: string;
  rarity?: string;
} = {}): Promise<ItemSku> => {
  const { subType, rarity } = params;
  const candidates = await listSkusByFilter({
    category: "cosmetic",
    subType,
    rarity,
  });
  if (!candidates.length) {
    throw new Error(
      `No cosmetic SKUs found for filters ${JSON.stringify(params)}`,
    );
  }
  return [...candidates].sort((a, b) => a.skuId.localeCompare(b.skuId))[0];
};

export const pickCosmeticSkus = async (
  params: {
    subType?: string;
    rarity?: string;
  } = {},
  count = 2,
): Promise<ItemSku[]> => {
  const candidates = await listSkusByFilter({
    category: "cosmetic",
    subType: params.subType,
    rarity: params.rarity,
  });
  if (!candidates.length) {
    throw new Error(
      `No cosmetic SKUs found for filters ${JSON.stringify(params)}`,
    );
  }
  const sorted = [...candidates].sort((a, b) => a.skuId.localeCompare(b.skuId));
  if (sorted.length < count) {
    throw new Error(
      `Not enough cosmetic SKUs (${sorted.length}) for filters ${JSON.stringify(params)}; need ${count}.`,
    );
  }
  return sorted.slice(0, count);
};

export const findPurchasableCrate = async (params: {
  rarity?: string;
  requireKey?: boolean;
} = {}): Promise<{
  crateId: string;
  crateSkuId: string;
  keySkuId: string | null;
}> => {
  const cratesDoc = await getCratesCatalogDoc();
  const itemsDoc = await getItemsCatalogDoc();
  const entries = Object.entries(cratesDoc.crates ?? {});
  const filtered = entries.filter(([crateId, crate]) => {
    if (params.rarity && crate.rarity !== params.rarity) {
      return false;
    }
    if (params.requireKey && !crate.keySkuId) {
      return false;
    }
    const skuId =
      crate.crateSkuId ??
      crate.skuId ??
      itemsDoc.items[crate.crateId]?.variants?.[0]?.skuId ??
      null;
    return Boolean(skuId);
  });
  if (!filtered.length) {
    throw new Error(
      `No crates found matching filters ${JSON.stringify(params)}`,
    );
  }
  const [crateId, crate] = filtered.sort((a, b) =>
    a[0].localeCompare(b[0]),
  )[0];
  const crateSkuId =
    crate.crateSkuId ??
    crate.skuId ??
    itemsDoc.items[crate.crateId]?.variants?.[0]?.skuId ??
    "";
  if (!crateSkuId) {
    throw new Error(`Crate ${crateId} missing skuId in catalog.`);
  }
  return {
    crateId,
    crateSkuId,
    keySkuId: crate.keySkuId ?? null,
  };
};

export const loadCrateSkuMap = async (): Promise<{
  crates: Record<string, string>;
  starterCrateId: string;
}> => {
  const cratesDoc = await getCratesCatalogDoc();
  const crates: Record<string, string> = {};
  for (const [crateId, crate] of Object.entries(cratesDoc.crates ?? {})) {
    const skuId = crate.crateSkuId ?? crate.skuId ?? null;
    if (skuId) {
      crates[crateId] = skuId;
    }
  }
  return {
    crates,
    starterCrateId:
      cratesDoc.defaults?.starterCrateId ?? Object.keys(crates)[0] ?? "",
  };
};

export const loadKeySkuMap = async (): Promise<Record<string, string>> => {
  const itemsDoc = await getItemsCatalogDoc();
  const keyMap: Record<string, string> = {};
  for (const item of Object.values(itemsDoc.items ?? {})) {
    if (!item || item.type !== "key") {
      continue;
    }
    const rarity = typeof item.rarity === "string" ? item.rarity.toLowerCase() : null;
    const variant = Array.isArray(item.variants)
      ? item.variants.find((entry) => typeof entry?.skuId === "string" && entry.skuId.trim().length > 0)
      : null;
    if (rarity && variant?.skuId) {
      keyMap[rarity] = variant.skuId;
    }
  }
  return keyMap;
};

export const loadBoosterSkuMap = async (): Promise<Record<string, string>> => {
  const itemsDoc = await getItemsCatalogDoc();
  const boosterMap: Record<string, string> = {};
  const boosters = Object.values(itemsDoc.items ?? {}).filter(
    (item) => item?.type === "booster",
  );
  for (const booster of boosters) {
    const variants = Array.isArray(booster.variants) ? booster.variants : [];
    const preferred =
      variants.find(
        (variant) =>
          typeof variant?.variant === "object" &&
          variant?.variant !== null &&
          typeof (variant.variant as Record<string, unknown>).durationLabel === "string" &&
          (variant.variant as Record<string, string>).durationLabel === "24h",
      ) ??
      variants.find(
        (variant) => typeof variant?.skuId === "string" && variant.skuId.trim().length > 0,
      );
    const subType =
      typeof (preferred?.subType) === "string"
        ? preferred.subType.toLowerCase()
        : typeof (booster as Record<string, unknown>).subType === "string"
        ? ((booster as Record<string, string>).subType ?? "").toLowerCase()
        : null;
    if (preferred?.skuId && subType) {
      const key = subType === "xp" ? "exp" : subType;
      boosterMap[key] = preferred.skuId;
      boosterMap[subType] = preferred.skuId;
    }
  }
  return boosterMap;
};

export const pickUpgradeableCar = async (): Promise<{
  carId: string;
  basePrice: number;
  upgradeCost: number;
}> => {
  const cars = await getCarsCatalog();
  const entries = Object.entries(cars).filter(([, car]) => {
    const hasMultipleLevels =
      car.levels && Object.keys(car.levels).length > 1;
    return car.basePrice > 0 && hasMultipleLevels;
  });
  if (!entries.length) {
    throw new Error("No upgradeable cars found in catalog.");
  }
  const [carId, car] = entries.sort((a, b) =>
    a[0].localeCompare(b[0]),
  )[0];
  const nextLevelCost = Number(car.levels?.["1"]?.priceCoins ?? 0);
  return {
    carId,
    basePrice: car.basePrice,
    upgradeCost: nextLevelCost,
  };
};
