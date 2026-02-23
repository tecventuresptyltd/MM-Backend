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
    CrateRewardsConfig,
    PlayerSlotsConfig,
    CarStatsBudgetConfig,
    CarStatsInput,
    ComputedCarStats,
    ArchetypeStatProfile,
    MasteryConfig,
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

/**
 * Get the XP cap for a star level, scaled by the car's tier.
 * Tier scaling multiplies the base XP cap to create tier-specific pacing.
 */
export async function getXpCapForStarAndTier(starLevel: number, tierOrder: number): Promise<number> {
    const catalog = await getCarEvolutionV2Catalog();
    const baseCap = catalog.xpCaps[String(starLevel)] ?? Infinity;
    const scaling = catalog.tierScaling?.[String(tierOrder)];
    const multiplier = scaling?.xpMultiplier ?? 1.0;
    return Math.round(baseCap * multiplier);
}

/**
 * Get the evolution cost for a star level, scaled by the car's tier.
 * Returns coins and duration both scaled by their respective tier multipliers.
 */
export async function getEvolutionCostForStarAndTier(
    currentStarLevel: number,
    tierOrder: number,
): Promise<{ coins: number; durationSeconds: number } | null> {
    const catalog = await getCarEvolutionV2Catalog();
    const entry = catalog.evolutionCosts[String(currentStarLevel)];
    if (!entry) {
        return null;
    }
    const scaling = catalog.tierScaling?.[String(tierOrder)];
    const coinMult = scaling?.coinMultiplier ?? 1.0;
    const timerMult = scaling?.timerMultiplier ?? 1.0;
    return {
        coins: Math.round(entry.coins * coinMult),
        durationSeconds: Math.max(1, Math.round(entry.durationSeconds * timerMult)),
    };
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

/**
 * Returns the cost to unlock a level-gated spell (level 0 → 1).
 * Falls back to 100 shards / 60s if not configured in the catalog.
 */
export async function getUnlockResearchCost(): Promise<{ shards: number; durationSeconds: number }> {
    const catalog = await getSpellEvolutionV2Catalog();
    if (catalog.unlockCost) {
        return {
            shards: catalog.unlockCost.shards,
            durationSeconds: catalog.unlockCost.durationSeconds,
        };
    }
    return { shards: 100, durationSeconds: 60 };
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
// CRATE REWARDS CONFIG
// =============================================================================

let crateRewardsConfigCache: CacheEntry<CrateRewardsConfig> | null = null;

export async function getCrateRewardsConfig(): Promise<CrateRewardsConfig> {
    const now = Date.now();
    if (crateRewardsConfigCache && now - crateRewardsConfigCache.lastFetched < CACHE_TTL_MS) {
        return crateRewardsConfigCache.data;
    }

    const docRef = CONFIG_ROOT.doc("CrateRewardsConfig");
    const doc = await docRef.get();

    if (!doc.exists) {
        throw new Error("CrateRewardsConfig not found at /GameData/v1/config/CrateRewardsConfig");
    }

    const data = doc.data() as CrateRewardsConfig;
    crateRewardsConfigCache = { data, lastFetched: now };
    console.log("[V2Config] Loaded CrateRewardsConfig");
    return data;
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
// HELPER: Calculate car level from XP and star level (CUMULATIVE)
// =============================================================================

/**
 * Dynamically calculate the car's CUMULATIVE level across all stars.
 *
 * The car level is GLOBAL and never resets. It increments continuously:
 *   Star 0: carLevel  0 → 10
 *   Star 1: carLevel 10 → 20
 *   Star 2: carLevel 20 → 30
 *   ...
 *   Star 9: carLevel 90 → 100
 *
 * Formula: carLevel = (starLevel × levelsPerStar) + localLevel
 * Where:   localLevel = floor(xp / (xpCap / levelsPerStar))
 *
 * Example at Star 0 (xpCap=1000, levelsPerStar=10):
 *   XP=0    → localLevel=0,  carLevel = (0×10) + 0  = 0
 *   XP=100  → localLevel=1,  carLevel = (0×10) + 1  = 1
 *   XP=500  → localLevel=5,  carLevel = (0×10) + 5  = 5
 *   XP=1000 → localLevel=10, carLevel = (0×10) + 10 = 10
 *
 * Example at Star 3 (xpCap=10000, levelsPerStar=10):
 *   XP=0    → localLevel=0,  carLevel = (3×10) + 0  = 30
 *   XP=5000 → localLevel=5,  carLevel = (3×10) + 5  = 35
 *   XP=10000→ localLevel=10, carLevel = (3×10) + 10 = 40
 *
 * Fully dynamic — if xpCap changes, levels recalculate automatically.
 *
 * @param currentXp - The car's current XP within this star
 * @param xpCap - The XP cap for the current star level
 * @param starLevel - The car's current star level
 * @param levelsPerStar - How many sub-levels in each star (from catalog)
 * @returns Object with carLevel (global), localLevel (within star), xpInLevel, xpPerLevel
 */
export function calculateCarLevel(
    currentXp: number,
    xpCap: number,
    starLevel: number,
    levelsPerStar: number,
): { carLevel: number; localLevel: number; xpInLevel: number; xpPerLevel: number; xpToNextLevel: number } {
    // Safety: ensure valid inputs
    const safeXp = Math.max(0, Math.floor(currentXp));
    const safeCap = Math.max(1, Math.floor(xpCap));
    const safeStar = Math.max(0, Math.floor(starLevel));
    const safeLevels = Math.max(1, Math.floor(levelsPerStar));

    const xpPerLevel = safeCap / safeLevels;

    // Calculate local level within this star (0 to levelsPerStar)
    let localLevel = Math.floor(safeXp / xpPerLevel);
    localLevel = Math.min(localLevel, safeLevels); // Cap at max

    // Calculate cumulative (global) car level
    const carLevel = (safeStar * safeLevels) + localLevel;

    // XP progress within the current local level
    const xpInLevel = localLevel >= safeLevels ? 0 : safeXp - (localLevel * xpPerLevel);
    const xpToNextLevel = localLevel >= safeLevels ? 0 : xpPerLevel - xpInLevel;

    return {
        carLevel,
        localLevel,
        xpInLevel: Math.max(0, xpInLevel),
        xpPerLevel,
        xpToNextLevel: Math.max(0, xpToNextLevel),
    };
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
// CAR STATS BUDGET CONFIG
// =============================================================================

let carStatsBudgetConfigCache: CacheEntry<CarStatsBudgetConfig> | null = null;

export async function getCarStatsBudgetConfig(): Promise<CarStatsBudgetConfig> {
    const now = Date.now();
    if (carStatsBudgetConfigCache && now - carStatsBudgetConfigCache.lastFetched < CACHE_TTL_MS) {
        return carStatsBudgetConfigCache.data;
    }

    const docRef = CONFIG_ROOT.doc("CarStatsBudgetConfig");
    const doc = await docRef.get();

    if (!doc.exists) {
        throw new Error("CarStatsBudgetConfig not found at /GameData/v1/config/CarStatsBudgetConfig");
    }

    const data = doc.data() as CarStatsBudgetConfig;
    carStatsBudgetConfigCache = { data, lastFetched: now };
    console.log("[V2Config] Loaded CarStatsBudgetConfig");
    return data;
}

// =============================================================================
// HELPER: Compute Car Stats from Budget Config (pure function)
// =============================================================================

/**
 * Compute a car's 5 stats dynamically based on tier, archetype, star level,
 * and car level. This is a pure function — no Firestore calls.
 *
 * How it works:
 *   1. budgetPerTier = globalStatCap / tierCount        (e.g. 100/5 = 20)
 *   2. tierFloor     = (tierOrder - 1) × budgetPerTier  (e.g. Tier 1 = 0, Tier 3 = 40)
 *   3. tierCeiling   = tierOrder × budgetPerTier        (e.g. Tier 1 = 20, Tier 3 = 60)
 *   4. starProgress  = starLevel / maxStarLevel         (0.0 to 1.0)
 *   5. levelProgress = carLevel / maxCarLevel            (0.0 to 1.0)
 *   6. starContrib   = budgetPerTier × starWeight × starProgress
 *   7. levelContrib  = budgetPerTier × levelWeight × levelProgress
 *   8. totalBudget   = tierFloor + starContrib + levelContrib
 *   9. Each stat     = totalBudget × archetypeProfile[stat]
 *
 * @param input - The car's current state (tier, archetype, star, level)
 * @param config - The CarStatsBudgetConfig from Firestore
 * @returns Computed stats for all 5 stats plus debug info
 */
export function computeCarStats(
    input: CarStatsInput,
    config: CarStatsBudgetConfig,
): ComputedCarStats {
    const {
        globalStatCap,
        tierCount,
        maxStarLevel,
        maxCarLevel,
        starWeight,
        levelWeight,
        archetypeProfiles,
        tierOverrides,
    } = config;

    // --- Safety clamps ---
    const safeTierOrder = Math.max(1, Math.min(input.tierOrder, tierCount));
    const safeStarLevel = Math.max(0, Math.min(input.starLevel, maxStarLevel));
    const safeCarLevel = Math.max(0, Math.min(input.carLevel, maxCarLevel));

    // --- Tier budget ---
    const defaultBudgetPerTier = globalStatCap / tierCount;
    const tierKey = String(safeTierOrder);
    const override = tierOverrides?.[tierKey];

    const budgetPerTier = override?.budgetOverride ?? defaultBudgetPerTier;
    const tierFloor = override?.floorOverride ?? (safeTierOrder - 1) * defaultBudgetPerTier;
    const tierCeiling = tierFloor + budgetPerTier;

    // --- Progression within tier ---
    const starProgress = maxStarLevel > 0 ? safeStarLevel / maxStarLevel : 0;
    const levelProgress = maxCarLevel > 0 ? safeCarLevel / maxCarLevel : 0;

    const starContribution = budgetPerTier * starWeight * starProgress;
    const levelContribution = budgetPerTier * levelWeight * levelProgress;

    const totalBudget = tierFloor + starContribution + levelContribution;

    // --- Archetype distribution ---
    const profile: ArchetypeStatProfile = archetypeProfiles[input.archetype]
        ?? archetypeProfiles.specialist
        ?? { topSpeed: 0.2, acceleration: 0.2, handling: 0.2, boostRegen: 0.2, boostPower: 0.2 };

    // Round to 2 decimal places for clean values
    const round2 = (n: number) => Math.round(n * 100) / 100;

    return {
        topSpeed: round2(totalBudget * profile.topSpeed),
        acceleration: round2(totalBudget * profile.acceleration),
        handling: round2(totalBudget * profile.handling),
        boostRegen: round2(totalBudget * profile.boostRegen),
        boostPower: round2(totalBudget * profile.boostPower),
        totalBudget: round2(totalBudget),
        tierFloor: round2(tierFloor),
        tierCeiling: round2(tierCeiling),
        starContribution: round2(starContribution),
        levelContribution: round2(levelContribution),
    };
}

// =============================================================================
// MASTERY CONFIG
// =============================================================================

let masteryConfigCache: CacheEntry<MasteryConfig> | null = null;

export async function getMasteryConfig(): Promise<MasteryConfig> {
    const now = Date.now();
    if (masteryConfigCache && now - masteryConfigCache.lastFetched < CACHE_TTL_MS) {
        return masteryConfigCache.data;
    }

    const docRef = CONFIG_ROOT.doc("MasteryConfig");
    const doc = await docRef.get();

    if (!doc.exists) {
        throw new Error("MasteryConfig not found at /GameData/v1/config/MasteryConfig");
    }

    const data = doc.data() as MasteryConfig;
    masteryConfigCache = { data, lastFetched: now };
    console.log("[V2Config] Loaded MasteryConfig");
    return data;
}

/**
 * Calculate mastery rank from cumulative mastery XP.
 * Pure function — no Firestore calls.
 *
 * Scans thresholds from highest rank down to find the highest rank
 * whose threshold the player has met.
 */
export function getMasteryRank(masteryXp: number, config: MasteryConfig): number {
    const safeXp = Math.max(0, Math.floor(masteryXp));
    let highestRank = 0;

    for (let rank = config.maxRank; rank >= 1; rank--) {
        const threshold = config.rankThresholds[String(rank)];
        if (threshold !== undefined && safeXp >= threshold) {
            highestRank = rank;
            break;
        }
    }

    return highestRank;
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
    carStatsBudgetConfigCache = null;
    masteryConfigCache = null;
    v2ConfigCache.clear();
}
