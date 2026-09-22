import * as admin from "firebase-admin";

export interface GemPack {
  iapId: string;
  displayName: string;
  gemAmount: number;
  priceUsd: number;
  bonusLabel?: string | null;
  productId: string;
  sortOrder: number;
}

interface GemPacksCatalogDoc {
  version?: string;
  packs?: Record<string, GemPack>;
}

const CATALOG_PATH = "GameData/v1/catalogs/GemPacksCatalog";
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { packs: GemPack[]; byProductId: Map<string, GemPack>; fetchedAt: number } | null = null;

const isValidPack = (value: unknown): value is GemPack => {
  const pack = value as GemPack;
  return (
    !!pack &&
    typeof pack.iapId === "string" &&
    typeof pack.productId === "string" &&
    typeof pack.gemAmount === "number" &&
    Number.isFinite(pack.gemAmount) &&
    pack.gemAmount > 0
  );
};

const loadCatalog = async (): Promise<NonNullable<typeof cache>> => {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache;
  }

  const snapshot = await admin.firestore().doc(CATALOG_PATH).get();
  if (!snapshot.exists) {
    throw new Error(`GemPacksCatalog not found at /${CATALOG_PATH}`);
  }

  const doc = snapshot.data() as GemPacksCatalogDoc;
  const packs = Object.values(doc.packs ?? {}).filter(isValidPack);
  if (packs.length === 0) {
    throw new Error(`GemPacksCatalog at /${CATALOG_PATH} contains no valid packs.`);
  }

  packs.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  const byProductId = new Map<string, GemPack>();
  packs.forEach((pack) => byProductId.set(pack.productId, pack));

  cache = { packs, byProductId, fetchedAt: now };
  return cache;
};

export const getGemPacksCatalog = async (): Promise<GemPack[]> =>
  (await loadCatalog()).packs;

export const findGemPackByProductId = async (
  productId: string,
): Promise<GemPack | null> => {
  const key = typeof productId === "string" ? productId.trim() : "";
  if (!key) {
    return null;
  }
  return (await loadCatalog()).byProductId.get(key) ?? null;
};

export const __resetGemPacksCacheForTests = (): void => {
  cache = null;
};
