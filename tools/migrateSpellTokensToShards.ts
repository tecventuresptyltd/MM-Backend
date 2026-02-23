/**
 * Migration Script: Convert Legacy spellTokens → V2 spellShards
 *
 * For all existing players, atomically move their spellTokens into spellShards
 * at a configurable conversion rate and zero out spellTokens.
 *
 * Usage (from project root):
 *   npx ts-node tools/migrateSpellTokensToShards.ts [--dry-run] [--rate=10]
 *
 * Options:
 *   --dry-run   Preview changes without writing to Firestore
 *   --rate=N    Conversion rate: 1 spellToken = N spellShards (default: 10)
 */

import * as admin from "firebase-admin";

// Initialize Admin SDK (uses GOOGLE_APPLICATION_CREDENTIALS or default SA)
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

const BATCH_SIZE = 500;
const DEFAULT_CONVERSION_RATE = 10; // 1 spellToken = 10 spellShards

interface MigrationResult {
    totalProcessed: number;
    totalMigrated: number;
    totalShardsMinted: number;
    totalTokensConsumed: number;
    errors: string[];
}

async function migrateSpellTokensToShards(
    dryRun: boolean,
    conversionRate: number,
): Promise<MigrationResult> {
    const result: MigrationResult = {
        totalProcessed: 0,
        totalMigrated: 0,
        totalShardsMinted: 0,
        totalTokensConsumed: 0,
        errors: [],
    };

    console.log(`\n=== Spell Tokens → Spell Shards Migration ===`);
    console.log(`Mode: ${dryRun ? "DRY RUN (no writes)" : "LIVE"}`);
    console.log(`Conversion Rate: 1 spellToken = ${conversionRate} spellShards`);
    console.log(`Batch Size: ${BATCH_SIZE}\n`);

    let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    let hasMore = true;

    while (hasMore) {
        // Query players who have spellTokens > 0
        let query = db
            .collectionGroup("Stats")
            .where("spellTokens", ">", 0)
            .limit(BATCH_SIZE);

        if (lastDoc) {
            query = query.startAfter(lastDoc);
        }

        const snapshot = await query.get();

        if (snapshot.empty) {
            hasMore = false;
            break;
        }

        lastDoc = snapshot.docs[snapshot.docs.length - 1];

        // Process in a batch write
        const batch = db.batch();
        let batchCount = 0;

        for (const doc of snapshot.docs) {
            result.totalProcessed++;

            const data = doc.data();
            const spellTokens = Number(data.spellTokens ?? 0);

            if (spellTokens <= 0) {
                continue;
            }

            // Verify this is an Economy/Stats doc (not some other Stats doc)
            const pathParts = doc.ref.path.split("/");
            if (
                pathParts.length < 4 ||
                pathParts[pathParts.length - 2] !== "Economy" ||
                pathParts[pathParts.length - 1] !== "Stats"
            ) {
                continue;
            }

            const shardsToGrant = Math.floor(spellTokens * conversionRate);
            const uid = pathParts[1]; // Players/{uid}/Economy/Stats

            if (dryRun) {
                console.log(
                    `[DRY RUN] ${uid}: ${spellTokens} tokens → ${shardsToGrant} shards`,
                );
            } else {
                batch.update(doc.ref, {
                    spellShards: admin.firestore.FieldValue.increment(shardsToGrant),
                    spellTokens: 0,
                    migratedTokensAt: admin.firestore.FieldValue.serverTimestamp(),
                    migratedTokensAmount: spellTokens,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                batchCount++;
            }

            result.totalMigrated++;
            result.totalShardsMinted += shardsToGrant;
            result.totalTokensConsumed += spellTokens;
        }

        // Commit batch if live mode
        if (!dryRun && batchCount > 0) {
            try {
                await batch.commit();
                console.log(`Committed batch of ${batchCount} updates`);
            } catch (error) {
                const msg = `Batch commit failed: ${error}`;
                console.error(msg);
                result.errors.push(msg);
            }
        }

        // Check if we got fewer than BATCH_SIZE (last page)
        if (snapshot.docs.length < BATCH_SIZE) {
            hasMore = false;
        }
    }

    return result;
}

// --- CLI Entry Point ---
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");

    const rateArg = args.find((a) => a.startsWith("--rate="));
    const conversionRate = rateArg
        ? Number(rateArg.split("=")[1])
        : DEFAULT_CONVERSION_RATE;

    if (!Number.isFinite(conversionRate) || conversionRate <= 0) {
        console.error("Invalid conversion rate. Must be a positive number.");
        process.exit(1);
    }

    const result = await migrateSpellTokensToShards(dryRun, conversionRate);

    console.log(`\n=== Migration Complete ===`);
    console.log(`Total Processed: ${result.totalProcessed}`);
    console.log(`Total Migrated:  ${result.totalMigrated}`);
    console.log(`Tokens Consumed: ${result.totalTokensConsumed}`);
    console.log(`Shards Minted:   ${result.totalShardsMinted}`);
    if (result.errors.length > 0) {
        console.error(`Errors: ${result.errors.length}`);
        result.errors.forEach((e) => console.error(`  - ${e}`));
    }

    process.exit(result.errors.length > 0 ? 1 : 0);
}

main().catch((error) => {
    console.error("Fatal migration error:", error);
    process.exit(1);
});
