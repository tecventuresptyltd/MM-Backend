/**
 * Upgrade Completion Scheduler
 *
 * Processes timer-based upgrades (Car Evolution + Spell Research) via a
 * centralized CompletionQueue.  Modeled on the proven offerScheduler.ts pattern.
 *
 * Collection: System/Upgrades/CompletionQueue
 * Doc ID:     {uid}_{upgradeType}_{targetId}
 * Schedule:   Every 2 minutes
 *
 * @module upgrades/upgradeScheduler
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { getFunctions } from "firebase-admin/functions";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import {
    UpgradeCompletionEntry,
    UpgradeType,
    UserPitCrewDoc,
    UserLibraryDoc,
} from "../shared/typesV2.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum completions to process per scheduler run */
const BATCH_SIZE = 500;

/** Number of items to process concurrently within a batch */
const PARALLEL_BATCH = 10;

/** Max retries before fuse breaker drops the entry */
const MAX_RETRIES = 5;

/** Path to the completion queue collection */
const COMPLETION_QUEUE_PATH = "System/Upgrades/CompletionQueue";



/**
 * The Cloud Tasks queue name for upgrade completions.
 * Firebase auto-creates this queue when deploying the onTaskDispatched function.
 * Format: ext-{functionName} → but we use a simpler name derived from the function export.
 */
const TASK_QUEUE_NAME = "completeUpgradeTask";


// ─────────────────────────────────────────────────────────────────────────────
// Queue Management (exported for use by start/skip/speedup functions)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the deterministic document ID for a queue entry.
 * Format: {uid}_{upgradeType}_{targetId}
 */
export const buildQueueDocId = (
    uid: string,
    upgradeType: UpgradeType,
    targetId: string,
): string => `${uid}_${upgradeType}_${targetId}`;

/**
 * Schedule an upgrade for auto-completion.
 * Called OUTSIDE the transaction in start functions (Transaction Metadata Return pattern).
 *
 * Writes a queue doc (for safety-net polling) AND enqueues a Cloud Task
 * that fires at the exact completesAt time for near-instant completion.
 */
export const scheduleUpgradeCompletion = async (
    entry: UpgradeCompletionEntry,
): Promise<void> => {
    const docId = buildQueueDocId(entry.uid, entry.upgradeType, entry.targetId);

    // 1. Write queue doc (safety-net tracking for the 2-minute poller)
    await db.collection(COMPLETION_QUEUE_PATH).doc(docId).set(entry);

    // 2. Enqueue Cloud Task at the exact completesAt time
    try {
        await enqueueUpgradeTask(entry);
    } catch (error) {
        // Non-fatal: the 2-minute poller will catch it as a safety net
        logger.warn(
            `[upgradeScheduler] Failed to enqueue Cloud Task for ${entry.upgradeType}: uid=${entry.uid} target=${entry.targetId}. Poller will handle it.`,
            error,
        );
    }

    logger.info(
        `[upgradeScheduler] Scheduled ${entry.upgradeType} completion: uid=${entry.uid} target=${entry.targetId} completesAt=${new Date(entry.completesAt).toISOString()}`,
    );
};

/**
 * Cancel a scheduled upgrade completion.
 * Called when a player skips (instant complete) or the upgrade is otherwise cancelled.
 * Deletes the queue doc (the orphan Cloud Task will gracefully no-op when it fires).
 */
export const cancelUpgradeCompletion = async (
    uid: string,
    upgradeType: UpgradeType,
    targetId: string,
): Promise<void> => {
    const docId = buildQueueDocId(uid, upgradeType, targetId);

    try {
        await db.collection(COMPLETION_QUEUE_PATH).doc(docId).delete();
        logger.info(`[upgradeScheduler] Cancelled ${upgradeType} completion: uid=${uid} target=${targetId}`);
    } catch (error) {
        // Non-fatal: doc may not exist if it was already processed
        logger.warn(`[upgradeScheduler] Failed to cancel ${upgradeType} for ${uid}/${targetId}`, error);
    }
};

/**
 * Update the completesAt of a scheduled upgrade (used by speedups).
 * If the new completesAt is in the past, deletes the queue entry instead.
 * Replaces the Cloud Task with a new one at the updated time.
 */
