import * as admin from "firebase-admin";
import {
  Car,
  Item,
  Offer,
  Rank,
  Spell,
  XpCurve,
  CarTuningConfig,
} from "../shared/types.js";
import {
  getItemsCatalog as loadItemsCatalog,
  getItemsCatalogDoc as loadItemsCatalogDoc,
  getItemById as loadItemById,
  getItemBySkuId as loadItemBySkuId,
  getFamilyMembers as loadFamilyMembers,
  getFamilyForSku as loadFamilyForSku,
  getSkuRecord as loadSkuRecord,
  listSkusForItem as loadSkusForItem,
  listSkusByFilter as loadSkusByFilter,
  getPriceForSku as loadPriceForSku,
  isPurchasableSku as loadIsPurchasableSku,
  getItemSkusCatalog as loadItemSkusCatalog,
  getItemSkusCatalogDoc as loadItemSkusCatalogDoc,
  resolveSkuOrThrow as loadResolveSkuOrThrow,
  assertAllVariantSkuIdsUnique as ensureUniqueVariantSkuIds,
  getCratesCatalogDoc as loadCratesCatalogDoc,
  getCratesCatalog as loadCratesCatalog,
  getSpellsCatalog as loadSpellsCatalog,
  findVariantBySku as loadFindVariantBySku,
  invalidateCatalogCache,
} from "./catalog.js";
import { ReferralConfig } from "../referral/types.js";

const db = admin.firestore();
const catalogRoot = db.collection("GameData").doc("v1").collection("catalogs");
const gameDataV1 = db.collection("GameData").doc("v1");
const referralConfigDoc = gameDataV1.collection("config").doc("ReferralConfig.v1");

const DEFAULT_CATALOG_REFS: Record<string, FirebaseFirestore.DocumentReference> = {
  ItemsCatalog: catalogRoot.doc("ItemsCatalog"),
  ItemsIndex: catalogRoot.doc("ItemsIndex"),
  CratesCatalog: catalogRoot.doc("CratesCatalog"),
  OffersCatalog: catalogRoot.doc("OffersCatalog"),
  SpellsCatalog: catalogRoot.doc("SpellsCatalog"),
  RanksCatalog: catalogRoot.doc("RanksCatalog"),
  XpCurve: catalogRoot.doc("XpCurve"),
  CarsCatalog: catalogRoot.doc("CarsCatalog"),
};

interface GameConfig {
  versionId: string;
  xpCurveId: string;
  featureFlags: Record<string, boolean>;
  // ... other config properties
}

let activeConfig: GameConfig | null = null;
let lastFetchedConfig: number = 0;
const CONFIG_CACHE_DURATION_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches the active game configuration, using an in-memory cache.
 * @returns {Promise<GameConfig>} The active game configuration.
 */
export async function getActiveGameConfig(): Promise<GameConfig> {
  const now = Date.now();
  if (activeConfig && now - lastFetchedConfig < CONFIG_CACHE_DURATION_MS) {
    return activeConfig;
  }

  try {
    const activeVersionRef = db.doc("/GameConfig/active");
    const activeVersionDoc = await activeVersionRef.get();

    if (!activeVersionDoc.exists) {
      throw new Error("Active game config version pointer not found!");
    }

    const { versionId } = activeVersionDoc.data() as { versionId: string };
    const configRef = db.doc(`/GameConfig/v1/Versions/${versionId}`);
    const configDoc = await configRef.get();

    if (!configDoc.exists) {
      throw new Error(`Game config for version ${versionId} not found!`);
    }

    activeConfig = configDoc.data() as GameConfig;
    lastFetchedConfig = now;
    console.log(`[Config] Loaded and cached game config version: ${versionId}`);
    return activeConfig;
  } catch (error) {
    console.error("[Config] Failed to fetch active game config:", error);
    if (activeConfig) {
      return activeConfig;
    }
    throw new Error("Could not load game configuration.");
  }
}

// --- Catalog Loader ---

const CATALOG_CACHE_TTL_MS = 60 * 1000; // 60 seconds
const catalogCache: Map<string, { data: any; lastFetched: number }> =
  new Map();

const REFERRAL_CACHE_TTL_MS = 60 * 1000;
let referralConfigCache: { data: ReferralConfig; lastFetched: number } | null = null;

async function getCatalog<T>(catalogName: string): Promise<T> {
  const now = Date.now();
  const cacheKey = catalogName;
  const cached = catalogCache.get(cacheKey);

  if (cached && now - cached.lastFetched < CATALOG_CACHE_TTL_MS) {
    return cached.data as T;
  }

  console.log(`[CatalogLoader] Cache miss for "${catalogName}", fetching from Firestore.`);

  const ref = DEFAULT_CATALOG_REFS[catalogName] ?? catalogRoot.doc(catalogName);
  const snapshot = await ref.get();

  if (!snapshot.exists) {
    console.error(`[CatalogLoader] Catalog document not found: ${catalogName}`);
    throw new Error(`Catalog not found: ${catalogName}`);
  }

  const data = snapshot.data() as T;
  catalogCache.set(cacheKey, { data, lastFetched: now });
  return data;
}

