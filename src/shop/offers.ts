import { HttpsError, onCall } from "firebase-functions/v2/https";

import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import {
  ActiveOffers,
  ActiveStarterOffer,
} from "../shared/types.js";
import {
  defaultDailyState,
  normaliseActiveOffers,
  pruneExpiredSpecialOffers,
  activeOffersRef,
  writeActiveOffers,
} from "./offerState.js";
import {
  DAY_MS,
  loadOfferLadderIndex,
  OfferLadderIndex,
} from "./offerCatalog.js";

const DAILY_NO_OFFER_PROBABILITY = 0.2;
const clampTier = (tier: number): number => {
  if (!Number.isFinite(tier)) {
    return 0;
  }
  return Math.max(0, Math.min(4, Math.floor(tier)));
};

const resolveNextTier = (previousTier: number, purchased: boolean): number => {
  if (purchased) {
    return Math.min(4, previousTier + 1);
  }
  return Math.max(0, previousTier - 2);
};

const selectDailyOfferId = (
  tier: number,
  index: OfferLadderIndex,
): string | null => {
  if (tier > 0) {
    const offerId = index.tierOfferIds[tier];
    if (!offerId) {
      throw new HttpsError(
        "failed-precondition",
        `Tier ${tier} offer is not configured.`,
      );
    }
    return offerId;
  }
  if (Math.random() < DAILY_NO_OFFER_PROBABILITY) {
    return null;
  }
  const ids = index.dailyBaseOfferIds;
  if (ids.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      "No Tier 0 daily offers available.",
    );
  }
  const randomIndex = Math.floor(Math.random() * ids.length);
  return ids[randomIndex];
};

const createStarterState = (
  index: OfferLadderIndex,
  now: number,
): ActiveStarterOffer => ({
  offerId: index.starterOfferId,
  expiresAt: now + index.starterValidityMs,
});

const ensureDailyState = (state: ActiveOffers): void => {
  if (!state.daily) {
    state.daily = defaultDailyState();
  }
};

// Client must call this on App Boot to hydrate the ActiveOffers document.
export const getDailyOffers = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const ladderIndex = await loadOfferLadderIndex();
  const now = Date.now();

  const result = await db.runTransaction(async (transaction) => {
    const ref = activeOffersRef(uid);
    const snapshot = await transaction.get(ref);
    const state = normaliseActiveOffers(snapshot.data());
    ensureDailyState(state);

    let mutated = false;

    const filteredSpecial = pruneExpiredSpecialOffers(state.special, now);
    if (filteredSpecial.length !== state.special.length) {
      state.special = filteredSpecial;
      mutated = true;
    }

    if (state.starter && state.starter.expiresAt <= now) {
      state.starter = undefined;
      mutated = true;
    }

    if (
      !state.starter &&
      (state.daily.generatedAt ?? 0) === 0
    ) {
      state.starter = createStarterState(ladderIndex, now);
      mutated = true;
    }

    if (state.daily.expiresAt <= now) {
      const previousTier = clampTier(state.daily.tier);
      const nextTier = resolveNextTier(previousTier, state.daily.isPurchased);
      const nextOfferId = selectDailyOfferId(nextTier, ladderIndex);
      state.daily = {
        offerId: nextOfferId,
        tier: nextTier,
        expiresAt: now + DAY_MS,
        isPurchased: false,
        generatedAt: now,
      };
      mutated = true;
    }

    if (mutated || !snapshot.exists) {
      const writer = writeActiveOffers(transaction, uid);
      writer(state, now);
    }

    return state;
  });

  return result;
});
