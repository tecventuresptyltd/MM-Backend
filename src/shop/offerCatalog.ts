import { getOffersCatalog } from "../core/config.js";
import { Offer, SpecialOfferTriggerType } from "../shared/types.js";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export type FlashOfferIds = Partial<Record<SpecialOfferTriggerType, string>>;

export interface OfferSlotIndex {
  micro_hookOfferIds: string[];
  sweet_spotOfferIds: string[];
  whaleOfferIds: string[];
  flashOfferIds: FlashOfferIds;
}

const collectSlotOffers = (offers: Record<string, Offer>, targetCategories: string[]): string[] => {
  const ids = Object.entries(offers)
    .filter(([, offer]) => offer.category && targetCategories.includes(offer.category))
    .map(([offerId]) => offerId);
  return ids;
};

export const buildOfferMultiSlotIndex = (
  offers: Record<string, Offer>,
): OfferSlotIndex => {
  const flashOfferIds: FlashOfferIds = {};

  for (const [offerId, offer] of Object.entries(offers)) {
    if (offer.category === "flash_missing_crate") {
      flashOfferIds.flash_missing_crate = offerId;
    }
  }

  return {
    micro_hookOfferIds: collectSlotOffers(offers, ["micro_hook"]),
    sweet_spotOfferIds: collectSlotOffers(offers, ["sweet_spot", "mid_tier"]),
    whaleOfferIds: collectSlotOffers(offers, ["whale"]),
    flashOfferIds,
  };
};

export const loadOfferSlotIndex = async (): Promise<OfferSlotIndex> => {
  const offers = await getOffersCatalog();
  return buildOfferMultiSlotIndex(offers);
};
