#!/usr/bin/env node
/**
 * Seed all available offer types for a specific player (for testing).
 * Creates: Main offer + all special offer types
 * 
 * Run with: node seedAllOffers.mjs <env> <uid>
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const env = process.argv[2] || 'sandbox';
const targetUid = process.argv[3];

if (!targetUid) {
    console.error('Usage: node seedAllOffers.mjs <env> <uid>');
    console.error('Example: node seedAllOffers.mjs sandbox WV5oQJ02wROIlYmZukWPwIuuYq63');
    process.exit(1);
}

const credFile = env === 'prod'
    ? './backend-production-mystic-motors-prod.json'
    : './mystic-motors-sandbox-9b64d57718a2.json';

console.log(`\nSeeding ALL offers for player: ${targetUid}`);
console.log(`Environment: ${env}\n`);

const serviceAccount = JSON.parse(readFileSync(credFile, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const now = Date.now();

async function seedAllOffers() {
    const activeRef = db.doc(`Players/${targetUid}/Offers/Active`);
    const stateRef = db.doc(`Players/${targetUid}/Offers/State`);

    // Main offer - using a ladder tier 2 offer (IAP)
    const mainOffer = {
        state: 'active',
        offerId: 'offer_hr9k5zv2', // Tier 2 ladder offer
        offerType: 7, // Ladder type
        expiresAt: now + (24 * 60 * 60 * 1000), // 24 hours
        isStarter: false,
        tier: 2,
    };

    // Special offers - one of each type
    const specialOffers = [
        // Level-up reward (level 5)
        {
            offerId: 'offer_3vv3me0e',
            triggerType: 'level_up',
            expiresAt: now + (48 * 60 * 60 * 1000), // 48 hours
            metadata: { level: 5 },
        },
        // Level-up reward (level 10)
        {
            offerId: 'offer_nzbg5lp4',
            triggerType: 'level_up',
            expiresAt: now + (48 * 60 * 60 * 1000),
            metadata: { level: 10 },
        },
        // Flash sale - missing key
        {
            offerId: 'offer_1fc83c23',
            triggerType: 'flash_missing_key',
            expiresAt: now + (6 * 60 * 60 * 1000), // 6 hours
        },
        // Flash sale - missing crate
        {
            offerId: 'offer_hqfexluh',
            triggerType: 'flash_missing_crate',
            expiresAt: now + (6 * 60 * 60 * 1000), // 6 hours
        },
    ];

    console.log('Creating offers document...');
    console.log(`Main offer: ${mainOffer.offerId} (Tier ${mainOffer.tier} Ladder)`);
    console.log(`Special offers: ${specialOffers.length} types\n`);

    await activeRef.set({
        main: mainOffer,
        special: specialOffers,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log('Creating state document...');
    await stateRef.set({
        starterEligible: true,
        starterShown: true,
        starterPurchased: false,
        tier: 2,
        lastOfferExpiredAt: null,
        lastOfferPurchasedAt: null,
        offersPurchased: 0,
        totalIapPurchases: 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log('\n✅ Successfully seeded all offer types!');
    console.log('\nCreated offers:');
    console.log('───────────────────────────────────────────');
    console.log('MAIN OFFER:');
    console.log(`  • ${mainOffer.offerId} - Tier 2 Ladder (24h)`);
    console.log('\nSPECIAL OFFERS:');
    specialOffers.forEach(offer => {
        const hours = Math.round((offer.expiresAt - now) / (60 * 60 * 1000));
        console.log(`  • ${offer.offerId} - ${offer.triggerType} (${hours}h)`);
    });
    console.log('───────────────────────────────────────────\n');
    console.log('View in Firebase Console:');
    console.log(`Players/${targetUid}/Offers/Active\n`);
}

seedAllOffers()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('\nFatal error:', err);
        process.exit(1);
    });
