#!/usr/bin/env node
/**
 * Manual script to distribute maintenance rewards for a specific maintenance session.
 * This fixes the bug where rewards weren't distributed when maintenance ended.
 * 
 * Run with: node distributeMaintenanceRewards.mjs <maintenanceHistoryId>
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';

const env = process.argv[2] || 'sandbox';
const maintenanceId = process.argv[3];

if (!maintenanceId) {
    console.error('Usage: node distributeMaintenanceRewards.mjs <env> <maintenanceHistoryId>');
    console.error('Example: node distributeMaintenanceRewards.mjs sandbox ohJEeseuxdkBG1y5Q7VZ');
    process.exit(1);
}

const credFile = env === 'prod'
    ? './backend-production-mystic-motors-prod.json'
    : './mystic-motors-sandbox-9b64d57718a2.json';

console.log(`\nDistributing rewards for maintenance: ${maintenanceId}`);
console.log(`Environment: ${env}\n`);

const serviceAccount = JSON.parse(readFileSync(credFile, 'utf8'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

async function distributeRewards() {
    // Get maintenance history
    const historySnap = await db.doc(`MaintenanceHistory/${maintenanceId}`).get();

    if (!historySnap.exists) {
        throw new Error(`Maintenance history ${maintenanceId} not found`);
    }

    const historyData = historySnap.data();
    const gemsToGrant = historyData.rewardGems || 100;
    const timestamp = Date.now();

    console.log(`Maintenance started: ${new Date(historyData.startedAt).toISOString()}`);
    console.log(`Gems to grant: ${gemsToGrant}\n`);

    // Get all players via Profile collection group
    const profilesSnap = await db.collectionGroup('Profile').get();

    const playerUids = new Set();
    profilesSnap.docs.forEach(doc => {
        const uid = doc.ref.parent.parent?.id;
        if (uid) playerUids.add(uid);
    });

    console.log(`Found ${playerUids.size} unique players\n`);
    console.log('Distributing rewards...\n');

    const uids = Array.from(playerUids);
    const BATCH_SIZE = 500;
    let totalDistributed = 0;
    let errors = 0;

    for (let i = 0; i < uids.length; i += BATCH_SIZE) {
        const batchUids = uids.slice(i, i + BATCH_SIZE);
        let batch = db.batch();
        let opCount = 0;

        for (const uid of batchUids) {
            try {
                // Add to unseen rewards
                const unseenRef = db.doc(`Players/${uid}/Maintenance/UnseenRewards`);
                batch.set(
                    unseenRef,
                    {
                        unseenRewards: admin.firestore.FieldValue.arrayUnion({
                            maintenanceId,
                            gems: gemsToGrant,
                            timestamp,
                        }),
                        totalUnseen: admin.firestore.FieldValue.increment(1),
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    },
                    { merge: true }
                );

                // Grant gems immediately
                const statsRef = db.doc(`Players/${uid}/Economy/Stats`);
                batch.update(statsRef, {
                    gems: admin.firestore.FieldValue.increment(gemsToGrant),
                });

                opCount += 2;
                totalDistributed++;

                // Commit every 250 players (500 operations)
                if (opCount >= 500) {
                    await batch.commit();
                    batch = db.batch();
                    opCount = 0;
                }
            } catch (error) {
                console.error(`Error for ${uid}:`, error.message);
                errors++;
            }
        }

        // Commit remaining
        if (opCount > 0) {
            await batch.commit();
        }

        console.log(`Progress: ${Math.min(i + BATCH_SIZE, uids.length)}/${uids.length} players`);
    }

    // Update maintenance history to mark as distributed
    await db.doc(`MaintenanceHistory/${maintenanceId}`).update({
        endedAt: timestamp,
        duration: timestamp - historyData.startedAt,
        rewardsDistributed: true,
        rewardsDistributedAt: timestamp,
        playersRewarded: totalDistributed,
    });

    console.log('\n' + '='.repeat(50));
    console.log('Reward Distribution Complete!');
    console.log('='.repeat(50));
    console.log(`Total players rewarded: ${totalDistributed}`);
    console.log(`Gems per player: ${gemsToGrant}`);
    console.log(`Total gems distributed: ${totalDistributed * gemsToGrant}`);
    console.log(`Errors: ${errors}`);
    console.log('='.repeat(50) + '\n');
}

distributeRewards()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('\nFatal error:', err);
        process.exit(1);
    });
