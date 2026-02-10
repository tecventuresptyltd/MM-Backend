/**
 * V2 Config Loaders for Mystic Motors Backend
 *
 * This module provides cached loaders for all V2 game configuration catalogs.
 * Config is stored in /GameData/v1/catalogs or /GameData/v1/config.
 */

import * as admin from "firebase-admin";
import {
    TiersCatalog,
    TierDefinition,
    EvolutionCostsCatalog,
    SpellResearchCostsCatalog,
    FuelConfig,
    CrateSlotsConfig,
    PlayerSlotsConfig,
} from "../shared/typesV2.js";

const db = admin.firestore();

// Cache configuration
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

// Firestore paths
const CONFIG_ROOT = db.collection("GameData").doc("v1").collection("config");
const CATALOGS_ROOT = db.collection("GameData").doc("v1").collection("catalogs");

// =============================================================================
// CACHE MANAGEMENT
// =============================================================================

interface CacheEntry<T> {
    data: T;
    lastFetched: number;
}

const v2ConfigCache: Map<string, CacheEntry<unknown>> = new Map();

function getCached<T>(key: string): T | null {
    const now = Date.now();
    const cached = v2ConfigCache.get(key);
    if (cached && now - cached.lastFetched < CACHE_TTL_MS) {
        return cached.data as T;
    }
    return null;
}

function setCache<T>(key: string, data: T): void {
    v2ConfigCache.set(key, { data, lastFetched: Date.now() });
}

export function invalidateV2ConfigCache(): void {
    v2ConfigCache.clear();
}

// =============================================================================
// TIERS CATALOG
// =============================================================================

let tiersCatalogCache: CacheEntry<TiersCatalog> | null = null;

export async function getTiersCatalog(): Promise<TiersCatalog> {
    const now = Date.now();
    if (tiersCatalogCache && now - tiersCatalogCache.lastFetched < CACHE_TTL_MS) {
        return tiersCatalogCache.data;
    }

    const docRef = CATALOGS_ROOT.doc("TiersCatalog");
    const doc = await docRef.get();

    if (!doc.exists) {
        throw new Error("TiersCatalog not found at /GameData/v1/catalogs/TiersCatalog");
    }

    const data = doc.data() as TiersCatalog;
    tiersCatalogCache = { data, lastFetched: now };
    console.log("[V2Config] Loaded TiersCatalog");
    return data;
}

export async function getTierById(tierId: string): Promise<TierDefinition | null> {
    const catalog = await getTiersCatalog();
    return catalog.tiers[tierId] ?? null;
}

export async function getStarterTier(): Promise<TierDefinition | null> {
    const catalog = await getTiersCatalog();
    return (
        Object.values(catalog.tiers).find((tier) => tier.starterLicense === true) ?? null
    );
}

// =============================================================================
// EVOLUTION COSTS CATALOG
// =============================================================================

let evolutionCatalogCache: CacheEntry<EvolutionCostsCatalog> | null = null;

export async function getEvolutionCostsCatalog(): Promise<EvolutionCostsCatalog> {
    const now = Date.now();
    if (evolutionCatalogCache && now - evolutionCatalogCache.lastFetched < CACHE_TTL_MS) {
        return evolutionCatalogCache.data;
    }

    const docRef = CATALOGS_ROOT.doc("EvolutionCostsCatalog");
    const doc = await docRef.get();

    if (!doc.exists) {
        throw new Error("EvolutionCostsCatalog not found at /GameData/v1/catalogs/EvolutionCostsCatalog");
    }

    const data = doc.data() as EvolutionCostsCatalog;
    evolutionCatalogCache = { data, lastFetched: now };
    console.log("[V2Config] Loaded EvolutionCostsCatalog");
    return data;
}

export async function getEvolutionCostForStarLevel(
    currentStarLevel: number,
): Promise<{ coins: number; durationSeconds: number } | null> {
    const catalog = await getEvolutionCostsCatalog();
    const entry = catalog.evolutionCosts[String(currentStarLevel)];
    if (!entry) {
        return null;
    }
    return {
        coins: entry.coins,
        durationSeconds: entry.durationSeconds,
    };
}

export async function getXpCapForStarLevel(starLevel: number): Promise<number> {
    const catalog = await getEvolutionCostsCatalog();
    return catalog.xpCaps[String(starLevel)] ?? Infinity;
}

// =============================================================================
// SPELL RESEARCH COSTS CATALOG
// =============================================================================

let spellResearchCatalogCache: CacheEntry<SpellResearchCostsCatalog> | null = null;

export async function getSpellResearchCostsCatalog(): Promise<SpellResearchCostsCatalog> {
    const now = Date.now();
    if (spellResearchCatalogCache && now - spellResearchCatalogCache.lastFetched < CACHE_TTL_MS) {
        return spellResearchCatalogCache.data;
    }

    const docRef = CATALOGS_ROOT.doc("SpellResearchCostsV2Catalog");
    const doc = await docRef.get();

    if (!doc.exists) {
        throw new Error(
            "SpellResearchCostsV2Catalog not found at /GameData/v1/catalogs/SpellResearchCostsV2Catalog",
        );
    }

    const data = doc.data() as SpellResearchCostsCatalog;
    spellResearchCatalogCache = { data, lastFetched: now };
    console.log("[V2Config] Loaded SpellResearchCostsV2Catalog");
    return data;
}

