/**
 * Seed all catalogs to Firestore PRODUCTION environment
 * 
 * IMPORTANT: This script requires the backend-production service account key file
 * to be present at: ../backend-production-mystic-motors-prod.json
 * 
 * To download the service account key:
 * 1. Go to Google Cloud Console → IAM & Admin → Service Accounts
 * 2. Find: backend-production@mystic-motors-prod.iam.gserviceaccount.com
 * 3. Click "Manage Keys" → "Add Key" → "Create new key" → JSON
 * 4. Save as: backend-production-mystic-motors-prod.json in the root directory
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const serviceAccountPath = path.join(__dirname, '..', 'mystic-motors-prod-8c9cbf7066fa.json');

if (!fs.existsSync(serviceAccountPath)) {
    console.error('❌ ERROR: Production service account key not found!');
    console.error('📍 Expected location:', serviceAccountPath);
    console.error('\n📝 To download the service account key:');
    console.error('   1. Go to Google Cloud Console → IAM & Admin → Service Accounts');
    console.error('   2. Find: backend-production@mystic-motors-prod.iam.gserviceaccount.com');
    console.error('   3. Click "Manage Keys" → "Add Key" → "Create new key" → JSON');
    console.error('   4. Save as: backend-production-mystic-motors-prod.json in the repo root\n');
    process.exit(1);
}

const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'mystic-motors-prod'
});

const db = admin.firestore();

async function seedCatalogs() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const password = await new Promise<string>(resolve => {
        rl.question('🔒 Enter Production Password: ', resolve);
    });
    rl.close();

    const envPath = path.join(__dirname, '..', '.env.mystic-motors-prod');
    let expectedPassword = 'MysticDeploy2026';
    if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const match = envContent.match(/^DEPLOY_PASSWORD=(.*)$/m);
        if (match && match[1]) {
            expectedPassword = match[1].trim();
        }
    }

    if (password !== expectedPassword) {
        console.error('\n❌ Incorrect password. Seeding cancelled.');
        process.exit(1);
    }

    console.log('🚀 Starting PRODUCTION catalog seeding...\n');
    console.log('⚠️  WARNING: You are seeding the PRODUCTION environment!');
    console.log('⚠️  This will overwrite existing catalog data in production.\n');

    // Add a 3-second delay to allow cancellation
    console.log('⏳ Starting in 3 seconds... (Press Ctrl+C to cancel)');
    await new Promise(resolve => setTimeout(resolve, 3000));

    const seedsRoot = path.join(__dirname, '..', 'seeds', 'Atul-Final-Seeds');
    const seedFile = path.join(seedsRoot, 'gameDataCatalogs.v3.normalized.json');
    if (!fs.existsSync(seedFile)) {
        console.error('❌ Seed file not found:', seedFile);
        process.exit(1);
    }

    const seedData = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));

    // Configs to load
    const configFiles = [
        'BotNamesConfig',
        'BotConfig',
        'SpellUpgradeCosts',
        'CarTuningConfig',
        'CarStatsBudgetConfig',
        'CrateRewardsConfig',
        'CrateSlotsConfig',
        'DailyRewardsConfig',
        'FuelConfig',
        'MasteryConfig',
        'PlayerSlotsConfig',
        'ShopPricingConfig',
        'SpeedUpsCatalog',
        'StarterCrateConfig'
    ];

    for (const configName of configFiles) {
        const file = path.join(seedsRoot, `${configName}.json`);
        if (fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (Array.isArray(data)) {
                seedData.push(...data);
            } else if (data && data.path && data.data) {
                seedData.push(data);
            } else {
                seedData.push({ path: `/GameData/v1/config/${configName}`, data });
            }
        }
    }

    // Additional Catalogs to load
    const catalogFiles = [
        'BoostersCatalog',
        'CarEvolutionV2Catalog',
        'SpellEvolutionV2Catalog',
        'TiersCatalog',
        'XpCurve'
    ];

    for (const catalogName of catalogFiles) {
        const file = path.join(seedsRoot, `${catalogName}.json`);
        if (fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (Array.isArray(data)) {
                seedData.push(...data);
            } else if (data && data.path && data.data) {
                seedData.push(data);
            } else {
                seedData.push({ path: `/GameData/v1/catalogs/${catalogName}`, data });
            }
        }
    }

    console.log(`\n📦 Found ${seedData.length} catalogs to seed\n`);

    for (const catalog of seedData) {
        try {
            console.log(`📦 Seeding ${catalog.path}...`);
            await db.doc(catalog.path).set(catalog.data);
            console.log(`✅ ${catalog.path} seeded successfully`);
        } catch (error) {
            console.error(`❌ Error seeding ${catalog.path}:`, error);
        }
    }

    console.log('\n✅ All PRODUCTION catalogs seeded successfully!\n');
    process.exit(0);
}

seedCatalogs().catch((error) => {
    console.error('❌ PRODUCTION seeding failed:', error);
    process.exit(1);
});
