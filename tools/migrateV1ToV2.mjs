/**
 * V1 → V2 Player Migration Script
 *
 * Batch-migrates all existing production players from the V1 linear progression
 * to the new V2 tier/archetype/evolution system.
 *
 * Features:
 *   --dry-run           Log changes without writing
 *   --single-player UID Migrate one player only
 *   --batch-size N      Players per batch (default: 50)
 *   --skip-backup       Skip writing backups (faster, for re-runs)
 *
 * Run: node tools/migrateV1ToV2.mjs [--dry-run] [--single-player <uid>]
 */

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── CLI Args ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SKIP_BACKUP = args.includes("--skip-backup");
const singleIdx = args.indexOf("--single-player");
const SINGLE_PLAYER = singleIdx !== -1 ? args[singleIdx + 1] : null;
const batchIdx = args.indexOf("--batch-size");
const BATCH_SIZE = batchIdx !== -1 ? parseInt(args[batchIdx + 1], 10) : 50;

// ─── Firebase Init ────────────────────────────────────────────────
const credFile = join(__dirname, "..", "backend-production-mystic-motors-prod.json");
const serviceAccount = JSON.parse(readFileSync(credFile, "utf8"));
initializeApp({ credential: cert(serviceAccount), projectId: "mystic-motors-prod" });
const db = getFirestore();

// ─── Catalog Data ─────────────────────────────────────────────────

/** Tier → car IDs mapping from TiersCatalog */
const TIERS = {
  tier_1: {
    order: 1, cars: [
      { carId: "car_h4ayzwf31g", archetype: "guardian" },
      { carId: "car_1wp1gr2p", archetype: "phantom" },
      { carId: "car_4bbp20vv", archetype: "arcanist" },
    ],
  },
  tier_2: {
    order: 2, cars: [
      { carId: "car_3n27817s", archetype: "guardian" },
      { carId: "car_xtm9htbs", archetype: "phantom" },
      { carId: "car_a9x2mkp3", archetype: "arcanist" },
    ],
  },
  tier_3: {
    order: 3, cars: [
      { carId: "car_jh5tqxqk", archetype: "guardian" },
      { carId: "car_0yhea29t", archetype: "phantom" },
      { carId: "car_p4n7mm2z", archetype: "arcanist" },
    ],
  },
  tier_4: {
    order: 4, cars: [
      { carId: "car_8m8qttmy", archetype: "guardian" },
      { carId: "car_rqjrt91b", archetype: "phantom" },
      { carId: "car_kztq00ve", archetype: "arcanist" },
    ],
  },
  tier_5: {
    order: 5, cars: [
      { carId: "car_d2ap3yms", archetype: "guardian" },
      { carId: "car_enmdcw5t", archetype: "phantom" },
      { carId: "car_2n5hnes4", archetype: "arcanist" },
    ],
  },
};

/** Reverse lookup: carId → { tierId, tierOrder, archetype } */
const CAR_LOOKUP = {};
for (const [tierId, tier] of Object.entries(TIERS)) {
  for (const car of tier.cars) {
    CAR_LOOKUP[car.carId] = { tierId, tierOrder: tier.order, archetype: car.archetype };
  }
}

