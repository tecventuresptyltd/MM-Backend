#!/usr/bin/env node

/**
 * Admin script to grant ALL tier licenses (and their bundled cars) to a player.
 *
 * ⚠️  SANDBOX ONLY — this script refuses to run against production.
 *
 * Usage: node tools/grantAllTiers.mjs <uid>
 * Example: node tools/grantAllTiers.mjs WhD94rd6OZdjW3jR0w3K02jPs562
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ──────────────────────────────────────────────────────────────────
// Args
// ──────────────────────────────────────────────────────────────────

const uid = process.argv[2];

if (!uid) {
    console.error('❌ Error: UID is required');
    console.log('Usage: node tools/grantAllTiers.mjs <uid>');
    process.exit(1);
}

// ──────────────────────────────────────────────────────────────────
// SAFETY: Force sandbox only
// ──────────────────────────────────────────────────────────────────

const env = 'sandbox'; // Hard-coded — we NEVER touch production
const serviceAccountFile = 'mystic-motors-sandbox-9b64d57718a2.json';
const serviceAccountPath = join(__dirname, '..', serviceAccountFile);

let serviceAccount;
try {
    serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
} catch (error) {
    console.error(`❌ Error: Could not read service account file: ${serviceAccountPath}`);
    process.exit(1);
}

// Double-check we're pointing at sandbox
if (!serviceAccount.project_id || !serviceAccount.project_id.includes('sandbox')) {
    console.error('❌ SAFETY: Service account does not appear to be sandbox. Aborting.');
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ──────────────────────────────────────────────────────────────────
// Tier catalog (from seeds/Atul-Final-Seeds/TiersCatalog.json)
// ──────────────────────────────────────────────────────────────────

const TIERS_CATALOG = {
    tier_1: {
        tierId: 'tier_1',
        displayName: 'Street License',
        order: 1,
        starterLicense: true,
        bundledCars: [
            { carId: 'car_h4ayzwf31g', archetype: 'guardian', displayName: 'Mitsabi Eon' },
            { carId: 'car_1wp1gr2p',   archetype: 'phantom',  displayName: 'Doge Chaser' },
            { carId: 'car_4bbp20vv',   archetype: 'arcanist', displayName: 'Nisaro 360X' },
        ],
    },
    tier_2: {
        tierId: 'tier_2',
        displayName: 'Sports License',
        order: 2,
        starterLicense: false,
        bundledCars: [
            { carId: 'car_3n27817s', archetype: 'guardian', displayName: 'Mercian SLR Apex' },
            { carId: 'car_xtm9htbs', archetype: 'phantom',  displayName: 'Nisaro Surya' },
            { carId: 'car_a9x2mkp3', archetype: 'arcanist', displayName: 'Aster Marlin D9' },
        ],
    },
    tier_3: {
        tierId: 'tier_3',
        displayName: 'Super License',
        order: 3,
        starterLicense: false,
        bundledCars: [
            { carId: 'car_jh5tqxqk', archetype: 'guardian', displayName: 'Mclovin MP3' },
            { carId: 'car_0yhea29t', archetype: 'phantom',  displayName: 'Chevaro Camara' },
            { carId: 'car_p4n7mm2z', archetype: 'arcanist', displayName: 'Aura R9' },
        ],
    },
    tier_4: {
        tierId: 'tier_4',
        displayName: 'Hyper License',
        order: 4,
        starterLicense: false,
        bundledCars: [
            { carId: 'car_8m8qttmy', archetype: 'guardian', displayName: 'Nisaro GR-X' },
            { carId: 'car_rqjrt91b', archetype: 'phantom',  displayName: 'Porza 919' },
            { carId: 'car_kztq00ve', archetype: 'arcanist', displayName: 'Lambros Avenger' },
        ],
    },
    tier_5: {
        tierId: 'tier_5',
        displayName: 'Mythic License',
        order: 5,
        starterLicense: false,
        bundledCars: [
            { carId: 'car_d2ap3yms', archetype: 'guardian', displayName: 'Ferano LaVita' },
            { carId: 'car_enmdcw5t', archetype: 'phantom',  displayName: 'Bugarri Chronos' },
            { carId: 'car_2n5hnes4', archetype: 'arcanist', displayName: 'Kosegg Agere' },
        ],
    },
};

// ──────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────

async function grantAllTiers() {
    console.log(`\n🔧 Granting ALL tier licenses to player`);
    console.log(`   UID : ${uid}`);
    console.log(`   ENV : ${env} (project: ${serviceAccount.project_id})`);
    console.log(`   Tiers: ${Object.keys(TIERS_CATALOG).join(', ')}\n`);

    // First verify the player exists
    const profileRef = db.doc(`/Players/${uid}/Profile/Profile`);
    const profileSnap = await profileRef.get();
    if (!profileSnap.exists) {
        console.error(`❌ Player ${uid} does not exist in ${env}. Aborting.`);
        process.exit(1);
    }
    console.log(`✅ Player found: ${profileSnap.data()?.displayName || uid}\n`);

    // Run inside a transaction to keep everything atomic
    await db.runTransaction(async (transaction) => {
        const licensesRef = db.doc(`/Players/${uid}/Licenses/Owned`);
        const garageRef    = db.doc(`/Players/${uid}/Garage/Cars`);

        const [licensesDoc, garageDoc] = await Promise.all([
            transaction.get(licensesRef),
            transaction.get(garageRef),
        ]);

        const timestamp = admin.firestore.FieldValue.serverTimestamp();

        // Existing data
        const licensesData = licensesDoc.exists
            ? (licensesDoc.data() || { licenses: {} })
            : { licenses: {} };
        const garageData = garageDoc.exists
            ? (garageDoc.data() || { cars: {} })
            : { cars: {} };
        const existingCars = garageData.cars || {};

        // Build updates
        const licensesUpdate = {};
        const carUpdates = {};
        const grantedCarIds = [];
        const skippedCarIds = [];
        const skippedTiers = [];

        for (const [tierId, tier] of Object.entries(TIERS_CATALOG)) {
            // Check if already owns this license
            if (licensesData.licenses && licensesData.licenses[tierId]) {
                skippedTiers.push(tierId);
                console.log(`⏭️  ${tier.displayName} — already owned, skipping`);
                continue;
            }

            // Record license
            licensesUpdate[`licenses.${tierId}`] = {
                tierId,
                purchasedAt: timestamp,
                grantedCars: tier.bundledCars.map(c => c.carId),
            };

            // Grant bundled cars
            for (const car of tier.bundledCars) {
                if (existingCars[car.carId]) {
                    skippedCarIds.push(car.carId);
                    continue;
                }
                grantedCarIds.push(car.carId);
                carUpdates[`cars.${car.carId}`] = {
                    carId: car.carId,
                    upgradeLevel: 0,
                    tuning: {},
                    xp: 0,
                    starLevel: 1,
                    carLevel: 1,
                    isXpCapped: false,
                    fuelBars: 5,
                    fuelLastRefillAt: timestamp,
                    archetype: car.archetype,
                    tierOrder: tier.order,
                    acquiredVia: 'adminGrant',
                    createdAt: timestamp,
                    updatedAt: timestamp,
                };
            }

            console.log(`🏎️  ${tier.displayName} — granting (${tier.bundledCars.length} cars)`);
        }

        // ── Writes ──

        // Licenses
        if (Object.keys(licensesUpdate).length > 0) {
            if (licensesDoc.exists) {
                transaction.update(licensesRef, {
                    ...licensesUpdate,
                    updatedAt: timestamp,
                });
            } else {
                // Convert dot-path updates to nested object for set()
                const licensesObj = {};
                for (const [tierId, tier] of Object.entries(TIERS_CATALOG)) {
                    if (licensesUpdate[`licenses.${tierId}`]) {
                        licensesObj[tierId] = licensesUpdate[`licenses.${tierId}`];
                    }
                }
                transaction.set(licensesRef, {
                    licenses: licensesObj,
                    updatedAt: timestamp,
                });
            }
        }

        // Cars
        if (Object.keys(carUpdates).length > 0) {
            if (garageDoc.exists) {
                transaction.update(garageRef, {
                    ...carUpdates,
                    updatedAt: timestamp,
                });
            } else {
                const carsObj = {};
                for (const [key, val] of Object.entries(carUpdates)) {
                    const carId = key.replace('cars.', '');
                    carsObj[carId] = val;
                }
                transaction.set(garageRef, {
                    cars: carsObj,
                    updatedAt: timestamp,
                });
            }
        }

        console.log('\n──────────────────────────────────────────');
        console.log('📊 Summary');
        console.log('──────────────────────────────────────────');
        console.log(`   Tiers granted  : ${Object.keys(TIERS_CATALOG).length - skippedTiers.length}`);
        console.log(`   Tiers skipped  : ${skippedTiers.length} (already owned)`);
        console.log(`   Cars granted   : ${grantedCarIds.length}`);
        console.log(`   Cars skipped   : ${skippedCarIds.length} (already in garage)`);
        console.log('──────────────────────────────────────────');
    });

    console.log('\n🎉 All tiers granted successfully!\n');
}

grantAllTiers()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('\n❌ Fatal error:', err);
        process.exit(1);
    });
