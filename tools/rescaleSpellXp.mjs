/**
 * Rescale Spell XP for all migrated players.
 *
 * What it does:
 *   1. Reads each player's Spells/Levels, Garage/Cars, and Profile/Profile
 *   2. Scales spell XP values by SCALE_FACTOR (0.35)
 *   3. Recalculates masteryXp using spellWeight=1.0 (instead of old 0.33)
 *   4. Updates Profile + Spells docs
 *
 * Usage:
 *   node tools/rescaleSpellXp.mjs --dry-run          # preview changes
 *   node tools/rescaleSpellXp.mjs                    # live run
 *   node tools/rescaleSpellXp.mjs --single-player <uid>
 */
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldPath, FieldValue } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── CLI ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const singleIdx = args.indexOf("--single-player");
const SINGLE_PLAYER = singleIdx !== -1 ? args[singleIdx + 1] : null;
const BATCH_SIZE = 500;

// ─── Firebase ─────────────────────────────────────────────────────
const credFile = join(__dirname, "..", "backend-production-mystic-motors-prod.json");
const serviceAccount = JSON.parse(readFileSync(credFile, "utf8"));
initializeApp({ credential: cert(serviceAccount), projectId: "mystic-motors-prod" });
const db = getFirestore();

// ─── Constants ────────────────────────────────────────────────────
const SCALE_FACTOR = 0.35;  // old spellWeight was 0.33, new earn rates are 0.35x
const NEW_SPELL_WEIGHT = 1.0;
const OLD_SPELL_WEIGHT = 0.33;
const CAR_WEIGHT = 1.0;

// Spell XP caps at old scale (used to recalculate totalSpellXp from level)
const OLD_SPELL_XP_CAPS = { 1: 4000, 2: 12000, 3: 20000, 4: 27000 };
const NEW_SPELL_XP_CAPS = { 1: 1400, 2: 4200, 3: 7000, 4: 9450 };

// Car XP caps (same as migration — used to recalculate totalCarXp)
const CAR_XP_PER_STAR = { 1: 0, 2: 300, 3: 750, 4: 1500, 5: 3000, 6: 5250, 7: 8400, 8: 12600, 9: 18000, 10: 25200 };

const RANK_THRESHOLDS = {
  1: 700, 2: 1900, 3: 3100, 4: 4300, 5: 5500, 6: 8500, 7: 11500,
  8: 14000, 9: 16500, 10: 18500, 11: 22000, 12: 25000, 13: 28000,
  14: 31000, 15: 34000, 16: 37500, 17: 40500, 18: 43000, 19: 46000,
  20: 49000, 21: 55000, 22: 61000, 23: 66500, 24: 72000, 25: 77500,
  26: 83000, 27: 88500, 28: 94000, 29: 99500, 30: 105000,
  31: 115500, 32: 126000, 33: 136500, 34: 147000, 35: 157500,
  36: 173000, 37: 189000, 38: 205000, 39: 220500, 40: 236000,
  41: 259500, 42: 283500, 43: 307500, 44: 331000, 45: 354000,
  46: 390000, 47: 425000, 48: 460500, 49: 496500, 50: 532000,
};

function getMasteryRank(xp) {
  let rank = 0;
  for (const [r, threshold] of Object.entries(RANK_THRESHOLDS)) {
    if (xp >= threshold) rank = Number(r);
  }
  return rank;
}

function getXpForRank(rank) {
  return RANK_THRESHOLDS[rank] ?? 0;
}

function getCarXpEarned(starLevel) {
  let total = 0;
  for (let s = 1; s < starLevel; s++) {
    total += CAR_XP_PER_STAR[s] ?? 0;
  }
  return total;
}

function getOldSpellXpEarned(level) {
  let total = 0;
  for (let l = 1; l < level; l++) {
    total += OLD_SPELL_XP_CAPS[l] ?? 0;
  }
  return total;
}

function getNewSpellXpEarned(level) {
  let total = 0;
  for (let l = 1; l < level; l++) {
    total += NEW_SPELL_XP_CAPS[l] ?? 0;
  }
  return total;
}