/** XP caps per car from CarsCatalog (xpToNext at each star level) */
const CAR_XP_CAPS = {
  car_h4ayzwf31g: [150, 150, 200, 250, 250, 350, 400, 450, 500, 0],
  car_1wp1gr2p:   [150, 150, 200, 250, 250, 350, 400, 450, 500, 0],
  car_4bbp20vv:   [150, 150, 200, 250, 250, 350, 400, 450, 500, 0],
  car_3n27817s:   [400, 500, 600, 700, 800, 1000, 1200, 1400, 1600, 0],
  car_xtm9htbs:   [400, 500, 600, 700, 800, 1000, 1200, 1400, 1600, 0],
  car_a9x2mkp3:   [400, 500, 600, 700, 800, 1000, 1200, 1400, 1600, 0],
  car_jh5tqxqk:   [950, 1200, 1400, 1700, 1900, 2400, 2800, 3300, 3800, 0],
  car_0yhea29t:   [950, 1200, 1400, 1700, 1900, 2400, 2800, 3300, 3800, 0],
  car_p4n7mm2z:   [950, 1200, 1400, 1700, 1900, 2400, 2800, 3300, 3800, 0],
  car_8m8qttmy:   [1900, 2400, 2900, 3400, 3900, 4800, 5800, 6700, 7700, 0],
  car_rqjrt91b:   [1900, 2400, 2900, 3400, 3900, 4800, 5800, 6700, 7700, 0],
  car_kztq00ve:   [1900, 2400, 2900, 3400, 3900, 4800, 5800, 6700, 7700, 0],
  car_d2ap3yms:   [3500, 4400, 5300, 6200, 7100, 8800, 10500, 12500, 14000, 0],
  car_enmdcw5t:   [3500, 4400, 5300, 6200, 7100, 8800, 10500, 12500, 14000, 0],
  car_2n5hnes4:   [3500, 4400, 5300, 6200, 7100, 8800, 10500, 12500, 14000, 0],
};

/** Spell XP caps per level (v5-mastery-rebalance) */
const SPELL_XP_CAPS = { 1: 4000, 2: 12000, 3: 20000, 4: 27000 };

/** Mastery config */
const MASTERY = {
  carWeight: 1.0,
  spellWeight: 0.33,
  rankThresholds: {
    1: 700, 2: 1900, 3: 3100, 4: 4300, 5: 5500, 6: 8500, 7: 11500,
    8: 14000, 9: 16500, 10: 18500, 11: 22000, 12: 25000, 13: 28000,
    14: 31000, 15: 34000, 16: 37500, 17: 40500, 18: 43000, 19: 46000,
    20: 49000, 21: 55000, 22: 61000, 23: 66500, 24: 72000, 25: 77500,
    26: 83000, 27: 88500, 28: 94000, 29: 99500, 30: 105000,
    31: 115500, 32: 126000, 33: 136500, 34: 147000, 35: 157500,
    36: 173000, 37: 189000, 38: 205000, 39: 220500, 40: 236000,
    41: 259500, 42: 283500, 43: 307500, 44: 331000, 45: 354000,
    46: 390000, 47: 425000, 48: 460500, 49: 496500, 50: 532000,
  },
  tierMinRank: { 1: 0, 2: 5, 3: 10, 4: 20, 5: 30 },
  spellLevelMinRank: { 1: 0, 2: 0, 3: 5, 4: 12, 5: 25 },
};

// ─── Inventory: Crate & Key SKU Definitions ───────────────────────

/** skuId → { category, rarity, gemPrice } */
const CRATE_KEY_SKUS = {
  // Crates
  sku_zz3twgp0wx: { category: "crate", rarity: "common",    gemPrice: 50 },
  sku_72wnqwtfmx: { category: "crate", rarity: "rare",      gemPrice: 150 },
  sku_e8e7jeba7v: { category: "crate", rarity: "exotic",    gemPrice: 400 },
  sku_n9hsc0wxxk: { category: "crate", rarity: "legendary", gemPrice: 1000 },
  sku_kgkjadrd79: { category: "crate", rarity: "mythical",  gemPrice: 2500 },
  // Keys
  sku_rjwe5tdtc4: { category: "key", rarity: "common",    gemPrice: 50 },
  sku_p3yxnyhkpx: { category: "key", rarity: "rare",      gemPrice: 100 },
  sku_zqqmqz7mwb: { category: "key", rarity: "exotic",    gemPrice: 175 },
  sku_acxbr542j1: { category: "key", rarity: "legendary", gemPrice: 300 },
  sku_hq5ywspmr5: { category: "key", rarity: "mythical",  gemPrice: 500 },
};

