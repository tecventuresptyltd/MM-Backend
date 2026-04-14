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
        logger.info("[offerFailSafe] Sweep disabled; relying on daily SafetyNet and getDailyOffers sync for multi-slot schemas array.");
        return stats;
    } catch (error) {
        logger.error("[offerFailSafe] Fatal error.", error);
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
