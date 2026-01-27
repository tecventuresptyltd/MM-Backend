import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const credFile = './mystic-motors-sandbox-9b64d57718a2.json';
const serviceAccount = JSON.parse(readFileSync(credFile, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

// Use a known test/dev UID if possible, or create a random one
// Here we'll use a specific ID to track it
const TEST_UID = "TEST_STUCK_OFFER_" + Date.now();

async function seedStuckOffer() {
    console.log(`Seeding stuck offer for ${TEST_UID}...`);
    const now = Date.now();
    const oneHourAgo = now - (60 * 60 * 1000);

    // Create a stuck offer:
    // 1. State = Active
    // 2. ExpiresAt = 1 hour ago
    // 3. NO TransitionQueue entry (simulating a crash/failure)

    await db.doc(`Players/${TEST_UID}/Offers/Active`).set({
        main: {
            offerId: "test_stuck_offer",
            offerType: 1,
            tier: 0,
            state: "active",
            expiresAt: oneHourAgo,
            isStarter: false
        },
        special: []
    });

    console.log(`✅ Seeded stuck offer for ${TEST_UID}`);
    console.log(`   ExpiresAt: ${new Date(oneHourAgo).toISOString()}`);
    console.log(`   (Current Time: ${new Date(now).toISOString()})`);

    return TEST_UID;
}

seedStuckOffer()
    .then((uid) => {
        console.log(`Use this UID to check recovery: ${uid}`);
        process.exit(0);
    })
    .catch(console.error);
