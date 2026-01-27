import admin from 'firebase-admin';
import { readFileSync } from 'fs';
// We need to import the function logic, but we can't easily import the .ts file in node directly without build
// So we'll replicate the core logic here for the test script or use ts-node if available.
// Given strict environment, we'll replicate the query logic to VERIFY the query works.

const credFile = './mystic-motors-sandbox-9b64d57718a2.json';
const serviceAccount = JSON.parse(readFileSync(credFile, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

async function runFailSafeVerification() {
    console.log('Running Fail-Safe Query Verification...');
    const now = Date.now();
    const expiryThreshold = now - (5 * 60 * 1000); // 5 mins ago

    try {
        const stuckOffersSnap = await db.collectionGroup("Offers")
            .where("main.state", "==", "active")
            .where("main.expiresAt", "<", expiryThreshold)
            .limit(10)
            .get();

        console.log(`Found ${stuckOffersSnap.size} stuck offers.`);

        stuckOffersSnap.forEach(doc => {
            console.log(`- ${doc.ref.path}`);
            console.log(`  ExpiresAt: ${new Date(doc.data().main.expiresAt).toISOString()}`);
        });

    } catch (error) {
        console.error('❌ Query Failed. Index might be missing.');
        console.error(error.message);
    }
}

runFailSafeVerification()
    .then(() => process.exit(0))
    .catch(console.error);
