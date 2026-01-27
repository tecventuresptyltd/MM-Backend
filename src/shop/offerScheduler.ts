import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import {
    MainOffer,
    OfferFlowState,
} from "../shared/types.js";
import {
    ACTIVE_OFFERS_PATH,
    OFFER_STATE_PATH,
    OFFER_VALIDITY_MS,
    POST_EXPIRY_COOLDOWN_MS,
    normaliseActiveOffers,
    normaliseOfferFlowState,
    pruneExpiredSpecialOffers,
    writeActiveOffersV2,
    writeOfferFlowState,
} from "./offerState.js";
import { loadOfferLadderIndex, OfferLadderIndex } from "./offerCatalog.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum transitions to process per scheduler run */
const BATCH_SIZE = 500;

/** Path to transition queue collection */
const TRANSITION_QUEUE_PATH = "System/Offers/TransitionQueue";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface OfferTransition {
    uid: string;
    transitionAt: number;
    transitionType: "cooldown_end" | "purchase_delay_end" | "offer_expired";
    tier: number;
    createdAt: number;
    retryCount?: number;
}


// ─────────────────────────────────────────────────────────────────────────────
// Queue Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schedule a transition for a player's offer.
 * Called when offer state changes to cooldown or purchase_delay.
 */
export const scheduleOfferTransition = async (
    uid: string,
    transitionAt: number,
    transitionType: OfferTransition["transitionType"],
    tier: number,
): Promise<void> => {
    const transitionDoc: OfferTransition = {
        uid,
        transitionAt,
        transitionType,
        tier,
        createdAt: Date.now(),
    };

    await db.collection(TRANSITION_QUEUE_PATH).doc(uid).set(transitionDoc);
};

/**
 * Remove a scheduled transition (called when player purchases before transition completes).
 */
export const cancelScheduledTransition = async (uid: string): Promise<void> => {
    await db.collection(TRANSITION_QUEUE_PATH).doc(uid).delete();
};

// ─────────────────────────────────────────────────────────────────────────────
// Offer Selection Logic
// ─────────────────────────────────────────────────────────────────────────────

const selectRandomDailyOffer = (index: OfferLadderIndex): { offerId: string; offerType: number } => {
    const ids = index.dailyBaseOfferIds;
    if (ids.length === 0) {
        throw new Error("No daily offers configured in catalog.");
    }
    const randomIndex = Math.floor(Math.random() * ids.length);
    const offerId = ids[randomIndex];
    return { offerId, offerType: randomIndex + 1 };
};

const selectOfferForTier = (
    tier: number,
    index: OfferLadderIndex,
): { offerId: string; offerType: number } => {
    if (tier === 0) {
        return selectRandomDailyOffer(index);
    }

    const offerId = index.tierOfferIds[tier];
    if (!offerId) {
        throw new Error(`Tier ${tier} offer not configured in catalog.`);
    }

    return { offerId, offerType: tier + 4 };
};

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
// Transition Processing
// ─────────────────────────────────────────────────────────────────────────────

/** Result from processing a transition, indicating follow-up schedules needed */
interface TransitionResult {
    /** If set, schedule a cooldown_end transition */
    scheduleCooldownEnd?: { tier: number; cooldownEndsAt: number };
    /** If set, schedule an offer_expired transition for newly created offer */
    scheduleOfferExpiry?: { tier: number; expiresAt: number };
}

/**
 * Process a single player's offer transition.
 */
