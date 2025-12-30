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

const serviceAccountPath = path.join(__dirname, '..', 'backend-production-mystic-motors-prod.json');

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
    // Verify owner before allowing production seeding
    const { execSync } = require('child_process');
    try {
        const currentUser = execSync('gcloud config get-value account 2>/dev/null', { encoding: 'utf-8' }).trim();
        if (currentUser !== 'tecventurescorp@gmail.com') {
            console.error('❌ ERROR: Only tecventurescorp@gmail.com can seed production!');
            console.error(`   Current user: ${currentUser}`);
            console.error('\n🔐 This is a security measure to prevent unauthorized production changes.');
            process.exit(1);
        }
        console.log(`✅ Verified owner: ${currentUser}\n`);
    } catch (error) {
        console.error('❌ ERROR: Could not verify gcloud user');
        console.error('   Make sure you are authenticated with: gcloud auth login');
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
    const botNamesSeedFile = path.join(seedsRoot, 'BotNamesConfig.json');
    const botConfigSeedFile = path.join(seedsRoot, 'BotConfig.json');

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
