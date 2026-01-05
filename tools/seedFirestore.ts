/**
 * Seed all catalogs to Firestore from the seed files
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const serviceAccount = require('../mystic-motors-sandbox-9b64d57718a2.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'mystic-motors-sandbox'
});

const db = admin.firestore();

async function seedCatalogs() {
  console.log('🌱 Starting catalog seeding...\n');

  const seedsRoot = path.join(__dirname, '..', 'seeds', 'Atul-Final-Seeds');
  const seedFile = path.join(seedsRoot, 'gameDataCatalogs.v3.normalized.json');
  const botNamesSeedFile = path.join(seedsRoot, 'BotNamesConfig.json');
  const botConfigSeedFile = path.join(seedsRoot, 'BotConfig.json');
  const spellUpgradeCostsSeedFile = path.join(seedsRoot, 'SpellUpgradeCosts.json');
  const carTuningConfigSeedFile = path.join(seedsRoot, 'CarTuningConfig.json');

  if (!fs.existsSync(seedFile)) {
    console.error('❌ Seed file not found:', seedFile);
    process.exit(1);
  }

  const seedData = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));

  // Add BotNamesConfig if it exists
  if (fs.existsSync(botNamesSeedFile)) {
    const botNamesDoc = JSON.parse(fs.readFileSync(botNamesSeedFile, 'utf-8'));
    if (Array.isArray(botNamesDoc)) {
      seedData.push(...botNamesDoc);
    } else if (botNamesDoc && typeof botNamesDoc === 'object') {
      seedData.push(botNamesDoc);
    }
  }

  // Add BotConfig if it exists
  if (fs.existsSync(botConfigSeedFile)) {
    const botConfigDoc = JSON.parse(fs.readFileSync(botConfigSeedFile, 'utf-8'));
    if (botConfigDoc && typeof botConfigDoc === 'object') {
      seedData.push(botConfigDoc);
    }
  }

  // Add SpellUpgradeCosts if it exists
  if (fs.existsSync(spellUpgradeCostsSeedFile)) {
    const spellUpgradeCostsDoc = JSON.parse(fs.readFileSync(spellUpgradeCostsSeedFile, 'utf-8'));
    if (spellUpgradeCostsDoc && typeof spellUpgradeCostsDoc === 'object') {
      seedData.push(spellUpgradeCostsDoc);
    }
  }

  // Add CarTuningConfig if it exists
  if (fs.existsSync(carTuningConfigSeedFile)) {
    const carTuningConfigDoc = JSON.parse(fs.readFileSync(carTuningConfigSeedFile, 'utf-8'));
    if (carTuningConfigDoc && typeof carTuningConfigDoc === 'object') {
      seedData.push(carTuningConfigDoc);
    }
  }

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
