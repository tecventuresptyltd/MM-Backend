import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const credFile = './mystic-motors-sandbox-9b64d57718a2.json';
const serviceAccount = JSON.parse(readFileSync(credFile, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

async function checkPlayersCollection() {
    console.log('Checking Players collection...\n');

    // Try the original approach
    const playersSnap = await db.collection('Players').limit(5).get();
    console.log(`Players collection: ${playersSnap.size} documents found`);

    playersSnap.docs.forEach((doc, idx) => {
        console.log(`${idx + 1}. Player ID: ${doc.id}`);
        const data = doc.data();
        console.log(`   Fields: ${Object.keys(data).join(', ')}`);
    });

    console.log('\n---\n');

    // Try collection group approach
    const profilesSnap = await db.collectionGroup('Profile').limit(5).get();
    console.log(`Profile collection group: ${profilesSnap.size} documents found`);

    profilesSnap.docs.forEach((doc, idx) => {
        const uid = doc.ref.parent.parent?.id;
        console.log(`${idx + 1}. UID from parent: ${uid}`);
    });
}

checkPlayersCollection()
    .then(() => process.exit(0))
    .catch(err => {
        console.error(err);
        process.exit(1);
    });
