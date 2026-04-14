import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import { MainOffer } from "../shared/types.js";
import {
    ACTIVE_OFFERS_PATH,
    OFFER_STATE_PATH,
    OFFER_VALIDITY_MS,
    POST_EXPIRY_COOLDOWN_MS,
    POST_PURCHASE_DELAY_MS,
    normaliseActiveOffers,
    pruneExpiredSpecialOffers,
    writeActiveOffersV2,
} from "./offerState.js";
import { loadOfferSlotIndex, OfferSlotIndex } from "./offerCatalog.js";

const BATCH_SIZE = 500;
const TRANSITION_QUEUE_PATH = "System/Offers/TransitionQueue";

export interface OfferTransition {
    uid: string;
    category: string;
    transitionAt: number;
    transitionType: "cooldown_end" | "purchase_delay_end" | "offer_expired";
    createdAt: number;
    retryCount?: number;
}

export const scheduleOfferTransition = async (
    uid: string,
    category: string,
    transitionAt: number,
    transitionType: OfferTransition["transitionType"],
): Promise<void> => {
    const transitionDoc: OfferTransition = {
        uid,
        category,
        transitionAt,
        transitionType,
        createdAt: Date.now(),
    };
    await db.collection(TRANSITION_QUEUE_PATH).doc(`${uid}_${category}`).set(transitionDoc);
};

export const cancelScheduledTransition = async (uid: string, category: string): Promise<void> => {
    await db.collection(TRANSITION_QUEUE_PATH).doc(`${uid}_${category}`).delete();
};

export const selectOfferForSlot = (
    index: OfferSlotIndex,
    category: string,
): { offerId: string } => {
    const ids = index[`${category}OfferIds` as keyof OfferSlotIndex] as string[];
    if (!ids || ids.length === 0) {
        throw new Error(`No offers configured for ${category} in catalog.`);
    }
    const randomIndex = Math.floor(Math.random() * ids.length);
    return { offerId: ids[randomIndex] };
};

export const createSlotOffer = (category: string, index: OfferSlotIndex, now: number): MainOffer => {
    const { offerId } = selectOfferForSlot(index, category);
    return {
        category,
        offerId,
        expiresAt: now + OFFER_VALIDITY_MS,
        tier: 0,
        state: "active",
        isStarter: false,
    };
};

interface TransitionResult {
    scheduleCooldownEnd?: { cooldownEndsAt: number };
    scheduleOfferExpiry?: { expiresAt: number };
}

const processPlayerTransition = async (
    transition: OfferTransition,
    slotIndex: OfferSlotIndex,
    now: number,
): Promise<boolean> => {
    const { uid, category, retryCount = 0 } = transition;
    const docId = `${uid}_${category}`;

    if (retryCount >= 5) {
        logger.error(`[offerScheduler] DROPPING transition for ${docId} after failures.`);
        try {
            await db.collection(TRANSITION_QUEUE_PATH).doc(docId).delete();
        } catch (e) {}
        return false;
    }

    try {
        const result = await db.runTransaction(async (transaction): Promise<TransitionResult> => {
            const activeRef = db.doc(ACTIVE_OFFERS_PATH(uid));
            const queueRef = db.collection(TRANSITION_QUEUE_PATH).doc(docId);

            const [activeSnap] = await Promise.all([
                transaction.get(activeRef),
            ]);

            const activeOffers = normaliseActiveOffers(activeSnap.data());
            if (!activeOffers.rotating) activeOffers.rotating = [];
            
            const rIndex = activeOffers.rotating.findIndex(r => r.category === category);

            if (transition.transitionType === "purchase_delay_end") {
                const newOffer = createSlotOffer(category, slotIndex, now);
                if (rIndex >= 0) {
                    activeOffers.rotating[rIndex] = newOffer;
                } else {
                    activeOffers.rotating.push(newOffer);
                }
                
                const prunedSpecial = pruneExpiredSpecialOffers(activeOffers.special, now);
                activeOffers.special = prunedSpecial;

                writeActiveOffersV2(transaction, uid, activeOffers, now);
                transaction.delete(queueRef);

                return { scheduleOfferExpiry: { expiresAt: newOffer.expiresAt } };
            }

            if (rIndex < 0) {
                transaction.delete(queueRef);
                return {};
            }
            
            const currentOffer = activeOffers.rotating[rIndex];

            if (transition.transitionType === "offer_expired") {
                if (currentOffer.state !== "active") {
                    transaction.delete(queueRef);
                    return {};
                }

                const cooldownEndsAt = now + POST_EXPIRY_COOLDOWN_MS;
                const cooldownOffer: MainOffer = {
                    ...currentOffer,
                    state: "cooldown",
                    nextOfferAt: cooldownEndsAt,
                };

                activeOffers.rotating[rIndex] = cooldownOffer;
                writeActiveOffersV2(transaction, uid, activeOffers, now);
                transaction.delete(queueRef);
                return { scheduleCooldownEnd: { cooldownEndsAt } };
            }

            if (transition.transitionType === "cooldown_end" && currentOffer.state !== "cooldown") {
                transaction.delete(queueRef);
                return {};
            }

            const newOffer = createSlotOffer(category, slotIndex, now);
            activeOffers.rotating[rIndex] = newOffer;
            writeActiveOffersV2(transaction, uid, activeOffers, now);
            transaction.delete(queueRef);

            return { scheduleOfferExpiry: { expiresAt: newOffer.expiresAt } };
        });

        if (result.scheduleCooldownEnd) {
            await scheduleOfferTransition(uid, category, result.scheduleCooldownEnd.cooldownEndsAt, "cooldown_end");
        }
        if (result.scheduleOfferExpiry) {
            await scheduleOfferTransition(uid, category, result.scheduleOfferExpiry.expiresAt, "offer_expired");
        }
        return true;
    } catch (error) {
        await db.collection(TRANSITION_QUEUE_PATH).doc(docId).update({ retryCount: retryCount + 1 }).catch(() => {});
        return false;
    }
};

export const processOfferTransitions = async () => {
    const stats = { processed: 0, errors: 0 };
    const now = Date.now();
    try {
        const slotIndex = await loadOfferSlotIndex();
        const dueTransitions = await db.collection(TRANSITION_QUEUE_PATH)
            .where("transitionAt", "<=", now).limit(BATCH_SIZE).get();
        
        const transitions = dueTransitions.docs.map(doc => doc.data() as OfferTransition);
        for (let i = 0; i < transitions.length; i += 10) {
            const batch = transitions.slice(i, i + 10);
            const results = await Promise.allSettled(batch.map(t => processPlayerTransition(t, slotIndex, now)));
            results.forEach((r) => { if (r.status === "fulfilled" && r.value) stats.processed++; else stats.errors++; });
        }
        return stats;
    } catch (error) {
        throw error;
    }
};

export const offerTransitionJob = {
    process: onSchedule({ region: REGION, schedule: "every 5 minutes", timeZone: "Etc/UTC", timeoutSeconds: 300, memory: "256MiB" },
        async () => { await processOfferTransitions(); })
};