export const getCarsCatalog = async (): Promise<Record<string, Car>> =>
  (await getCatalog<{ cars: Record<string, Car> }>("CarsCatalog")).cars;

export const getItemsCatalog = loadItemsCatalog;
export const getItemsCatalogDoc = loadItemsCatalogDoc;
export const getCatalogItemById = loadItemById;
export const getItemBySkuId = loadItemBySkuId;
export const getCatalogItemBySkuId = loadItemBySkuId;
export const getFamilyMembers = loadFamilyMembers;
export const getFamilyForSku = loadFamilyForSku;
export const getSkuRecord = loadSkuRecord;
export const resolveSkuOrThrow = loadResolveSkuOrThrow;
export const listSkusForItem = loadSkusForItem;
export const listSkusByFilter = loadSkusByFilter;
export const getPriceForSku = loadPriceForSku;
export const isPurchasableSku = loadIsPurchasableSku;
export const assertAllVariantSkuIdsUnique = ensureUniqueVariantSkuIds;
export const getItemSkusCatalog = loadItemSkusCatalog;
export const getItemSkusCatalogDoc = loadItemSkusCatalogDoc;
export const getSpellsCatalog = loadSpellsCatalog;
export const getCratesCatalogDoc = loadCratesCatalogDoc;
export const getCratesCatalog = loadCratesCatalog;
export const findVariantBySku = loadFindVariantBySku;

export const getOffersCatalog = async (): Promise<Record<string, Offer>> =>
  (await getCatalog<{ offers: Record<string, Offer> }>("OffersCatalog"))
    .offers;

export const getRanksCatalog = async (): Promise<Rank[]> =>
  (await getCatalog<{ ranks: Rank[] }>("RanksCatalog")).ranks;

export const getXpCurveCatalog = async (): Promise<XpCurve> =>
  await getCatalog<XpCurve>("XpCurve");


