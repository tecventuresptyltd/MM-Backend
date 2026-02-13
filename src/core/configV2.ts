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
    CarEvolutionV2Catalog,
    SpellEvolutionV2Catalog,
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
// CAR EVOLUTION V2 CATALOG
// =============================================================================

let carEvolutionCatalogCache: CacheEntry<CarEvolutionV2Catalog> | null = null;

export async function getCarEvolutionV2Catalog(): Promise<CarEvolutionV2Catalog> {
    const now = Date.now();
    if (carEvolutionCatalogCache && now - carEvolutionCatalogCache.lastFetched < CACHE_TTL_MS) {
        return carEvolutionCatalogCache.data;
    }

    const docRef = CATALOGS_ROOT.doc("CarEvolutionV2Catalog");
    const doc = await docRef.get();

    if (!doc.exists) {
        throw new Error("CarEvolutionV2Catalog not found at /GameData/v1/catalogs/CarEvolutionV2Catalog");
    }

    const data = doc.data() as CarEvolutionV2Catalog;
    carEvolutionCatalogCache = { data, lastFetched: now };
    console.log("[V2Config] Loaded CarEvolutionV2Catalog");
    return data;
}

export async function getEvolutionCostForStarLevel(
    currentStarLevel: number,
): Promise<{ coins: number; durationSeconds: number } | null> {
    const catalog = await getCarEvolutionV2Catalog();
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
    const catalog = await getCarEvolutionV2Catalog();
    return catalog.xpCaps[String(starLevel)] ?? Infinity;
}

// =============================================================================
// SPELL EVOLUTION CATALOG
// =============================================================================

let spellEvolutionCatalogCache: CacheEntry<SpellEvolutionV2Catalog> | null = null;

export async function getSpellEvolutionV2Catalog(): Promise<SpellEvolutionV2Catalog> {
    const now = Date.now();
    if (spellEvolutionCatalogCache && now - spellEvolutionCatalogCache.lastFetched < CACHE_TTL_MS) {
        return spellEvolutionCatalogCache.data;
    }

    const docRef = CATALOGS_ROOT.doc("SpellEvolutionV2Catalog");
    const doc = await docRef.get();

    if (!doc.exists) {
        throw new Error(
            "SpellEvolutionV2Catalog not found at /GameData/v1/catalogs/SpellEvolutionV2Catalog",
        );
    }

    const data = doc.data() as SpellEvolutionV2Catalog;
    spellEvolutionCatalogCache = { data, lastFetched: now };
    console.log("[V2Config] Loaded SpellEvolutionV2Catalog");
    return data;
}

export async function getResearchCostForLevel(
    targetLevel: number,
): Promise<{ shards: number; durationSeconds: number } | null> {
    const catalog = await getSpellEvolutionV2Catalog();
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
    carEvolutionCatalogCache = null;
    spellEvolutionCatalogCache = null;
    fuelConfigCache = null;
    crateSlotsConfigCache = null;
    playerSlotsConfigCache = null;
    v2ConfigCache.clear();
}