export const updateUpgradeCompletionTime = async (
    uid: string,
    upgradeType: UpgradeType,
    targetId: string,
    newCompletesAt: number,
): Promise<void> => {
    const docId = buildQueueDocId(uid, upgradeType, targetId);
    const now = Date.now();


    try {
        await db.collection(COMPLETION_QUEUE_PATH).doc(docId).update({
            completesAt: newCompletesAt,
        });
        logger.info(
            `[upgradeScheduler] Updated ${upgradeType} completesAt: uid=${uid} target=${targetId} newCompletesAt=${new Date(newCompletesAt).toISOString()}`,
        );
    } catch (error) {
        // Non-fatal: doc may not exist
        logger.warn(`[upgradeScheduler] Failed to update completesAt for ${uid}/${targetId}`, error);
    }

    // Enqueue a new Cloud Task at the updated time. 
    // The old Cloud Task is left orphaned and will gracefully no-op when it fires later.
    try {
        // Fetch the targetLevel from the document to include in the new task payload
        const docSnap = await db.collection(COMPLETION_QUEUE_PATH).doc(docId).get();
        const entry = docSnap.data() as UpgradeCompletionEntry | undefined;

        await enqueueUpgradeTask({
            uid,
            upgradeType,
            targetId,
            targetLevel: entry?.targetLevel ?? 0,
            completesAt: newCompletesAt,
            createdAt: now,
        });
    } catch (error) {
        // Non-fatal: poller safety net will catch it
        logger.warn(`[upgradeScheduler] Failed to enqueue updated Cloud Task for ${upgradeType}: ${uid}/${targetId}`, error);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Completion Processing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a single car evolution completion.
 * Replicates the core logic of claimCarEvolutionV2 without client auth checks.
 */
const processCarEvolution = async (entry: UpgradeCompletionEntry): Promise<boolean> => {
    const { uid, targetId: carId, targetLevel } = entry;

    return db.runTransaction(async (transaction) => {
        const garageRef = db.doc(`/Players/${uid}/Garage/Cars`);
        const pitCrewRef = db.doc(`/Players/${uid}/Queues/PitCrew`);
        const queueRef = db.collection(COMPLETION_QUEUE_PATH).doc(
            buildQueueDocId(uid, "carEvolution", carId),
        );

        const [garageDoc, pitCrewDoc] = await Promise.all([
            transaction.get(garageRef),
            transaction.get(pitCrewRef),
        ]);

        // Validate pit crew exists and contains the car
        if (!pitCrewDoc.exists) {
            // No pit crew doc — stale queue entry, just delete it
            transaction.delete(queueRef);
            return true;
        }

        const pitCrewData = pitCrewDoc.data() as UserPitCrewDoc;
        const currentSlots = pitCrewData.slots ?? [];
        const slotIndex = currentSlots.findIndex((slot) => slot.carId === carId);

        if (slotIndex === -1) {
            // Car not in queue — already claimed or cancelled, delete queue entry
            transaction.delete(queueRef);
            return true;
        }

        const slot = currentSlots[slotIndex];
        const completesAt = slot.completesAt as admin.firestore.Timestamp;
        const now = Date.now();

        if (completesAt.toMillis() > now) {
            // Timer not yet complete (Cloud Task fired slightly early) — don't delete queue entry!
            // Return false so the task fails and retries, rather than silently succeeding and breaking auto-completion.
            logger.warn(
                `[upgradeScheduler] Car evolution not yet complete: uid=${uid} car=${carId} remaining=${Math.ceil((completesAt.toMillis() - now) / 1000)}s`,
            );
            return false;
        }

        // Validate garage
        if (!garageDoc.exists || !garageDoc.data()?.cars?.[carId]) {
            logger.error(`[upgradeScheduler] Car ${carId} not found in garage for ${uid}`);
            transaction.delete(queueRef);
            return true;
        }

        const timestamp = admin.firestore.FieldValue.serverTimestamp();

        // Remove from pit crew queue
        const updatedSlots = currentSlots.filter((_, idx) => idx !== slotIndex);
        transaction.update(pitCrewRef, {
            slots: updatedSlots,
            updatedAt: timestamp,
        });

        // Apply the evolution: increment star level, reset XP
        const newStarLevel = targetLevel;
        transaction.update(garageRef, {
            [`cars.${carId}.starLevel`]: newStarLevel,
            [`cars.${carId}.carLevel`]: newStarLevel,
            [`cars.${carId}.xp`]: 0,
            [`cars.${carId}.isXpCapped`]: false,
            [`cars.${carId}.updatedAt`]: timestamp,
        });

        // Delete queue entry
        transaction.delete(queueRef);

        logger.info(
            `[upgradeScheduler] Auto-completed car evolution: uid=${uid} car=${carId} newStarLevel=${newStarLevel}`,
        );

        return true;
    });
};

/**
 * Process a single spell research completion.
 * Replicates the core logic of claimSpellResearchV2 without client auth checks.
 */
const processSpellResearch = async (entry: UpgradeCompletionEntry): Promise<boolean> => {
    const { uid, targetId: spellId, targetLevel } = entry;

    return db.runTransaction(async (transaction) => {
        const spellsRef = db.doc(`/Players/${uid}/Spells/Levels`);
        const libraryRef = db.doc(`/Players/${uid}/Queues/Library`);
        const queueRef = db.collection(COMPLETION_QUEUE_PATH).doc(
            buildQueueDocId(uid, "spellResearch", spellId),
        );

        const [spellsDoc, libraryDoc] = await Promise.all([
            transaction.get(spellsRef),
            transaction.get(libraryRef),
        ]);

        // Validate library exists and contains the spell
        if (!libraryDoc.exists) {
            transaction.delete(queueRef);
            return true;
        }

        const libraryData = libraryDoc.data() as UserLibraryDoc;
        const currentSlots = libraryData.slots ?? [];
        const slotIndex = currentSlots.findIndex((slot) => slot.spellId === spellId);

        if (slotIndex === -1) {
            // Spell not in queue — already claimed, delete queue entry
            transaction.delete(queueRef);
            return true;
        }

        const slot = currentSlots[slotIndex];
        const completesAt = slot.completesAt as admin.firestore.Timestamp;
        const now = Date.now();

        if (completesAt.toMillis() > now) {
            // Timer not yet complete (Cloud Task fired slightly early) — don't delete queue entry!
            // Return false so the task fails and retries, rather than silently succeeding and breaking auto-completion.
            logger.warn(
                `[upgradeScheduler] Spell research not yet complete: uid=${uid} spell=${spellId} remaining=${Math.ceil((completesAt.toMillis() - now) / 1000)}s`,
            );
            return false;
        }

        const timestamp = admin.firestore.FieldValue.serverTimestamp();

        // Remove from library queue
        const updatedSlots = currentSlots.filter((_, idx) => idx !== slotIndex);
        transaction.update(libraryRef, {
            slots: updatedSlots,
            updatedAt: timestamp,
        });

        // Apply the research: update spell level
        const isUnlockClaim = targetLevel === 1;
        const spellsData = spellsDoc.exists ? spellsDoc.data() : {};
        const spellsMap = ((spellsData as Record<string, unknown>)?.spells ?? {}) as Record<string, unknown>;
        const existingSpell = spellsMap[spellId] as { level?: number } | undefined;
        const existingLevel = existingSpell?.level ?? 0;

        if (isUnlockClaim && existingLevel < 1) {
            // Brand new spell unlock
            const timestamp2 = admin.firestore.FieldValue.serverTimestamp();
            if (spellsDoc.exists) {
                transaction.update(spellsRef, {
                    [`spells.${spellId}`]: { level: 1, xp: 0, isXpCapped: false },
                    [`unlockedAt.${spellId}`]: timestamp2,
                    updatedAt: timestamp,
                });
            } else {
                transaction.set(spellsRef, {
                    spells: { [spellId]: { level: 1, xp: 0, isXpCapped: false } },
                    unlockedAt: { [spellId]: timestamp2 },
                    updatedAt: timestamp,
                });
            }
        } else {
            // Normal level-up
            transaction.update(spellsRef, {
                [`spells.${spellId}.level`]: targetLevel,
                [`spells.${spellId}.xp`]: 0,
                [`spells.${spellId}.isXpCapped`]: false,
                updatedAt: timestamp,
            });
        }

        // Delete queue entry
        transaction.delete(queueRef);

        logger.info(
            `[upgradeScheduler] Auto-completed spell research: uid=${uid} spell=${spellId} newLevel=${targetLevel}`,
        );

        return true;
    });
};

/**
 * Process a single upgrade completion entry.
 * Routes to the appropriate handler based on upgradeType.
 *
 * EXPORTED for use by upgradeTaskHandler.ts (Cloud Tasks handler).
 */
export const processUpgradeCompletionEntry = async (entry: UpgradeCompletionEntry): Promise<boolean> => {
    const { uid, upgradeType, targetId, retryCount = 0 } = entry;

    // FUSE BREAKER: Drop after too many retries
    if (retryCount >= MAX_RETRIES) {
        logger.error(
            `[upgradeScheduler] DROPPING ${upgradeType} for ${uid}/${targetId} after ${retryCount} failures.`,
        );
        try {
            const docId = buildQueueDocId(uid, upgradeType, targetId);
            await db.collection(COMPLETION_QUEUE_PATH).doc(docId).delete();
        } catch (e) {
            logger.error(`[upgradeScheduler] Failed to clean up dropped entry for ${uid}/${targetId}`, e);
        }
        return false;
    }

    try {
        switch (upgradeType) {
            case "carEvolution":
                return await processCarEvolution(entry);
            case "spellResearch":
                return await processSpellResearch(entry);
            default:
                logger.error(`[upgradeScheduler] Unknown upgradeType: ${upgradeType}`);
                return false;
        }
    } catch (error) {
        logger.error(`[upgradeScheduler] Failed to process ${upgradeType} for ${uid}/${targetId}:`, error);

        // Increment retry count
        try {
            const docId = buildQueueDocId(uid, upgradeType, targetId);
            await db.collection(COMPLETION_QUEUE_PATH).doc(docId).update({
                retryCount: (retryCount || 0) + 1,
            });
        } catch (updateErr) {
            logger.warn(`[upgradeScheduler] Failed to update retry count for ${uid}/${targetId}`, updateErr);
        }

        return false;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled Function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process pending upgrade completions from the queue.
 * Only processes entries where completesAt <= now.
 */
export const processUpgradeCompletions = async (): Promise<{
    processed: number;
    errors: number;
}> => {
    const stats = { processed: 0, errors: 0 };
    const now = Date.now();

    try {
        // Query ONLY completions that are due
        const dueCompletions = await db
            .collection(COMPLETION_QUEUE_PATH)
            .where("completesAt", "<=", now)
            .limit(BATCH_SIZE)
            .get();

        if (dueCompletions.empty) {
            return stats;
        }

        logger.info(`[upgradeScheduler] Found ${dueCompletions.size} due upgrade completions`);

        const entries = dueCompletions.docs.map(doc => doc.data() as UpgradeCompletionEntry);

        // Process in parallel batches (safety net — Cloud Tasks handles most completions)
        for (let i = 0; i < entries.length; i += PARALLEL_BATCH) {
            const batch = entries.slice(i, i + PARALLEL_BATCH);
            const results = await Promise.allSettled(
                batch.map(entry => processUpgradeCompletionEntry(entry)),
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
        logger.error("[upgradeScheduler] Fatal error processing upgrade completions:", error);
        throw error;
    }
};

/**
 * Scheduled function that processes upgrade completions every 2 minutes.
 * Acts as a SAFETY NET for Cloud Tasks — most completions are handled instantly
 * by completeUpgradeTask via Cloud Tasks. This poller catches any that slip through.
 * When no upgrades are due, this does 1 indexed query returning 0 results.
 */
export const upgradeCompletionJob = {
    process: onSchedule(
        {
            region: REGION,
            schedule: "every 2 minutes",
            timeZone: "Etc/UTC",
            timeoutSeconds: 300,
            memory: "256MiB",
        },
        async () => {
            logger.info("[upgradeScheduler] Starting upgrade completion job");
            const stats = await processUpgradeCompletions();
            logger.info("[upgradeScheduler] Upgrade completion job completed", stats);
        },
    ),
};

// ─────────────────────────────────────────────────────────────────────────────
// Cloud Tasks Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enqueue a Cloud Task to fire at the exact completesAt time.
 * The task invokes the completeUpgradeTask onTaskDispatched handler.
 */
const enqueueUpgradeTask = async (entry: UpgradeCompletionEntry): Promise<void> => {
    const queue = getFunctions().taskQueue(TASK_QUEUE_NAME);

    // Calculate schedule time
    const now = Date.now();
    const delayMs = Math.max(0, entry.completesAt - now);
    // Use Math.ceil to ensure we schedule for the second AFTER completing, avoiding early task triggers
    const scheduleTimeSeconds = Math.ceil((now + delayMs) / 1000);

    // Task payload
    const payload = {
        uid: entry.uid,
        upgradeType: entry.upgradeType,
        targetId: entry.targetId,
        targetLevel: entry.targetLevel,
        completesAt: entry.completesAt,
    };

    try {
        // We do NOT provide an 'id' to Cloud Tasks. This allows Cloud Tasks to auto-generate 
        // a unique ID, bypassing the 9-day deduplication tombstone issue which breaks
        // subsequent upgrades or speedup changes for the same car/spell.
        await queue.enqueue(payload, {
            scheduleTime: new Date(scheduleTimeSeconds * 1000),
        });

        logger.info(
            `[upgradeScheduler] Enqueued Cloud Task: ${entry.upgradeType} uid=${entry.uid} target=${entry.targetId} targetLevel=${entry.targetLevel} ` +
            `fires at ${new Date(scheduleTimeSeconds * 1000).toISOString()} (delay=${Math.round(delayMs / 1000)}s)`,
        );
    } catch (error: any) {
        throw error;
    }
};

