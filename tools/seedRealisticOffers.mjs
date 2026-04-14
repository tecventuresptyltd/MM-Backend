#!/usr/bin/env node
/**
 * Seed realistic offers for a specific player based on their actual data.
 * 
 * Run with: node seedRealisticOffers.mjs <env> <uid>
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const env = process.argv[2] || 'sandbox';
const targetUid = process.argv[3];

if (!targetUid) {
    console.error('Usage: node seedRealisticOffers.mjs <env> <uid>');
    console.error('Example: node seedRealisticOffers.mjs sandbox WV5oQJ02wROIlYmZukWPwIuuYq63');
    process.exit(1);
}

const credFile = env === 'prod'
    ? './backend-production-mystic-motors-prod.json'
    : './mystic-motors-sandbox-9b64d57718a2.json';

console.log(`\nSeeding realistic offers for: ${targetUid}`);
console.log(`Environment: ${env}\n`);

const serviceAccount = JSON.parse(readFileSync(credFile, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();
const now = Date.now();

// Available daily/ladder offers from catalog
const DAILY_OFFERS = [
    { offerId: 'offer_ignition_starter' },
    { offerId: 'offer_fuel_emergency' },
    { offerId: 'offer_nitro_surge' },
    { offerId: 'offer_adrenaline_shot' },
];

async function seedRealisticOffers() {
    console.log('Fetching player data...\n');

    // Get player's current state
    const profileSnap = await db.doc(`Players/${targetUid}/Profile/Profile`).get();

    if (!profileSnap.exists) {
        throw new Error(`Player ${targetUid} not found`);
    }

    const profileData = profileSnap.data();
    const level = profileData.level || 1;
    const totalRaces = profileData.totalRaces || 0;

    console.log(`Player Level: ${level}`);
    console.log(`Total Races: ${totalRaces}\n`);

    // Pick a random daily offer (as the function would)
    const randomDaily = DAILY_OFFERS[Math.floor(Math.random() * DAILY_OFFERS.length)];
    const mainOffer = {
        state: 'active',
        offerId: randomDaily.offerId,
        offerType: 1, // Legacy integer shim
        expiresAt: now + (24 * 60 * 60 * 1000), // 24 hours from now
        isStarter: false,
        tier: 0,
    };

    console.log(`Main offer: ${mainOffer.offerId}`);

    // Determine special offers based on actual data
    const specialOffers = [];

    // Add level-up offer if player is at milestone level (5, 10, or 20)
    if (level === 5) {
        specialOffers.push({
            offerId: 'offer_lvl10_milestone', // Our new ID for Mastery Rank 5
            triggerType: 'mastery_rank_5',
            expiresAt: now + (24 * 60 * 60 * 1000),
            metadata: { level: 5 },
        });
        console.log('  + Mastery 5 milestone offer');
    } else if (level === 10) {
        specialOffers.push({
            offerId: 'offer_lvl20_milestone', // Our new ID for Mastery Rank 10
            triggerType: 'mastery_rank_10',
            expiresAt: now + (24 * 60 * 60 * 1000),
            metadata: { level: 10 },
        });
        console.log('  + Mastery 10 milestone offer');
    }

    // Add contextual sales (these would be triggered by game state checks in real function)
    specialOffers.push({
        offerId: 'offer_resource_rush',
        triggerType: 'fuel_empty',
        expiresAt: now + (4 * 60 * 60 * 1000), // 4 hours
    });
    console.log('  + Contextual: Fuel Empty');

    specialOffers.push({
        offerId: 'offer_double_clutch',
        triggerType: 'weekend',
        expiresAt: now + (24 * 60 * 60 * 1000),
    });
    console.log('  + Event: Weekend Double Clutch');

    console.log(`\nTotal special offers: ${specialOffers.length}\n`);

    // Write to Firestore (exactly as the function would)
    const activeRef = db.doc(`Players/${targetUid}/Offers/Active`);
    const stateRef = db.doc(`Players/${targetUid}/Offers/State`);

    await activeRef.set({
        main: mainOffer,
        special: specialOffers,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await stateRef.set({
        starterEligible: totalRaces >= 2,
        starterShown: totalRaces >= 2,
        starterPurchased: false,
        tier: 0,
        lastOfferExpiredAt: null,
        lastOfferPurchasedAt: null,
        offersPurchased: 0,
        totalIapPurchases: 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log('✅ Successfully seeded realistic offers!\n');
    console.log('═══════════════════════════════════════════');
    console.log('OFFERS CREATED:');
    console.log('═══════════════════════════════════════════');
    console.log('Main:');
    console.log(`  • ${mainOffer.offerId} - ${mainOffer.state} (24h validity)`);

    console.log('\nSpecial:');
    specialOffers.forEach(offer => {
        const hours = Math.round((offer.expiresAt - now) / (60 * 60 * 1000));
        const meta = offer.metadata ? ` - Level ${offer.metadata.level}` : '';
        console.log(`  • ${offer.offerId} - ${offer.triggerType}${meta} (${hours}h)`);
    });
    console.log('═══════════════════════════════════════════\n');
    console.log(`Firebase path: Players/${targetUid}/Offers/Active\n`);
}

seedRealisticOffers()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('\nFatal error:', err);
        process.exit(1);
    });
