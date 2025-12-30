export interface CarLevel {
  priceCoins: number;
  topSpeed?: number;      // display slider (1..16)
  acceleration?: number;  // display slider
  handling?: number;      // display slider
  boostRegen?: number;    // display slider
  boostPower?: number;    // display slider

  // Legacy/deprecated fields retained for backwards compatibility during migration.
  topSpeed_value?: number;
  acceleration_value?: number;
  handling_value?: number;
  boostRegen_value?: number;
  boostPower_value?: number;
  topSpeed_real?: number;
  acceleration_real?: number;
  handling_real?: number;
  boostRegen_real?: number;
  boostPower_real?: number;
  speed?: number;
  accel?: number;
  accelerationMultiplier?: number;
  topSpeedMultiplier?: number;
  boostSpeedMultiplier?: number;
  boostRegenMultiplier?: number;
  handlingMultiplier?: number;
}

export interface Car {
  carId: string;
  displayName: string;
  i18n: { en: string };
  class: string;
  basePrice: number;
  unlock: { type: string; minPlayerLevel?: number };
  levels: Record<string, CarLevel>;
  growthModel: {
    price: string;
    stat: string;
    configKey: string;
  };
  version: string;
  createdAt: number;
  updatedAt: number;
}

export interface StatRange { min: number; max: number }

export interface CarTuningConfig {
  valueScale: { min: number; max: number; step: number };
  player: {
    topSpeed: StatRange;
    acceleration: StatRange;
    handling: StatRange;
    boostRegen: StatRange;
    boostPower: StatRange;
  };
  notes?: string;
  updatedAt: number;
}

export interface SpellLevelCost {
  // Legacy shape
  tokenCost?: number;
  // Consolidated shape
  cost?: { spellTokens?: number };
}

export type ItemRarity =
  | "common"
  | "rare"
  | "exotic"
  | "legendary"
  | "special"
  | "Default";

export type CosmeticSubType = "wheels" | "spoiler" | "underglow" | "decal" | "boost";

export type BoosterSubType = "coin" | "exp";

export interface ItemVariant {
  skuId: string;
  displayName?: string;
  rarity?: ItemRarity;
  stackable?: boolean;
  purchasable?: boolean;
  gemPrice?: number;
  durationSeconds?: number;
  subType?: CosmeticSubType | BoosterSubType | string | null;
  assetRef?: AssetRef;
  variant?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  tags?: string[];
}

export interface AssetRef {
  prefab: string;
  [key: string]: unknown;
}

export interface Spell {
  spellId: string;
  displayName: string;
  i18n?: { en: string };
  description?: string;
  levels?: Record<string, SpellLevelCost>;
  requiredLevel: number;
  displayOrder: number;
  isUnlocked?: boolean;
  unlocked?: boolean;
}

export interface BaseItem {
  itemId: string;
  type: "cosmetic" | "crate" | "key" | "booster" | "currency";
  category?: BaseItem["type"] | string;
  displayName: string;
  rarity: ItemRarity;
  stackable: boolean;
  variant?: string | null;
  assetRef?: AssetRef;
  metadata?: Record<string, unknown>;
  tags?: string[];
  purchasable?: boolean;
  gemPrice?: number;
  variants?: ItemVariant[];
}

export interface CosmeticItem extends BaseItem {
  type: "cosmetic";
  subType: CosmeticSubType;
  stackable: boolean;
  assetRef: AssetRef;
}

export interface CrateItem extends BaseItem {
  type: "crate";
  stackable: true;
}

export interface KeyItem extends BaseItem {
  type: "key";
  stackable: true;
}

export interface BoosterItem extends BaseItem {
  type: "booster";
  subType: BoosterSubType;
  durationSeconds: number;
  stackable: true;
}

export interface CurrencyItem extends BaseItem {
  type: "currency";
  stackable: true;
  metadata?: Record<string, unknown> & { currency?: string };
}

export type Item = CosmeticItem | CrateItem | KeyItem | BoosterItem | CurrencyItem;

export interface ItemPurchasable {
  currency: "gems" | "coins";
  amount: number;
}

export interface ItemSku {
  skuId: string;
  itemId: string;
  type: Item["type"];
  displayName: string;
  itemDisplayName: string;
  category: BaseItem["type"] | string;
  subType?: CosmeticSubType | BoosterSubType | string | null;
  rarity: ItemRarity;
  stackable: boolean;
  assetRef?: AssetRef;
  variant?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  tags?: string[];
  purchasable?: ItemPurchasable | null;
  gemPrice?: number | null;
  durationSeconds?: number | null;
}

export interface ItemSkusCatalogDoc {
  version?: string;
  updatedAt?: number;
  skus: Record<string, ItemSku>;
}

