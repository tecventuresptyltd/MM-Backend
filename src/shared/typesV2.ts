/**
 * V2 Types for Mystic Motors Backend
 *
 * This file contains TypeScript interfaces for the new V2 game systems:
 * - Tier License System
 * - Car Evolution (Pit Crew)
 * - Spell Research (Library)
 * - Fuel System
 * - Crate Slots
 * - Car Stats Budget System
 */

// =============================================================================
// TIER LICENSE SYSTEM
// =============================================================================

export type CarArchetype = "guardian" | "phantom" | "arcanist";

export interface TierBundledCar {
    carId: string;
    archetype: CarArchetype;
    displayName?: string;
}

export interface TierRequirements {
    masteryRank: number;
    coins: number;
}

export interface TierDefinition {
    tierId: string;
    displayName: string;
    i18n: { en: string };
    order: number;
    requirements: TierRequirements;
    bundledCars: TierBundledCar[];
    starterLicense: boolean;
    description?: string;
}

export interface TiersCatalog {
    version: string;
    updatedAt: number;
    tiers: Record<string, TierDefinition>;
}

export interface UserTierLicense {
    tierId: string;
    purchasedAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
    grantedCars: string[];
}

export interface UserLicensesDoc {
    licenses: Record<string, UserTierLicense>;
    updatedAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
}

// =============================================================================
// CAR EVOLUTION V2 (PIT CREW) SYSTEM
// =============================================================================

export interface TierScaling {
    coinMultiplier: number;
    timerMultiplier: number;
}

export interface EvolutionSkipCost {
    gemsPerHour: number;
    minGems: number;
    /** Timers ≤ this many seconds can be skipped for free (GoW-style). Default: 0 (disabled). */
    freeSkipThresholdSeconds?: number;
}

export interface StatBonusPerStar {
    topSpeed: number;
    acceleration: number;
    handling: number;
    boostRegen: number;
    boostPower: number;
}

/**
 * Global car evolution config.
 * XP caps, evolution costs, and timer values all live in CarsCatalog
 * per-car per-level (keys "0"-"9"). This catalog holds only the
 * shared global config: skip cost, stat bonuses, level shape.
 *
 * starLevel == carLevel (1:1). Star levels run 0-9 matching CarsCatalog keys.
 * maxStarLevel = 9 = fully evolved.
 */
export interface CarEvolutionV2Catalog {
    version: string;
    updatedAt: number;
    notes?: string;
    maxStarLevel: number;    // 9 — 0-indexed, 10 levels total
    levelsPerStar: number;   // 1 — star level and car level are the same thing
    skipCost: EvolutionSkipCost;
    statBonusPerStar: StatBonusPerStar;
    statBonusPerLevel: StatBonusPerStar;
    /** Coin and timer multipliers per tier order ("1"-"5"). Applied on top of CarsCatalog base values. */
    tierScaling: Record<string, TierScaling>;
}

// XP-to-next and evolution costs live in CarsCatalog per car per level.

export interface PitCrewSlotEntry {
    carId: string;
    startedAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
    completesAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
    targetCarLevel: number;
    coinsPaid: number;
}

export interface UserPitCrewDoc {
    slots: PitCrewSlotEntry[];
    maxSlots: number;
    updatedAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
}

// Extended car data for V2
export interface UserCarV2 {
    carId: string;
    upgradeLevel: number; // Legacy field - keep for compatibility
    tuning: Record<string, unknown>;
    createdAt?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
    updatedAt?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
    // V2 Fields (nullable for backward compatibility)
    xp?: number;
    starLevel?: number; // 1 to 10 — current star (== carLevel, 1:1 mapping, matches CarsCatalog keys)
    carLevel?: number; // 1 to 10 — mirrors starLevel
    isXpCapped?: boolean;
    fuelBars?: number;
    fuelLastRefillAt?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue | null;
    tierOrder?: number; // Which tier this car belongs to (1-5)
    archetype?: CarArchetype;
}

// =============================================================================
// SPELL EVOLUTION (LIBRARY) SYSTEM
// =============================================================================

export interface ResearchCostEntry {
    targetLevel: number;
    shards: number;
    durationSeconds: number;
    displayDuration?: string;
    description?: string;
}

export interface ResearchSkipCost {
    gemsPerHour: number;
    minGems: number;
    /** Timers ≤ this many seconds can be skipped for free. Default: 0 (disabled). */
    freeSkipThresholdSeconds?: number;
}

