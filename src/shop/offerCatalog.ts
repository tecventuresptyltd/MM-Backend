import { getOffersCatalog } from "../core/config.js";
import { Offer, SpecialOfferTriggerType } from "../shared/types.js";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const STARTER_FALLBACK_HOURS = 48;

const DAILY_BASE_OFFER_TYPES = new Set([1, 2, 3, 4]);
const TIER_TYPE_MAP = new Map<number, number>([
  [1, 5],
  [2, 6],
  [3, 7],
  [4, 8],
]);
const FLASH_TRIGGER_BY_TYPE = new Map<number, SpecialOfferTriggerType>([
  [11, "flash_missing_key"],
  [12, "flash_missing_crate"],
]);

export interface OfferLadderIndex {
  starterOfferId: string;
  starterValidityMs: number;
  dailyBaseOfferIds: string[];
  tierOfferIds: Record<number, string>;
  flashOfferIds: Partial<Record<SpecialOfferTriggerType, string>>;
}

const normalisePositiveNumber = (
  value: unknown,
  fallback: number,
): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const resolveStarterOffer = (
  offers: Record<string, Offer>,
): { id: string; validityMs: number } => {
  for (const [offerId, offer] of Object.entries(offers)) {
    if (offer.offerType === 0) {
      const hours = normalisePositiveNumber(
        offer.validityHours,
        STARTER_FALLBACK_HOURS,
      );
      return { id: offerId, validityMs: hours * HOUR_MS };
    }
  }
  throw new Error("Starter offer (offerType 0) not found in catalog.");
};

const collectDailyBaseOffers = (offers: Record<string, Offer>): string[] => {
  const ids = Object.entries(offers)
    .filter(([, offer]) => DAILY_BASE_OFFER_TYPES.has(offer.offerType ?? -1))
    .map(([offerId]) => offerId);
  if (ids.length === 0) {
    throw new Error("No Tier 0 daily offers (offerType 1-4) were found.");
  }
  return ids;
};

const collectTierOffers = (offers: Record<string, Offer>): Record<number, string> => {
  const result: Record<number, string> = {};
  for (const [tier, offerType] of TIER_TYPE_MAP.entries()) {
    const entry = Object.entries(offers).find(
      ([, offer]) => offer.offerType === offerType,
    );
    if (!entry) {
      throw new Error(`Missing Tier ${tier} offer (offerType ${offerType}).`);
    }
    result[tier] = entry[0];
  }
  return result;
};

const collectFlashOffers = (
  offers: Record<string, Offer>,
): Partial<Record<SpecialOfferTriggerType, string>> => {
  const result: Partial<Record<SpecialOfferTriggerType, string>> = {};
  for (const [offerId, offer] of Object.entries(offers)) {
    const trigger = FLASH_TRIGGER_BY_TYPE.get(offer.offerType ?? -1);
    if (trigger) {
      result[trigger] = offerId;
    }
  }
  return result;
};

export const buildOfferLadderIndex = (
  offers: Record<string, Offer>,
): OfferLadderIndex => {
  const starter = resolveStarterOffer(offers);
  return {
    starterOfferId: starter.id,
    starterValidityMs: starter.validityMs,
    dailyBaseOfferIds: collectDailyBaseOffers(offers),
    tierOfferIds: collectTierOffers(offers),
    flashOfferIds: collectFlashOffers(offers),
  };
};

export const loadOfferLadderIndex = async (): Promise<OfferLadderIndex> => {
  const offers = await getOffersCatalog();
  return buildOfferLadderIndex(offers);
};
