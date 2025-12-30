import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import { MainOffer, OfferFlowState } from "../shared/types.js";
import {
  activeOffersRef,
  offerStateRef,
  normaliseActiveOffers,
  normaliseOfferFlowState,
  pruneExpiredSpecialOffers,
  writeActiveOffersV2,
  writeOfferFlowState,
  STARTER_VALIDITY_MS,
  OFFER_VALIDITY_MS,
  POST_EXPIRY_COOLDOWN_MS,
  STARTER_RACE_THRESHOLD,
} from "./offerState.js";
import { loadOfferLadderIndex, OfferLadderIndex } from "./offerCatalog.js";
import { scheduleOfferTransition } from "./offerScheduler.js";

// ─────────────────────────────────────────────────────────────────────────────
// Offer Selection Logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Select a random daily offer ID (tier 0).
 * Always returns an offer (0% no-offer rate, 25% for each of 4 offers).
 */
const selectRandomDailyOffer = (index: OfferLadderIndex): { offerId: string; offerType: number } => {
  const ids = index.dailyBaseOfferIds;
  if (ids.length === 0) {
    throw new HttpsError("failed-precondition", "No daily offers configured in catalog.");
  }
  const randomIndex = Math.floor(Math.random() * ids.length);
  const offerId = ids[randomIndex];
  // Daily offers have offerType 1-4
  return { offerId, offerType: randomIndex + 1 };
};

/**
 * Select the appropriate offer for a given tier.
 */
const selectOfferForTier = (
  tier: number,
  index: OfferLadderIndex,
): { offerId: string; offerType: number } => {
  if (tier === 0) {
    return selectRandomDailyOffer(index);
  }

  const offerId = index.tierOfferIds[tier];
  if (!offerId) {
    throw new HttpsError("failed-precondition", `Tier ${tier} offer not configured in catalog.`);
  }

  // Tier 1-4 map to offerType 5-8
  return { offerId, offerType: tier + 4 };
};

/**
 * Create a starter offer for the main slot.
 */
const createStarterOffer = (index: OfferLadderIndex, now: number): MainOffer => ({
  offerId: index.starterOfferId,
  offerType: 0,
  expiresAt: now + STARTER_VALIDITY_MS,
  tier: 0,
  state: "active",
  isStarter: true,
});

/**
 * Create a daily/ladder offer for the main slot.
 */
