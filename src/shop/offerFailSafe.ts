import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import { scheduleOfferTransition } from "./offerScheduler.js";
import { MainOffer } from "../shared/types.js";
import { POST_EXPIRY_COOLDOWN_MS } from "./offerState.js";

const SWEEP_FREQUENCY_MINS = 15;
const EXPIRY_BUFFER_MINS = 5;

/**
 * Sweeps for offers that are ACTIVE but have EXPIRED and missed their transition.
 * Uses a targeted CollectionGroup query (requires index).
 */
export const runOfferFailSafe = async (): Promise<{
    found: number;
    recovered: number;
    errors: number;
}> => {
    const stats = { found: 0, recovered: 0, errors: 0 };
    const now = Date.now();
    const expiryThreshold = now - (EXPIRY_BUFFER_MINS * 60 * 1000);

    try {
        // Query for stuck offers: State=Active AND ExpiresAt < (Now - 5m)
        // Requires Composite Index: CollectionGroup 'Offers' -> main.state ASC + main.expiresAt ASC
        const stuckOffersSnap = await db.collectionGroup("Offers")
            .where("main.state", "==", "active")
            .where("main.expiresAt", "<", expiryThreshold)
            .limit(500) // Safety limit
            .get();

        stats.found = stuckOffersSnap.size;

        if (stats.found === 0) {
            return stats;
        }

        logger.warn(`[offerFailSafe] Found ${stats.found} stuck active offers. Initiating recovery...`);

        const recoveryPromises = stuckOffersSnap.docs.map(async (doc) => {
            const uid = doc.ref.parent.parent?.id;
            if (!uid) {
                logger.error(`[offerFailSafe] Could not determine UID for doc ${doc.ref.path}`);
                return false;
            }

            try {
                const data = doc.data();
                const offer = data.main as MainOffer | undefined;

                if (!offer) {
                    logger.warn(`[offerFailSafe] Doc ${doc.ref.path} missing main offer data`);
                    return false;
                }

                // Double check (in case index is slightly stale)
                if (offer.state !== "active" || offer.expiresAt >= now) {
                    return false;
                }

                // Force schedule the transition
                // We use the ORIGINAL formatted expiration time to respect the timeline
                // But if it's super old, the scheduler will just process it immediately
                await scheduleOfferTransition(
                    uid,
                    offer.expiresAt,
                    "offer_expired",
                    offer.tier
                );

                logger.info(`[offerFailSafe] Recovered specific stuck offer for ${uid} (Expired: ${new Date(offer.expiresAt).toISOString()})`);
                return true;
            } catch (err) {
                logger.error(`[offerFailSafe] Failed to recover ${uid}:`, err);
                return false;
            }
        });

        const results = await Promise.allSettled(recoveryPromises);
        results.forEach(res => {
            if (res.status === "fulfilled" && res.value) stats.recovered++;
            else stats.errors++; // Count false (skipped) as error? No, only exceptions. simplified here.
        });

        return stats;

    } catch (error) {
        logger.error("[offerFailSafe] Fatal error in query (Missing Index?):", error);
        throw error;
    }
};

/**
 * Scheduled job to catch stuck offers.
 */
export const offerFailSafeJob = {
    process: onSchedule(
        {
            region: REGION,
            schedule: `every ${SWEEP_FREQUENCY_MINS} minutes`,
            timeZone: "Etc/UTC",
            timeoutSeconds: 300,
            memory: "256MiB",
        },
        async () => {
            logger.info("[offerFailSafe] Starting fail-safe sweep");
            const stats = await runOfferFailSafe();
            logger.info("[offerFailSafe] Sweep completed", stats);
        }
    )
};