export interface ItemsCatalogDoc {
  version?: string;
  updatedAt: number;
  items: Record<string, Item>;
  index: Record<string, string[]>;
}

export interface ItemsIndexDoc {
  version?: string;
  updatedAt?: number;
  index: Record<string, string[]>;
}

export interface CrateDropEntry {
  weight: number;
  itemId: string;
}

export interface CrateDefinition {
  crateId: string;
  displayName: string;
  rarity: ItemRarity;
  dropTable: CrateDropEntry[];
  keyItemId?: string | null;
  updatedAt?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** Legacy compat fields */
  skuId?: string | null;
  crateSkuId?: string | null;
  keySkuId?: string | null;
  rarityWeights?: Record<string, number>;
  poolsByRarity?: Record<string, string[]>;
  loot?: Array<{ skuId?: string; itemId?: string; weight?: number; quantity?: number }>;
}

export type Crate = CrateDefinition;

export interface CratesCatalogDoc {
  version?: string;
  updatedAt?: number;
  defaults?: {
    starterCrateId?: string;
    starterKeyItemId?: string;
    starterKeySkuId?: string;
  };
  crates: Record<string, CrateDefinition>;
}

export interface OfferEntitlement {
  type: "gems" | "coins" | "crate" | "key" | "booster" | "cosmetic";
  id: string;
  quantity: number;
}

export interface Offer {
  offerId: string;
  displayName: string;
  currency?: string;
  amount?: number;
  price?: number;
  originalPrice?: number;
  productId?: string;
  entitlements: OfferEntitlement[];
  startAt?: number;
  endAt?: number;
  metadata?: Record<string, unknown>;
  validityHours?: number;
  offerType?: number;
  updatedAt?: number;
}

export interface ActiveStarterOffer {
  offerId: string;
  expiresAt: number;
}

/** @deprecated Use MainOfferState instead */
export interface ActiveDailyOfferState {
  offerId: string | null;
  tier: number;
  expiresAt: number;
  isPurchased: boolean;
  generatedAt: number;
}

export type SpecialOfferTriggerType =
  | "level_up"
  | "flash_missing_key"
  | "flash_missing_crate";

export interface ActiveSpecialOffer {
  offerId: string;
  triggerType: SpecialOfferTriggerType;
  expiresAt: number;
  metadata?: { level?: number };
}

/**
 * State of the main rotating offer slot.
 * States: 'active' (offer visible), 'cooldown' (12h wait after expiry),
 * 'purchase_delay' (30min wait after IAP purchase)
 */
export type MainOfferState = 'active' | 'cooldown' | 'purchase_delay';

/**
 * Main offer slot in the redesigned offer flow.
 * Replaces separate starter/daily handling with unified slot.
 */
export interface MainOffer {
  offerId: string;
  offerType: number;
  expiresAt: number;
  tier: number;
  state: MainOfferState;
  /** When next offer becomes available (used in cooldown/purchase_delay states) */
  nextOfferAt?: number;
  /** True if this is a starter offer */
  isStarter?: boolean;
}

/**
 * Backend-only state for tracking offer flow progression.
 * Stored at Players/{uid}/Offers/State
 */
export interface OfferFlowState {
  starterEligible: boolean;
  starterShown: boolean;
  starterPurchased: boolean;
  tier: number;
  lastOfferExpiredAt?: number;
  lastOfferPurchasedAt?: number;
  offersPurchased: string[];
  totalIapPurchases: number;
  updatedAt: number;
}

/**
 * Client-facing active offers document.
 * Stored at Players/{uid}/Offers/Active
 */
export interface ActiveOffers {
  /** @deprecated Use main instead - kept for backward compatibility */
  starter?: ActiveStarterOffer;
  /** @deprecated Use main instead - kept for backward compatibility */
  daily?: ActiveDailyOfferState;
  /** New unified main offer slot */
  main?: MainOffer;
  /** Independent stackable offers (milestones, flash sales) */
  special: ActiveSpecialOffer[];
  updatedAt?: number;
}


export interface Rank {
  rankId: string;
  displayName: string;
  i18n: { en: string };
  minMmr: number;
  rewards: Rewards;
}

export interface Booster {
  boosterId: string;
  price: number;
}

export interface BoosterTimerState {
  activeUntil: number;
  stackedCount: number;
}

export interface PlayerBoostersState {
  coin?: BoosterTimerState;
  exp?: BoosterTimerState;
}

export interface RewardInventoryGrant {
  skuId: string;
  quantity: number;
}

export interface Rewards {
  coins?: number;
  gems?: number;
  inventory?: RewardInventoryGrant[];
}

export interface XpCurve {
  // Optional metadata fields that may exist in catalog
  curveId?: string;
  version?: string;
  generated?: boolean;
  createdAt?: string | number;
  updatedAt?: string | number;
  // Required payload
  levels: Record<string, number>;
}