/** Flat rewards granted per matched crate+key pair (by rarity) */
const CRATE_OPEN_REWARDS = {
  common:    { coins: 200,  shards: 50 },
  rare:      { coins: 500,  shards: 125 },
  exotic:    { coins: 1200, shards: 300 },
  legendary: { coins: 3000, shards: 750 },
  mythical:  { coins: 7500, shards: 1875 },
};

/** 50% gem refund for unmatched leftovers */
const GEM_REFUND_RATE = 0.5;

// ─── Helpers ──────────────────────────────────────────────────────

/** Calculate total XP earned by a car at a given star level */
function getCarXpEarned(carId, starLevel) {
  const caps = CAR_XP_CAPS[carId];
  if (!caps) return 0;
  let total = 0;
  // starLevel 1 = level index 0, starLevel N means completed levels 1..N-1
  for (let i = 0; i < starLevel - 1 && i < caps.length; i++) {
    total += caps[i];
  }
  return total;
}

/** Calculate total XP earned by a spell at a given level */
function getSpellXpEarned(spellLevel) {
  let total = 0;
  for (let l = 1; l < spellLevel; l++) {
    total += SPELL_XP_CAPS[l] ?? 0;
  }
  return total;
}

/** Calculate mastery rank from mastery XP */
function getMasteryRank(masteryXp) {
  let rank = 0;
  for (const [r, threshold] of Object.entries(MASTERY.rankThresholds)) {
    if (masteryXp >= threshold) rank = parseInt(r, 10);
  }
  return rank;
}

/** Get the minimum mastery XP needed to reach a rank */
function getXpForRank(rank) {
  return MASTERY.rankThresholds[rank] ?? 0;
}

/** Check if a player doc has V2 signals (already migrated or V2-native) */
function hasV2Signals(garageData, profileData, licensesExists) {
  if (licensesExists) return true;
  if (profileData?.masteryRank !== undefined && profileData.masteryRank !== null) return true;
  const cars = garageData?.cars ?? {};
  for (const car of Object.values(cars)) {
    if (car.starLevel !== undefined && car.starLevel !== null) return true;
  }
  return false;
}

// ─── Per-Player Migration ─────────────────────────────────────────

