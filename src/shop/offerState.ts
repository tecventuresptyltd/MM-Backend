import * as admin from "firebase-admin";

import { db } from "../shared/firestore.js";
import {
  ActiveDailyOfferState,
  ActiveOffers,
  ActiveSpecialOffer,
  ActiveStarterOffer,
  MainOffer,
  MainOfferState,
  OfferFlowState,
  SpecialOfferTriggerType,
} from "../shared/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Timing Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Duration of starter offer */
export const STARTER_VALIDITY_MS = 48 * 60 * 60 * 1000; // 48 hours

/** Duration of daily/ladder offers */
export const OFFER_VALIDITY_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Cooldown period after an offer expires before next one appears */
export const POST_EXPIRY_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hours

/** Delay after IAP purchase before next tier offer appears */
export const POST_PURCHASE_DELAY_MS = 30 * 60 * 1000; // 30 minutes

/** Minimum completed races required for starter offer eligibility */
export const STARTER_RACE_THRESHOLD = 2;

/** Maximum ladder tier */
export const MAX_TIER = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Path Constants
// ─────────────────────────────────────────────────────────────────────────────

export const ACTIVE_OFFERS_PATH = (uid: string): string =>
  `Players/${uid}/Offers/Active`;

export const OFFER_STATE_PATH = (uid: string): string =>
  `Players/${uid}/Offers/State`;

export const activeOffersRef = (uid: string) => db.doc(ACTIVE_OFFERS_PATH(uid));

export const offerStateRef = (uid: string) => db.doc(OFFER_STATE_PATH(uid));

// ─────────────────────────────────────────────────────────────────────────────
// Trigger Types
// ─────────────────────────────────────────────────────────────────────────────

const SPECIAL_TRIGGER_TYPES: SpecialOfferTriggerType[] = [
  "level_up",
  "flash_missing_key",
  "flash_missing_crate",
];
const SPECIAL_TRIGGER_SET = new Set(SPECIAL_TRIGGER_TYPES);

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

const normaliseNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
};

const clampTier = (tier: unknown): number => {
  const parsed = Math.floor(Number(tier));
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(MAX_TIER, parsed));
};

const isValidMainOfferState = (value: unknown): value is MainOfferState =>
  value === "active" || value === "cooldown" || value === "purchase_delay";

const isSpecialTriggerType = (value: unknown): value is SpecialOfferTriggerType =>
  typeof value === "string" && SPECIAL_TRIGGER_SET.has(value as SpecialOfferTriggerType);

// ─────────────────────────────────────────────────────────────────────────────
// Tier Progression Logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate next tier after an offer is purchased (IAP only).
 * Climbs 1 tier, with special wrap from tier 4 → tier 3.
 */
export const resolveNextTierOnPurchase = (currentTier: number): number => {
  if (currentTier >= MAX_TIER) {
    return MAX_TIER - 1; // Wrap T4 → T3
  }
  return Math.min(MAX_TIER, currentTier + 1);
};

/**
 * Calculate next tier after an offer expires.
 * Drops 2 tiers, minimum tier 0.
 */
export const resolveNextTierOnExpiry = (currentTier: number): number => {
  return Math.max(0, currentTier - 2);
};

/**
 * Get the appropriate cooldown duration based on how the offer ended.
 */
export const resolveCooldownDuration = (purchased: boolean): number => {
  return purchased ? POST_PURCHASE_DELAY_MS : POST_EXPIRY_COOLDOWN_MS;
};

// ─────────────────────────────────────────────────────────────────────────────
// Default State Factories
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use defaultOfferFlowState instead */
export const defaultDailyState = (): ActiveDailyOfferState => ({
  offerId: null,
  tier: 0,
  expiresAt: 0,
  isPurchased: false,
  generatedAt: 0,
});

/**
 * Default backend offer flow state for new players.
 */
export const defaultOfferFlowState = (): OfferFlowState => ({
  starterEligible: false,
  starterShown: false,
  starterPurchased: false,
  tier: 0,
  offersPurchased: [],
  totalIapPurchases: 0,
  updatedAt: 0,
});

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation Functions
// ─────────────────────────────────────────────────────────────────────────────

const normaliseStarter = (value: unknown): ActiveStarterOffer | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const { offerId, expiresAt } = value as ActiveStarterOffer;
  if (typeof offerId !== "string" || !offerId) {
    return undefined;
  }
  const expires = normaliseNumber(expiresAt);
  if (expires <= 0) {
    return undefined;
  }
  return { offerId, expiresAt: expires };
};

const normaliseMainOffer = (value: unknown): MainOffer | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const data = value as Partial<MainOffer>;
  if (typeof data.offerId !== "string" || !data.offerId) {
    return undefined;
  }
  const state = isValidMainOfferState(data.state) ? data.state : "active";
  return {
    offerId: data.offerId,
    offerType: normaliseNumber(data.offerType, 0),
    expiresAt: normaliseNumber(data.expiresAt),
    tier: clampTier(data.tier),
    state,
    nextOfferAt: data.nextOfferAt ? normaliseNumber(data.nextOfferAt) : undefined,
    isStarter: Boolean(data.isStarter),
  };
};

