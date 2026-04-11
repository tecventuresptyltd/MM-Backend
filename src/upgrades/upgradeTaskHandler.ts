/**
 * Cloud Tasks Handler for Instant Upgrade Completion
 *
 * Instead of polling every 2 minutes, Cloud Tasks fires this handler
 * at the EXACT completesAt timestamp so upgrades complete within seconds.
 *
 * The existing 2-minute poller in upgradeScheduler.ts remains as a safety net.
 *
 * @module upgrades/upgradeTaskHandler
 */

import { onTaskDispatched } from "firebase-functions/v2/tasks";
import * as logger from "firebase-functions/logger";
import { REGION } from "../shared/region.js";
import { UpgradeCompletionEntry } from "../shared/typesV2.js";
import { processUpgradeCompletionEntry, buildQueueDocId } from "./upgradeScheduler.js";
import { db } from "../shared/firestore.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Path to the completion queue collection */
const COMPLETION_QUEUE_PATH = "System/Upgrades/CompletionQueue";

// ─────────────────────────────────────────────────────────────────────────────
// Task Payload
// ─────────────────────────────────────────────────────────────────────────────

export interface UpgradeTaskPayload {
    uid: string;
    upgradeType: "carEvolution" | "spellResearch";
    targetId: string;
    targetLevel: number;
    completesAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloud Tasks Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles upgrade completion tasks dispatched by Cloud Tasks.
 * Fired at the exact completesAt timestamp for near-instant completion.
 *
 * Retry policy: Cloud Tasks will retry on failure with exponential backoff.
 * The handler is idempotent — if the upgrade was already completed (by the
 * poller safety net or a manual claim), it gracefully no-ops.
 */
export const completeUpgradeTask = onTaskDispatched(
    {
        region: REGION,
        retryConfig: {
            maxAttempts: 5,
            minBackoffSeconds: 10,
            maxBackoffSeconds: 120,
            maxDoublings: 3,
        },
        rateLimits: {
            maxConcurrentDispatches: 50,
            maxDispatchesPerSecond: 50,
        },
        memory: "256MiB",
        minInstances: 1, // Keep 1 instance warm to eliminate the 15-20 second cold start delay
    },
    async (request) => {
        const payload = request.data as UpgradeTaskPayload;
        const { uid, upgradeType, targetId, targetLevel, completesAt } = payload;

        logger.info(
            `[upgradeTask] Processing ${upgradeType} completion: uid=${uid} target=${targetId} ` +
            `targetLevel=${targetLevel} completesAt=${new Date(completesAt).toISOString()}`,
        );

        // Read the queue doc to build the full UpgradeCompletionEntry
        const docId = buildQueueDocId(uid, upgradeType, targetId);
        const queueDoc = await db.collection(COMPLETION_QUEUE_PATH).doc(docId).get();

        if (!queueDoc.exists) {
            // Already processed (by poller safety net or manual claim) — graceful no-op
            logger.info(
                `[upgradeTask] Queue entry already cleared for ${upgradeType}: uid=${uid} target=${targetId}. Skipping.`,
            );
            return;
        }

        const entry = queueDoc.data() as UpgradeCompletionEntry;

        const success = await processUpgradeCompletionEntry(entry);

        if (success) {
            logger.info(
                `[upgradeTask] Successfully completed ${upgradeType}: uid=${uid} target=${targetId}`,
            );
        } else {
            // Throw to trigger Cloud Tasks retry
            throw new Error(
                `[upgradeTask] Failed to process ${upgradeType} for ${uid}/${targetId}. Will retry.`,
            );
        }
    },
);