async function migratePlayer(uid, stats) {
  const prefix = DRY_RUN ? "[DRY-RUN] " : "";
  const playerRef = db.doc(`Players/${uid}`);

  // ── Step 0: Guard — check migrationVersion ──
  const playerDoc = await playerRef.get();
  if (!playerDoc.exists) {
    console.log(`${prefix}⏭️  ${uid}: Player doc missing, skipping.`);
    stats.skipped++;
    return;
  }

  const playerData = playerDoc.data();
  if (playerData.migrationVersion >= "v2") {
    console.log(`${prefix}⏭️  ${uid}: Already migrated (migrationVersion=${playerData.migrationVersion}).`);
    stats.skipped++;
    return;
  }

  // ── Read all subdocs ──
  const [garageDoc, economyDoc, spellsDoc, profileDoc, licensesDoc] = await Promise.all([
    db.doc(`Players/${uid}/Garage/Cars`).get(),
    db.doc(`Players/${uid}/Economy/Stats`).get(),
    db.doc(`Players/${uid}/Spells/Levels`).get(),
    db.doc(`Players/${uid}/Profile/Profile`).get(),
    db.doc(`Players/${uid}/Licenses/Owned`).get(),
  ]);

  // Read inventory (for crate/key migration)
  const inventorySnap = await db.collection(`Players/${uid}/Inventory`).get();

  const garageData = garageDoc.exists ? garageDoc.data() : null;
  const economyData = economyDoc.exists ? economyDoc.data() : null;
  const spellsData = spellsDoc.exists ? spellsDoc.data() : null;
  const profileData = profileDoc.exists ? profileDoc.data() : null;

  // ── Secondary V2 signal check ──
  if (hasV2Signals(garageData, profileData, licensesDoc.exists)) {
    console.log(`${prefix}⏭️  ${uid}: V2 signals detected, stamping marker only.`);
    if (!DRY_RUN) {
      await playerRef.update({ migrationVersion: "v2", migratedAt: FieldValue.serverTimestamp() });
    }
    stats.skipped++;
    return;
  }

  // ── Step 1: Backup ──
  if (!SKIP_BACKUP && !DRY_RUN) {
    await db.doc(`System/MigrationBackups/${uid}/snapshot`).set({
      garage: garageData,
      economy: economyData,
      spells: spellsData,
      profile: profileData,
      capturedAt: FieldValue.serverTimestamp(),
    });
  }

  // ── Step 2: Determine tier licenses ──
  const ownedCarIds = new Set(Object.keys(garageData?.cars ?? {}));
  const grantedTiers = {};
  let highestTierOrder = 0;

  for (const [tierId, tier] of Object.entries(TIERS)) {
    const ownsAny = tier.cars.some((c) => ownedCarIds.has(c.carId));
    if (ownsAny) {
      grantedTiers[tierId] = {
        tierId,
        purchasedAt: Timestamp.now(),
        grantedCars: tier.cars.map((c) => c.carId),
      };
      highestTierOrder = Math.max(highestTierOrder, tier.order);
    }
  }

  // Safety floor: ALWAYS grant tier_1 — every player must have starter tier
  if (!grantedTiers.tier_1) {
    grantedTiers.tier_1 = {
      tierId: "tier_1",
      purchasedAt: Timestamp.now(),
      grantedCars: TIERS.tier_1.cars.map((c) => c.carId),
    };
    highestTierOrder = Math.max(highestTierOrder, 1);
    console.log(`${prefix}  ⚠️  ${uid}: No tier_1 cars found — granting starter tier as safety floor.`);
  }

  // ── Step 3: Build migrated car data ──
  const migratedCars = {};
  let totalCarXp = 0;
  const now = Timestamp.now();

  // Migrate existing cars
  for (const [carId, carData] of Object.entries(garageData?.cars ?? {})) {
    const lookup = CAR_LOOKUP[carId];
    if (!lookup) {
      // Unknown car — preserve as-is with minimal V2 fields
      migratedCars[carId] = { ...carData, fuelBars: 5, fuelLastRefillAt: now };
      continue;
    }
    const upgradeLevel = carData.upgradeLevel ?? 0;
    const starLevel = upgradeLevel + 1; // V1 0-9 → V2 1-10
    const carXp = getCarXpEarned(carId, starLevel);
    totalCarXp += carXp;

    migratedCars[carId] = {
      ...carData,
      starLevel,
      carLevel: starLevel,
      xp: 0,
      isXpCapped: false,
      fuelBars: 5,
      fuelLastRefillAt: now,
      archetype: lookup.archetype,
      tierOrder: lookup.tierOrder,
      acquiredVia: "migration",
      updatedAt: now,
    };
  }

  // Add newly granted cars from tier licenses
  for (const [tierId, license] of Object.entries(grantedTiers)) {
    const tier = TIERS[tierId];
    for (const car of tier.cars) {
      if (!migratedCars[car.carId]) {
        migratedCars[car.carId] = {
          carId: car.carId,
          upgradeLevel: 0,
          tuning: {},
          starLevel: 1,
          carLevel: 1,
          xp: 0,
          isXpCapped: false,
          fuelBars: 5,
          fuelLastRefillAt: now,
          archetype: car.archetype,
          tierOrder: tier.order,
          acquiredVia: "tierLicense",
          createdAt: now,
          updatedAt: now,
        };
        // Star level 1 = 0 XP earned, no mastery contribution
      }
    }
  }

  // ── Step 4: Calculate mastery ──
  // Spell XP
  let totalSpellXp = 0;
  let highestSpellLevel = 0;
  const v1Levels = spellsData?.levels ?? {};
  const v2Spells = spellsData?.spells ?? {};

  // Check both V1 format (levels map) and any partial V2 format
  const spellLevelMap = {};
  for (const [spellId, level] of Object.entries(v1Levels)) {
    if (typeof level === "number" && level > 0) {
      spellLevelMap[spellId] = level;
    }
  }
  // V2 format overrides if present
  for (const [spellId, data] of Object.entries(v2Spells)) {
    if (data?.level > 0) {
      spellLevelMap[spellId] = data.level;
    }
  }

  for (const [spellId, level] of Object.entries(spellLevelMap)) {
    totalSpellXp += getSpellXpEarned(level);
    highestSpellLevel = Math.max(highestSpellLevel, level);
  }

  const rawMasteryXp = (totalCarXp * MASTERY.carWeight) + (totalSpellXp * MASTERY.spellWeight);
  let calculatedRank = getMasteryRank(rawMasteryXp);

  // Safety floor clamp
  const tierFloor = MASTERY.tierMinRank[highestTierOrder] ?? 0;
  const spellFloor = MASTERY.spellLevelMinRank[highestSpellLevel] ?? 0;
  const floorRank = Math.max(calculatedRank, tierFloor, spellFloor);

  let finalMasteryXp = rawMasteryXp;
  if (floorRank > calculatedRank) {
    finalMasteryXp = Math.max(rawMasteryXp, getXpForRank(floorRank));
    console.log(`${prefix}  ⬆️  ${uid}: Mastery floor applied: calculated MR${calculatedRank} → MR${floorRank}`);
  }
  const finalRank = getMasteryRank(finalMasteryXp);

  // ── Step 5: Build migrated spell data ──
  const migratedSpells = {};
  const unlockedAt = {};
  for (const [spellId, level] of Object.entries(spellLevelMap)) {
    migratedSpells[spellId] = { level, xp: 0, isXpCapped: false };
    unlockedAt[spellId] = now;
  }

  // ── Step 6: Inventory — Match crates + keys, open pairs, refund leftovers ──
  const cratesByRarity = {};  // rarity → [{ skuId, qty }]
  const keysByRarity = {};    // rarity → [{ skuId, qty }]
  const crateKeyDocIds = [];  // inventory doc IDs to delete

  for (const invDoc of inventorySnap.docs) {
    const skuId = invDoc.id;
    if (skuId === "_summary") continue;
    const meta = CRATE_KEY_SKUS[skuId];
    if (!meta) continue; // not a crate or key — skip (cosmetics stay)

    const qty = Math.floor(Number(invDoc.data()?.quantity ?? invDoc.data()?.qty ?? 0));
    if (qty <= 0) continue;

    crateKeyDocIds.push(skuId);
    const bucket = meta.category === "crate" ? cratesByRarity : keysByRarity;
    if (!bucket[meta.rarity]) bucket[meta.rarity] = [];
    bucket[meta.rarity].push({ skuId, qty });
  }

  // Match pairs by rarity and calculate rewards
  let inventoryCoins = 0;
  let inventoryShards = 0;
  let inventoryGems = 0;
  let totalPairsOpened = 0;
  let totalLeftovers = 0;

  const allRarities = new Set([...Object.keys(cratesByRarity), ...Object.keys(keysByRarity)]);
  for (const rarity of allRarities) {
    const totalCrates = (cratesByRarity[rarity] ?? []).reduce((s, e) => s + e.qty, 0);
    const totalKeys = (keysByRarity[rarity] ?? []).reduce((s, e) => s + e.qty, 0);
    const pairs = Math.min(totalCrates, totalKeys);

    // Grant rewards for matched pairs
    if (pairs > 0) {
      const rewards = CRATE_OPEN_REWARDS[rarity] ?? CRATE_OPEN_REWARDS.common;
      inventoryCoins += rewards.coins * pairs;
      inventoryShards += rewards.shards * pairs;
      totalPairsOpened += pairs;
    }

    // Refund unmatched leftovers at 50% gem value
    const leftoverCrates = totalCrates - pairs;
    const leftoverKeys = totalKeys - pairs;

    if (leftoverCrates > 0) {
      const crateMeta = (cratesByRarity[rarity] ?? [])[0];
      if (crateMeta) {
        const gemPrice = CRATE_KEY_SKUS[crateMeta.skuId]?.gemPrice ?? 50;
        inventoryGems += Math.floor(gemPrice * GEM_REFUND_RATE) * leftoverCrates;
        totalLeftovers += leftoverCrates;
      }
    }
    if (leftoverKeys > 0) {
      const keyMeta = (keysByRarity[rarity] ?? [])[0];
      if (keyMeta) {
        const gemPrice = CRATE_KEY_SKUS[keyMeta.skuId]?.gemPrice ?? 50;
        inventoryGems += Math.floor(gemPrice * GEM_REFUND_RATE) * leftoverKeys;
        totalLeftovers += leftoverKeys;
      }
    }
  }

  // ── Step 7: Economy ──
  // spellShards: initialize to 0 for V2, plus any crate rewards on top
  const economyUpdates = { updatedAt: now };
  economyUpdates.spellShards = inventoryShards; // init to 0 + crate rewards (V1 had no shards)
  if (inventoryCoins > 0) economyUpdates.coins = FieldValue.increment(inventoryCoins);
  if (inventoryGems > 0) economyUpdates.gems = FieldValue.increment(inventoryGems);

  // ── Log summary ──
  const ownedCount = Object.keys(garageData?.cars ?? {}).length;
  const newCarCount = Object.keys(migratedCars).length - ownedCount;
  const inventoryLog = crateKeyDocIds.length > 0
    ? `, 📦 ${totalPairsOpened} crate pairs opened (+${inventoryCoins}c/+${inventoryShards}s), ${totalLeftovers} leftovers refunded (+${inventoryGems}g)`
    : "";
  console.log(
    `${prefix}✅ ${uid}: ${ownedCount} cars owned → ${Object.keys(migratedCars).length} total ` +
    `(+${newCarCount} from licenses), ${Object.keys(grantedTiers).length} tier licenses, ` +
    `${Object.keys(spellLevelMap).length} spells, MR${finalRank} (${Math.round(finalMasteryXp)} MP)${inventoryLog}`
  );

  if (DRY_RUN) {
    stats.processed++;
    return;
  }

  // ── Step 7-10: Write all changes ──
  const batch = db.batch();
  const timestamp = FieldValue.serverTimestamp();

  // Garage
  batch.set(db.doc(`Players/${uid}/Garage/Cars`), { cars: migratedCars, updatedAt: timestamp }, { merge: false });

  // Licenses
  if (Object.keys(grantedTiers).length > 0) {
    batch.set(db.doc(`Players/${uid}/Licenses/Owned`), { licenses: grantedTiers, updatedAt: timestamp });
  }

  // Spells — preserve existing data, add V2 structure
  const spellWriteData = { updatedAt: timestamp };
  if (Object.keys(migratedSpells).length > 0) {
    spellWriteData.spells = migratedSpells;
    spellWriteData.unlockedAt = unlockedAt;
  }
  // Keep legacy levels map for backward compat
  if (Object.keys(v1Levels).length > 0) {
    spellWriteData.levels = v1Levels;
  }
  if (spellsDoc.exists) {
    batch.update(db.doc(`Players/${uid}/Spells/Levels`), spellWriteData);
  } else if (Object.keys(migratedSpells).length > 0) {
    batch.set(db.doc(`Players/${uid}/Spells/Levels`), spellWriteData);
  }

  // Economy (spellShards init + crate/key rewards + gem refunds)
  if (economyDoc.exists) {
    batch.update(db.doc(`Players/${uid}/Economy/Stats`), economyUpdates);
  }

  // Delete crate & key inventory docs + update _summary
  for (const skuId of crateKeyDocIds) {
    batch.delete(db.doc(`Players/${uid}/Inventory/${skuId}`));
  }
  if (crateKeyDocIds.length > 0) {
    const summaryRef = db.doc(`Players/${uid}/Inventory/_summary`);
    batch.update(summaryRef, {
      "totalsByCategory.crate": 0,
      "totalsByCategory.key": 0,
      updatedAt: timestamp,
    });
  }

  // Profile — set all V2 mastery fields to match bootstrap structure
  const nextRankThreshold = MASTERY.rankThresholds[finalRank + 1];
  const currentRankThreshold = MASTERY.rankThresholds[finalRank] ?? 0;
  const expProgress = Math.round(finalMasteryXp - currentRankThreshold);
  const expToNextLevel = nextRankThreshold ? (nextRankThreshold - currentRankThreshold) : 0;
  const expProgressDisplay = nextRankThreshold ? `${expProgress} / ${expToNextLevel}` : "Max Rank";

  const profileUpdates = {
    masteryXp: finalMasteryXp,
    masteryRank: finalRank,
    level: finalRank,                          // V2: level = masteryRank
    expProgress,                               // XP within current rank
    expToNextLevel,                            // XP span current→next rank
    expProgressDisplay,                        // human readable
    pitCrewSlots: 1,
    librarySlots: 1,
    updatedAt: timestamp,
  };
  if (profileDoc.exists) {
    batch.update(db.doc(`Players/${uid}/Profile/Profile`), profileUpdates);
  }

  // Queues (empty)
  batch.set(db.doc(`Players/${uid}/Queues/PitCrew`), { slots: [], maxSlots: 1, updatedAt: timestamp });
  batch.set(db.doc(`Players/${uid}/Queues/Library`), { slots: [], maxSlots: 1, updatedAt: timestamp });

  // Crate slots (4 empty)
  batch.set(db.doc(`Players/${uid}/Crates/Slots`), {
    slots: [null, null, null, null], maxSlots: 4, updatedAt: timestamp,
  });

  // Stamp migration marker
  batch.update(playerRef, { migrationVersion: "v2", migratedAt: timestamp });

  await batch.commit();
  stats.processed++;
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  const mode = DRY_RUN ? "DRY-RUN" : "LIVE";
  console.log(`\n🚀 V1 → V2 Migration [${mode}]`);
  console.log(`   Batch size: ${BATCH_SIZE}`);
  if (SINGLE_PLAYER) console.log(`   Single player: ${SINGLE_PLAYER}`);
  console.log("");

  const stats = { processed: 0, skipped: 0, errors: 0 };

  if (SINGLE_PLAYER) {
    try {
      await migratePlayer(SINGLE_PLAYER, stats);
    } catch (err) {
      console.error(`❌ ${SINGLE_PLAYER}: ${err.message}`);
      stats.errors++;
    }
  } else {
    // Paginate through all players
    let lastDoc = null;
    let batchNum = 0;

    while (true) {
      batchNum++;
      let query = db.collection("Players").limit(BATCH_SIZE);
      if (lastDoc) query = query.startAfter(lastDoc);

      const snapshot = await query.get();
      if (snapshot.empty) break;

      console.log(`\n── Batch ${batchNum} (${snapshot.size} players) ──`);

      for (const doc of snapshot.docs) {
        try {
          await migratePlayer(doc.id, stats);
        } catch (err) {
          console.error(`❌ ${doc.id}: ${err.message}`);
          stats.errors++;
        }
      }

      lastDoc = snapshot.docs[snapshot.docs.length - 1];

      // Brief pause between batches to avoid rate limiting
      if (snapshot.size === BATCH_SIZE) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  console.log(`\n═══════════════════════════════════════`);
  console.log(`  Migration Complete [${mode}]`);
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
