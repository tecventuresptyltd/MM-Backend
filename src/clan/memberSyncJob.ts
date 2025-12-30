import { onSchedule } from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import { clansCollection, clanMembersCollection, playerProfileRef } from "./helpers.js";

/**
 * Batch size for reading clan members at once
 */
const MEMBER_BATCH_SIZE = 500;

/**
 * Batch size for Firestore batch writes (Firestore limit is 500)
 */
const WRITE_BATCH_SIZE = 450;

/**
 * Maximum number of clans to process per job run
 */
const MAX_CLANS_PER_RUN = 100;

interface MemberSyncStats {
    clansProcessed: number;
    membersScanned: number;
    membersUpdated: number;
    membersMissing: number;
    errors: number;
}

/**
 * Syncs a single clan's member documents with the latest player profile data
 */
const syncClanMembers = async (clanId: string): Promise<{
    scanned: number;
    updated: number;
    missing: number;
}> => {
    let scanned = 0;
    let updated = 0;
    let missing = 0;

    try {
        // Fetch all members for this clan
        const membersSnapshot = await clanMembersCollection(clanId).get();
        scanned = membersSnapshot.size;

        if (membersSnapshot.empty) {
            return { scanned, updated, missing };
        }

        // Extract UIDs
        const memberUids = membersSnapshot.docs.map((doc) => doc.id);

        // Batch read player profiles (max 500 per getAll)
        const profileRefs = memberUids.map((uid) => playerProfileRef(uid));
        const profileSnapshots = await db.getAll(...profileRefs);

        // Build a map of uid -> profile data
        const profileMap = new Map<string, {
            displayName: string;
            avatarId: number;
            level: number;
            trophies: number;
        }>();

        profileSnapshots.forEach((snap, idx) => {
            const uid = memberUids[idx];
            if (!snap.exists) {
                logger.warn(`[memberSyncJob] Player profile not found for ${uid} in clan ${clanId}`);
                missing++;
                return;
            }

            const data = snap.data() ?? {};
            profileMap.set(uid, {
                displayName: typeof data.displayName === "string" && data.displayName.trim().length > 0
                    ? data.displayName.trim()
                    : "Racer",
                avatarId: typeof data.avatarId === "number" && Number.isFinite(data.avatarId)
                    ? data.avatarId
                    : Number(data.avatarId) || 1,
                level: typeof data.level === "number" && Number.isFinite(data.level)
                    ? data.level
                    : Number(data.level) || 1,
                trophies: typeof data.trophies === "number" && Number.isFinite(data.trophies)
                    ? data.trophies
                    : Number(data.trophies) || 0,
            });
        });

        // Identify members that need updates
        const updatesToApply: Array<{
            uid: string;
            updates: {
                displayName?: string;
                avatarId?: number;
                level?: number;
                trophies?: number;
            };
        }> = [];

        membersSnapshot.docs.forEach((memberDoc) => {
            const uid = memberDoc.id;
            const memberData = memberDoc.data() ?? {};
            const profile = profileMap.get(uid);

            if (!profile) {
                // Profile doesn't exist, skip (already logged above)
                return;
            }

            // Check for drift
            const updates: typeof updatesToApply[0]["updates"] = {};

            if (memberData.displayName !== profile.displayName) {
                updates.displayName = profile.displayName;
            }
            if (memberData.avatarId !== profile.avatarId) {
                updates.avatarId = profile.avatarId;
            }
            if (memberData.level !== profile.level) {
                updates.level = profile.level;
            }
            if (memberData.trophies !== profile.trophies) {
                updates.trophies = profile.trophies;
            }

            if (Object.keys(updates).length > 0) {
                updatesToApply.push({ uid, updates });
            }
        });

        // Track if trophies were updated (need to recalculate clan totals)
        const trophiesUpdated = updatesToApply.some((update) => update.updates.trophies !== undefined);

        // Apply updates in batches
        if (updatesToApply.length > 0) {
            for (let i = 0; i < updatesToApply.length; i += WRITE_BATCH_SIZE) {
                const batch = db.batch();
                const chunk = updatesToApply.slice(i, i + WRITE_BATCH_SIZE);

                chunk.forEach(({ uid, updates }) => {
                    const memberRef = clanMembersCollection(clanId).doc(uid);
                    batch.update(memberRef, updates);
                });

                await batch.commit();
                updated += chunk.length;
            }

            logger.info(`[memberSyncJob] Updated ${updatesToApply.length} members in clan ${clanId}`);
        }

        // Recalculate clan total trophies from member docs if any trophy updates occurred
        if (trophiesUpdated) {
            let totalTrophies = 0;
            profileMap.forEach((profile) => {
                totalTrophies += profile.trophies;
            });

            await db.doc(`/Clans/${clanId}`).update({
                "stats.trophies": totalTrophies,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            logger.info(`[memberSyncJob] Recalculated clan ${clanId} total trophies: ${totalTrophies}`);
        }

        return { scanned, updated, missing };
    } catch (error) {
        logger.error(`[memberSyncJob] Error syncing clan ${clanId}:`, error);
        throw error;
    }
};

/**
 * Main job function that processes all active clans
 */
export const syncAllClanMembers = async (): Promise<MemberSyncStats> => {
    const stats: MemberSyncStats = {
        clansProcessed: 0,
        membersScanned: 0,
        membersUpdated: 0,
        membersMissing: 0,
        errors: 0,
    };

    try {
        logger.info("[memberSyncJob] Starting clan member sync job");

        // Fetch all active clans
        const clansSnapshot = await clansCollection()
            .where("status", "==", "active")
            .limit(MAX_CLANS_PER_RUN)
            .get();

        logger.info(`[memberSyncJob] Found ${clansSnapshot.size} active clans to process`);

        // Process each clan sequentially (to avoid overwhelming Firestore)
        for (const clanDoc of clansSnapshot.docs) {
            const clanId = clanDoc.id;

            try {
                const result = await syncClanMembers(clanId);
                stats.clansProcessed++;
                stats.membersScanned += result.scanned;
                stats.membersUpdated += result.updated;
                stats.membersMissing += result.missing;
            } catch (error) {
                logger.error(`[memberSyncJob] Failed to sync clan ${clanId}:`, error);
                stats.errors++;
            }
        }

        logger.info("[memberSyncJob] Clan member sync job completed", stats);
        return stats;
    } catch (error) {
        logger.error("[memberSyncJob] Fatal error in sync job:", error);
        throw error;
    }
};

/**
 * Scheduled function that runs every 6 hours
 */
export const clanMemberSyncJob = {
    sync: onSchedule(
        {
            region: REGION,
            schedule: "every 6 hours",
            timeZone: "Etc/UTC",
            timeoutSeconds: 540, // 9 minutes (max is 540s for scheduled functions)
            memory: "512MiB",
        },
        async () => {
            await syncAllClanMembers();
        },
    ),
};
