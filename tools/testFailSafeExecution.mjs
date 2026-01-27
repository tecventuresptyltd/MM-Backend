import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const credFile = './mystic-motors-sandbox-9b64d57718a2.json';
const serviceAccount = JSON.parse(readFileSync(credFile, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

// Replicating the logic from src/shop/offerFailSafe.ts
// We can't import TS files directly in this environment easily.

async function testExecution() {
    console.log('Testing Fail-Safe Logic Execution...');
    const now = Date.now();
    const expiryThreshold = now - (5 * 60 * 1000);

    // 1. Query
    console.log('1. Querying for stuck offers...');
    const stuckOffersSnap = await db.collectionGroup("Offers")
        .where("main.state", "==", "active")
        .where("main.expiresAt", "<", expiryThreshold)
        .limit(10)
        .get();

    console.log(`   Found ${stuckOffersSnap.size} potentially stuck offers.`);

    if (stuckOffersSnap.empty) {
        console.log('   No offers found. Be sure to run seedStuckOffer.mjs first.');
        return;
    }

    // 2. Process (Simulate recovery)
    for (const doc of stuckOffersSnap.docs) {
        const uid = doc.ref.parent.parent?.id;
        if (!uid) continue;
        const data = doc.data();

        // Filter for our test user to avoid messing with real data during test
        if (!uid.startsWith("TEST_STUCK_OFFER")) {
            console.log(`   Skipping real user ${uid}`);
            continue;
        }

        console.log(`2. Recovering TEST user ${uid}`);
        console.log(`   Offer Expired: ${new Date(data.main.expiresAt).toISOString()}`);

        // Schedule Transition (Write to Queue)
        await db.collection("System/Offers/TransitionQueue").doc(uid).set({
            uid,
            transitionAt: data.main.expiresAt,
            transitionType: "offer_expired",
            tier: data.main.tier,
            createdAt: now,
            triggeredBy: "fail_safe_test"
        });

        console.log(`   ✅ Scheduled recovery transition in Queue!`);
    }
}

testExecution()
    .then(() => process.exit(0))
    .catch(err => {
        console.error("Exec failed:", err);
        process.exit(1);
    });
