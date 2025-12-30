import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const credFile = './mystic-motors-sandbox-9b64d57718a2.json';
const serviceAccount = JSON.parse(readFileSync(credFile, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

async function checkOffers() {
    const profilesSnap = await db.collectionGroup('Profile').limit(5).get();

    console.log('Checking first 5 players...\n');

    for (const doc of profilesSnap.docs) {
        const uid = doc.ref.parent.parent?.id;
        if (!uid) continue;

        const offersSnap = await db.doc(`Players/${uid}/Offers/Active`).get();

        console.log(`Player ${uid}:`);
        if (offersSnap.exists) {
            const data = offersSnap.data();
            console.log('  Main offer:', data.main ? 'EXISTS' : 'MISSING');
            console.log('  Special offers:', data.special?.length || 0);
            if (data.main) {
                console.log('  Main data:', JSON.stringify(data.main, null, 2));
            }
        } else {
            console.log('  ❌ NO OFFERS DOCUMENT');
        }
        console.log('');
    }
}

checkOffers()
    .then(() => process.exit(0))
    .catch(err => {
        console.error(err);
        process.exit(1);
    });
