import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import { MainOffer } from "../shared/types.js";
import { callableOptions } from "../shared/callableOptions.js";
import {
    OFFER_VALIDITY_MS,
    normaliseActiveOffers,
    normaliseOfferFlowState,
    writeActiveOffersV2,
    writeOfferFlowState,
} from "./offerState.js";
import { loadOfferLadderIndex, OfferLadderIndex } from "./offerCatalog.js";

// ─────────────────────────────────────────────────────────────────────────────
// Offer Selection
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

const createDailyOffer = (index: OfferLadderIndex, now: number): MainOffer => {
    const { offerId, offerType } = selectRandomDailyOffer(index);
    return {
        offerId,
        offerType,
        expiresAt: now + OFFER_VALIDITY_MS,
        tier: 0,
        state: "active",
        isStarter: false,
    };
};

// ─────────────────────────────────────────────────────────────────────────────
// Safety Net Logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if a player needs offer restoration.
 * Players need restoration if:
 * 1. They have no main offer at all
 * 2. They're not in a valid state (active/cooldown/purchase_delay)
 */
const needsOfferRestoration = (activeOffers: any, flowState: any, now: number): boolean => {
    // No main offer at all
    if (!activeOffers.main) {
        return true;
    }

    const main = activeOffers.main;

    // Invalid state
    if (!["active", "cooldown", "purchase_delay"].includes(main.state)) {
        logger.warn(`Invalid offer state: ${main.state}`);
        return true;
    }

    // Stuck in cooldown/delay for too long (>48 hours)
    if (main.state !== "active" && main.nextOfferAt) {
        const timeSinceTransition = now - main.nextOfferAt;
        if (timeSinceTransition > 48 * 60 * 60 * 1000) {
            logger.warn(`Offer stuck in ${main.state} for >48h`);
            return true;
        }
    }

    return false;
};

/**
 * Restore offers for a single player.
 */
const restorePlayerOffers = async (
    uid: string,
    ladderIndex: OfferLadderIndex,
    now: number,
): Promise<boolean> => {
    try {
        return await db.runTransaction(async (transaction) => {
            const activeRef = db.doc(`Players/${uid}/Offers/Active`);
            const stateRef = db.doc(`Players/${uid}/Offers/State`);

            const [activeSnap, stateSnap] = await Promise.all([
                transaction.get(activeRef),
                transaction.get(stateRef),
            ]);

            const activeOffers = normaliseActiveOffers(activeSnap.data());
            const flowState = normaliseOfferFlowState(stateSnap.data());

            // Check if restoration needed
            if (!needsOfferRestoration(activeOffers, flowState, now)) {
                return false;
            }

            logger.info(`[offerSafetyNet] Restoring offers for player ${uid}`);

            // Create fresh daily offer at current tier
            const restoredOffer = createDailyOffer(ladderIndex, now);
            restoredOffer.tier = flowState.tier; // Maintain their tier

            // Preserve special offers
            const special = activeOffers.special || [];

            writeActiveOffersV2(transaction, uid, {
                main: restoredOffer,
                special,
            }, now);

            // Ensure flow state exists
            if (!stateSnap.exists) {
                writeOfferFlowState(transaction, uid, {
                    starterEligible: false,
                    starterShown: true,
                    starterPurchased: false,
                    tier: flowState.tier,
                    offersPurchased: flowState.offersPurchased,
                    totalIapPurchases: flowState.totalIapPurchases,
                }, now);
            }

            return true;
        });
    } catch (error) {
        logger.error(`[offerSafetyNet] Failed to restore offers for ${uid}:`, error);
        return false;
    }
};

/**
 * Scan all players and restore offers for those who need it.
 * Runs daily as a safety net.
 */
export const runOfferSafetyCheck = async (): Promise<{
    scanned: number;
    restored: number;
    errors: number;
}> => {
    const stats = { scanned: 0, restored: 0, errors: 0 };
    const now = Date.now();

    try {
        const ladderIndex = await loadOfferLadderIndex();

        // Query all player profiles to get UIDs
        // We use Profile collection as the source of truth for active players
        const profilesSnap = await db
            .collectionGroup("Profile")
            .where("__name__", "==", "Profile")
            .get();

        logger.info(`[offerSafetyNet] Found ${profilesSnap.size} players to check`);

        // Process in batches
        const BATCH_SIZE = 20;
        const playerDocs = profilesSnap.docs;

        for (let i = 0; i < playerDocs.length; i += BATCH_SIZE) {
            const batch = playerDocs.slice(i, i + BATCH_SIZE);

            const results = await Promise.allSettled(
                batch.map(async (doc) => {
                    const uid = doc.ref.parent.parent?.id;
                    if (!uid) {
                        logger.warn(`[offerSafetyNet] Could not extract UID from ${doc.ref.path}`);
                        return { restored: false, error: false };
                    }

                    stats.scanned++;

                    const restored = await restorePlayerOffers(uid, ladderIndex, now);
                    return { restored, error: false };
                })
            );

            results.forEach((result) => {
                if (result.status === "fulfilled") {
                    if (result.value.restored) {
                        stats.restored++;
                    }
                    if (result.value.error) {
                        stats.errors++;
                    }
                } else {
                    stats.errors++;
                }
            });

            // Progress logging every 100 players
            if (stats.scanned % 100 === 0) {
                logger.info(`[offerSafetyNet] Progress: ${stats.scanned} scanned, ${stats.restored} restored`);
            }
        }

        return stats;
    } catch (error) {
        logger.error("[offerSafetyNet] Fatal error during safety check:", error);
        throw error;
    }
};

/**
 * Scheduled function that runs daily to catch any players who fell out of the offer cycle.
 * This is a safety net - under normal circumstances, players should never need restoration.
 */
export const offerSafetyNetJob = onSchedule(
    {
        region: REGION,
        schedule: "every day 02:00", // Runs at 2 AM UTC daily (low-traffic time)
        timeZone: "Etc/UTC",
        timeoutSeconds: 540, // 9 minutes
        memory: "512MiB",
    },
    async () => {
        logger.info("[offerSafetyNet] Starting daily offer safety check");

        const stats = await runOfferSafetyCheck();

        logger.info("[offerSafetyNet] Daily safety check completed", stats);

        // Alert if many restorations (indicates a problem)
        if (stats.restored > 10) {
            logger.warn(
                `[offerSafetyNet] High restoration count: ${stats.restored} players needed restoration. ` +
                "This may indicate a bug in the offer flow system."
            );
        }
    }
);

/**
 * Manual callable function to trigger the safety check on-demand.
 * Useful for:
 * - Running immediately after deployment
 * - Testing the safety net
 * - Emergency restorations
 * 
 * IMPORTANT: Only callable by authenticated users (add admin check if needed)
 */
export const runOfferSafetyNet = onCall(
    callableOptions({
        timeoutSeconds: 540,
        memory: "512MiB",
    }),
    async (request) => {
        const uid = request.auth?.uid;
        if (!uid) {
            throw new HttpsError("unauthenticated", "Must be authenticated to run safety check");
        }

        logger.info(`[offerSafetyNet] Manual safety check triggered by ${uid}`);

        const stats = await runOfferSafetyCheck();

        logger.info("[offerSafetyNet] Manual safety check completed", stats);

        return {
            success: true,
            ...stats,
            message: `Scanned ${stats.scanned} players, restored ${stats.restored} offers`,
        };
    }
);
