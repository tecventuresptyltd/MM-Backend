#!/usr/bin/env node

/**
 * Admin tool: fully UNLOCK a player's account in the SANDBOX Firestore.
 *
 * Grants (unlock only — existing progression is never overwritten):
 *   1. All tier licenses (TiersCatalog)
 *   2. All cars (CarsCatalog) at starting level — cars already owned are left alone
 *   3. All spells (SpellsCatalog) at level 1 — spells already owned are left alone
 *   4. All cosmetics (ItemSkusCatalog, category=cosmetic) at qty >= 1
 *   5. Pins the player's mastery rank to MasteryConfig.maxRank so it does not
 *      drop back to an XP-derived value after a race (see race/index.ts pinnedMasteryRank).
 *
 * Catalogs are read LIVE from Firestore — nothing is hard-coded.
 *
 * ⚠️  SANDBOX ONLY — refuses to run against any non-sandbox project.
 *
 * Usage:
 *   node tools/unlockAllForPlayerSandbox.mjs <uid>              # dry run (no writes)
 *   node tools/unlockAllForPlayerSandbox.mjs <uid> --apply      # perform the writes
 *   node tools/unlockAllForPlayerSandbox.mjs <uid> --rank=100   # pin above MasteryConfig.maxRank
 *
 * --rank defaults to MasteryConfig.maxRank (50). Pinning ABOVE maxRank is legal and is
 * sometimes what you want on a test account: several spells carry requiredLevel gates of
 * 55/60, and requiredLevel:-1 normalizes to 100 (see core/catalog.ts). The unlock check is
 * `playerLevel < requiredLevel`, so --rank=100 clears every gate in the spell catalog.
 */

import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────────────────────────
// Args
// ──────────────────────────────────────────────────────────────────

const uid = process.argv[2];
const APPLY = process.argv.includes('--apply');
const rankArg = process.argv.find((a) => a.startsWith('--rank='));
const RANK_OVERRIDE = rankArg ? Number(rankArg.split('=')[1]) : null;

if (!uid || uid.startsWith('--')) {
    console.error('❌ Error: UID is required');
    console.log('Usage: node tools/unlockAllForPlayerSandbox.mjs <uid> [--apply] [--rank=N]');
    process.exit(1);
}

if (rankArg && (!Number.isFinite(RANK_OVERRIDE) || RANK_OVERRIDE < 1)) {
    console.error(`❌ Error: --rank must be a positive integer, got "${rankArg.split('=')[1]}"`);
    process.exit(1);
}

// ──────────────────────────────────────────────────────────────────
// SAFETY: sandbox only
// ──────────────────────────────────────────────────────────────────

const serviceAccountPath = join(__dirname, '..', 'mystic-motors-sandbox-9b64d57718a2.json');

let serviceAccount;
try {
    serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));
} catch {
    console.error(`❌ Could not read service account: ${serviceAccountPath}`);
    process.exit(1);
}

if (!serviceAccount.project_id?.includes('sandbox')) {
    console.error(`❌ SAFETY: project "${serviceAccount.project_id}" is not sandbox. Aborting.`);
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
});

const db = admin.firestore();
const FV = admin.firestore.FieldValue;

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

const getDoc = async (path) => {
    const snap = await db.doc(path).get();
    if (!snap.exists) throw new Error(`Missing catalog/config doc: ${path}`);
    return snap.data();
};

