import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const credFile = './mystic-motors-sandbox-9b64d57718a2.json';
const serviceAccount = JSON.parse(readFileSync(credFile, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

async function checkMaintenanceState() {
    // Check current maintenance config
    const maintenanceSnap = await db.doc('GameConfig/maintenance').get();
    console.log('Current Maintenance Config:');
    console.log(JSON.stringify(maintenanceSnap.data(), null, 2));
    console.log('\n');

    // Check maintenance history
    const historySnap = await db.collection('MaintenanceHistory').orderBy('startedAt', 'desc').limit(3).get();
    console.log(`Found ${historySnap.size} maintenance history entries:\n`);

    historySnap.docs.forEach((doc, idx) => {
        console.log(`${idx + 1}. History ID: ${doc.id}`);
        console.log(JSON.stringify(doc.data(), null, 2));
        console.log('');
    });

    // Check a few players' unseen rewards
    const profilesSnap = await db.collectionGroup('Profile').limit(3).get();
    console.log('Sample player unseen rewards:\n');

    for (const doc of profilesSnap.docs) {
        const uid = doc.ref.parent.parent?.id;
        if (!uid) continue;

        const unseenSnap = await db.doc(`Players/${uid}/Maintenance/UnseenRewards`).get();
        const data = unseenSnap.data();

        console.log(`Player ${uid}:`);
        if (unseenSnap.exists) {
            console.log(`  Total unseen: ${data.totalUnseen || 0}`);
            console.log(`  Rewards: ${JSON.stringify(data.unseenRewards || [], null, 2)}`);
        } else {
            console.log('  No UnseenRewards document');
        }
        console.log('');
    }
}

checkMaintenanceState()
    .then(() => process.exit(0))
    .catch(err => {
        console.error(err);
        process.exit(1);
    });
