#!/usr/bin/env node
/**
 * Migration script: Initialize Referrals/UnseenRewards for all existing players
 * 
 * Run with: node initializeReferralsUnseenRewards.mjs <env>
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const env = process.argv[2] || 'sandbox';

const credFile = env === 'prod'
    ? './backend-production-mystic-motors-prod.json'
    : './mystic-motors-sandbox-9b64d57718a2.json';

console.log(`\nInitializing Referrals/UnseenRewards for all players`);
console.log(`Environment: ${env}\n`);

const serviceAccount = JSON.parse(readFileSync(credFile, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

async function initializeReferralsUnseenRewards() {
    console.log('Fetching all players...');

    // Get all player documents
    const playersSnapshot = await db.collection('Players').get();

    console.log(`Found ${playersSnapshot.size} players\n`);

    let initialized = 0;
    let skipped = 0;
    let errors = 0;

    // Process in batches of 10 for efficiency
    const BATCH_SIZE = 10;
    const playerDocs = playersSnapshot.docs;

    for (let i = 0; i < playerDocs.length; i += BATCH_SIZE) {
        const batch = playerDocs.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (playerDoc) => {
            const uid = playerDoc.id;
            const referralsUnseenRef = db.doc(`Players/${uid}/Referrals/UnseenRewards`);

            try {
                const doc = await referralsUnseenRef.get();

                if (doc.exists) {
                    console.log(`[SKIP] ${uid} - Already has Referrals/UnseenRewards`);
                    skipped++;
                    return;
                }

                // Create the document
                await referralsUnseenRef.set({
                    unseenRewards: [],
                    totalUnseen: 0,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });

                console.log(`[OK] ${uid} - Initialized Referrals/UnseenRewards`);
                initialized++;

            } catch (error) {
                console.error(`[ERROR] ${uid} - Failed:`, error.message);
                errors++;
            }
        }));
    }

    console.log('\n═══════════════════════════════════════════');
    console.log('✅ MIGRATION COMPLETE');
    console.log('═══════════════════════════════════════════');
    console.log(`Total players: ${playersSnapshot.size}`);
    console.log(`Initialized: ${initialized}`);
    console.log(`Skipped (already exists): ${skipped}`);
    console.log(`Errors: ${errors}`);
    console.log('═══════════════════════════════════════════\n');
}

initializeReferralsUnseenRewards()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('\nFatal error:', err);
        process.exit(1);
    });
