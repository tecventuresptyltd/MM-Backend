/**
 * Manually process overdue offer transitions.
 * Simulates what the scheduler would do.
 * Run with: node tools/processOverdueTransitions.mjs
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// Initialize with Application Default Credentials
initializeApp({
    credential: applicationDefault(),
    projectId: "mystic-motors-prod",
});

const db = getFirestore();
const TRANSITION_QUEUE_PATH = "System/Offers/TransitionQueue";
const POST_EXPIRY_COOLDOWN_MS = 30 * 60 * 1000; // 30 min cooldown

async function main() {
    console.log("🔧 Processing Overdue Transitions Manually\n");
    const now = Date.now();

    // Get all overdue transitions
    const overdueSnap = await db
        .collection(TRANSITION_QUEUE_PATH)
        .where("transitionAt", "<=", now)
        .limit(500)
        .get();

    console.log(`📋 Found ${overdueSnap.size} overdue transitions\n`);

    if (overdueSnap.size === 0) {
        console.log("✅ No overdue transitions to process!");
        return;
    }

    let processed = 0;
    let errors = 0;

    for (const doc of overdueSnap.docs) {
        const transition = doc.data();
        const uid = transition.uid;

        try {
            await db.runTransaction(async (transaction) => {
                const activeRef = db.doc(`Players/${uid}/Offers/Active`);
                const stateRef = db.doc(`Players/${uid}/Offers/State`);
                const queueRef = doc.ref;

                const activeSnap = await transaction.get(activeRef);
                const main = activeSnap.data()?.main;

                // If no main offer or not in correct state, just delete the queue entry
                if (!main || main.state !== "active") {
                    transaction.delete(queueRef);
                    return;
                }

                // Transition to cooldown
                const newTier = Math.max(0, (main.tier || 0) - 2);
                const cooldownEndsAt = now + POST_EXPIRY_COOLDOWN_MS;

                transaction.update(activeRef, {
                    "main.state": "cooldown",
                    "main.nextOfferAt": cooldownEndsAt,
                    "main.tier": newTier,
                    updatedAt: now,
                });

                transaction.set(stateRef, {
                    tier: newTier,
                    lastOfferExpiredAt: now,
                    updatedAt: now,
                }, { merge: true });

                // Update queue entry for cooldown_end
                transaction.set(queueRef, {
                    uid,
                    transitionAt: cooldownEndsAt,
                    transitionType: "cooldown_end",
                    tier: newTier,
                    createdAt: now,
                });
            });

            processed++;
            if (processed % 50 === 0) {
                console.log(`Progress: ${processed}/${overdueSnap.size} processed`);
            }
        } catch (error) {
            errors++;
            console.error(`Error processing ${uid}:`, error.message);
        }
    }

    console.log("\n✅ Complete!");
    console.log(`   Processed: ${processed}`);
    console.log(`   Errors: ${errors}`);

    if (overdueSnap.size === 500) {
        console.log("\n⚠️  Hit batch limit - run again to process more!");
    }
}

main().catch(console.error);
