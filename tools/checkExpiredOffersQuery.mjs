import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const credFile = './mystic-motors-sandbox-9b64d57718a2.json';
const serviceAccount = JSON.parse(readFileSync(credFile, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

async function checkQuery() {
    console.log('Attempting to query expired active offers...');
    const now = Date.now();

    // We want to find offers that are ACTIVE but EXPIRED
    // This requires an index on 'main.state' and 'main.expiresAt'
    try {
        const query = db.collectionGroup('Offers')
            .where('main.state', '==', 'active')
            .where('main.expiresAt', '<', now)
            .limit(10);

        const snap = await query.get();

        console.log(`Query successful! Found ${snap.size} stuck offers.`);
        snap.forEach(doc => {
            console.log(`- ${doc.ref.path}: Expired at ${new Date(doc.data().main.expiresAt).toISOString()}`);
        });

    } catch (error) {
        console.error('Query failed (likely needs index):');
        console.error(error.message);
    }
}

checkQuery()
    .then(() => process.exit(0))
    .catch(console.error);
