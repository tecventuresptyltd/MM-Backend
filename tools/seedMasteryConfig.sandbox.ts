/**
 * Seed ONLY /GameData/v1/config/MasteryConfig to the SANDBOX project.
 *
 * Deliberately narrow: the full seeder (seedFirestore.sandbox.ts) rewrites every
 * catalog, which is more blast radius than a mastery-curve change needs.
 * Hard-wired to mystic-motors-sandbox — it cannot target production.
 *
 * Run:  npx tsx tools/seedMasteryConfig.sandbox.ts
 */

import * as admin from 'firebase-admin';
import * as fs from 'fs';
import * as path from 'path';

const serviceAccount = require('../mystic-motors-sandbox-9b64d57718a2.json');

if (serviceAccount.project_id !== 'mystic-motors-sandbox') {
    console.error(`Refusing to run: key is for ${serviceAccount.project_id}, expected mystic-motors-sandbox`);
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'mystic-motors-sandbox',
});

const db = admin.firestore();
const DOC_PATH = '/GameData/v1/config/MasteryConfig';

async function main() {
    const seedFile = path.join(__dirname, '..', 'seeds', 'Atul-Final-Seeds', 'MasteryConfig.json');
    const data = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));

    const rankCount = Object.keys(data.rankThresholds).length;
    console.log(`Project : mystic-motors-sandbox`);
    console.log(`Document: ${DOC_PATH}`);
    console.log(`Source  : ${seedFile}`);
    console.log(`maxRank : ${data.maxRank}, thresholds: ${rankCount}\n`);

    await db.doc(DOC_PATH).set(data);
    console.log('Written. Verifying against the file...\n');

    const snap = await db.doc(DOC_PATH).get();
    const live = snap.data() as any;

    const problems: string[] = [];
    if (live.maxRank !== data.maxRank) problems.push(`maxRank: file ${data.maxRank}, live ${live.maxRank}`);
    if (live.carWeight !== data.carWeight) problems.push(`carWeight: file ${data.carWeight}, live ${live.carWeight}`);
    if (live.spellWeight !== data.spellWeight) problems.push(`spellWeight: file ${data.spellWeight}, live ${live.spellWeight}`);

    const liveCount = Object.keys(live.rankThresholds ?? {}).length;
    if (liveCount !== rankCount) problems.push(`threshold count: file ${rankCount}, live ${liveCount}`);

    for (let r = 1; r <= data.maxRank; r++) {
        const f = data.rankThresholds[String(r)];
        const l = live.rankThresholds?.[String(r)];
        if (f !== l) problems.push(`rank ${r}: file ${f}, live ${l}`);
    }

    if (problems.length) {
        console.error('MISMATCH:\n  ' + problems.join('\n  '));
        process.exit(1);
    }

    console.log(`All ${rankCount} thresholds match the file exactly.`);
    console.log(`  rank 1   = ${live.rankThresholds['1'].toLocaleString()}`);
    console.log(`  rank 2   = ${live.rankThresholds['2'].toLocaleString()}`);
    console.log(`  rank 50  = ${live.rankThresholds['50'].toLocaleString()}`);
    console.log(`  rank 150 = ${live.rankThresholds['150'].toLocaleString()}`);
    process.exit(0);
}

main().catch((err) => {
    console.error('Failed:', err);
    process.exit(1);
});
