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

    // Main offer - Using Sweet Spot test offer
    const mainOffer = {
        state: 'active',
        offerId: 'offer_mechanics_choice',
        offerType: 5, // Legacy integer shim (5 = Tier 1 Ladder equivalent)
        expiresAt: now + (48 * 60 * 60 * 1000), // 48 hours for sweet spot
        isStarter: false,
        tier: 1,
    };

    // Special offers - all other 29 offers
    const specialOffers = [
        { offerId: 'offer_ignition_starter', triggerType: 'test_trigger_micro_hook', expiresAt: now + (24 * 60 * 60 * 1000) },
        { offerId: 'offer_drift_king_upsell', triggerType: 'post_purchase_upsell', expiresAt: now + (0.25 * 60 * 60 * 1000) },
        { offerId: 'offer_fuel_emergency', triggerType: 'test_trigger_micro_hook', expiresAt: now + (24 * 60 * 60 * 1000) },
        { offerId: 'offer_nitro_surge', triggerType: 'test_trigger_micro_hook', expiresAt: now + (24 * 60 * 60 * 1000) },
        { offerId: 'offer_adrenaline_shot', triggerType: 'test_trigger_micro_hook', expiresAt: now + (24 * 60 * 60 * 1000) },
        { offerId: 'offer_sprint_starter', triggerType: 'test_trigger_micro_hook', expiresAt: now + (24 * 60 * 60 * 1000) },
        { offerId: 'offer_midnight_oil', triggerType: 'test_trigger_micro_hook', expiresAt: now + (24 * 60 * 60 * 1000) },
        { offerId: 'offer_nitro_boost_plus', triggerType: 'test_trigger_micro_hook', expiresAt: now + (24 * 60 * 60 * 1000) },
        { offerId: 'offer_pit_stop_special', triggerType: 'test_trigger_micro_hook', expiresAt: now + (24 * 60 * 60 * 1000) },
        { offerId: 'offer_drift_king', triggerType: 'test_trigger_sweet_spot', expiresAt: now + (48 * 60 * 60 * 1000) },
        { offerId: 'offer_tuners_vault', triggerType: 'test_trigger_sweet_spot', expiresAt: now + (48 * 60 * 60 * 1000) },
        { offerId: 'offer_street_legend', triggerType: 'test_trigger_mid_tier', expiresAt: now + (48 * 60 * 60 * 1000) },
        { offerId: 'offer_pro_circuit_pack', triggerType: 'test_trigger_mid_tier', expiresAt: now + (48 * 60 * 60 * 1000) },
        { offerId: 'offer_weekend_warrior', triggerType: 'test_trigger_sweet_spot', expiresAt: now + (48 * 60 * 60 * 1000) },
        { offerId: 'offer_fast_lane_pack', triggerType: 'test_trigger_sweet_spot', expiresAt: now + (48 * 60 * 60 * 1000) },
        { offerId: 'offer_pro_crew_kit', triggerType: 'test_trigger_mid_tier', expiresAt: now + (48 * 60 * 60 * 1000) },
        { offerId: 'offer_grand_prix_hoard', triggerType: 'test_trigger_whale', expiresAt: now + (72 * 60 * 60 * 1000) },
        { offerId: 'offer_the_sovereign', triggerType: 'test_trigger_whale', expiresAt: now + (72 * 60 * 60 * 1000) },
        { offerId: 'offer_elite_engineer', triggerType: 'test_trigger_whale', expiresAt: now + (72 * 60 * 60 * 1000) },
        { offerId: 'offer_the_collector', triggerType: 'test_trigger_whale', expiresAt: now + (72 * 60 * 60 * 1000) },
        { offerId: 'offer_garage_overhaul', triggerType: 'test_trigger_whale', expiresAt: now + (72 * 60 * 60 * 1000) },
        { offerId: 'offer_championship_kit', triggerType: 'test_trigger_whale', expiresAt: now + (72 * 60 * 60 * 1000) },
        { offerId: 'offer_lvl10_milestone', triggerType: 'mastery_rank_5', expiresAt: now + (24 * 60 * 60 * 1000) },
        { offerId: 'offer_lvl20_milestone', triggerType: 'mastery_rank_10', expiresAt: now + (24 * 60 * 60 * 1000) },
        { offerId: 'offer_lvl50_milestone', triggerType: 'mastery_rank_20', expiresAt: now + (48 * 60 * 60 * 1000) },
        { offerId: 'offer_resource_rush', triggerType: 'fuel_empty', expiresAt: now + (4 * 60 * 60 * 1000) },
        { offerId: 'offer_adrenaline_pro', triggerType: 'win_streak_3', expiresAt: now + (1 * 60 * 60 * 1000) },
        { offerId: 'offer_mythic_mystery', triggerType: 'mythical_crate_earned', expiresAt: now + (8 * 60 * 60 * 1000) },
        { offerId: 'offer_double_clutch', triggerType: 'weekend', expiresAt: now + (24 * 60 * 60 * 1000) }
    ];

    console.log('Creating offers document...');
    console.log(`Main offer: ${mainOffer.offerId}`);
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
        tier: 1,
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
    console.log(`  • ${mainOffer.offerId}`);
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
