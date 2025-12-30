#!/usr/bin/env node
/**
 * Simple standalone script to initialize offers for all existing players.
 * Run with: node initializeOffers.js <env>
 * Example: node initializeOffers.js sandbox
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const env = process.argv[2] || 'sandbox';
const credFile = env === 'prod'
    ? './backend-production-mystic-motors-prod.json'
    : './mystic-motors-sandbox-9b64d57718a2.json';

console.log(`\nInitializing Firebase for ${env}...`);
console.log(`Using credentials: ${credFile}\n`);

const serviceAccount = JSON.parse(readFileSync(credFile, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const now = Date.now();

// Hardcoded daily offer IDs from catalog
const dailyOfferIds = [
    'offer_bwebp6s4', // Daily I
    'offer_lj8amwse', // Daily II  
    'offer_y01n85xc', // Daily III
    'offer_7h4e5g5c', // Daily IV
];

async function initializePlayer(uid) {
    const activeRef = db.doc(`Players/${uid}/Offers/Active`);
    const stateRef = db.doc(`Players/${uid}/Offers/State`);

    const [activeSnap, stateSnap] = await Promise.all([
        activeRef.get(),
        stateRef.get(),
    ]);

    // Skip if already has main offer
    if (activeSnap.exists && activeSnap.data()?.main) {
        return { initialized: false, reason: 'already_has_offer' };
    }

    // Select random daily offer
    const randomIndex = Math.floor(Math.random() * dailyOfferIds.length);
    const offerId = dailyOfferIds[randomIndex];
    const offerType = randomIndex + 1;

    await db.runTransaction(async (txn) => {
        txn.set(activeRef, {
            main: {
                offerId,
                offerType,
                expiresAt: now + (24 * 60 * 60 * 1000), // 24 hours
                tier: 0,
                state: 'active',
                isStarter: false,
            },
            special: [],
            updatedAt: now,
        });

        txn.set(stateRef, {
            starterEligible: false,
            starterShown: true,
            starterPurchased: false,
            tier: 0,
            offersPurchased: [],
            totalIapPurchases: 0,
            updatedAt: now,
        });
    });

    return { initialized: true, offerId };
}

async function main() {
    console.log('Fetching all players...\n');

    const profilesSnap = await db
        .collectionGroup('Profile')
        .get();

    console.log(`Found ${profilesSnap.size} profile documents\n`);

    // Extract unique player UIDs
    const playerUids = new Set();
    profilesSnap.docs.forEach(doc => {
        const uid = doc.ref.parent.parent?.id;
        if (uid) playerUids.add(uid);
    });

    console.log(`Found ${playerUids.size} unique players\n`);
    console.log('Initializing offers...\n');

    let initialized = 0;
    let skipped = 0;
    let errors = 0;

    const BATCH_SIZE = 10;
    const uids = Array.from(playerUids);

    for (let i = 0; i < uids.length; i += BATCH_SIZE) {
        const batch = uids.slice(i, i + BATCH_SIZE);

        const results = await Promise.allSettled(
            batch.map(uid => initializePlayer(uid))
        );

        results.forEach((r, idx) => {
            const processed = i + idx + 1;
            if (r.status === 'fulfilled') {
                if (r.value.initialized) {
                    initialized++;
                    console.log(`✅ ${processed}/${uids.length} - Initialized`);
                } else {
                    skipped++;
                }
            } else {
                errors++;
                console.error(`❌ ${processed}/${uids.length} - Error: ${r.reason}`);
            }
        });
    }

    console.log('\n' + '='.repeat(50));
    console.log('Migration Complete!');
    console.log('='.repeat(50));
    console.log(`Initialized: ${initialized}`);
    console.log(`Skipped: ${skipped}`);
    console.log(`Errors: ${errors}`);
    console.log('='.repeat(50) + '\n');
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('\nFatal error:', err);
        process.exit(1);
    });