export interface SpellXpConfig {
    xpPerRace: number;
    xpPerWin: number;
    xpPerSpellCast: number;
    xpCapPerLevel: Record<string, number>;
}

export interface ShardRewardsConfig {
    byPosition: Record<string, number>; // "1" -> 10, "2" -> 7, "3" -> 4
    defaultShards: number;              // fallback for positions not listed
}

export interface SpellEvolutionV2Catalog {
    version: string;
    updatedAt: number;
    notes?: string;
    maxSpellLevel: number;
    unlockCost?: ResearchCostEntry; // Cost to unlock a level-gated spell (0 → 1)
    researchCosts: Record<string, ResearchCostEntry>; // targetLevel -> cost
    skipCost: ResearchSkipCost;
    spellXpConfig: SpellXpConfig;
    shardRewards?: ShardRewardsConfig;
    /** Mastery rank gates per spell level. Key = targetLevel string, value = required mastery rank. */
    masteryGates?: Record<string, number>;
}

export interface LibrarySlotEntry {
    spellId: string;
    startedAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
    completesAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
    targetLevel: number;
    shardsPaid: number;
}

export interface UserLibraryDoc {
    slots: LibrarySlotEntry[];
    maxSlots: number;
    updatedAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
}

// Extended spell data for V2
export interface UserSpellV2 {
    level: number;
    unlockedAt?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
    // V2 Fields
    xp?: number;
    isXpCapped?: boolean;
}

// =============================================================================
// FUEL SYSTEM
// =============================================================================

export interface FuelAdRefillOption {
    type: "ad";
    refillAmount: number;
    cooldownMinutes: number;
    maxAdWatchesPerDay: number;
}

export interface FuelCellRefillOption {
    type: "item";
    skuId: string;
    refillAmount: number;
    description?: string;
}

export interface FuelGemRefillOption {
    type: "premium";
    gemsPerBar: number;
    refillAmount: number;
}

export interface FuelRefillOptions {
    ad: FuelAdRefillOption;
    fuelCell: FuelCellRefillOption;
    gems: FuelGemRefillOption;
}

export interface FuelFallbackReward {
    enabled: boolean;
    description?: string;
    coins: number;
}

export interface FuelConfig {
    version: string;
    updatedAt: number;
    notes?: string;
    maxBars: number;
    regenIntervalMinutes: number;
    raceCostPerRace: number;
    refillOptions: FuelRefillOptions;
    fallbackReward: FuelFallbackReward;
}

// =============================================================================
// CRATE SLOTS SYSTEM
// =============================================================================

export interface CrateUnlockDuration {
    durationSeconds: number;
    displayDuration?: string;
}

export interface CrateSlotsSkipCost {
    gemsPerHour: number;
    minGems: number;
}

export interface CrateSlotFullFallback {
    enabled: boolean;
    description?: string;
    rewards: {
        coins?: number;
        spellShards?: number;
    };
}

export interface CrateSlotsConfig {
    version: string;
    updatedAt: number;
    notes?: string;
    maxSlots: number;
    defaultSlots: number;
    purchasableSlots: {
        enabled: boolean;
        maxPurchasable: number;
        gemCostPerSlot: number;
    };
    unlockDurations: Record<string, CrateUnlockDuration>; // rarity -> duration
    skipCost: CrateSlotsSkipCost;
    slotFullFallback: CrateSlotFullFallback;
    simultaneousUnlocks: number;
}

export interface CrateSlotEntry {
    crateSkuId: string;
    crateId: string;
    rarity: string;
    receivedAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
    isUnlocking: boolean;
    startedAt?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue | null;
    completesAt?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue | null;
    /** Total unlock duration in seconds for this crate's rarity, captured at receive time */
    unlockDurationSeconds?: number;
}

export interface UserCrateSlotsDoc {
    slots: (CrateSlotEntry | null)[];
    maxSlots: number;
    updatedAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
}

// =============================================================================
// PLAYER SLOTS (PIT CREW & LIBRARY PURCHASES)
// =============================================================================

export interface SlotPurchaseConfig {
    slotNumber: number;
    gemCost: number;
    displayName: string;
}

export interface PitCrewSlotsConfig {
    description?: string;
    defaultSlots: number;
    maxSlots: number;
    purchasableSlotsConfig: SlotPurchaseConfig[];
}

