import * as logger from "firebase-functions/logger";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import {
    playerClanStateRef,
    clanMembersCollection,
    clanRef,
} from "./helpers.js";
import * as admin from "firebase-admin";

/**
 * Firestore trigger that syncs player profile changes to clan member documents.
 * 
 * Monitors: Players/{userId}/Profile/Profile
 * Updates: Clans/{clanId}/Members/{userId}
 * 
 * Tracked fields: trophies, avatarId, displayName, level
 */
export const onPlayerProfileUpdate = onDocumentUpdated(
    {
        document: "Players/{userId}/Profile/Profile",
        region: REGION,
        memory: "256MiB",
        timeoutSeconds: 60,
    },
    async (event) => {
        const userId = event.params.userId;
        const before = event.data?.before.data();
        const after = event.data?.after.data();

        if (!before || !after) {
            logger.warn(`[onPlayerProfileUpdate] Missing before/after data for ${userId}`);
            return;
        }

        // Detect what changed
        const changedFields: {
            trophies?: number;
            avatarId?: number;
            displayName?: string;
            level?: number;
        } = {};

        if (before.trophies !== after.trophies) {
            changedFields.trophies = typeof after.trophies === "number" ? after.trophies : 0;
        }
        if (before.avatarId !== after.avatarId) {
            changedFields.avatarId = typeof after.avatarId === "number" ? after.avatarId : 1;
        }
        if (before.displayName !== after.displayName) {
            changedFields.displayName = typeof after.displayName === "string" ? after.displayName : "Racer";
        }
        if (before.level !== after.level) {
            changedFields.level = typeof after.level === "number" ? after.level : 1;
        }

        // Early exit if no tracked fields changed
        if (Object.keys(changedFields).length === 0) {
            return;
        }

        logger.info(`[onPlayerProfileUpdate] Player ${userId} changed fields:`, Object.keys(changedFields));

        try {
            // Check if user is in a clan
            const clanStateSnap = await playerClanStateRef(userId).get();
            const clanId = clanStateSnap.data()?.clanId;

            if (typeof clanId !== "string" || clanId.length === 0) {
                logger.debug(`[onPlayerProfileUpdate] Player ${userId} not in clan, skipping sync`);
                return;
            }

            // Update clan member document
            const memberRef = clanMembersCollection(clanId).doc(userId);

            // If trophies changed, we need to recalculate clan totals atomically
            if (changedFields.trophies !== undefined) {
                await db.runTransaction(async (transaction) => {
                    const memberSnap = await transaction.get(memberRef);

                    if (!memberSnap.exists) {
                        logger.warn(`[onPlayerProfileUpdate] Member doc not found for ${userId} in clan ${clanId}`);
                        return;
                    }

                    const oldMemberTrophies = typeof memberSnap.data()?.trophies === "number"
                        ? memberSnap.data()!.trophies
                        : 0;
                    const newMemberTrophies = changedFields.trophies!;
                    const trophyDelta = newMemberTrophies - oldMemberTrophies;

                    // Update member doc
                    transaction.update(memberRef, {
                        ...changedFields,
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    });

                    // Update clan total trophies
                    if (trophyDelta !== 0) {
                        transaction.update(clanRef(clanId), {
                            "stats.trophies": admin.firestore.FieldValue.increment(trophyDelta),
                            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        });
                    }

                    logger.info(`[onPlayerProfileUpdate] Synced ${userId} to clan ${clanId}, trophy delta: ${trophyDelta}`);
                });
            } else {
                // No trophy change, just update member doc
                await memberRef.update({
                    ...changedFields,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });

                logger.info(`[onPlayerProfileUpdate] Synced ${userId} to clan ${clanId} (non-trophy fields)`);
            }
        } catch (error) {
            logger.error(`[onPlayerProfileUpdate] Error syncing player ${userId}:`, error);
            // Don't throw - we don't want profile updates to fail if clan sync fails
        }
    }
);
