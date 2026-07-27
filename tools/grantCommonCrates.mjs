#!/usr/bin/env node

/**
 * Admin script to grant Common Crates to a player's crate slots.
 *
 * ⚠️  SANDBOX ONLY — this script refuses to run against production.
 *
 * Writes to /Players/<uid>/Crates/Slots, mirroring the slot entry shape
 * produced by the real receiveCrateV2 cloud function.
 *
 * Usage:   node tools/grantCommonCrates.mjs <uid> [count]
 * Example: node tools/grantCommonCrates.mjs WhD94rd6OZdjW3jR0w3K02jPs562 4
 *
 * count defaults to 4 (the max slot capacity). The slots array is
 * OVERWRITTEN with `count` fresh Common Crates.
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
const requestedCount = process.argv[3] ? parseInt(process.argv[3], 10) : 4;

if (!uid) {
    console.error('❌ Error: UID is required');
    console.log('Usage: node tools/grantCommonCrates.mjs <uid> [count]');
    process.exit(1);
}

// ──────────────────────────────────────────────────────────────────
// Common Crate + slot config (from seeds/Atul-Final-Seeds)
// ──────────────────────────────────────────────────────────────────

const COMMON_CRATE = {
    crateId: 'crt_ayvncyt0',
    crateSkuId: 'sku_zz3twgp0wx',
    rarity: 'common',
    unlockDurationSeconds: 1800, // 30 minutes (CrateSlotsConfig.unlockDurations.common)
};

const MAX_SLOTS = 4; // CrateSlotsConfig.maxSlots
const count = Math.max(1, Math.min(requestedCount, MAX_SLOTS));

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
// Main
// ──────────────────────────────────────────────────────────────────

async function grantCommonCrates() {
    console.log(`\n🔧 Granting Common Crates to player`);
    console.log(`   UID   : ${uid}`);
    console.log(`   ENV   : ${env} (project: ${serviceAccount.project_id})`);
    console.log(`   Count : ${count} (overwrite mode)\n`);

    // First verify the player exists
    const profileRef = db.doc(`/Players/${uid}/Profile/Profile`);
    const profileSnap = await profileRef.get();
    if (!profileSnap.exists) {
        console.error(`❌ Player ${uid} does not exist in ${env}. Aborting.`);
        process.exit(1);
    }
    console.log(`✅ Player found: ${profileSnap.data()?.displayName || uid}\n`);

    const slotsRef = db.doc(`/Players/${uid}/Crates/Slots`);
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    // Build `count` fresh Common Crate slot entries.
    // Note: serverTimestamp() is NOT allowed inside array elements, so
    // receivedAt uses a concrete Timestamp — exactly like receiveCrateV2.
    const receivedAt = admin.firestore.Timestamp.now();
    const buildSlot = () => ({
        crateSkuId: COMMON_CRATE.crateSkuId,
        crateId: COMMON_CRATE.crateId,
        rarity: COMMON_CRATE.rarity,
        receivedAt,
        isUnlocking: false,
        startedAt: null,
        completesAt: null,
        unlockDurationSeconds: COMMON_CRATE.unlockDurationSeconds,
    });

    const newSlots = Array.from({ length: count }, buildSlot);

    await slotsRef.set({
        slots: newSlots,
        maxSlots: MAX_SLOTS,
        updatedAt: timestamp,
    });

    console.log('──────────────────────────────────────────');
    console.log('📊 Summary');
    console.log('──────────────────────────────────────────');
    console.log(`   Common Crates granted : ${count}`);
    console.log(`   Slot doc              : /Players/${uid}/Crates/Slots`);
    console.log('──────────────────────────────────────────');
    console.log('\n🎉 Common Crates granted successfully!\n');
}

grantCommonCrates()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('\n❌ Fatal error:', err);
        process.exit(1);
    });