const createTierOffer = (tier: number, index: OfferLadderIndex, now: number): MainOffer => {
  const { offerId, offerType } = selectOfferForTier(tier, index);
  return {
    offerId,
    offerType,
    expiresAt: now + OFFER_VALIDITY_MS,
    tier,
    state: "active",
    isStarter: false,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Starter Offer Trigger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a player is eligible for the starter offer and generate it if so.
 * Called after race completion when totalRaces >= STARTER_RACE_THRESHOLD.
 */
export const maybeGenerateStarterOffer = async (uid: string): Promise<boolean> => {
  const now = Date.now();

  try {
    const ladderIndex = await loadOfferLadderIndex();

    return await db.runTransaction(async (transaction) => {
      const activeRef = activeOffersRef(uid);
      const stateRef = offerStateRef(uid);

      const [activeSnap, stateSnap] = await Promise.all([
        transaction.get(activeRef),
        transaction.get(stateRef),
      ]);

      const flowState = normaliseOfferFlowState(stateSnap.data());

      // Already shown starter? Don't show again
      if (flowState.starterShown) {
        return false;
      }

      // Check if there's already an active main offer
      const activeOffers = normaliseActiveOffers(activeSnap.data());
      if (activeOffers.main && activeOffers.main.state === "active") {
        return false;
      }

      // Generate starter offer
      const starterOffer = createStarterOffer(ladderIndex, now);
      const prunedSpecial = pruneExpiredSpecialOffers(activeOffers.special, now);

      writeActiveOffersV2(transaction, uid, {
        main: starterOffer,
        special: prunedSpecial,
      }, now);

      writeOfferFlowState(transaction, uid, {
        starterEligible: true,
        starterShown: true,
        tier: 0,
      }, now);

      logger.info(`[offers] Generated starter offer for player ${uid}`);
      return true;
    });
  } catch (error) {
    logger.error(`[offers] Failed to generate starter offer for ${uid}:`, error);
    return false;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Get Daily Offers (Legacy API - now just reads current state)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Client callable to get current active offers.
 * In the new architecture, this primarily reads the current state.
 * Offer generation is handled by:
 * - maybeGenerateStarterOffer (after race completion)
 * - offerTransitionJob (scheduled, handles cooldown/delay transitions)
 */
export const getDailyOffers = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const now = Date.now();
  const ladderIndex = await loadOfferLadderIndex();

  const result = await db.runTransaction(async (transaction) => {
    const activeRef = activeOffersRef(uid);
    const stateRef = offerStateRef(uid);

    const [activeSnap, stateSnap] = await Promise.all([
      transaction.get(activeRef),
      transaction.get(stateRef),
    ]);

    const activeOffers = normaliseActiveOffers(activeSnap.data());
    const flowState = normaliseOfferFlowState(stateSnap.data());
    let mutated = false;

    // Prune expired special offers
    const prunedSpecial = pruneExpiredSpecialOffers(activeOffers.special, now);
    if (prunedSpecial.length !== activeOffers.special.length) {
      activeOffers.special = prunedSpecial;
      mutated = true;
    }

    // Check if we need to initialize or transition main offer
    if (!activeOffers.main) {
      // No main offer exists - initialize based on state
      if (!flowState.starterShown) {
        // New player without starter - wait for race completion trigger
        // Just initialize the document structure
        mutated = true;
      } else {
        // Starter was shown, generate first daily offer
        activeOffers.main = createTierOffer(flowState.tier, ladderIndex, now);
        mutated = true;
      }
    } else {
      // Main offer exists - check for transitions
      const main = activeOffers.main;

      // Handle expired active offer -> cooldown
      if (main.state === "active" && main.expiresAt <= now) {
        const newTier = Math.max(0, main.tier - 2); // Drop 2 tiers on expiry
        const cooldownEndsAt = main.expiresAt + POST_EXPIRY_COOLDOWN_MS; // From EXPIRY, not now

        activeOffers.main = {
          ...main,
          state: "cooldown",
          nextOfferAt: cooldownEndsAt,
          tier: newTier,
        };
        mutated = true;
      }

      // Handle cooldown -> new active offer
      // NOTE: This is intentional fallback - if scheduler is delayed/down, client still gets offers
      if (main.state === "cooldown" && (main.nextOfferAt ?? 0) <= now) {
        activeOffers.main = createTierOffer(main.tier, ladderIndex, now);
        mutated = true;
      }

      // Handle purchase_delay -> new active offer
      // NOTE: This is intentional fallback - if scheduler is delayed/down, client still gets offers
      if (main.state === "purchase_delay" && (main.nextOfferAt ?? 0) <= now) {
        activeOffers.main = createTierOffer(main.tier, ladderIndex, now);
        mutated = true;
      }
    }

    // Write if anything changed
    if (mutated || !activeSnap.exists) {
      writeActiveOffersV2(transaction, uid, {
        main: activeOffers.main ?? null,
        special: activeOffers.special,
      }, now);

      // Sync tier to flow state if main exists
      if (activeOffers.main) {
        writeOfferFlowState(transaction, uid, {
          tier: activeOffers.main.tier,
        }, now);
      }
    }

    return {
      main: activeOffers.main ?? null,
      special: activeOffers.special,
      updatedAt: now,
    };
  });

  // Schedule transition if offer entered cooldown (outside transaction)
  if (result.main?.state === "cooldown" && result.main.nextOfferAt) {
    try {
      await scheduleOfferTransition(
        uid,
        result.main.nextOfferAt,
        "cooldown_end",
        result.main.tier,
      );
    } catch (error) {
      logger.warn(`Failed to schedule cooldown transition for ${uid}`, error);
    }
  }

  return result;
});
