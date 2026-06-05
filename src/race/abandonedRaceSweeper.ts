import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { REGION } from "../shared/region.js";
import { GameMode, resolveGameMode, getTrophyFields, shouldModifyTrophies, shouldSyncClanTrophies } from "../shared/gamemode.js";
import { playerClanStateRef, clanMembersCollection, clanRef } from "../clan/helpers.js";

const db = admin.firestore();

/**
 * Maximum age (in ms) before a "pending" race is considered abandoned.
 * A race lasting longer than this was never completed by the client.
 * Standard races are 2–3 minutes; 10 minutes is a generous safety margin.
 */
const ABANDONED_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Maximum number of abandoned races to process per sweeper run.
 * Prevents timeout on scheduled functions if there's a sudden spike.
 */
const MAX_BATCH_SIZE = 50;

/**
 * Finds all races stuck in "pending" status that are older than the threshold,
 * refunds any pre-deducted trophies to each participant, and marks the race as "abandoned".
 *
 * This is the Fail-Safe Sweeper for the race lifecycle — prevents permanent
 * trophy loss when a client crashes after calling prepareRace but before
 * calling recordRaceResult.
 */
const sweepAbandonedRaces = async (): Promise<{ scanned: number; refunded: number; errors: number }> => {
  const stats = { scanned: 0, refunded: 0, errors: 0 };
  const cutoffTime = admin.firestore.Timestamp.fromMillis(Date.now() - ABANDONED_THRESHOLD_MS);

  // Query races that are still "pending" and were created before the cutoff
  const abandonedQuery = db.collection("Races")
    .where("status", "==", "pending")
    .where("createdAt", "<", cutoffTime)
    .limit(MAX_BATCH_SIZE);

  const snapshot = await abandonedQuery.get();

  if (snapshot.empty) {
    logger.info("[AbandonedRaceSweeper] No abandoned races found.");
    return stats;
  }

  logger.info(`[AbandonedRaceSweeper] Found ${snapshot.size} abandoned race(s) to process.`);

  for (const raceDoc of snapshot.docs) {
    stats.scanned++;
    const raceId = raceDoc.id;
    const raceData = raceDoc.data();

    try {
      // Get all participants for this race
      const participantsSnap = await db.collection(`Races/${raceId}/Participants`).get();

      if (participantsSnap.empty) {
        // No participants — just mark as abandoned
        await raceDoc.ref.update({
          status: "abandoned",
          abandonedAt: admin.firestore.FieldValue.serverTimestamp(),
          abandonedReason: "no_participants",
        });
        logger.info(`[AbandonedRaceSweeper] Race ${raceId} abandoned (no participants).`);
        continue;
      }

      // Process each participant's trophy refund
      for (const participantDoc of participantsSnap.docs) {
        const uid = participantDoc.id;
        const participantData = participantDoc.data();
        const preDeducted = Number(participantData.preDeductedTrophies ?? 0);

        // Only refund if trophies were actually deducted (negative value means loss)
        if (preDeducted >= 0) {
          logger.info(`[AbandonedRaceSweeper] Race ${raceId} participant ${uid}: no trophy deduction to refund (preDeducted=${preDeducted}).`);
          continue;
        }

        const gamemode: GameMode = resolveGameMode(participantData.gamemode);

        // Skip refund for gamemodes that don't modify trophies
        if (!shouldModifyTrophies(gamemode)) {
          logger.info(`[AbandonedRaceSweeper] Race ${raceId} participant ${uid}: gamemode ${gamemode} doesn't modify trophies, skipping refund.`);
          continue;
        }

        const trophyFields = getTrophyFields(gamemode);
        const refundAmount = Math.abs(preDeducted); // Convert negative to positive for increment

        try {
          await db.runTransaction(async (transaction) => {
            const profileRef = db.doc(`/Players/${uid}/Profile/Profile`);
            const profileSnap = await transaction.get(profileRef);

            if (!profileSnap.exists) {
              logger.warn(`[AbandonedRaceSweeper] Profile not found for ${uid}, skipping refund.`);
              return;
            }

            // Refund the pre-deducted trophies
            transaction.update(profileRef, {
              [trophyFields.current]: admin.firestore.FieldValue.increment(refundAmount),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            // Refund clan trophies if applicable (RANKED only)
            if (shouldSyncClanTrophies(gamemode)) {
              const clanStateRef = playerClanStateRef(uid);
              const clanStateSnap = await transaction.get(clanStateRef);
              const clanId = clanStateSnap.data()?.clanId;

              if (typeof clanId === "string" && clanId.length > 0) {
                const memberRef = clanMembersCollection(clanId).doc(uid);
                const memberSnap = await transaction.get(memberRef);

                if (memberSnap.exists) {
                  transaction.update(memberRef, {
                    trophies: admin.firestore.FieldValue.increment(refundAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });

                  transaction.update(clanRef(clanId), {
                    "stats.trophies": admin.firestore.FieldValue.increment(refundAmount),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                  });
                }
              }
            }

            // Mark participant as refunded
            transaction.update(participantDoc.ref, {
              refunded: true,
              refundedAmount: refundAmount,
              refundedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          });

          logger.info(`[AbandonedRaceSweeper] Refunded ${refundAmount} trophies to ${uid} for abandoned race ${raceId} (gamemode: ${gamemode}).`);
          stats.refunded++;
        } catch (txError) {
          logger.error(`[AbandonedRaceSweeper] Failed to refund ${uid} for race ${raceId}:`, txError);
          stats.errors++;
        }
      }

      // Mark race as abandoned
      await raceDoc.ref.update({
        status: "abandoned",
        abandonedAt: admin.firestore.FieldValue.serverTimestamp(),
        abandonedReason: "client_timeout",
      });

      logger.info(`[AbandonedRaceSweeper] Race ${raceId} marked as abandoned.`);
    } catch (raceError) {
      logger.error(`[AbandonedRaceSweeper] Error processing race ${raceId}:`, raceError);
      stats.errors++;
    }
  }

  logger.info(`[AbandonedRaceSweeper] Sweep complete.`, stats);
  return stats;
};

/**
 * Scheduled sweeper: Runs every 15 minutes to find and refund abandoned races.
 * Matches the Fail-Safe Sweeper pattern used in the shop offer system.
 */
export const abandonedRaceSweeper = onSchedule(
  {
    region: REGION,
    schedule: "every 15 minutes",
    timeZone: "Etc/UTC",
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    const stats = await sweepAbandonedRaces();
    if (stats.refunded > 0) {
      logger.warn(`[AbandonedRaceSweeper] Refunded ${stats.refunded} abandoned race(s) this cycle.`);
    }
    if (stats.errors > 0) {
      logger.error(`[AbandonedRaceSweeper] ${stats.errors} error(s) during sweep.`);
    }
  },
);
