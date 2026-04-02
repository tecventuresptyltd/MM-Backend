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
    CarsCatalog,
    CarLevelData,
    CarCatalogEntry,
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
// CAR EVOLUTION V2 — XP CAP AND COST HELPERS (reads from CarsCatalog)
// =============================================================================

/**
 * Get the XP cap (xpToNext) for a specific car at its current star/car level.
 * Reads from CarsCatalog.cars[carId].levels[starLevel].xpToNext.
 * starLevel matches CarsCatalog keys ("1"-"10").
 *
 * Returns 0 if car is at max level (xpToNext=0), Infinity if car/level not found.
 */
export async function getXpCapForCar(carId: string, starLevel: number): Promise<number> {
    const catalog = await getCarsCatalog();
    const levelData = catalog.cars?.[carId]?.levels?.[String(starLevel)];
    if (!levelData) {
        console.warn(`[V2Config] No level data for car ${carId} at star ${starLevel}, falling back to Infinity`);
        return Infinity;
    }
    const xpToNext = levelData.xpToNext;
    // xpToNext = 0 means max level — cap XP immediately
    return xpToNext > 0 ? xpToNext : 0;
}

/**
 * Get the evolution cost for a specific car to reach its NEXT star level.
 * Reads priceCoins and upgradeTimerSeconds from the TARGET level in CarsCatalog.
 * Returns null if the car is at max star level or config is missing.
 */
export async function getEvolutionCostForCar(
    carId: string,
    starLevel: number,
): Promise<{ coins: number; durationSeconds: number; targetStarLevel: number } | null> {
    const catalog = await getCarsCatalog();

    // Check current level to verify if progression is possible
    const currentLevelData = catalog.cars?.[carId]?.levels?.[String(starLevel)];
    if (!currentLevelData) return null;

    // If this is the max level (xpToNext = 0), there's no next level to evolve to
    if (currentLevelData.xpToNext === 0) return null;

    // Target the next star level to grab cost and timer
    const targetStarLevel = starLevel + 1;
    const targetLevelData = catalog.cars?.[carId]?.levels?.[String(targetStarLevel)];
    if (!targetLevelData) return null; // Failsafe if target config doesn't exist

    return {
        targetStarLevel,
        coins: targetLevelData.priceCoins,
        durationSeconds: targetLevelData.upgradeTimerSeconds,
    };
}

// =============================================================================
// CARS CATALOG (10-LEVEL PROGRESSION)
// =============================================================================

let carsCatalogCache: CacheEntry<CarsCatalog> | null = null;

export async function getCarsCatalog(): Promise<CarsCatalog> {
    const now = Date.now();
    if (carsCatalogCache && now - carsCatalogCache.lastFetched < CACHE_TTL_MS) {
        return carsCatalogCache.data;
    }

    const docRef = CATALOGS_ROOT.doc("CarsCatalog");
    const doc = await docRef.get();

    if (!doc.exists) {
        throw new Error("CarsCatalog not found at /GameData/v1/catalogs/CarsCatalog");
    }

    const data = doc.data() as CarsCatalog;
    carsCatalogCache = { data, lastFetched: now };
    console.log("[V2Config] Loaded CarsCatalog");
    return data;
}

export async function getCarLevelData(carId: string, carLevel: number): Promise<CarLevelData | null> {
    const catalog = await getCarsCatalog();
    const car = catalog.cars[carId];
    if (!car || !car.levels) return null;
    return car.levels[String(carLevel)] ?? null;
}

// =============================================================================
// CAR EVOLUTION CATALOG
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
        throw new Error(
            "CarEvolutionV2Catalog not found at /GameData/v1/catalogs/CarEvolutionV2Catalog",
        );
    }

    const data = doc.data() as CarEvolutionV2Catalog;
    carEvolutionCatalogCache = { data, lastFetched: now };
    console.log("[V2Config] Loaded CarEvolutionV2Catalog");
    return data;
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

/**
 * Calculate rank-scaled coin reward for a crate opening.
 *
 * Uses COIN_CAPS_BY_RANK[playerRank][0] (1st-place cap) as the base,
 * multiplied by a rarity-specific factor with ±variance randomness.
 *
 * @param trophies - Player's current trophies (used to derive rank)
 * @param rarity   - The item-pool rarity tier being rolled (common→mythical)
 * @param config   - CoinScalingConfig from CrateRewardsConfig
 */
