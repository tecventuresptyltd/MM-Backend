#!/usr/bin/env node
/**
 * Initialize missing documents for existing players:
 * - Maintenance/UnseenRewards
 * - Referral codes (via ensureReferralCode)
 * 
 * Run with: node initializePlayerDocs.mjs <env>
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

// Referral config - matching your backend config
const REFERRAL_CONFIG = {
    alphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', // No 0, O, I, 1
    codeLength: 6,
};

async function initializeMaintenanceDoc(uid) {
    const maintenanceRef = db.doc(`Players/${uid}/Maintenance/UnseenRewards`);

    try {
        const snap = await maintenanceRef.get();

        if (snap.exists) {
            return { created: false, reason: 'exists' };
        }

        await maintenanceRef.set({
            unseenRewards: [],
            totalUnseen: 0,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return { created: true };
    } catch (error) {
        console.error(`  Error creating maintenance doc for ${uid}:`, error);
        return { created: false, error: true };
    }
}

async function ensureReferralCode(uid) {
    const profileRef = db.doc(`Players/${uid}/Profile/Profile`);

    try {
        const profileSnap = await profileRef.get();
        const profileData = profileSnap.data() || {};

        // Check if already has referral code
        if (profileData.referralCode && typeof profileData.referralCode === 'string') {
            return { created: false, code: profileData.referralCode, reason: 'exists' };
        }

        // Generate new code
        const code = await generateReferralCode(uid);

        // Update profile
        await profileRef.set({
            referralCode: code,
            referredBy: profileData.referredBy || null,
        }, { merge: true });

        return { created: true, code };
    } catch (error) {
        console.error(`  Error creating referral code for ${uid}:`, error);
        return { created: false, error: true };
    }
}

async function generateReferralCode(uid) {
    const alphabet = REFERRAL_CONFIG.alphabet;
    const length = REFERRAL_CONFIG.codeLength;

    // Try to generate unique code (up to 10 attempts)
    for (let attempt = 0; attempt < 10; attempt++) {
        const code = Array.from({ length }, () =>
            alphabet.charAt(Math.floor(Math.random() * alphabet.length))
        ).join('');

        // Check if code already exists
        const codeRef = db.doc(`ReferralCodeRegistry/${code}`);
        const codeSnap = await codeRef.get();

        if (!codeSnap.exists) {
            // Register the code
            await db.runTransaction(async (txn) => {
                txn.set(codeRef, {
                    uid,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });

                txn.set(db.doc(`ReferralUidRegistry/${uid}`), {
                    code,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            });

            return code;
        }
    }

    throw new Error('Failed to generate unique referral code');
}

async function initializePlayer(uid) {
    const [maintenance, referral] = await Promise.all([
        initializeMaintenanceDoc(uid),
        ensureReferralCode(uid),
    ]);

    return {
        maintenance,
        referral,
        anyCreated: maintenance.created || referral.created,
    };
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
    console.log('Initializing documents...\n');

    let maintenanceCreated = 0;
    let referralCreated = 0;
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
            const uid = batch[idx];

            if (r.status === 'fulfilled') {
                const { maintenance, referral, anyCreated } = r.value;

                if (anyCreated) {
                    const parts = [];
                    if (maintenance.created) {
                        parts.push('Maintenance');
                        maintenanceCreated++;
                    }
                    if (referral.created) {
                        parts.push(`Referral(${referral.code})`);
                        referralCreated++;
                    }
                    console.log(`✅ ${processed}/${uids.length} - Created: ${parts.join(', ')}`);
                }
            } else {
                errors++;
                console.error(`❌ ${processed}/${uids.length} - Error: ${r.reason}`);
            }
        });
    }

    console.log('\n' + '='.repeat(50));
    console.log('Document Migration Complete!');
    console.log('='.repeat(50));
    console.log(`Maintenance docs created: ${maintenanceCreated}`);
    console.log(`Referral codes created: ${referralCreated}`);
    console.log(`Errors: ${errors}`);
    console.log('='.repeat(50) + '\n');
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('\nFatal error:', err);
        process.exit(1);
    });