export async function getResearchCostForLevel(
    targetLevel: number,
): Promise<{ shards: number; durationSeconds: number } | null> {
    const catalog = await getSpellResearchCostsCatalog();
    const entry = catalog.researchCosts[String(targetLevel)];
    if (!entry) {
        return null;
    }
    return {
        shards: entry.shards,
        durationSeconds: entry.durationSeconds,
    };
}

// =============================================================================
// FUEL CONFIG
// =============================================================================

let fuelConfigCache: CacheEntry<FuelConfig> | null = null;

export async function getFuelConfig(): Promise<FuelConfig> {
    const now = Date.now();
    if (fuelConfigCache && now - fuelConfigCache.lastFetched < CACHE_TTL_MS) {
        return fuelConfigCache.data;
    }

    const docRef = CONFIG_ROOT.doc("FuelConfig");
    const doc = await docRef.get();

    if (!doc.exists) {
        throw new Error("FuelConfig not found at /GameData/v1/config/FuelConfig");
    }

    const data = doc.data() as FuelConfig;
    fuelConfigCache = { data, lastFetched: now };
    console.log("[V2Config] Loaded FuelConfig");
    return data;
}

// =============================================================================
// CRATE SLOTS CONFIG
// =============================================================================

let crateSlotsConfigCache: CacheEntry<CrateSlotsConfig> | null = null;

export async function getCrateSlotsConfig(): Promise<CrateSlotsConfig> {
    const now = Date.now();
    if (crateSlotsConfigCache && now - crateSlotsConfigCache.lastFetched < CACHE_TTL_MS) {
        return crateSlotsConfigCache.data;
    }

    const docRef = CONFIG_ROOT.doc("CrateSlotsConfig");
    const doc = await docRef.get();

    if (!doc.exists) {
        throw new Error("CrateSlotsConfig not found at /GameData/v1/config/CrateSlotsConfig");
    }

    const data = doc.data() as CrateSlotsConfig;
    crateSlotsConfigCache = { data, lastFetched: now };
    console.log("[V2Config] Loaded CrateSlotsConfig");
    return data;
}

export async function getUnlockDurationForRarity(rarity: string): Promise<number> {
    const config = await getCrateSlotsConfig();
    const duration = config.unlockDurations[rarity];
    if (!duration) {
        // Default to common if rarity not found
        return config.unlockDurations.common?.durationSeconds ?? 1800;
    }
    return duration.durationSeconds;
}

// =============================================================================
// PLAYER SLOTS CONFIG
// =============================================================================

let playerSlotsConfigCache: CacheEntry<PlayerSlotsConfig> | null = null;

export async function getPlayerSlotsConfig(): Promise<PlayerSlotsConfig> {
    const now = Date.now();
    if (playerSlotsConfigCache && now - playerSlotsConfigCache.lastFetched < CACHE_TTL_MS) {
        return playerSlotsConfigCache.data;
    }

    const docRef = CONFIG_ROOT.doc("PlayerSlotsConfig");
    const doc = await docRef.get();

    if (!doc.exists) {
        throw new Error("PlayerSlotsConfig not found at /GameData/v1/config/PlayerSlotsConfig");
    }

    const data = doc.data() as PlayerSlotsConfig;
    playerSlotsConfigCache = { data, lastFetched: now };
    console.log("[V2Config] Loaded PlayerSlotsConfig");
    return data;
}

export async function getPitCrewSlotPurchaseCost(slotNumber: number): Promise<number | null> {
    const config = await getPlayerSlotsConfig();
    const slotConfig = config.pitCrew.purchasableSlotsConfig.find(
        (s) => s.slotNumber === slotNumber,
    );
    return slotConfig?.gemCost ?? null;
}

export async function getLibrarySlotPurchaseCost(slotNumber: number): Promise<number | null> {
    const config = await getPlayerSlotsConfig();
    const slotConfig = config.library.purchasableSlotsConfig.find(
        (s) => s.slotNumber === slotNumber,
    );
    return slotConfig?.gemCost ?? null;
}

// =============================================================================
// HELPER: Calculate skip cost in gems
// =============================================================================

export function calculateSkipCost(
    remainingSeconds: number,
    gemsPerHour: number,
    minGems: number,
): number {
    if (remainingSeconds <= 0) {
        return 0;
    }
    const remainingHours = remainingSeconds / 3600;
    const calculatedCost = Math.ceil(remainingHours * gemsPerHour);
    return Math.max(calculatedCost, minGems);
}

// =============================================================================
// HELPER: Calculate fuel regeneration
// =============================================================================

export function calculateFuelBars(
    currentBars: number,
    lastRefillAt: Date | null,
    config: FuelConfig,
): number {
    if (currentBars >= config.maxBars) {
        return config.maxBars;
    }

    if (!lastRefillAt) {
        // No refill recorded, assume full
        return config.maxBars;
    }

    const now = new Date();
    const elapsedMs = now.getTime() - lastRefillAt.getTime();
    const elapsedMinutes = elapsedMs / (1000 * 60);
    const regenBars = Math.floor(elapsedMinutes / config.regenIntervalMinutes);

    return Math.min(currentBars + regenBars, config.maxBars);
}

// =============================================================================
// TEST HELPERS
// =============================================================================

export function __resetV2ConfigCacheForTests(): void {
    tiersCatalogCache = null;
    evolutionCatalogCache = null;
    spellResearchCatalogCache = null;
    fuelConfigCache = null;
    crateSlotsConfigCache = null;
    playerSlotsConfigCache = null;
    v2ConfigCache.clear();
}
