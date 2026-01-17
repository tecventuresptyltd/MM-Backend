/**
 * Populate missing transition queue entries for all active offers.
 * This fixes accounts that were restored by the safety net before
 * the scheduleOfferTransition fix was deployed.
 * Run with: node tools/populateMissingQueueEntries.mjs
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Initialize with Application Default Credentials
initializeApp({
    credential: applicationDefault(),
    projectId: "mystic-motors-prod",
});

const db = getFirestore();
const TRANSITION_QUEUE_PATH = "System/Offers/TransitionQueue";
const BATCH_SIZE = 400;

async function main() {
    console.log("🔍 Populating Missing Queue Entries...\n");
    const now = Date.now();

    let totalScanned = 0;
    let entriesCreated = 0;
    let alreadyHaveEntry = 0;
    let noMainOffer = 0;
    let expiredCount = 0;
    let errors = 0;

    // Get all players
    const playersSnap = await db.collection("Players").limit(10000).get();
    console.log(`📊 Found ${playersSnap.size} players to check\n`);

    // Collect all entries to create
    const entriesToCreate = [];

    for (const playerDoc of playersSnap.docs) {
        const uid = playerDoc.id;
        totalScanned++;

        if (totalScanned % 1000 === 0) {
            console.log(`Scanning: ${totalScanned}/${playersSnap.size}`);
        }

        try {
            // Check if queue entry already exists
            const queueDoc = await db.collection(TRANSITION_QUEUE_PATH).doc(uid).get();
            if (queueDoc.exists) {
                alreadyHaveEntry++;
                continue;
            }

            // Get active offers
            const activeSnap = await db.doc(`Players/${uid}/Offers/Active`).get();
            const activeData = activeSnap.data();
            const main = activeData?.main;

            if (!main || !main.offerId) {
                noMainOffer++;
                continue;
            }

            // Only schedule if offer is active
            if (main.state !== "active") {
                continue;
            }

            const expiresAt = main.expiresAt;
            if (!expiresAt) {
                continue;
            }

            if (expiresAt <= now) {
                expiredCount++;
            }

            // Queue for creation
            entriesToCreate.push({
                uid,
                transitionAt: expiresAt,
                transitionType: "offer_expired",
                tier: main.tier ?? 0,
                createdAt: now,
            });
        } catch (error) {
            errors++;
        }
    }

    console.log(`\n📋 Found ${entriesToCreate.length} entries to create\n`);

    // Write in batches
    for (let i = 0; i < entriesToCreate.length; i += BATCH_SIZE) {
        const batchEntries = entriesToCreate.slice(i, i + BATCH_SIZE);
        const batch = db.batch(); // Create NEW batch for each commit

        for (const entry of batchEntries) {
            batch.set(db.collection(TRANSITION_QUEUE_PATH).doc(entry.uid), entry);
        }

        await batch.commit();
        entriesCreated += batchEntries.length;
        console.log(`   Committed batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batchEntries.length} entries (total: ${entriesCreated})`);
    }

    console.log("\n✅ Complete!");
    console.log(`📊 Total scanned: ${totalScanned}`);
    console.log(`✅ Entries created: ${entriesCreated}`);
    console.log(`   Already had entry: ${alreadyHaveEntry}`);
    console.log(`   No main offer: ${noMainOffer}`);
    console.log(`   Already expired: ${expiredCount}`);
    console.log(`❌ Errors: ${errors}`);

    if (expiredCount > 0) {
        console.log(`\n⚠️  ${expiredCount} offers were already expired. Scheduler will process them on next run.`);
    }
}

main().catch(console.error);
