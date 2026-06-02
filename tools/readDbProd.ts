import * as admin from 'firebase-admin';

const serviceAccount = require('../backend-production-mystic-motors-prod.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'mystic-motors-prod'
});

const db = admin.firestore();

async function run() {
  const budgetSnap = await db.doc('GameData/v1/config/CarStatsBudgetConfig').get();
  console.log('--- CarStatsBudgetConfig ---');
  if (budgetSnap.exists) {
    console.log(JSON.stringify(budgetSnap.data(), null, 2));
  } else {
    console.log('Not found');
  }

  const catalogSnap = await db.doc('GameData/v1/catalogs/CarsCatalog').get();
  console.log('--- CarsCatalog Version ---');
  if (catalogSnap.exists) {
    const data = catalogSnap.data();
    console.log('Version:', data?.version);
    console.log('Updated:', data?.updatedAt);
    console.log('Mitsabi Eon (car_h4ayzwf31g) L1:', JSON.stringify(data?.cars?.car_h4ayzwf31g?.levels?.['1']));
    console.log('Doge Chaser (car_1wp1gr2p) L1:', JSON.stringify(data?.cars?.car_1wp1gr2p?.levels?.['1']));
  } else {
    console.log('Not found');
  }

  process.exit(0);
}

run().catch(console.error);
