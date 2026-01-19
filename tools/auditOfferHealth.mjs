/**
 * Comprehensive audit of offer system health.
 * Checks all player accounts for problematic states.
 * Run with: node tools/auditOfferHealth.mjs
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

async function main() {
    console.log("🔍 Comprehensive Offer System Audit\n");
    const now = Date.now();

    const stats = {
        totalPlayers: 0,
        withProfile: 0,
        withActiveOffers: 0,
        withMainOffer: 0,

        // Offer states
        activeOffers: 0,
        cooldownOffers: 0,
        purchaseDelayOffers: 0,

        // Problems
        expiredActive: 0,          // Active offers that are expired (BAD)
        expiredWithQueue: 0,       // Expired with queue entry (will be processed)
        expiredWithoutQueue: 0,    // Expired WITHOUT queue entry (CRITICAL)
        activeWithoutQueue: 0,     // Active offers without queue entry (will break when expired)

        // Queue
        totalQueueEntries: 0,
        overdueQueueEntries: 0,
    };

    const problemAccounts = [];

    // Get all players
    console.log("📋 Scanning all players...");
    const playersSnap = await db.collection("Players").limit(10000).get();
    stats.totalPlayers = playersSnap.size;
    console.log(`   Found ${stats.totalPlayers} players\n`);

    // Build map of queue entries for fast lookup
    console.log("📋 Loading transition queue...");
    const queueSnap = await db.collection(TRANSITION_QUEUE_PATH).get();
    const queueMap = new Map();
    for (const doc of queueSnap.docs) {
        queueMap.set(doc.id, doc.data());
        stats.totalQueueEntries++;
        if (doc.data().transitionAt <= now) {
            stats.overdueQueueEntries++;
        }
    }
    console.log(`   Found ${stats.totalQueueEntries} queue entries, ${stats.overdueQueueEntries} overdue\n`);

    console.log("📋 Auditing each player...");
    let scanned = 0;

    for (const playerDoc of playersSnap.docs) {
        const uid = playerDoc.id;
        scanned++;

        if (scanned % 1000 === 0) {
            console.log(`   Progress: ${scanned}/${stats.totalPlayers}`);
        }

        try {
            // Check profile
            const profileSnap = await db.doc(`Players/${uid}/Profile/Profile`).get();
            if (profileSnap.exists) {
                stats.withProfile++;
            }

            // Check active offers
            const activeSnap = await db.doc(`Players/${uid}/Offers/Active`).get();
            if (!activeSnap.exists) {
                continue;
            }
            stats.withActiveOffers++;

            const activeData = activeSnap.data();
            const main = activeData?.main;

            if (!main || !main.offerId) {
                continue;
            }
            stats.withMainOffer++;

            // Check state
            if (main.state === "active") {
                stats.activeOffers++;

                const isExpired = main.expiresAt && main.expiresAt <= now;
                const hasQueueEntry = queueMap.has(uid);

                if (isExpired) {
                    stats.expiredActive++;
                    if (hasQueueEntry) {
                        stats.expiredWithQueue++;
                    } else {
                        stats.expiredWithoutQueue++;
                        const expiredMinutes = Math.floor((now - main.expiresAt) / 60000);
                        problemAccounts.push({
                            uid,
                            problem: "EXPIRED_NO_QUEUE",
                            expiredMinutes,
                            offerId: main.offerId,
                        });
                    }
                } else if (!hasQueueEntry) {
                    stats.activeWithoutQueue++;
                    problemAccounts.push({
                        uid,
                        problem: "ACTIVE_NO_QUEUE",
                        expiresInMinutes: Math.floor((main.expiresAt - now) / 60000),
                        offerId: main.offerId,
                    });
                }
            } else if (main.state === "cooldown") {
                stats.cooldownOffers++;
            } else if (main.state === "purchase_delay") {
                stats.purchaseDelayOffers++;
            }
        } catch (error) {
            // Skip errors
        }
    }

    // Print results
    console.log("\n" + "=".repeat(60));
    console.log("📊 AUDIT RESULTS");
    console.log("=".repeat(60));

    console.log("\n📋 Player Statistics:");
    console.log(`   Total players: ${stats.totalPlayers}`);
    console.log(`   With profile: ${stats.withProfile}`);
    console.log(`   With Offers/Active doc: ${stats.withActiveOffers}`);
    console.log(`   With main offer: ${stats.withMainOffer}`);

    console.log("\n📋 Offer States:");
    console.log(`   Active: ${stats.activeOffers}`);
    console.log(`   Cooldown: ${stats.cooldownOffers}`);
    console.log(`   Purchase Delay: ${stats.purchaseDelayOffers}`);

    console.log("\n📋 Queue Statistics:");
    console.log(`   Total queue entries: ${stats.totalQueueEntries}`);
    console.log(`   Overdue entries: ${stats.overdueQueueEntries}`);

    console.log("\n" + "=".repeat(60));
    console.log("🚨 PROBLEMS");
    console.log("=".repeat(60));

    console.log(`\n⚠️  Expired offers (still showing): ${stats.expiredActive}`);
    console.log(`   With queue entry (will be fixed): ${stats.expiredWithQueue}`);
    console.log(`   WITHOUT queue entry (BROKEN): ${stats.expiredWithoutQueue}`);

    console.log(`\n⚠️  Active offers without queue: ${stats.activeWithoutQueue}`);
    console.log(`   (Will break when they expire)`);

    if (problemAccounts.length > 0) {
        console.log("\n📋 Sample problem accounts (first 10):");
        problemAccounts.slice(0, 10).forEach(acc => {
            console.log(`   ${acc.uid}: ${acc.problem} (${acc.expiredMinutes || acc.expiresInMinutes} min)`);
        });
    }

    if (stats.expiredWithoutQueue > 0 || stats.activeWithoutQueue > 0) {
        console.log("\n🚨 ACTION NEEDED: Re-run queue population script!");
    } else if (stats.overdueQueueEntries > 5) {
        console.log("\n⚠️  WARNING: Many overdue queue entries - scheduler may be delayed");
    } else {
        console.log("\n✅ System appears healthy!");
    }

    console.log("\n✅ Audit complete!");
}

main().catch(console.error);