const qtyOf = (data) => {
    const raw = data?.quantity ?? data?.qty;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** Mirrors src/shared/inventory.ts extractSubType() */
const extractSubType = (sku) =>
    sku?.type === 'cosmetic' || sku?.type === 'booster' || sku?.type === 'speedup'
        ? sku.subType ?? null
        : null;

const applyDelta = (map, key, delta) => {
    if (!key || delta === 0) return;
    const next = (map[key] ?? 0) + delta;
    if (next <= 0) delete map[key];
    else map[key] = next;
};

// ──────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────

async function run() {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(`  UNLOCK ALL — ${APPLY ? '\x1b[31mAPPLY (writing)\x1b[0m' : 'DRY RUN (no writes)'}`);
    console.log(`  UID     : ${uid}`);
    console.log(`  Project : ${serviceAccount.project_id}`);
    console.log('═══════════════════════════════════════════════════\n');

    // --- Load live catalogs ---
    const [carsCat, tiersCat, spellsCat, skusCat, masteryConfig, fuelConfig] = await Promise.all([
        getDoc('GameData/v1/catalogs/CarsCatalog'),
        getDoc('GameData/v1/catalogs/TiersCatalog'),
        getDoc('GameData/v1/catalogs/SpellsCatalog'),
        getDoc('GameData/v1/catalogs/ItemSkusCatalog'),
        getDoc('GameData/v1/config/MasteryConfig'),
        getDoc('GameData/v1/config/FuelConfig'),
    ]);

    const allCars = carsCat.cars ?? {};
    const allTiers = tiersCat.tiers ?? {};
    const allSpells = spellsCat.spells ?? {};
    const allSkus = skusCat.skus ?? {};
    const maxRank = Number(masteryConfig.maxRank);
    const maxFuelBars = Number(fuelConfig.maxBars ?? 5);

    if (!Number.isFinite(maxRank) || maxRank < 1) {
        throw new Error(`MasteryConfig.maxRank is invalid: ${masteryConfig.maxRank}`);
    }

    // The rank we actually pin. Defaults to the catalog max; may be raised deliberately
    // to clear spell requiredLevel gates that sit above maxRank.
    const pinRank = RANK_OVERRIDE ?? maxRank;

    const cosmeticSkuIds = Object.keys(allSkus).filter((id) => allSkus[id]?.category === 'cosmetic');

    // carId -> { archetype, tierOrder } from the tier bundles
    const carTierMeta = {};
    for (const tier of Object.values(allTiers)) {
        for (const bundled of tier.bundledCars ?? []) {
            carTierMeta[bundled.carId] = { archetype: bundled.archetype, tierOrder: tier.order };
        }
    }

    console.log(`Catalogs: ${Object.keys(allCars).length} cars · ${Object.keys(allTiers).length} tiers · ` +
        `${Object.keys(allSpells).length} spells · ${cosmeticSkuIds.length} cosmetics · maxRank ${maxRank}\n`);

    // --- Player must exist ---
    const profileRef = db.doc(`Players/${uid}/Profile/Profile`);
    const profileSnap = await profileRef.get();
    if (!profileSnap.exists) {
        console.error(`❌ Player ${uid} does not exist in ${serviceAccount.project_id}. Aborting.`);
        process.exit(1);
    }
    const profile = profileSnap.data();
    console.log(`Player: "${profile.displayName ?? uid}" — level ${profile.level}, ` +
        `masteryRank ${profile.masteryRank}, pinned ${profile.pinnedMasteryRank ?? 'none'}\n`);

    const licensesRef = db.doc(`Players/${uid}/Licenses/Owned`);
    const garageRef = db.doc(`Players/${uid}/Garage/Cars`);
    const spellsRef = db.doc(`Players/${uid}/Spells/Levels`);
    const summaryRef = db.doc(`Players/${uid}/Inventory/_summary`);

    const [licSnap, garageSnap, spellSnap, summarySnap] = await Promise.all([
        licensesRef.get(), garageRef.get(), spellsRef.get(), summaryRef.get(),
    ]);

    const ownedLicenses = licSnap.exists ? (licSnap.data().licenses ?? {}) : {};
    const ownedCars = garageSnap.exists ? (garageSnap.data().cars ?? {}) : {};
    const ownedSpells = spellSnap.exists ? (spellSnap.data().spells ?? {}) : {};

    // ── 1. Licenses ──
    const missingTiers = Object.keys(allTiers).filter((t) => !ownedLicenses[t]);

    // ── 2. Cars (unlock only — never touch an owned car's level/xp) ──
    const missingCars = Object.keys(allCars).filter((c) => !ownedCars[c]);

    // ── 3. Spells (unlock only — never touch an owned spell's level/xp) ──
    const missingSpells = Object.keys(allSpells).filter((s) => {
        const lvl = Number(ownedSpells[s]?.level ?? 0);
        return !(lvl >= 1);
    });

    // ── 4. Cosmetics ──
    const invSnaps = await db.getAll(
        ...cosmeticSkuIds.map((id) => db.doc(`Players/${uid}/Inventory/${id}`)),
    );
    const missingCosmetics = [];
    invSnaps.forEach((snap, i) => {
        if (qtyOf(snap.data()) < 1) missingCosmetics.push(cosmeticSkuIds[i]);
    });

    // ── 5. Mastery pin ──
    // No threshold exists above maxRank, so fall back to the maxRank threshold — it keeps
    // masteryXp coherent (player still resolves to maxRank if the pin is ever removed).
    const pinThresholdXp = Number(
        masteryConfig.rankThresholds?.[String(pinRank)] ??
        masteryConfig.rankThresholds?.[String(maxRank)] ??
        0,
    );
    const pinNeeded =
        profile.pinnedMasteryRank !== pinRank ||
        profile.masteryRank !== pinRank ||
        profile.level !== pinRank;

    // ── Report ──
    console.log('───────────────── PLAN ─────────────────');
    console.log(`Licenses  : ${Object.keys(allTiers).length - missingTiers.length}/${Object.keys(allTiers).length} owned → granting ${missingTiers.length}` +
        (missingTiers.length ? ` [${missingTiers.join(', ')}]` : ''));
    console.log(`Cars      : ${Object.keys(allCars).length - missingCars.length}/${Object.keys(allCars).length} owned → granting ${missingCars.length}` +
        (missingCars.length ? ` [${missingCars.join(', ')}]` : ''));
    console.log(`Spells    : ${Object.keys(allSpells).length - missingSpells.length}/${Object.keys(allSpells).length} owned → granting ${missingSpells.length}` +
        (missingSpells.length ? ` [${missingSpells.join(', ')}]` : ''));
    console.log(`Cosmetics : ${cosmeticSkuIds.length - missingCosmetics.length}/${cosmeticSkuIds.length} owned → granting ${missingCosmetics.length}`);
    console.log(`Mastery   : rank ${profile.masteryRank} / pin ${profile.pinnedMasteryRank ?? 'none'} → pin ${pinRank} ${pinNeeded ? '(update)' : '(already set)'}` +
        (pinRank > maxRank ? `  ⚠ above MasteryConfig.maxRank (${maxRank}) — intentional, clears all spell gates` : ''));
    console.log('────────────────────────────────────────\n');
    console.log('NOTE: car star/level and spell levels are NOT modified — unlock only.\n');

    if (!APPLY) {
        console.log('ℹ️  Dry run complete. Re-run with --apply to write these changes.\n');
        return;
    }

    // ══════════════════════ WRITES ══════════════════════

    // --- Licenses + Cars + Spells + Profile (one transaction) ---
    await db.runTransaction(async (tx) => {
        // Re-read inside the transaction for consistency
        const [lic2, garage2, spell2, prof2] = await Promise.all([
            tx.get(licensesRef), tx.get(garageRef), tx.get(spellsRef), tx.get(profileRef),
        ]);
        const ts = FV.serverTimestamp();
        const licNow = lic2.exists ? (lic2.data().licenses ?? {}) : {};
        const carsNow = garage2.exists ? (garage2.data().cars ?? {}) : {};
        const spellsNow = spell2.exists ? (spell2.data().spells ?? {}) : {};

        // Licenses
        const licUpdates = {};
        for (const [tierId, tier] of Object.entries(allTiers)) {
            if (licNow[tierId]) continue;
            licUpdates[`licenses.${tierId}`] = {
                tierId,
                purchasedAt: ts,
                grantedCars: (tier.bundledCars ?? []).map((c) => c.carId),
            };
        }
        if (Object.keys(licUpdates).length > 0) {
            if (lic2.exists) {
                tx.update(licensesRef, { ...licUpdates, updatedAt: ts });
            } else {
                const nested = {};
                for (const [k, v] of Object.entries(licUpdates)) nested[k.slice('licenses.'.length)] = v;
                tx.set(licensesRef, { licenses: nested, updatedAt: ts });
            }
        }

        // Cars — granted at the same starting state initializeUser/tiersV2 use
        const carUpdates = {};
        for (const carId of Object.keys(allCars)) {
            if (carsNow[carId]) continue; // owned: leave progression untouched
            const meta = carTierMeta[carId] ?? {};
            carUpdates[`cars.${carId}`] = {
                carId,
                upgradeLevel: 0,
                tuning: {},
                xp: 0,
                starLevel: 1,
                carLevel: 1,
                isXpCapped: false,
                fuelBars: maxFuelBars,
                fuelLastRefillAt: ts,
                archetype: meta.archetype ?? allCars[carId]?.class ?? null,
                tierOrder: meta.tierOrder ?? 1,
                acquiredVia: 'adminGrant',
                createdAt: ts,
                updatedAt: ts,
            };
        }
        if (Object.keys(carUpdates).length > 0) {
            if (garage2.exists) {
                tx.update(garageRef, { ...carUpdates, updatedAt: ts });
            } else {
                const nested = {};
                for (const [k, v] of Object.entries(carUpdates)) nested[k.slice('cars.'.length)] = v;
                tx.set(garageRef, { cars: nested, updatedAt: ts });
            }
        }

        // Spells — unlocked at level 1, matching researchV2's brand-new-unlock shape
        const spellUpdates = {};
        for (const spellId of Object.keys(allSpells)) {
            if (Number(spellsNow[spellId]?.level ?? 0) >= 1) continue; // owned: leave level/xp untouched
            spellUpdates[`spells.${spellId}`] = { level: 1, xp: 0, isXpCapped: false };
            spellUpdates[`unlockedAt.${spellId}`] = ts;
        }
        if (Object.keys(spellUpdates).length > 0) {
            if (spell2.exists) {
                tx.update(spellsRef, { ...spellUpdates, updatedAt: ts });
            } else {
                const spells = {};
                const unlockedAt = {};
                for (const [k, v] of Object.entries(spellUpdates)) {
                    if (k.startsWith('spells.')) spells[k.slice('spells.'.length)] = v;
                    else unlockedAt[k.slice('unlockedAt.'.length)] = v;
                }
                tx.set(spellsRef, { spells, unlockedAt, updatedAt: ts });
            }
        }

        // Mastery pin — keeps the rank from being recomputed from XP after a race
        const prof = prof2.data() ?? {};
        if (prof.pinnedMasteryRank !== pinRank || prof.masteryRank !== pinRank || prof.level !== pinRank) {
            tx.update(profileRef, {
                pinnedMasteryRank: pinRank,
                masteryRank: pinRank,
                level: pinRank,
                // Keep the underlying XP consistent with the pinned rank so the rank
                // survives even if the pin is later removed.
                masteryXp: Math.max(Number(prof.masteryXp ?? 0), pinThresholdXp),
                expProgress: 0,
                expToNextLevel: 0,
                expProgressDisplay: 'Max Rank',
                updatedAt: ts,
            });
        }
    });
    console.log('✅ Licenses, cars, spells and mastery pin written.');

    // --- Cosmetics (batched outside the transaction; 366 docs exceeds tx limits) ---
    if (missingCosmetics.length > 0) {
        const summaryDelta = {};
        let batch = db.batch();
        let opsInBatch = 0;

        for (const skuId of missingCosmetics) {
            const sku = allSkus[skuId];
            batch.set(
                db.doc(`Players/${uid}/Inventory/${skuId}`),
                {
                    skuId,
                    quantity: 1,
                    qty: 1,
                    type: sku.type ?? 'cosmetic',
                    createdAt: FV.serverTimestamp(),
                    updatedAt: FV.serverTimestamp(),
                },
                { merge: true },
            );
            summaryDelta[skuId] = 1;
            if (++opsInBatch >= 400) {
                await batch.commit();
                batch = db.batch();
                opsInBatch = 0;
            }
        }
        if (opsInBatch > 0) await batch.commit();

        // Update _summary using the same semantics as src/shared/inventory.ts
        const current = summarySnap.exists ? summarySnap.data() : {};
        const totalsByCategory = { ...(current.totalsByCategory ?? {}) };
        const totalsByRarity = { ...(current.totalsByRarity ?? {}) };
        const totalsBySubType = { ...(current.totalsBySubType ?? {}) };
        for (const [skuId, delta] of Object.entries(summaryDelta)) {
            const sku = allSkus[skuId];
            applyDelta(totalsByCategory, sku?.type ?? null, delta);
            applyDelta(totalsByRarity, sku?.rarity ?? null, delta);
            applyDelta(totalsBySubType, extractSubType(sku), delta);
        }
        await summaryRef.set(
            { totalsByCategory, totalsByRarity, totalsBySubType, updatedAt: FV.serverTimestamp() },
            { merge: true },
        );
        console.log(`✅ ${missingCosmetics.length} cosmetics granted and _summary updated.`);
    } else {
        console.log('✅ Cosmetics already fully unlocked — nothing to write.');
    }

    console.log('\n🎉 Done.\n');
}

run()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('\n❌ Fatal error:', err);
        process.exit(1);
    });
