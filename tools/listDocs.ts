import * as admin from 'firebase-admin';

const serviceAccount = require('../mystic-motors-sandbox-9b64d57718a2.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'mystic-motors-sandbox'
});

const db = admin.firestore();

async function run() {
  const catalogsSnap = await db.collection('GameData/v1/catalogs').listDocuments();
  console.log('--- Catalogs ---');
  for (const doc of catalogsSnap) {
    console.log(doc.path);
  }

  const configsSnap = await db.collection('GameData/v1/config').listDocuments();
  console.log('--- Configs ---');
  for (const doc of configsSnap) {
    console.log(doc.path);
  }

  process.exit(0);
}

run().catch(console.error);