// ─── Per-Player Rescale ───────────────────────────────────────────
async function rescalePlayer(uid, prefetched, stats) {
  const prefix = DRY_RUN ? "[DRY-RUN] " : "";
  const { profileData, garageData, spellsData } = prefetched;

  if (!profileData) { stats.skipped++; return; }
  if (profileData.spellXpRescaled) {
    stats.skipped++;
    return;
  }

  // Recalculate total car XP from garage
  let totalCarXp = 0;
  if (garageData?.cars) {
    for (const [carId, car] of Object.entries(garageData.cars)) {
      const starLevel = car.starLevel ?? car.upgradeLevel ?? 1;
      totalCarXp += getCarXpEarned(starLevel);
    }
  }

  // Recalculate total spell XP at NEW scale from spell levels
  let totalNewSpellXp = 0;
  const spells = spellsData?.spells ?? {};
  const scaledSpells = {};
  let spellCount = 0;
  const seenSpellIds = new Set();

  for (const [spellId, data] of Object.entries(spells)) {
    const level = data?.level ?? 1;
    const oldXp = data?.xp ?? 0;
    // Scale the within-level XP progress
    const newXp = Math.round(oldXp * SCALE_FACTOR);
    const newLevelBase = getNewSpellXpEarned(level);
    totalNewSpellXp += newLevelBase + newXp;
    scaledSpells[spellId] = { ...data, xp: newXp };
    seenSpellIds.add(spellId);
    spellCount++;
  }

  // Also handle V1 levels format if present (avoid double-counting)
  const v1Levels = spellsData?.levels ?? {};
  for (const [spellId, level] of Object.entries(v1Levels)) {
    if (typeof level === "number" && level > 0 && !seenSpellIds.has(spellId)) {
      totalNewSpellXp += getNewSpellXpEarned(level);
      seenSpellIds.add(spellId);
    }
  }

  // Calculate old spell contribution to mastery (what migration applied)
  const oldMasteryXp = profileData.masteryXp ?? 0;
  const oldRank = profileData.masteryRank ?? 0;
  let totalOldSpellXp = 0;
  for (const [spellId, data] of Object.entries(spells)) {
    const level = data?.level ?? 1;
    totalOldSpellXp += getOldSpellXpEarned(level);
  }
  // V1-only spells
  for (const [spellId, level] of Object.entries(v1Levels)) {
    if (typeof level === "number" && level > 0 && !seenSpellIds.has(spellId)) {
      totalOldSpellXp += getOldSpellXpEarned(level);
    }
  }

  const oldSpellContribution = Math.round(totalOldSpellXp * OLD_SPELL_WEIGHT);
  const newSpellContribution = Math.round(totalNewSpellXp * NEW_SPELL_WEIGHT);
  const spellDelta = newSpellContribution - oldSpellContribution;

  // Apply delta to existing mastery (preserves any post-migration gameplay XP)
  const newMasteryXp = Math.max(0, oldMasteryXp + spellDelta);
  const newRank = getMasteryRank(newMasteryXp);

  // Calculate progress within rank
  const currentThreshold = getXpForRank(newRank);
  const nextThreshold = RANK_THRESHOLDS[newRank + 1];
  const expProgress = newMasteryXp - currentThreshold;
  const expToNextLevel = nextThreshold ? nextThreshold - currentThreshold : 999999;

  const delta = newMasteryXp - oldMasteryXp;

  if (Math.abs(delta) < 1 && Object.keys(scaledSpells).length === 0) {
    stats.skipped++;
    return;
  }

  // Debug: show breakdown for non-trivial changes
  if (SINGLE_PLAYER || Math.abs(delta) > 500) {
    console.log(`   🔍 ${uid}: oldSpellContrib=${oldSpellContribution}, newSpellContrib=${newSpellContribution}, delta=${spellDelta}`);
  }

  console.log(`${prefix}✅ ${uid}: mastery ${oldMasteryXp}→${newMasteryXp} (${delta >= 0 ? "+" : ""}${delta}), rank ${oldRank}→${newRank}, ${spellCount} spells rescaled`);

  if (!DRY_RUN) {
    const batch = db.batch();

    // Update profile mastery
    batch.update(db.doc(`Players/${uid}/Profile/Profile`), {
      masteryXp: newMasteryXp,
      masteryRank: newRank,
      level: newRank,
      expProgress,
      expToNextLevel,
      expProgressDisplay: `${expProgress} / ${expToNextLevel}`,
      spellXpRescaled: true,
      updatedAt: FieldValue.serverTimestamp(),
    });

    // Update spell XP values
    if (Object.keys(scaledSpells).length > 0) {
      const dotUpdate = {};
      for (const [sid, sData] of Object.entries(scaledSpells)) {
        dotUpdate[`spells.${sid}`] = sData;
      }
      dotUpdate.updatedAt = FieldValue.serverTimestamp();
      batch.update(db.doc(`Players/${uid}/Spells/Levels`), dotUpdate);
    }

    await batch.commit();
  }

  stats.processed++;
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  const mode = DRY_RUN ? "DRY-RUN" : "LIVE";
  console.log(`\n🔧 Spell XP Rescale [${mode}]`);
  console.log(`   Scale factor: ${SCALE_FACTOR}`);
  console.log(`   spellWeight: ${OLD_SPELL_WEIGHT} → ${NEW_SPELL_WEIGHT}\n`);

  const stats = { processed: 0, skipped: 0, errors: 0 };

  if (SINGLE_PLAYER) {
    const uid = SINGLE_PLAYER;
    const [profileDoc, garageDoc, spellsDoc] = await Promise.all([
      db.doc(`Players/${uid}/Profile/Profile`).get(),
      db.doc(`Players/${uid}/Garage/Cars`).get(),
      db.doc(`Players/${uid}/Spells/Levels`).get(),
    ]);
    await rescalePlayer(uid, {
      profileData: profileDoc.exists ? profileDoc.data() : null,
      garageData: garageDoc.exists ? garageDoc.data() : null,
      spellsData: spellsDoc.exists ? spellsDoc.data() : null,
    }, stats);
  } else {
    let lastDoc = null;
    let batchNum = 0;

    while (true) {
      batchNum++;
      let query = db.collection("Players").orderBy(FieldPath.documentId()).limit(BATCH_SIZE);
      if (lastDoc) query = query.startAfter(lastDoc);

      const snapshot = await query.get();
      if (snapshot.empty) break;

      console.log(`── Batch ${batchNum} (${snapshot.size} players) ──`);

      const uids = snapshot.docs.map(d => d.id);

      const profileRefs = uids.map(uid => db.doc(`Players/${uid}/Profile/Profile`));
      const garageRefs = uids.map(uid => db.doc(`Players/${uid}/Garage/Cars`));
      const spellsRefs = uids.map(uid => db.doc(`Players/${uid}/Spells/Levels`));

      const [profileDocs, garageDocs, spellsDocs] = await Promise.all([
        db.getAll(...profileRefs),
        db.getAll(...garageRefs),
        db.getAll(...spellsRefs),
      ]);

      console.log(`   📥 Bulk-read complete for ${uids.length} players`);

      for (let i = 0; i < uids.length; i++) {
        const uid = uids[i];
        try {
          await rescalePlayer(uid, {
            profileData: profileDocs[i].exists ? profileDocs[i].data() : null,
            garageData: garageDocs[i].exists ? garageDocs[i].data() : null,
            spellsData: spellsDocs[i].exists ? spellsDocs[i].data() : null,
          }, stats);
        } catch (err) {
          console.error(`❌ ${uid}: ${err.message}`);
          stats.errors++;
        }
      }

      lastDoc = snapshot.docs[snapshot.docs.length - 1];
      if (snapshot.size === BATCH_SIZE) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  console.log(`\n═══════════════════════════════════════`);
  console.log(`  Rescale Complete [${mode}]`);
  console.log(`  Processed: ${stats.processed}`);
  console.log(`  Skipped:   ${stats.skipped}`);
  console.log(`  Errors:    ${stats.errors}`);
  console.log(`═══════════════════════════════════════\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("💥 Fatal error:", err);
    process.exit(1);
  });
