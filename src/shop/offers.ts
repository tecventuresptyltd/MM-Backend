import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { REGION } from "../shared/region.js";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { db } from "../shared/firestore.js";
import {
  activeOffersRef,
  offerStateRef,
  normaliseActiveOffers,
  normaliseOfferFlowState,
  pruneExpiredSpecialOffers,
  writeActiveOffersV2,
  writeOfferFlowState,
  POST_EXPIRY_COOLDOWN_MS,
} from "./offerState.js";
import { loadOfferSlotIndex } from "./offerCatalog.js";
import { scheduleOfferTransition, createSlotOffer } from "./offerScheduler.js";

export const maybeGenerateStarterOffer = async (uid: string): Promise<boolean> => {
  const now = Date.now();
  try {
    const slotIndex = await loadOfferSlotIndex();
    const result = await db.runTransaction(async (transaction) => {
      const activeRef = activeOffersRef(uid);
      const stateRef = offerStateRef(uid);

      const [activeSnap, stateSnap] = await Promise.all([
        transaction.get(activeRef),
        transaction.get(stateRef),
      ]);

      const flowState = normaliseOfferFlowState(stateSnap.data());
      if (flowState.starterShown) return null;

      const activeOffers = normaliseActiveOffers(activeSnap.data());
      
      activeOffers.rotating = [
        createSlotOffer("micro_hook", slotIndex, now),
        createSlotOffer("sweet_spot", slotIndex, now),
        createSlotOffer("whale", slotIndex, now),
      ];

      writeActiveOffersV2(transaction, uid, activeOffers, now);
      writeOfferFlowState(transaction, uid, { starterShown: true }, now);

      return activeOffers;
    });

    if (result && result.rotating) {
      for (const offer of result.rotating) {
        if (offer.state === "active" && offer.category) {
          await scheduleOfferTransition(uid, offer.category, offer.expiresAt, "offer_expired").catch(e => logger.warn(e));
        }
      }
      return true;
    }
    return false;
  } catch (error) {
    logger.error(`Failed to generate rotating offers for ${uid}`, error);
    return false;
  }
};

export const getDailyOffers = onCall(callableOptions({ minInstances: getMinInstances(false), memory: "512MiB", cpu: 1, concurrency: 80 }, true), async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "User must be authenticated.");

  const now = Date.now();
  const slotIndex = await loadOfferSlotIndex();

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

    const prunedSpecial = pruneExpiredSpecialOffers(activeOffers.special, now);
    if (prunedSpecial.length !== activeOffers.special.length) {
      activeOffers.special = prunedSpecial;
      mutated = true;
    }

    if (!flowState.starterShown || !activeOffers.rotating || activeOffers.rotating.length === 0) {
      activeOffers.rotating = [
        createSlotOffer("micro_hook", slotIndex, now),
        createSlotOffer("sweet_spot", slotIndex, now),
        createSlotOffer("whale", slotIndex, now),
      ];
      mutated = true;
      if (!flowState.starterShown) {
        writeOfferFlowState(transaction, uid, { starterShown: true }, now);
      }
    } else {
      const requiredSlots = ["micro_hook", "sweet_spot", "whale"];
      
      // Check existing slots or missing slots
      const existingSlots = new Set(activeOffers.rotating.map(r => r.category));
      for (const rSlot of requiredSlots) {
        if (!existingSlots.has(rSlot)) {
          activeOffers.rotating.push(createSlotOffer(rSlot, slotIndex, now));
          mutated = true;
        }
      }

      for (let i = 0; i < activeOffers.rotating.length; i++) {
        const slot = activeOffers.rotating[i];
        if (!slot.category) continue;
        
        if (slot.state === "active" && slot.expiresAt <= now) {
          activeOffers.rotating[i] = {
            ...slot,
            state: "cooldown",
            nextOfferAt: slot.expiresAt + POST_EXPIRY_COOLDOWN_MS,
          };
          mutated = true;
        } else if ((slot.state === "cooldown" || slot.state === "purchase_delay") && (slot.nextOfferAt ?? 0) <= now) {
          activeOffers.rotating[i] = createSlotOffer(slot.category, slotIndex, now);
          mutated = true;
        }
      }
    }

    if (mutated || !activeSnap.exists) {
      writeActiveOffersV2(transaction, uid, activeOffers, now);
    }

    return activeOffers;
  });

  if (result.rotating) {
    for (const offer of result.rotating) {
      if (!offer.category) continue;
      if (offer.state === "cooldown" && offer.nextOfferAt) {
        await scheduleOfferTransition(uid, offer.category, offer.nextOfferAt, "cooldown_end").catch(e => logger.warn(e));
      } else if (offer.state === "active" && offer.expiresAt > now) {
        await scheduleOfferTransition(uid, offer.category, offer.expiresAt, "offer_expired").catch(e => logger.warn(e));
      }
    }
  }

  return result;
});