export function calculateCrateCoins(
    trophies: number,
    rarity: string,
    config: CrateRewardsConfig["coinScaling"] | undefined,
): number {
    // Import rank lookup lazily to avoid circular dependency issues
    const { getRankForTrophies, COIN_CAPS_BY_RANK } = require("../race/economy.js");

    const rank = getRankForTrophies(trophies);
    const caps = COIN_CAPS_BY_RANK[rank] ?? COIN_CAPS_BY_RANK["Unranked"];
    const maxCoinPerRace = caps[0]; // 1st place cap

    const multipliers = config?.multipliers ?? {};
    const multiplier = multipliers[rarity] ?? multipliers["common"] ?? 0.25;
    const variance = config?.variance ?? 0.2;

    // Random factor: (1 - variance) to (1 + variance)
    const randomFactor = (1 - variance) + Math.random() * (2 * variance);

    return Math.floor(maxCoinPerRace * multiplier * randomFactor);
}

/**
 * Calculate rank-scaled shard reward for a crate opening.
 *
 * Uses the same shardBase formula as race rewards: `5 + (20 × rankIndex/50)`,
 * multiplied by a rarity-specific factor with ±variance randomness.
 * Shards scale ~5× across ranks (vs coins' ~20×) — intentionally slower
 * so crates can't shortcut spell progression.
 */
