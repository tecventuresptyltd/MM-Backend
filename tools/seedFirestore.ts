/**
 * Seed all catalogs to Firestore from the seed files
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const serviceAccount = require('../mystic-motors-sandbox-2831a79c5ae0.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'mystic-motors-sandbox'
});

const db = admin.firestore();

async function seedCatalogs() {
  console.log('🌱 Starting catalog seeding...\n');

  const seedFile = path.join(__dirname, '..', 'seeds', 'Atul-Final-Seeds', 'gameDataCatalogs.v3.normalized.json');
  
  if (!fs.existsSync(seedFile)) {
    console.error('❌ Seed file not found:', seedFile);
    process.exit(1);
  }

  const seedData = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));

  console.log(`📦 Found ${seedData.length} catalogs to seed\n`);

  for (const catalog of seedData) {
    try {
      console.log(`📦 Seeding ${catalog.path}...`);
      await db.doc(catalog.path).set(catalog.data);
      console.log(`✅ ${catalog.path} seeded successfully`);
    } catch (error) {
      console.error(`❌ Error seeding ${catalog.path}:`, error);
    }
  }

  console.log('\n✅ All catalogs seeded successfully!\n');
  process.exit(0);
}

seedCatalogs().catch((error) => {
  console.error('❌ Seeding failed:', error);
  process.exit(1);
});
