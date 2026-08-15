/**
 * Seed ONLY /GameData/v1/catalogs/SpellsCatalog to the SANDBOX project.
 *
 * Reads the SpellsCatalog entry out of gameDataCatalogs.v3.normalized.json — that is the
 * copy the real seeder uses; the standalone SpellsCatalog.json is never seeded by
 * seedFirestore.sandbox.ts, so editing it alone has no effect.
 *
 * Hard-wired to mystic-motors-sandbox — it cannot target production.
 *
 * Run:  npx tsx tools/seedSpellsCatalog.sandbox.ts
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
const DOC_PATH = '/GameData/v1/catalogs/SpellsCatalog';

async function main() {
    const seedFile = path.join(__dirname, '..', 'seeds', 'Atul-Final-Seeds', 'gameDataCatalogs.v3.normalized.json');
    const all = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));
    const entry = (Object.values(all) as any[]).find((e) => e.path && e.path.endsWith('SpellsCatalog'));

    if (!entry) {
        console.error('No SpellsCatalog entry found in the normalized seed file.');
        process.exit(1);
    }

    const data = entry.data;
    console.log(`Project : mystic-motors-sandbox`);
    console.log(`Document: ${DOC_PATH}`);
    console.log(`Spells  : ${Object.keys(data.spells).length}\n`);

    await db.doc(DOC_PATH).set(data);

    const live = (await db.doc(DOC_PATH).get()).data() as any;
    const problems: string[] = [];

    for (const [id, spell] of Object.entries<any>(data.spells)) {
        const l = live.spells?.[id];
        if (!l) { problems.push(`${id} missing from live doc`); continue; }
        if (l.requiredLevel !== spell.requiredLevel) {
            problems.push(`${spell.displayName}: file ${spell.requiredLevel}, live ${l.requiredLevel}`);
        }
    }

    if (problems.length) {
        console.error('MISMATCH:\n  ' + problems.join('\n  '));
        process.exit(1);
    }

    console.log('All spell requirements match the file. Gated spells now:');
    Object.values<any>(live.spells)
        .filter((s) => s.requiredLevel > 0)
        .sort((a, b) => a.requiredLevel - b.requiredLevel)
        .forEach((s) => console.log(`  rank ${String(s.requiredLevel).padStart(3)} - ${s.displayName}`));
    process.exit(0);
}

main().catch((err) => {
    console.error('Failed:', err);
    process.exit(1);
});