export interface LibrarySlotsConfig {
    description?: string;
    defaultSlots: number;
    maxSlots: number;
    purchasableSlotsConfig: SlotPurchaseConfig[];
}

export interface PlayerSlotsConfig {
    version: string;
    updatedAt: number;
    notes?: string;
    pitCrew: PitCrewSlotsConfig;
    library: LibrarySlotsConfig;
}

// =============================================================================
// V2 PROFILE EXTENSIONS
// =============================================================================

export interface UserProfileV2Extensions {
    // V2 fields to add to existing Profile/Profile document
    masteryXp?: number;
    masteryRank?: number;
    pitCrewSlots?: number;
    librarySlots?: number;
    fuelCellCount?: number;
}

// =============================================================================
// MASTERY SYSTEM CONFIG
// =============================================================================

export interface MasteryConfig {
    version: string;
    updatedAt: number;
    notes?: string;
    carWeight: number;    // Multiplier for car XP contribution (1.0)
    spellWeight: number;  // Multiplier for spell XP contribution (0.33)
    maxRank: number;
    rankThresholds: Record<string, number>; // rank -> cumulative MP required
}

// =============================================================================
// V2 ECONOMY EXTENSIONS
// =============================================================================

export interface UserEconomyV2Extensions {
    // V2 fields to add to existing Economy/Stats document
    spellShards?: number;
}

// =============================================================================
// REQUEST/RESPONSE TYPES FOR V2 FUNCTIONS
// =============================================================================

// Tier License
export interface PurchaseTierLicenseRequest {
    tierId: string;
    opId: string;
}

export interface PurchaseTierLicenseResponse {
    success: boolean;
    opId: string;
    tierId: string;
    grantedCars: string[];
    coinsSpent: number;
}

// Car Evolution
export interface StartCarEvolutionRequest {
    carId: string;
    opId: string;
}

export interface StartCarEvolutionResponse {
    success: boolean;
    opId: string;
    carId: string;
    targetCarLevel: number;
    completesAt: number; // Unix timestamp
    coinsSpent: number;
}

export interface ClaimCarEvolutionRequest {
    carId: string;
    opId: string;
}

export interface ClaimCarEvolutionResponse {
    success: boolean;
    opId: string;
    carId: string;
    newCarLevel: number;
}

export interface SkipCarEvolutionRequest {
    carId: string;
    opId: string;
}

export interface SkipCarEvolutionResponse {
    success: boolean;
    opId: string;
    carId: string;
    gemsSpent: number;
    newCarLevel?: number;
}

// Spell Research
export interface StartSpellResearchRequest {
    spellId: string;
    opId: string;
}

export interface StartSpellResearchResponse {
    success: boolean;
    opId: string;
    spellId: string;
    targetLevel: number;
    completesAt: number; // Unix timestamp
    shardsSpent: number;
}

export interface ClaimSpellResearchRequest {
    spellId: string;
    opId: string;
}

export interface ClaimSpellResearchResponse {
    success: boolean;
    opId: string;
    spellId: string;
    newLevel: number;
}

export interface SkipSpellResearchResponse {
    success: boolean;
    opId: string;
    spellId: string;
    gemsSpent: number;
    newLevel?: number;
}

// Fuel
export interface ConsumeFuelRequest {
    carId: string;
}

export interface ConsumeFuelResponse {
    success: boolean;
    carId: string;
    fuelBarsRemaining: number;
}

export interface RefuelWithAdRequest {
    carId: string;
    opId: string;
}

export interface RefuelWithAdResponse {
    success: boolean;
    opId: string;
    carId: string;
    fuelBarsAfter: number;
    barsAdded: number;
}

export interface UseFuelCellRequest {
    carId: string;
    opId: string;
}

export interface UseFuelCellResponse {
    success: boolean;
    opId: string;
    carId: string;
    fuelBarsAfter: number;
}

// Crate Slots
export interface ReceiveCrateV2Request {
    crateSkuId: string;
    opId: string;
}

export interface ReceiveCrateV2Response {
    success: boolean;
    opId: string;
    slotIndex: number | null; // null if fallback was granted
    fallbackGranted: boolean;
    fallbackRewards?: {
        coins?: number;
        spellShards?: number;
    };
}

export interface StartCrateUnlockRequest {
    slotIndex: number;
    opId: string;
}

export interface StartCrateUnlockResponse {
    success: boolean;
    opId: string;
    slotIndex: number;
    completesAt: number; // Unix timestamp
}