const normaliseSpecialOffer = (value: unknown): ActiveSpecialOffer | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { offerId, triggerType, expiresAt, metadata } = value as {
    offerId?: unknown;
    triggerType?: unknown;
    expiresAt?: unknown;
    metadata?: unknown;
  };
  if (typeof offerId !== "string" || !offerId) {
    return null;
  }
  if (!isSpecialTriggerType(triggerType)) {
    return null;
  }
  const expires = normaliseNumber(expiresAt);
  if (expires <= 0) {
    return null;
  }
  const result: ActiveSpecialOffer = { offerId, triggerType, expiresAt: expires };
  if (metadata && typeof metadata === "object") {
    result.metadata = metadata as { level?: number };
  }
  return result;
};

const normaliseSpecialList = (value: unknown): ActiveSpecialOffer[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normaliseSpecialOffer(entry))
    .filter((entry): entry is ActiveSpecialOffer => Boolean(entry));
};

/** @deprecated Use normaliseActiveOffersV2 for new code */
export const normaliseDailyState = (value: unknown): ActiveDailyOfferState => {
  if (!value || typeof value !== "object") {
    return defaultDailyState();
  }
  const { offerId, tier, expiresAt, isPurchased, generatedAt } =
    value as Partial<ActiveDailyOfferState>;
  return {
    offerId: typeof offerId === "string" ? offerId : null,
    tier: clampTier(tier),
    expiresAt: normaliseNumber(expiresAt),
    isPurchased: Boolean(isPurchased),
    generatedAt: normaliseNumber(generatedAt),
  };
};

/**
 * Normalise ActiveOffers document data.
 * Supports both legacy (starter/daily) and new (main) formats.
 */
export const normaliseActiveOffers = (
  data: FirebaseFirestore.DocumentData | undefined | null,
): ActiveOffers => {
  const starter = normaliseStarter(data?.starter);
  const daily = data?.daily ? normaliseDailyState(data.daily) : undefined;
  const main = normaliseMainOffer(data?.main);
  const special = normaliseSpecialList(data?.special);
  return {
    starter,
    daily,
    main,
    special,
    updatedAt: normaliseNumber(data?.updatedAt, 0) || undefined,
  };
};

/**
 * Normalise OfferFlowState document data.
 */
export const normaliseOfferFlowState = (
  data: FirebaseFirestore.DocumentData | undefined | null,
): OfferFlowState => {
  if (!data) {
    return defaultOfferFlowState();
  }
  return {
    starterEligible: Boolean(data.starterEligible),
    starterShown: Boolean(data.starterShown),
    starterPurchased: Boolean(data.starterPurchased),
    tier: clampTier(data.tier),
    lastOfferExpiredAt: data.lastOfferExpiredAt
      ? normaliseNumber(data.lastOfferExpiredAt)
      : undefined,
    lastOfferPurchasedAt: data.lastOfferPurchasedAt
      ? normaliseNumber(data.lastOfferPurchasedAt)
      : undefined,
    offersPurchased: Array.isArray(data.offersPurchased)
      ? data.offersPurchased.filter((id: unknown) => typeof id === "string")
      : [],
    totalIapPurchases: normaliseNumber(data.totalIapPurchases),
    updatedAt: normaliseNumber(data.updatedAt),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

export const pruneExpiredSpecialOffers = (
  special: ActiveSpecialOffer[],
  now: number,
): ActiveSpecialOffer[] => special.filter((entry) => entry.expiresAt > now);

/**
 * Check if a main offer is ready for the next transition.
 */
export const isMainOfferTransitionReady = (
  main: MainOffer | undefined,
  now: number,
): boolean => {
  if (!main) return false;
  if (main.state === "active") {
    return main.expiresAt <= now;
  }
  if (main.state === "cooldown" || main.state === "purchase_delay") {
    return (main.nextOfferAt ?? 0) <= now;
  }
  return false;
};

// ─────────────────────────────────────────────────────────────────────────────
// Write Functions
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated Use writeActiveOffersV2 for new code */
export const writeActiveOffers =
  (
    transaction: FirebaseFirestore.Transaction,
    uid: string,
  ) =>
    (state: ActiveOffers, now: number) => {
      const ref = activeOffersRef(uid);
      const starterValue: ActiveStarterOffer | FirebaseFirestore.FieldValue =
        state.starter ?? admin.firestore.FieldValue.delete();

      transaction.set(
        ref,
        {
          starter: starterValue,
          daily: state.daily ?? admin.firestore.FieldValue.delete(),
          special: state.special,
          updatedAt: now,
        },
        { merge: true },
      );
    };

/**
 * Write the new-format ActiveOffers document with main slot.
 */
export const writeActiveOffersV2 = (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  state: {
    main?: MainOffer | null;
    special: ActiveSpecialOffer[];
  },
  now: number,
): void => {
  const ref = activeOffersRef(uid);
  const mainValue: MainOffer | FirebaseFirestore.FieldValue =
    state.main ?? admin.firestore.FieldValue.delete();

  transaction.set(
    ref,
    {
      main: mainValue,
      special: state.special,
      // Clear legacy fields
      starter: admin.firestore.FieldValue.delete(),
      daily: admin.firestore.FieldValue.delete(),
      updatedAt: now,
    },
    { merge: true },
  );
};

/**
 * Update the OfferFlowState document.
 */
export const writeOfferFlowState = (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  updates: Partial<OfferFlowState>,
  now: number,
): void => {
  const ref = offerStateRef(uid);
  transaction.set(
    ref,
    {
      ...updates,
      updatedAt: now,
    },
    { merge: true },
  );
};
