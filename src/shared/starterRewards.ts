import { getCratesCatalogDoc, getItemsCatalogDoc } from "../core/config.js";
import { CrateDefinition, CratesCatalogDoc, Item } from "./types.js";

export interface StarterRewardsConfig {
  crateId: string;
  crateItemId: string;
  crateSkuId: string;
  crate: CrateDefinition;
  crateItem: Item;
  keyItemId: string;
  keySkuId: string;
  keyItem: Item;
}

const cache = new Map<string, { value: StarterRewardsConfig; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 1000;

const isCosmeticStarterCrate = (crate: CrateDefinition): boolean =>
  crate.tags?.includes("starter") ?? false;

const resolveStarterCrateId = (doc: CratesCatalogDoc): string | null => {
  if (doc.defaults?.starterCrateId) {
    return doc.defaults.starterCrateId;
  }
  const entry = Object.entries(doc.crates).find(([, crate]) =>
    isCosmeticStarterCrate(crate),
  );
  return entry ? entry[0] : null;
};

export const loadStarterRewards = async (): Promise<StarterRewardsConfig> => {
  const now = Date.now();
  const cacheKey = "canonical";
  const cached = cache.get(cacheKey);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const [itemsDoc, cratesDoc] = await Promise.all([
    getItemsCatalogDoc(),
    getCratesCatalogDoc(),
  ]);

  const starterCrateId = resolveStarterCrateId(cratesDoc);
  if (!starterCrateId) {
    throw new Error("Starter crate ID missing from CratesCatalog.");
  }

  const crate = cratesDoc.crates[starterCrateId];
  if (!crate) {
    throw new Error(`Starter crate ${starterCrateId} missing from CratesCatalog.`);
  }

  const crateItemId = starterCrateId;
  const crateItem = itemsDoc.items[crateItemId];
  if (!crateItem || crateItem.type !== "crate") {
    throw new Error(`ItemsCatalog missing crate item ${crateItemId}.`);
  }
  const crateSkuId =
    (typeof crate.skuId === "string" && crate.skuId.trim().length > 0
      ? crate.skuId.trim()
      : null) ??
    (Array.isArray(crateItem.variants)
      ? crateItem.variants
          .map((variant) =>
            typeof variant?.skuId === "string" && variant.skuId.trim().length > 0
              ? variant.skuId.trim()
              : null,
          )
          .find((skuId): skuId is string => !!skuId)
      : null);

  if (!crateSkuId) {
    throw new Error(`Starter crate ${starterCrateId} is missing a skuId.`);
  }

  const keySkuFromCatalog =
    (typeof crate.keySkuId === "string" && crate.keySkuId.trim().length > 0
      ? crate.keySkuId.trim()
      : null) ??
    (typeof cratesDoc.defaults?.starterKeySkuId === "string"
      ? cratesDoc.defaults.starterKeySkuId.trim()
      : null);

  if (!keySkuFromCatalog) {
    throw new Error(`Starter key SKU missing for crate ${starterCrateId}.`);
  }

  const resolveKeyItemId = (): string | null => {
    if (typeof crate.keyItemId === "string" && crate.keyItemId.trim()) {
      return crate.keyItemId.trim();
    }
    if (
      typeof cratesDoc.defaults?.starterKeyItemId === "string" &&
      cratesDoc.defaults.starterKeyItemId.trim()
    ) {
      const candidate = cratesDoc.defaults.starterKeyItemId.trim();
      if (candidate) {
        return candidate;
      }
    }
    for (const [itemId, item] of Object.entries(itemsDoc.items)) {
      if (item?.type !== "key" || !Array.isArray(item.variants)) {
        continue;
      }
      const matches = item.variants.some(
        (variant) =>
          typeof variant?.skuId === "string" &&
          variant.skuId.trim() === keySkuFromCatalog,
      );
      if (matches) {
        return itemId;
      }
    }
    return null;
  };

  const keyItemId = resolveKeyItemId();
  if (!keyItemId) {
    throw new Error(
      `Starter key item ID missing for crate ${starterCrateId}.`,
    );
  }

  const keyItem = itemsDoc.items[keyItemId];
  if (!keyItem || keyItem.type !== "key") {
    throw new Error(`ItemsCatalog missing key item ${keyItemId}.`);
  }
  const keySkuId =
    keySkuFromCatalog ??
    (Array.isArray(keyItem.variants)
      ? keyItem.variants
          .map((variant) =>
            typeof variant?.skuId === "string" && variant.skuId.trim().length > 0
              ? variant.skuId.trim()
              : null,
          )
          .find((skuId): skuId is string => !!skuId)
      : null);

  if (!keySkuId) {
    throw new Error(`Starter key item ${keyItemId} is missing a skuId.`);
  }

  const config: StarterRewardsConfig = {
    crateId: starterCrateId,
    crateItemId,
    crateSkuId,
    crate,
    crateItem,
    keyItemId,
    keySkuId,
    keyItem,
  };
  cache.set(cacheKey, { value: config, fetchedAt: now });
  return config;
};