export interface ClaimCrateRewardV2Request {
    slotIndex: number;
    opId: string;
}

/** A single reward item that can be awarded from a crate */
export interface CrateRewardItem {
    /** Reward type: "coins" | "gems" | "xpBooster" | "coinBooster" | "shardBooster" | "speedUp" */
    type: string;
    /** Display name for UI */
    displayName: string;
    /** Quantity to award */
    quantity: number;
    /** Duration in hours (for boosters/speedups) */
    durationHours?: number;
    /** Weight for random selection (higher = more likely) */
    weight: number;
    /** SKU ID to grant in inventory (for boosters/speedups) */
    skuId?: string;
}

/** Reward pool for a specific crate rarity */
export interface CrateRewardPool {
    /** Number of cosmetic items to award */
    cosmeticCount: number;
    /** Number of random catalog items to award */
    catalogItemCount: number;
    /** Available catalog reward items to pick from */
    rewardPool: CrateRewardItem[];
}

/** Slot activation probabilities for bonus/jackpot slots */
export interface SlotActivation {
    slot2: number;
    slot3: number;
}

/** Rank-scaled coin reward configuration */
export interface CoinScalingConfig {
    /** Multiplier per rarity tier applied to COIN_CAPS_BY_RANK[rank][0] */
    multipliers: Record<string, number>;
    /** Random variance ± (e.g. 0.2 = ±20%) */
    variance: number;
}

/** Config document at /GameData/v1/config/CrateRewardsConfig (v2.0 multi-slot) */
export interface CrateRewardsConfig {
    version: string;
    updatedAt: number;
    notes?: string;
    /** Slot 2/3 activation probabilities per crate rarity */
    slotActivation: Record<string, SlotActivation>;
    /** Per-slot rarity distribution for bonus/jackpot slots */
    slotRarityDistribution: Record<string, {
        slot2: Record<string, number>;
        slot3: Record<string, number>;
    }>;
    /** Rank-scaled coin reward configuration */
    coinScaling: CoinScalingConfig;
    /** Rank-scaled shard reward configuration (scales slower than coins) */
    shardScaling: CoinScalingConfig;
    /** Number of cosmetic items to award per crate */
    cosmeticCount: number;
    /** Item pools keyed by rarity tier (common, rare, exotic, legendary, mythical) */
    itemPoolsByRarity: Record<string, CrateRewardItem[]>;
    /** @deprecated Legacy v1 pools — kept for migration safety */
    rewardsByRarity?: Record<string, CrateRewardPool>;
}

/** A single awarded item in the claim response */
export interface AwardedItem {
    type: string;
    displayName: string;
    quantity: number;
    rarity?: string;
    skuId?: string;
    itemId?: string;
    durationHours?: number;
}

export interface ClaimCrateRewardV2Response {
    success: boolean;
    opId: string;
    slotIndex: number;
    awarded: AwardedItem[];
    economyChanges: {
        coins?: number;
        gems?: number;
        spellShards?: number;
    };
}

// =============================================================================
// SPEEDUP SYSTEM
// =============================================================================

export interface SpeedUpEntry {
    skuId: string;
    itemId: string;
    displayName: string;
    category: string;
    type: string;
    rarity: string;
    stackable: boolean;
    variant: string | null;
    subType: string;
    durationSeconds: number;
}

export interface SpeedUpsCatalog {
    version: string;
    updatedAt: number;
    speedups: Record<string, SpeedUpEntry>;
}

export type SpeedupQueueType = "pitCrew" | "library" | "crateSlot";

export interface UseSpeedupRequest {
    queueType: SpeedupQueueType;
    targetId: string; // carId, spellId, or slotIndex (as string, e.g. "0")
    speedupSkuId: string;
    opId: string;
}

export interface UseSpeedupResponse {
    success: boolean;
    opId: string;
    queueType: SpeedupQueueType;
    targetId: string;
    speedupUsed: string;
    secondsRemoved: number;
    newCompletesAt: number;
    isNowComplete: boolean;
    newRemainingSeconds: number;
}

// =============================================================================
// CAR STATS BUDGET SYSTEM
// =============================================================================

/**
 * Per-archetype stat distribution profile.
 * Values must sum to 1.0 — they represent what fraction of the
 * total stat budget goes into each stat.
 */
export interface ArchetypeStatProfile {
    description?: string;
    topSpeed: number;
    acceleration: number;
    handling: number;
    boostRegen: number;
    boostPower: number;
}

