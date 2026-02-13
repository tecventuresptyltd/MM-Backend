/**
 * V2 Types for Mystic Motors Backend
 *
 * This file contains TypeScript interfaces for the new V2 game systems:
 * - Tier License System
 * - Car Evolution (Pit Crew)
 * - Spell Research (Library)
 * - Fuel System
 * - Crate Slots
 */

// =============================================================================
// TIER LICENSE SYSTEM
// =============================================================================

export type CarArchetype = "tank" | "speedster" | "specialist";

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

export interface EvolutionCostEntry {
    targetStarLevel: number;
    coins: number;
    durationSeconds: number;
    displayDuration?: string;
}

export interface EvolutionSkipCost {
    gemsPerHour: number;
    minGems: number;
}

export interface StatBonusPerStar {
    topSpeed: number;
    acceleration: number;
    handling: number;
    boostRegen: number;
    boostPower: number;
}

export interface CarEvolutionV2Catalog {
    version: string;
    updatedAt: number;
    notes?: string;
    xpCaps: Record<string, number>; // starLevel -> XP cap
    maxStarLevel: number;
    evolutionCosts: Record<string, EvolutionCostEntry>; // currentStarLevel -> cost
    skipCost: EvolutionSkipCost;
    statBonusPerStar: StatBonusPerStar;
}

export interface PitCrewSlotEntry {
    carId: string;
    startedAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
    completesAt: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue;
    targetStarLevel: number;
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
    starLevel?: number;
    isXpCapped?: boolean;
    fuelBars?: number;
    fuelLastRefillAt?: FirebaseFirestore.Timestamp | FirebaseFirestore.FieldValue | null;
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
}

export interface SpellXpConfig {
    xpPerRace: number;
    xpPerWin: number;
    xpPerSpellCast: number;
    xpCapPerLevel: Record<string, number>;
}

export interface SpellEvolutionV2Catalog {
    version: string;
    updatedAt: number;
    notes?: string;
    maxSpellLevel: number;
    researchCosts: Record<string, ResearchCostEntry>; // targetLevel -> cost
    skipCost: ResearchSkipCost;
    spellXpConfig: SpellXpConfig;
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
    masteryRank?: number;
    pitCrewSlots?: number;
    librarySlots?: number;
    fuelCellCount?: number;
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
    targetStarLevel: number;
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
    newStarLevel: number;
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

export interface ClaimCrateRewardV2Response {
    success: boolean;
    opId: string;
    slotIndex: number;
    awarded: {
        skuId: string;
        itemId: string;
        type: string;
        rarity: string;
        quantity: number;
    };
}
