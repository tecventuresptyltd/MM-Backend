#!/usr/bin/env tsx
/**
 * One-time migration script to sync all existing clan member documents with current player profile data.
 * 
 * This script:
 * 1. Queries all active clans
 * 2. For each clan, fetches all member UIDs
 * 3. Batch reads player profiles
 * 4. Compares member docs with profile data
 * 5. Batch updates drifted fields
 * 6. Recalculates clan totals
 * 
 * Usage:
 *   npm run sync-clan-members           # Run migration
 *   npm run sync-clan-members -- --dry-run  # Preview changes without applying
 */

import * as admin from "firebase-admin";

// Initialize Firebase Admin with production credentials
const serviceAccount = require("../backend-production-mystic-motors-prod.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: "mystic-motors-prod",
});

const db = admin.firestore();

// Inline helper functions to avoid import order issues
const clansCollection = () => db.collection("Clans");
const clanMembersCollection = (clanId: string) => clansCollection().doc(clanId).collection("Members");
const playerProfileRef = (uid: string) => db.doc(`/Players/${uid}/Profile/Profile`);

async function recalculateClanTotalTrophies(clanId: string): Promise<number> {
    const membersSnap = await clanMembersCollection(clanId).get();
    let total = 0;
    membersSnap.forEach((doc) => {
        const data = doc.data();
        if (typeof data.trophies === "number" && Number.isFinite(data.trophies)) {
            total += data.trophies;
        }
    });

    await db.doc(`/Clans/${clanId}`).update({
        "stats.trophies": total,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return total;
}

interface SyncStats {
    clansProcessed: number;
    membersScanned: number;
    membersUpdated: number;
    membersMissing: number;
    clansRecalculated: number;
    errors: string[];
}

interface MemberUpdate {
    uid: string;
    updates: {
        displayName?: string;
        avatarId?: number;
        level?: number;
        trophies?: number;
    };
}

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = 500;

/**
 * Syncs a single clan's member documents with player profiles
 */
async function syncClanMembers(clanId: string): Promise<{
    scanned: number;
    updated: number;
    missing: number;
    recalculated: boolean;
}> {
    let scanned = 0;
    let updated = 0;
    let missing = 0;
    let trophiesChanged = false;

    // Fetch all members for this clan
    const membersSnapshot = await clanMembersCollection(clanId).get();
    scanned = membersSnapshot.size;

    if (membersSnapshot.empty) {
        return { scanned, updated, missing, recalculated: false };
    }

    // Extract UIDs
    const memberUids = membersSnapshot.docs.map((doc) => doc.id);

    // Batch read player profiles
    const profileRefs = memberUids.map((uid) => playerProfileRef(uid));
    const profileSnapshots = await db.getAll(...profileRefs);

    // Build a map of uid -> profile data
    const profileMap = new Map<
        string,
        {
            displayName: string;
            avatarId: number;
            level: number;
            trophies: number;
        }
    >();

    profileSnapshots.forEach((snap, idx) => {
        const uid = memberUids[idx];
        if (!snap.exists) {
            console.warn(`  ⚠️  Player profile not found for ${uid} in clan ${clanId}`);
            missing++;
            return;
        }

        const data = snap.data() ?? {};
        profileMap.set(uid, {
            displayName:
                typeof data.displayName === "string" && data.displayName.trim().length > 0
                    ? data.displayName.trim()
                    : "Racer",
            avatarId:
                typeof data.avatarId === "number" && Number.isFinite(data.avatarId)
                    ? data.avatarId
                    : Number(data.avatarId) || 1,
            level:
                typeof data.level === "number" && Number.isFinite(data.level)
                    ? data.level
                    : Number(data.level) || 1,
            trophies:
                typeof data.trophies === "number" && Number.isFinite(data.trophies)
                    ? data.trophies
                    : Number(data.trophies) || 0,
        });
    });

    // Identify members that need updates
    const updatesToApply: MemberUpdate[] = [];

    membersSnapshot.docs.forEach((memberDoc) => {
        const uid = memberDoc.id;
        const memberData = memberDoc.data() ?? {};
        const profile = profileMap.get(uid);

        if (!profile) {
            return; // Profile doesn't exist, skip
        }

        // Check for drift
        const updates: MemberUpdate["updates"] = {};

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
            trophiesChanged = true;
        }

        if (Object.keys(updates).length > 0) {
            updatesToApply.push({ uid, updates });
        }
    });

    console.log(`  Found ${updatesToApply.length} drifted member(s) in clan ${clanId}`);

    if (updatesToApply.length > 0) {
        for (const update of updatesToApply) {
            const fieldsList = Object.keys(update.updates).join(", ");
            console.log(`    - ${update.uid}: ${fieldsList}`);
        }
    }

    // Apply updates in batches
    if (updatesToApply.length > 0 && !DRY_RUN) {
        for (let i = 0; i < updatesToApply.length; i += BATCH_SIZE) {
            const batch = db.batch();
            const chunk = updatesToApply.slice(i, i + BATCH_SIZE);

            chunk.forEach(({ uid, updates }) => {
                const memberRef = clanMembersCollection(clanId).doc(uid);
                batch.update(memberRef, {
                    ...updates,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            });

            await batch.commit();
            updated += chunk.length;
        }

        console.log(`  ✅ Updated ${updated} member(s)`);
    }

    // Recalculate clan totals if trophies changed
    let recalculated = false;
    if (trophiesChanged && !DRY_RUN) {
        const newTotal = await recalculateClanTotalTrophies(clanId);
        console.log(`  ✅ Recalculated clan total trophies: ${newTotal}`);
        recalculated = true;
    } else if (trophiesChanged && DRY_RUN) {
        console.log(`  [DRY RUN] Would recalculate clan total trophies`);
    }

    return { scanned, updated, missing, recalculated };
}

/**
 * Main migration function
 */
async function main() {
    console.log("\n🚀 Starting Clan Member Sync Migration\n");

    if (DRY_RUN) {
        console.log("⚠️  Running in DRY RUN mode - no changes will be applied\n");
    }

    const stats: SyncStats = {
        clansProcessed: 0,
        membersScanned: 0,
        membersUpdated: 0,
        membersMissing: 0,
        clansRecalculated: 0,
        errors: [],
    };

    try {
        // Fetch all active clans
        const clansSnapshot = await clansCollection().where("status", "==", "active").get();

        console.log(`📊 Found ${clansSnapshot.size} active clan(s)\n`);

        // Process each clan
        for (const clanDoc of clansSnapshot.docs) {
            const clanId = clanDoc.id;
            const clanData = clanDoc.data();
            const clanName = clanData?.name || "Unknown";

            console.log(`\n🏛️  Processing clan: ${clanName} (${clanId})`);

            try {
                const result = await syncClanMembers(clanId);
                stats.clansProcessed++;
                stats.membersScanned += result.scanned;
                stats.membersUpdated += result.updated;
                stats.membersMissing += result.missing;
                if (result.recalculated) {
                    stats.clansRecalculated++;
                }
            } catch (error) {
                const errorMsg = `Failed to sync clan ${clanId}: ${error}`;
                console.error(`  ❌ ${errorMsg}`);
                stats.errors.push(errorMsg);
            }
        }

        // Print summary
        console.log("\n\n" + "=".repeat(60));
        console.log("📈 Migration Summary");
        console.log("=".repeat(60));
        console.log(`Clans processed:         ${stats.clansProcessed}`);
        console.log(`Members scanned:         ${stats.membersScanned}`);
        console.log(`Members updated:         ${stats.membersUpdated}`);
        console.log(`Members missing:         ${stats.membersMissing}`);
        console.log(`Clans recalculated:      ${stats.clansRecalculated}`);
        console.log(`Errors:                  ${stats.errors.length}`);

        if (stats.errors.length > 0) {
            console.log("\n❌ Errors:");
            stats.errors.forEach((error, idx) => {
                console.log(`  ${idx + 1}. ${error}`);
            });
        }

        if (DRY_RUN) {
            console.log("\n⚠️  DRY RUN completed - no changes were applied");
        } else {
            console.log("\n✅ Migration completed successfully");
        }

        console.log("=".repeat(60) + "\n");
    } catch (error) {
        console.error("\n❌ Fatal error:", error);
        process.exit(1);
    }
}

// Run the migration
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Unhandled error:", error);
        process.exit(1);
    });