/**
 * Optional per-tier override. If present, overrides the evenly
 * distributed budget for that specific tier.
 */
export interface TierBudgetOverride {
    budgetOverride?: number;
    floorOverride?: number;
}

/**
 * Master config for the dynamic car stats budget system.
 * Stored at /GameData/v1/config/CarStatsBudgetConfig
 *
 * The system evenly divides globalStatCap across tiers, then distributes
 * each tier's budget across the 5 stats using archetype profiles.
 * Stars contribute starWeight% and car levels contribute levelWeight%.
 */
export interface CarStatsBudgetConfig {
    version: string;
    updatedAt: number;
    notes?: string;
    /** Maximum stat value any car can reach (e.g. 100) */
    globalStatCap: number;
    /** Number of tiers in the game (e.g. 5) */
    tierCount: number;
    /** Maximum star level a car can reach (e.g. 10) */
    maxStarLevel: number;
    /** Maximum cumulative car level (e.g. 100) */
    maxCarLevel: number;
    /** Fraction of tier budget contributed by star levels (0.0 - 1.0) */
    starWeight: number;
    /** Fraction of tier budget contributed by car levels (0.0 - 1.0) */
    levelWeight: number;
    /** The 5 stat keys, in order */
    statKeys: string[];
    /** Distribution profiles per archetype (guardian, phantom, arcanist) */
    archetypeProfiles: Record<string, ArchetypeStatProfile>;
    /** Optional per-tier budget overrides */
    tierOverrides?: Record<string, TierBudgetOverride>;
}

export interface CarAbility {
    id: string;
    duration?: number;
    cooldown?: number;
    cooldownReduction?: number;
    speedMultiplier?: number;
}

export interface CarLevelData {
    xpToNext: number;
    upgradeTimerSeconds: number;
    priceCoins: number;
    carRating: number;
    topSpeed: number;
    acceleration: number;
    handling: number;
    boostRegen: number;
    boostPower: number;
}

export interface CarCatalogEntry {
    carId?: string;
    displayName?: string;
    class?: string;
    basePrice?: number;
    ability?: CarAbility;
    levels?: Record<string, CarLevelData>;
    unlock?: {
        type: string;
        minPlayerLevel?: number;
        seriesId?: string;
    };
    version?: string;
}

export interface CarsCatalog {
    version: string;
    updatedAt: number;
    cars: Record<string, CarCatalogEntry>;
}

/**
 * The computed stats for a car at a specific star level and car level.
 */
export interface ComputedCarStats {
    topSpeed: number;
    acceleration: number;
    handling: number;
    boostRegen: number;
    boostPower: number;
    /** Total stat budget at this progression point */
    totalBudget: number;
    /** Tier floor value */
    tierFloor: number;
    /** Tier ceiling value */
    tierCeiling: number;
    /** Budget allocated from star progression */
    starContribution: number;
    /** Budget allocated from car level progression */
    levelContribution: number;
    /** Computed car rating (totalBudget × ratingMultiplier, e.g. 100–1000) */
    carRating: number;
}

/**
 * Input needed to compute a car's stats.
 */
export interface CarStatsInput {
    /** Tier order (1-based: 1 = Street, 5 = Mythic) */
    tierOrder: number;
    /** Car archetype: "guardian", "phantom", or "arcanist" */
    archetype: string;
    /** Current star level (0 to maxStarLevel) */
    starLevel: number;
    /** Current cumulative car level (0 to maxCarLevel) */
    carLevel: number;
}

// =============================================================================
// UPGRADE COMPLETION QUEUE
// =============================================================================

export type UpgradeType = "carEvolution" | "spellResearch";

/**
 * Document stored at System/Upgrades/CompletionQueue/{uid}_{upgradeType}_{targetId}
 * Used by the scheduled upgradeCompletionJob to auto-complete upgrades when timers expire.
 */
export interface UpgradeCompletionEntry {
    /** Player UID */
    uid: string;
    /** Type of upgrade: car evolution or spell research */
    upgradeType: UpgradeType;
    /** The carId or spellId being upgraded */
    targetId: string;
    /** Target star level (car) or spell level */
    targetLevel: number;
    /** Unix timestamp (ms) when the upgrade completes — indexed for queries */
    completesAt: number;
    /** Unix timestamp (ms) when this queue entry was created */
    createdAt: number;
    /** Incremented on processing failure; fuse breaker drops at >= 5 */
    retryCount?: number;
}
