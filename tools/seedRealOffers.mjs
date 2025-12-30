#!/usr/bin/env node
/**
 * Seed REAL offers (from actual catalog) for GUI testing.
 * Uses actual offer IDs that match gameDataCatalogs.v3.normalized.json
 * 
 * Run with: node seedRealOffers.mjs <env> <uid>
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const env = process.argv[2] || 'sandbox';
const targetUid = process.argv[3];

if (!targetUid) {
    console.error('Usage: node seedRealOffers.mjs <env> <uid>');
    console.error('Example: node seedRealOffers.mjs sandbox WV5oQJ02wROIlYmZukWPwIuuYq63');
    process.exit(1);
}

const credFile = env === 'prod'
    ? './backend-production-mystic-motors-prod.json'
    : './mystic-motors-sandbox-9b64d57718a2.json';

console.log(`\nSeeding REAL offers for: ${targetUid}`);
console.log(`Environment: ${env}\n`);

const serviceAccount = JSON.parse(readFileSync(credFile, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const now = Date.now();

// REAL OFFER IDS from gameDataCatalogs.v3.normalized.json
const CATALOG_OFFERS = {
    starter: 'offer_3jaky2p2',      // Type 0
    daily1: 'offer_kn1k91mn',        // Type 1
    daily2: 'offer_bfnnjavw',        // Type 2  
    daily3: 'offer_g3dxevzg',        // Type 3
    daily4: 'offer_edcayzxw',        // Type 4
    tier0: 'offer_bwebp6s4',         // Type 5 - Gem Surge
    tier1: 'offer_z5k1130z',         // Type 6 - Gemstream
    tier2: 'offer_nymn2fmt',         // Type 7 - Fortune Fuel
    tier3: 'offer_k1v1vt5f',         // Type 8 - Jackpot Journey
};

async function seedRealOffers() {
    const activeRef = db.doc(`Players/${targetUid}/Offers/Active`);
    const stateRef = db.doc(`Players/${targetUid}/Offers/State`);

    // Main offer - Daily Type 2 (matches what functions would create)
    const mainOffer = {
        state: 'active',
        offerId: CATALOG_OFFERS.daily2,
        offerType: 2,
        expiresAt: now + (24 * 60 * 60 * 1000), // 24 hours
        isStarter: false,
        tier: 0,
    };

    // Special offers - NO level-up offers (not at milestone)
    // Only flash sales for GUI testing
    const specialOffers = [
        {
            offerId: CATALOG_OFFERS.tier0, // flash uses tier offers as placeholders
            triggerType: 'flash_missing_key',
            expiresAt: now + (6 * 60 * 60 * 1000), // 6 hours
        },
        {
            offerId: CATALOG_OFFERS.tier1, // flash uses tier offers as placeholders
            triggerType: 'flash_missing_crate',
            expiresAt: now + (6 * 60 * 60 * 1000),
        },
    ];

    console.log('✅ Using REAL offer IDs from catalog:');
    console.log(`   Main: ${mainOffer.offerId} (Daily II - Type ${mainOffer.offerType})`);
    specialOffers.forEach(o => {
        console.log(`   Special: ${o.offerId} (${o.triggerType})`);
    });
    console.log('');

    await activeRef.set({
        main: mainOffer,
        special: specialOffers,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await stateRef.set({
        starterEligible: true,
        starterShown: false, // haven't seen starter yet
        starterPurchased: false,
        tier: 0,
        lastOfferExpiredAt: null,
        lastOfferPurchasedAt: null,
        offersPurchased: 0,
        totalIapPurchases: 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log('═══════════════════════════════════════════');
    console.log('✅ REAL OFFERS SEEDED SUCCESSFULLY');
    console.log('═══════════════════════════════════════════');
    console.log('Main Offer:');
    console.log(`  ${mainOffer.offerId} - Daily Offer II`);
    console.log(`  Type: ${mainOffer.offerType}, Status: ${mainOffer.state}`);
    console.log(`  Expires: 24h from now`);
    console.log('');
    console.log('Special Offers:');
    specialOffers.forEach(o => {
        const hours = Math.round((o.expiresAt - now) / (60 * 60 * 1000));
        console.log(`  ${o.offerId} - ${o.triggerType} (${hours}h)`);
    });
    console.log('═══════════════════════════════════════════');
    console.log(`\nFirebase path: Players/${targetUid}/Offers/Active`);
}

seedRealOffers()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('\nFatal error:', err);
        process.exit(1);
    });
