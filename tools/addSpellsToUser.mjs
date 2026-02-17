#!/usr/bin/env node

/**
 * Admin script to add 3 starter spells to a user account
 * Usage: node tools/addSpellsToUser.mjs <uid> <environment>
 * Example: node tools/addSpellsToUser.mjs edlRbPOGsrbUIWCdo227c4Itwzk2 sandbox
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get arguments
const uid = process.argv[2];
const env = process.argv[3] || 'sandbox';

if (!uid) {
    console.error('❌ Error: UID is required');
    console.log('Usage: node tools/addSpellsToUser.mjs <uid> <environment>');
    console.log('Example: node tools/addSpellsToUser.mjs edlRbPOGsrbUIWCdo227c4Itwzk2 sandbox');
    process.exit(1);
}

// Initialize Firebase Admin
const serviceAccountMap = {
    'sandbox': 'mystic-motors-sandbox-9b64d57718a2.json',
    'prod': 'mystic-motors-prod-42437be98d22.json',
};

const serviceAccountFile = serviceAccountMap[env];
if (!serviceAccountFile) {
    console.error(`❌ Error: Invalid environment: ${env}`);
    console.log('Valid environments: sandbox, prod');
    process.exit(1);
}

const serviceAccountPath = join(__dirname, '..', serviceAccountFile);
let serviceAccount;
try {
    serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
} catch (error) {
    console.error(`❌ Error: Could not read service account file: ${serviceAccountPath}`);
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Default starter spells (from catalog)
const STARTER_SPELLS = [
    'spell_2382r2jk',
    'spell_hg6ddry4',
    'spell_kdh7hy7r',
];

async function addSpellsToUser() {
    console.log(`\n🔧 Adding spells to user: ${uid}`);
    console.log(`📍 Environment: ${env}`);
    console.log(`🎯 Spells to add: ${STARTER_SPELLS.join(', ')}\n`);

    const spellsRef = db.doc(`/Players/${uid}/Spells/Levels`);
    const decksRef = db.doc(`/Players/${uid}/SpellDecks/Decks`);

    try {
        await db.runTransaction(async (transaction) => {
            const [spellsDoc, decksDoc] = await Promise.all([
                transaction.get(spellsRef),
                transaction.get(decksRef),
            ]);

            const timestamp = admin.firestore.FieldValue.serverTimestamp();

            // Prepare spell data
            const spells = {};
            const unlockedAt = {};

            STARTER_SPELLS.forEach((spellId) => {
                spells[spellId] = {
                    xp: 0,
                    level: 1,
                    isXpCapped: false,
                };
                unlockedAt[spellId] = timestamp;
            });

            // Update or create Spells/Levels document
            if (spellsDoc.exists) {
                const updates = {};
                STARTER_SPELLS.forEach((spellId) => {
                    updates[`spells.${spellId}`] = spells[spellId];
                    updates[`unlockedAt.${spellId}`] = timestamp;
                });
                updates.updatedAt = timestamp;
                transaction.update(spellsRef, updates);
                console.log('✅ Updated existing Spells/Levels document');
            } else {
                transaction.set(spellsRef, {
                    spells,
                    unlockedAt,
                    updatedAt: timestamp,
                });
                console.log('✅ Created new Spells/Levels document');
            }

            // Update or create SpellDecks/Decks document
            if (decksDoc.exists) {
                transaction.update(decksRef, {
                    'decks.1.spells': STARTER_SPELLS,
                    updatedAt: timestamp,
                });
                console.log('✅ Updated Deck 1 with starter spells');
            } else {
                transaction.set(decksRef, {
                    active: 1,
                    decks: {
                        '1': { name: 'Starter', spells: STARTER_SPELLS },
                        '2': { name: 'Deck 2', spells: ['', '', ''] },
                        '3': { name: 'Deck 3', spells: ['', '', ''] },
                        '4': { name: 'Deck 4', spells: ['', '', ''] },
                        '5': { name: 'Deck 5', spells: ['', '', ''] },
                    },
                    updatedAt: timestamp,
                });
                console.log('✅ Created new SpellDecks/Decks document');
            }
        });

        console.log('\n🎉 Success! Spells added to user account.\n');
        console.log('📊 Summary:');
        console.log(`   User: ${uid}`);
        console.log(`   Spells: ${STARTER_SPELLS.join(', ')}`);
        console.log(`   All spells set to: xp=0, level=1, isXpCapped=false\n`);

    } catch (error) {
        console.error('\n❌ Error adding spells:', error);
        process.exit(1);
    }

    process.exit(0);
}

addSpellsToUser();