const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DENIED_CHARS = new Set(["I", "L", "O", "U"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toPositiveInteger = (value: unknown, fallback: number): number => {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }
  return Math.floor(num);
};

const toBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const normaliseAlphabet = (value: unknown, fallback: string): string => {
  let source = fallback;
  if (typeof value === "string" && value.trim().length > 0) {
    source = value.trim().toUpperCase();
  }
  const deduped: string[] = [];
  for (const char of source) {
    if (DENIED_CHARS.has(char)) {
      continue;
    }
    if (!CROCKFORD_ALPHABET.includes(char)) {
      continue;
    }
    if (!deduped.includes(char)) {
      deduped.push(char);
    }
  }
  return deduped.length > 0 ? deduped.join("") : fallback;
};

const parseSkuReward = (value: unknown): ReferralConfig["inviteeRewards"][number] | null => {
  if (!isRecord(value)) {
    return null;
  }
  const rawSku = value.skuId;
  if (typeof rawSku !== "string" || rawSku.trim().length === 0) {
    return null;
  }
  const qty = toPositiveInteger(value.qty ?? value.quantity, 0);
  if (qty <= 0) {
    return null;
  }
  return { skuId: rawSku.trim(), qty };
};

const parseThresholdReward = (
  value: unknown,
): ReferralConfig["inviterRewards"][number] | null => {
  if (!isRecord(value)) {
    return null;
  }
  const threshold = toPositiveInteger(value.threshold, 0);
  if (threshold <= 0) {
    return null;
  }
  const rawRewards = Array.isArray(value.rewards) ? value.rewards : [];
  const rewards = rawRewards
    .map((entry) => parseSkuReward(entry))
    .filter((entry): entry is ReferralConfig["inviteeRewards"][number] => Boolean(entry));
  if (rewards.length === 0) {
    return null;
  }
  return { threshold, rewards };
};

export async function getReferralConfig(): Promise<ReferralConfig> {
  const now = Date.now();
  if (referralConfigCache && now - referralConfigCache.lastFetched < REFERRAL_CACHE_TTL_MS) {
    return referralConfigCache.data;
  }

  const snapshot = await referralConfigDoc.get();
  if (!snapshot.exists) {
    throw new Error("ReferralConfig not found at /GameData/v1/config/ReferralConfig.v1");
  }

  const data = snapshot.data() ?? {};
  const alphabet = normaliseAlphabet(data.alphabet, CROCKFORD_ALPHABET);
  // Enforce 6-character referral codes regardless of stored config
  const raw = toPositiveInteger(data.codeLength, 6);
  const codeLength = 6;
  if (codeLength > alphabet.length) {
    throw new Error(
      `ReferralConfig codeLength (${codeLength}) exceeds alphabet size (${alphabet.length}).`,
    );
  }

  const inviteeRewards = (Array.isArray(data.inviteeRewards) ? data.inviteeRewards : [])
    .map((entry) => parseSkuReward(entry))
    .filter((entry): entry is ReferralConfig["inviteeRewards"][number] => Boolean(entry));
  if (inviteeRewards.length === 0) {
    throw new Error("ReferralConfig must define at least one invitee reward.");
  }

  const inviterRewards = (Array.isArray(data.inviterRewards) ? data.inviterRewards : [])
    .map((entry) => parseThresholdReward(entry))
    .filter((entry): entry is ReferralConfig["inviterRewards"][number] => Boolean(entry))
    .sort((a, b) => a.threshold - b.threshold);

  for (let i = 1; i < inviterRewards.length; i++) {
    if (inviterRewards[i].threshold <= inviterRewards[i - 1].threshold) {
      throw new Error("ReferralConfig inviter reward thresholds must be strictly increasing.");
    }
  }

  const config: ReferralConfig = {
    codeLength,
    alphabet,
    maxClaimPerInvitee: toPositiveInteger(data.maxClaimPerInvitee, 1),
    maxClaimsPerInviter: toPositiveInteger(data.maxClaimsPerInviter, 9999),
    inviteeRewards,
    inviterRewards,
    blockSelfReferral: toBoolean(data.blockSelfReferral, true),
    blockCircularReferral: toBoolean(data.blockCircularReferral, true),
  };

  referralConfigCache = { data: config, lastFetched: now };
  return config;
}

export function invalidateReferralConfigCache(): void {
  referralConfigCache = null;
}

// --- Car Tuning Config Loader (singleton under /GameData/v1) ---
let cachedTuning: { data: CarTuningConfig; lastFetched: number } | null = null;
export async function getCarTuningConfig(): Promise<CarTuningConfig> {
  const now = Date.now();
  if (cachedTuning && now - cachedTuning.lastFetched < CATALOG_CACHE_TTL_MS) {
    return cachedTuning.data;
  }
  const docRef = admin.firestore().doc("/GameData/v1/config/CarTuningConfig");
  const doc = await docRef.get();
  if (!doc.exists) {
    throw new Error("CarTuningConfig not found at /GameData/v1/config/CarTuningConfig");
  }
  const data = doc.data() as CarTuningConfig;
  cachedTuning = { data, lastFetched: now };
  return data;
}

// --- BotConfig Loader (/GameData/v1/BotConfig) ---
export type BotConfig = {
  statRanges: {
    aiSpeed: { min: number; max: number };
    aiBoostPower: { min: number; max: number };
    aiAcceleration: { min: number; max: number };
    endGameDifficulty: number;
  };
  performanceVariance?: {
    enabled: boolean;
    standardDeviation: number;
    description?: string;
  };
  carUnlockThresholds: Array<{ carId: string; trophies: number }>;
  cosmeticRarityWeights: Record<string, Record<string, number>>;
  spellLevelBands: Array<{ minTrophies: number; maxTrophies: number; minLevel: number; maxLevel: number }>;
  excludedSpells?: string[];
  updatedAt: number;
};

let cachedBotCfg: { data: BotConfig; lastFetched: number } | null = null;
export async function getBotConfig(): Promise<BotConfig> {
  const now = Date.now();
  if (cachedBotCfg && now - cachedBotCfg.lastFetched < CATALOG_CACHE_TTL_MS) {
    return cachedBotCfg.data;
  }
  const doc = await admin.firestore().doc("/GameData/v1/config/BotConfig").get();
  if (!doc.exists) throw new Error("BotConfig not found at /GameData/v1/config/BotConfig");
  const data = doc.data() as BotConfig;
  cachedBotCfg = { data, lastFetched: now };
  return data;
}

// --- Bot Names Loader (/GameData/v1/config/BotNames) ---
let cachedBotNames: { data: string[]; lastFetched: number } | null = null;
export async function getBotNamesConfig(): Promise<string[]> {
  const now = Date.now();
  if (cachedBotNames && now - cachedBotNames.lastFetched < CATALOG_CACHE_TTL_MS) {
    return cachedBotNames.data;
  }
  const doc = await admin.firestore().doc("/GameData/v1/config/BotNames").get();
  if (!doc.exists) {
    throw new Error("BotNames config not found at /GameData/v1/config/BotNames");
  }
  const names = Array.isArray(doc.data()?.names)
    ? (doc.data()?.names as unknown[]).map((name) => (typeof name === "string" ? name : "")).filter((name) => name.length > 0)
    : [];
  cachedBotNames = { data: names, lastFetched: now };
  return names;
}

// Test-only helpers --------------------------------------------------------
export function __resetCatalogCacheForTests(): void {
  catalogCache.clear();
  invalidateCatalogCache();
  cachedTuning = null;
  cachedBotCfg = null;
  cachedBotNames = null;
  referralConfigCache = null;
}
