/**
 * One-time tool: pin a player's mastery rank in the SANDBOX Firestore.
 * Sets pinnedMasteryRank, masteryRank, and level immediately.
 *
 * Usage:
 *   npx tsx tools/pinPlayerLevelSandbox.ts
 */

import * as admin from 'firebase-admin';

const serviceAccount = require('../mystic-motors-sandbox-9b64d57718a2.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'mystic-motors-sandbox',
});

const db = admin.firestore();

const TARGET_UID = 'WhD94rd6OZdjW3jR0w3K02jPs562';
const TARGET_LEVEL = 100;

async function pinPlayerLevel() {
    const profileRef = db.doc(`/Players/${TARGET_UID}/Profile/Profile`);
    const profileDoc = await profileRef.get();

    if (!profileDoc.exists) {
        console.error(`❌ Profile not found for player: ${TARGET_UID}`);
        process.exit(1);
    }

    const before = profileDoc.data()!;
    console.log(`\nPlayer: ${TARGET_UID}`);
    console.log(`  Current masteryRank : ${before.masteryRank ?? 'N/A'}`);
    console.log(`  Current level       : ${before.level ?? 'N/A'}`);
    console.log(`  Current masteryXp   : ${before.masteryXp ?? 'N/A'}`);
    console.log(`  pinnedMasteryRank   : ${before.pinnedMasteryRank ?? 'not set'}\n`);

    await profileRef.update({
        pinnedMasteryRank: TARGET_LEVEL,
        masteryRank: TARGET_LEVEL,
        level: TARGET_LEVEL,
        expProgress: 0,
        expToNextLevel: 0,
        expProgressDisplay: 'Max Rank',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`✅ Player ${TARGET_UID} pinned to mastery rank ${TARGET_LEVEL} in SANDBOX.`);
    console.log('   The level will remain at 100 after all future races.');
}

pinPlayerLevel()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('❌ Error:', err);
        process.exit(1);
    });
