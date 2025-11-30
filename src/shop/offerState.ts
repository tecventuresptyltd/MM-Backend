import * as admin from "firebase-admin";

import { db } from "../shared/firestore.js";
import {
  ActiveDailyOfferState,
  ActiveOffers,
  ActiveSpecialOffer,
  ActiveStarterOffer,
  SpecialOfferTriggerType,
} from "../shared/types.js";

const SPECIAL_TRIGGER_TYPES: SpecialOfferTriggerType[] = [
  "level_up",
  "flash_missing_key",
  "flash_missing_crate",
];
const SPECIAL_TRIGGER_SET = new Set(SPECIAL_TRIGGER_TYPES);

export const ACTIVE_OFFERS_PATH = (uid: string): string =>
  `Players/${uid}/Offers/Active`;

export const activeOffersRef = (uid: string) => db.doc(ACTIVE_OFFERS_PATH(uid));

export const defaultDailyState = (): ActiveDailyOfferState => ({
  offerId: null,
  tier: 0,
  expiresAt: 0,
  isPurchased: false,
  generatedAt: 0,
});

const normaliseNumber = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
};

const clampDailyTier = (tier: unknown): number => {
  const parsed = Math.floor(Number(tier));
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(4, parsed));
};

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

const isSpecialTriggerType = (value: unknown): value is SpecialOfferTriggerType =>
  typeof value === "string" && SPECIAL_TRIGGER_SET.has(value as SpecialOfferTriggerType);

const normaliseSpecialOffer = (value: unknown): ActiveSpecialOffer | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { offerId, triggerType, expiresAt } = value as {
    offerId?: unknown;
    triggerType?: unknown;
    expiresAt?: unknown;
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
  return { offerId, triggerType, expiresAt: expires };
};

const normaliseSpecialList = (value: unknown): ActiveSpecialOffer[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normaliseSpecialOffer(entry))
    .filter((entry): entry is ActiveSpecialOffer => Boolean(entry));
};

export const normaliseDailyState = (value: unknown): ActiveDailyOfferState => {
  if (!value || typeof value !== "object") {
    return defaultDailyState();
  }
  const { offerId, tier, expiresAt, isPurchased, generatedAt } =
    value as Partial<ActiveDailyOfferState>;
  return {
    offerId: typeof offerId === "string" ? offerId : null,
    tier: clampDailyTier(tier),
    expiresAt: normaliseNumber(expiresAt),
    isPurchased: Boolean(isPurchased),
    generatedAt: normaliseNumber(generatedAt),
  };
};

export const normaliseActiveOffers = (
  data: FirebaseFirestore.DocumentData | undefined | null,
): ActiveOffers => {
  const starter = normaliseStarter(data?.starter);
  const daily = normaliseDailyState(data?.daily);
  const special = normaliseSpecialList(data?.special);
  return {
    starter,
    daily,
    special,
    updatedAt: normaliseNumber(data?.updatedAt, 0) || undefined,
  };
};

export const pruneExpiredSpecialOffers = (
  special: ActiveSpecialOffer[],
  now: number,
): ActiveSpecialOffer[] => special.filter((entry) => entry.expiresAt > now);

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
        daily: state.daily,
        special: state.special,
        updatedAt: now,
      },
      { merge: true },
    );
  };