export function calculateCrateShards(
    trophies: number,
    crateRarity: string,
    config: CrateRewardsConfig["shardScaling"] | undefined,
): number {
    const { getRankForTrophies, RANK_THRESHOLDS } = require("../race/economy.js");

    const rank = getRankForTrophies(trophies);
    const totalRanks = RANK_THRESHOLDS.length; // 28
    const numericRank = RANK_THRESHOLDS.findIndex(
        (t: { label: string }) => t.label === rank,
    );
    const safeIndex = numericRank >= 0 ? numericRank : 0;

    // Same formula as race shards: shardBase = 5 + (20 × index/totalRanks)
    const shardBase = 5 + (20 * (Math.max(1, safeIndex) / totalRanks));

    const multipliers = config?.multipliers ?? {};
    const multiplier = multipliers[crateRarity] ?? multipliers["common"] ?? 0.4;
    const variance = config?.variance ?? 0.2;

    const randomFactor = (1 - variance) + Math.random() * (2 * variance);

    return Math.max(1, Math.floor(shardBase * multiplier * randomFactor));
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
 * Calculate the car's current level from its XP and star level.
 *
 * MODEL: star level == car level (1:1 mapping, per CarsCatalog keys "1"-"10").
 *   carLevel = starLevel  (XP is tracked within the star; level only increments on evolution)
 *
 * Returned fields:
 *   carLevel    — equals starLevel (1-10)
 *   localLevel  — always 0 (no sub-levels within a star)
 *   xpInLevel   — XP earned so far within this star
 *   xpPerLevel  — equals xpCap (xpToNext from CarsCatalog)
 *   xpToNextLevel — xpCap - xpInLevel
 *
 * @param currentXp   - Car's current XP within this star
 * @param xpCap       - XP cap for this star (xpToNext from CarsCatalog)
 * @param starLevel   - Car's current star level (1-10, matching CarsCatalog keys)
 * @param levelsPerStar - Should be 1 per catalog (kept for signature compat)
 */
export function calculateCarLevel(
    currentXp: number,
    xpCap: number,
    starLevel: number,
    levelsPerStar: number,
): { carLevel: number; localLevel: number; xpInLevel: number; xpPerLevel: number; xpToNextLevel: number } {
    const safeXp = Math.max(0, Math.floor(currentXp));
    const safeCap = Math.max(1, Math.floor(xpCap));
    const safeStar = Math.max(1, Math.floor(starLevel)); // 1-10, matching CarsCatalog keys

    // Star level IS the car level — 1:1 mapping
    const carLevel = safeStar;

    // No sub-levels within a star (levelsPerStar = 1)
    const localLevel = 0;

    const xpInLevel = Math.min(safeXp, safeCap);
    const xpToNextLevel = Math.max(0, safeCap - xpInLevel);

    return {
        carLevel,
        localLevel,
        xpInLevel,
        xpPerLevel: safeCap,
        xpToNextLevel,
    };
}

// =============================================================================
// HELPER: Calculate skip cost in gems
// =============================================================================

export function calculateSkipCost(
    remainingSeconds: number,
    gemsPerHour: number, // Base rate (e.g. 20)
    minGems: number,
    freeSkipThresholdSeconds: number = 0,
): number {
    if (remainingSeconds <= 0) {
        return 0;
    }
    // Free skip for timers under the threshold (GoW-style)
    if (freeSkipThresholdSeconds > 0 && remainingSeconds <= freeSkipThresholdSeconds) {
        return 0;
    }
    const remainingHours = remainingSeconds / 3600;

    // Dynamic skip formula: gems = baseRate * (hours ^ 0.85)
    // This provides a continuous volume discount where longer timers cost less per hour.
    const calculatedCost = Math.ceil(gemsPerHour * Math.pow(remainingHours, 0.85));

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
        ?? archetypeProfiles.arcanist
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

/**
 * Calculate mastery progress within the current rank.
 * Pure function — no Firestore calls.
 *
 * Returns:
 *   rank          - current mastery rank (0-50)
 *   expProgress   - XP earned since start of this rank
 *   expToNextLevel - total XP span of this rank (threshold[rank+1] - threshold[rank])
 *   expProgressDisplay - e.g. "225 / 2000"
 */
export function getMasteryProgress(
    masteryXp: number,
    config: MasteryConfig,
): { rank: number; expProgress: number; expToNextLevel: number; expProgressDisplay: string } {
    const safeXp = Math.max(0, Math.floor(masteryXp));
    const rank = getMasteryRank(safeXp, config);

    // XP threshold for the current rank (floor)
    const currentThreshold = config.rankThresholds[String(rank)] ?? 0;

    // XP threshold for the next rank (ceiling)
    const nextRank = rank + 1;
    const nextThreshold = config.rankThresholds[String(nextRank)];

    if (nextThreshold === undefined || rank >= config.maxRank) {
        // At max rank
        return {
            rank,
            expProgress: safeXp - currentThreshold,
            expToNextLevel: 0,
            expProgressDisplay: "Max Rank",
        };
    }

    const expProgress = safeXp - currentThreshold;
    const expToNextLevel = nextThreshold - currentThreshold;

    return {
        rank,
        expProgress,
        expToNextLevel,
        expProgressDisplay: `${expProgress} / ${expToNextLevel}`,
    };
}

// =============================================================================
// DAILY REWARDS CONFIG
// =============================================================================

export interface DailyRewardItem {
    type: "gems" | "booster" | "speedUp";
    id: string;
    quantity: number;
    label?: string;
}

export interface DailyRewardDay {
    day: number;
    gems: number;
    items: DailyRewardItem[];
    isMilestone?: boolean;
}

export interface DailyRewardsConfig {
    version: string;
    rewards: Record<string, DailyRewardDay>;
}

let dailyRewardsConfigCache: CacheEntry<DailyRewardsConfig> | null = null;

export async function getDailyRewardsConfig(): Promise<DailyRewardsConfig> {
    if (dailyRewardsConfigCache && Date.now() - dailyRewardsConfigCache.lastFetched < 300_000) {
        return dailyRewardsConfigCache.data;
    }
    const snap = await admin.firestore().collection("GameData").doc("v1")
        .collection("config").doc("DailyRewardsConfig").get();
    if (!snap.exists) {
        throw new Error("DailyRewardsConfig not found in Firestore.");
    }
    const config = snap.data() as DailyRewardsConfig;
    dailyRewardsConfigCache = { data: config, lastFetched: Date.now() };
    return config;
}

// =============================================================================
// TEST HELPERS
// =============================================================================

export function __resetV2ConfigCacheForTests(): void {
    tiersCatalogCache = null;
    carsCatalogCache = null;
    spellEvolutionCatalogCache = null;
    fuelConfigCache = null;
    crateSlotsConfigCache = null;
    playerSlotsConfigCache = null;
    carStatsBudgetConfigCache = null;
    masteryConfigCache = null;
    dailyRewardsConfigCache = null;
    v2ConfigCache.clear();
}