const processPlayerTransition = async (
    transition: OfferTransition,
    ladderIndex: OfferLadderIndex,
    now: number,
): Promise<boolean> => {
    const { uid, tier, retryCount = 0 } = transition;

    // FUSE BREAKER: If retried too many times, drop it to prevent blocking the queue
    if (retryCount >= 5) {
        logger.error(`[offerScheduler] DROPPING transition for ${uid} after ${retryCount} failures.`);
        try {
            await db.collection(TRANSITION_QUEUE_PATH).doc(uid).delete();
            // Optional: Write to DLQ here if we had one
        } catch (e) {
            logger.error(`[offerScheduler] Failed to clean up dropped transition for ${uid}`, e);
        }
        return false; // Considered "processed" (removed from queue)
    }

    try {
        const result = await db.runTransaction(async (transaction): Promise<TransitionResult> => {
            const activeRef = db.doc(ACTIVE_OFFERS_PATH(uid));
            const stateRef = db.doc(OFFER_STATE_PATH(uid));
            const queueRef = db.collection(TRANSITION_QUEUE_PATH).doc(uid);

            const [activeSnap, stateSnap] = await Promise.all([
                transaction.get(activeRef),
                transaction.get(stateRef),
            ]);

            const activeOffers = normaliseActiveOffers(activeSnap.data());
            const flowState = normaliseOfferFlowState(stateSnap.data());

            // For purchase_delay_end: main offer was deleted on purchase, create new one
            if (transition.transitionType === "purchase_delay_end") {
                // Generate new tier offer
                const newOffer = createTierOffer(tier, ladderIndex, now);
                const prunedSpecial = pruneExpiredSpecialOffers(activeOffers.special, now);

                writeActiveOffersV2(transaction, uid, {
                    main: newOffer,
                    special: prunedSpecial,
                }, now);

                writeOfferFlowState(transaction, uid, {
                    tier,
                }, now);

                // Delete queue entry inside transaction for atomicity
                transaction.delete(queueRef);

                // Schedule expiry for this new offer
                return { scheduleOfferExpiry: { tier, expiresAt: newOffer.expiresAt } };
            }

            // For other transitions: verify main still exists and matches state
            const main = activeOffers.main;
            if (!main) {
                // Delete stale queue entry
                transaction.delete(queueRef);
                return {};
            }

            // For offer_expired: verify offer is still active
            if (transition.transitionType === "offer_expired") {
                if (main.state !== "active") {
                    // Offer was already purchased or transitioned
                    transaction.delete(queueRef);
                    return {};
                }

                // Transition to cooldown
                const newTier = Math.max(0, main.tier - 2); // Drop 2 tiers on expiry
                const cooldownEndsAt = now + POST_EXPIRY_COOLDOWN_MS;

                const cooldownOffer: MainOffer = {
                    ...main,
                    state: "cooldown",
                    nextOfferAt: cooldownEndsAt,
                    tier: newTier,
                };

                const expiredPrunedSpecial = pruneExpiredSpecialOffers(activeOffers.special, now);
                writeActiveOffersV2(transaction, uid, {
                    main: cooldownOffer,
                    special: expiredPrunedSpecial,
                }, now);

                writeOfferFlowState(transaction, uid, {
                    tier: newTier,
                    lastOfferExpiredAt: now,
                }, now);

                // Delete queue entry - we'll schedule cooldown_end outside transaction
                transaction.delete(queueRef);

                // Mark that we need to schedule cooldown_end
                return { scheduleCooldownEnd: { tier: newTier, cooldownEndsAt } };
            }

            // Only proceed if state matches expected transition type
            if (transition.transitionType === "cooldown_end" && main.state !== "cooldown") {
                // State changed, delete stale queue entry
                transaction.delete(queueRef);
                return {};
            }

            // Generate new active offer
            const newOffer = createTierOffer(tier, ladderIndex, now);
            const prunedSpecial = pruneExpiredSpecialOffers(activeOffers.special, now);

            writeActiveOffersV2(transaction, uid, {
                main: newOffer,
                special: prunedSpecial,
            }, now);

            writeOfferFlowState(transaction, uid, {
                tier,
            }, now);

            // CRITICAL: Delete queue entry inside transaction for atomicity
            transaction.delete(queueRef);

            // Schedule expiry for this new offer
            return { scheduleOfferExpiry: { tier, expiresAt: newOffer.expiresAt } };
        });

        // Schedule follow-up transitions outside the transaction
        if (result.scheduleCooldownEnd) {
            try {
                await scheduleOfferTransition(
                    uid,
                    result.scheduleCooldownEnd.cooldownEndsAt,
                    "cooldown_end",
                    result.scheduleCooldownEnd.tier,
                );
            } catch (error) {
                logger.warn(`[offerScheduler] Failed to schedule cooldown_end for ${uid}`, error);
            }
        }

        if (result.scheduleOfferExpiry) {
            try {
                await scheduleOfferTransition(
                    uid,
                    result.scheduleOfferExpiry.expiresAt,
                    "offer_expired",
                    result.scheduleOfferExpiry.tier,
                );
            } catch (error) {
                logger.warn(`[offerScheduler] Failed to schedule offer_expired for ${uid}`, error);
            }
        }

        return true;
    } catch (error) {
        logger.error(`[offerScheduler] Failed to process transition for ${uid}:`, error);

        // RETRY LOGIC: Increment retry count instead of just failing
        try {
            await db.collection(TRANSITION_QUEUE_PATH).doc(uid).update({
                retryCount: (retryCount || 0) + 1
            });
        } catch (updateErr) {
            logger.warn(`[offerScheduler] Failed to update retry count for ${uid}`, updateErr);
        }

        return false;
    }
};


// ─────────────────────────────────────────────────────────────────────────────
// Scheduled Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process pending offer transitions from the queue.
 * Only processes players who have scheduled transitions due NOW.
 */
export const processOfferTransitions = async (): Promise<{
    processed: number;
    errors: number;
}> => {
    const stats = { processed: 0, errors: 0 };
    const now = Date.now();

    try {
        const ladderIndex = await loadOfferLadderIndex();

        // Query ONLY transitions that are due (much more efficient than collection group)
        const dueTransitions = await db
            .collection(TRANSITION_QUEUE_PATH)
            .where("transitionAt", "<=", now)
            .limit(BATCH_SIZE)
            .get();

        logger.info(`[offerScheduler] Found ${dueTransitions.size} due transitions`);

        // Process in parallel batches
        const PARALLEL_BATCH = 10;
        const transitions = dueTransitions.docs.map(doc => doc.data() as OfferTransition);

        for (let i = 0; i < transitions.length; i += PARALLEL_BATCH) {
            const batch = transitions.slice(i, i + PARALLEL_BATCH);
            const results = await Promise.allSettled(
                batch.map(t => processPlayerTransition(t, ladderIndex, now))
            );

            results.forEach((result) => {
                if (result.status === "fulfilled" && result.value) {
                    stats.processed++;
                } else {
                    stats.errors++;
                }
            });
        }

        return stats;
    } catch (error) {
        logger.error("[offerScheduler] Fatal error processing transitions:", error);
        throw error;
    }
};

/**
 * Scheduled function that processes offer transitions every 5 minutes.
 * EFFICIENT: Only queries the transition queue, not all player documents.
 */
export const offerTransitionJob = {
    process: onSchedule(
        {
            region: REGION,
            schedule: "every 5 minutes",
            timeZone: "Etc/UTC",
            timeoutSeconds: 300,
            memory: "256MiB",
        },
        async () => {
            logger.info("[offerScheduler] Starting offer transition job");
            const stats = await processOfferTransitions();
            logger.info("[offerScheduler] Offer transition job completed", stats);
        },
    ),
};
