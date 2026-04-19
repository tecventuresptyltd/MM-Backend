#!/usr/bin/env node
/**
 * generateCarStats.mjs — Car Stat Archetype Balancing Generator
 *
 * Computes balanced, archetype-differentiated stats for all 15 cars across
 * 5 tiers × 10 levels. Uses the CarStatsBudgetConfig for budget parameters
 * and TiersCatalog for car→tier→archetype mapping.
 *
 * Each individual stat is on a 1-10 scale:
 *   - T1L1: average stat = 1.0  (total budget = 5.0)
 *   - T5L10: average stat = 9.5 (total budget = 47.5)
 *   - Car Rating = average stat × 100 (range: 100 → 950)
 *
 * Run with: node tools/generateCarStats.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedsDir = join(__dirname, "..", "seeds", "Atul-Final-Seeds");

// ─────────────────────────────────────────────────────────────────────────────
// 1. Load configs
// ─────────────────────────────────────────────────────────────────────────────

const budgetConfig = JSON.parse(readFileSync(join(seedsDir, "CarStatsBudgetConfig.json"), "utf8"));
const tiersCatalog = JSON.parse(readFileSync(join(seedsDir, "TiersCatalog.json"), "utf8"));
const existingCatalog = JSON.parse(readFileSync(join(seedsDir, "CarsCatalog.json"), "utf8"));

const {
    globalStatCap,
    tierCount,
    maxStarLevel,
    starWeight,
    levelWeight,
    archetypeProfiles,
    flavorVariance = 0.02,
    ratingMultiplier = 100,
    globalFloor = 5.0,
} = budgetConfig;

// Total budget ranges from globalFloor (5.0) to globalStatCap (47.5)
const budgetPerTier = (globalStatCap - globalFloor) / tierCount;

const STAT_KEYS = ["topSpeed", "acceleration", "handling", "boostRegen", "boostPower"];
const STAT_COUNT = STAT_KEYS.length;

// ─────────────────────────────────────────────────────────────────────────────
// 2. Build car→tier→archetype mapping from TiersCatalog
// ─────────────────────────────────────────────────────────────────────────────

const carMapping = {}; // carId → { tierOrder, archetype, displayName, tierName }

for (const [tierId, tierDef] of Object.entries(tiersCatalog.tiers)) {
    for (const car of tierDef.bundledCars) {
        carMapping[car.carId] = {
            tierOrder: tierDef.order,
            archetype: car.archetype,
            displayName: car.displayName || car.carId,
            tierName: tierDef.displayName,
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Seeded flavor variance (deterministic per carId)
// ─────────────────────────────────────────────────────────────────────────────

function hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function getFlavorProfile(carId, baseProfile, variance) {
    const flavored = {};
    let total = 0;

    for (const key of STAT_KEYS) {
        // Deterministic pseudo-random offset based on car ID and stat key
        const statSeed = hashString(`${carId}_${key}`);
        const offset = ((statSeed % 1000) / 500 - 1) * variance; // -variance to +variance
        flavored[key] = baseProfile[key] + offset;
        if (flavored[key] < 0.01) flavored[key] = 0.01; // Floor to prevent negative
        total += flavored[key];
    }

    // Renormalize to exactly 1.0
    for (const key of STAT_KEYS) {
        flavored[key] = flavored[key] / total;
    }

    return flavored;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Compute stats for a car at a specific level
// ─────────────────────────────────────────────────────────────────────────────

function computeStats(tierOrder, starLevel, profile) {
    const tierFloor = globalFloor + (tierOrder - 1) * budgetPerTier;
    const starProgress = starLevel / maxStarLevel;

    const starContribution = budgetPerTier * starWeight * starProgress;
    const levelContribution = budgetPerTier * levelWeight * starProgress; // level == star in 1:1

    const totalBudget = tierFloor + starContribution + levelContribution;
    const avgStat = totalBudget / STAT_COUNT;

    const stats = {};
    for (const key of STAT_KEYS) {
        stats[key] = round2(totalBudget * profile[key]);
    }

    // Car rating = average stat × ratingMultiplier
    const carRating = Math.round(avgStat * ratingMultiplier);

    return { stats, totalBudget: round2(totalBudget), avgStat: round2(avgStat), carRating };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Generate the catalog
// ─────────────────────────────────────────────────────────────────────────────

const newCars = {};
const summaryRows = [];

for (const [carId, existingCar] of Object.entries(existingCatalog.cars)) {
    const mapping = carMapping[carId];
    if (!mapping) {
        console.warn(`⚠️  Car ${carId} not found in TiersCatalog, copying as-is`);
        newCars[carId] = existingCar;
        continue;
    }

    const baseProfile = archetypeProfiles[mapping.archetype];
    if (!baseProfile) {
        console.warn(`⚠️  Archetype ${mapping.archetype} not found in config, copying as-is`);
        newCars[carId] = existingCar;
        continue;
    }

    // Apply per-car flavor
    const flavoredProfile = getFlavorProfile(carId, baseProfile, flavorVariance);

    // Build new car entry preserving non-stat fields
    const newCar = {
        displayName: existingCar.displayName,
        class: existingCar.class,
        basePrice: existingCar.basePrice,
        unlock: existingCar.unlock,
        levels: {},
        i18n: existingCar.i18n,
        version: "v3-archetype-balanced",
        carId: existingCar.carId || carId,
        ability: existingCar.ability,
    };

    for (let lvl = 1; lvl <= 10; lvl++) {
        const existingLevel = existingCar.levels?.[String(lvl)] ?? {};
        const { stats, totalBudget, avgStat, carRating } = computeStats(mapping.tierOrder, lvl, flavoredProfile);

        newCar.levels[String(lvl)] = {
            xpToNext: existingLevel.xpToNext ?? 0,
            upgradeTimerSeconds: existingLevel.upgradeTimerSeconds ?? 0,
            priceCoins: existingLevel.priceCoins ?? 0,
            carRating,
            topSpeed: stats.topSpeed,
            acceleration: stats.acceleration,
            handling: stats.handling,
            boostRegen: stats.boostRegen,
            boostPower: stats.boostPower,
        };

        // Collect summary for level 1 and level 10
        if (lvl === 1 || lvl === 5 || lvl === 10) {
            summaryRows.push({
                car: mapping.displayName,
                tier: mapping.tierOrder,
                tierName: mapping.tierName,
                archetype: mapping.archetype,
                level: lvl,
                ...stats,
                totalBudget,
                avgStat,
                carRating,
            });
        }
    }

    newCars[carId] = newCar;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Write output
// ─────────────────────────────────────────────────────────────────────────────

const newCatalog = {
    version: "v9-archetype-balanced",
    updatedAt: Date.now(),
    cars: newCars,
};

writeFileSync(
    join(seedsDir, "CarsCatalog.json"),
    JSON.stringify(newCatalog, null, 2),
    "utf8"
);

// ─────────────────────────────────────────────────────────────────────────────
// 7. Print summary table
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n╔═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗");
console.log("║                          CAR STAT ARCHETYPE BALANCING — SUMMARY TABLE                                              ║");
console.log("║  Stats are on a 1-10 scale. Avg = average of 5 stats. Rating = Avg × 100.                                         ║");
console.log("╠═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╣");

const header = [
    "Car Name".padEnd(20),
    "T",
    "Arch".padEnd(9),
    "Lv",
    "TopSpd",
    "Accel ",
    "Handl ",
    "BstReg",
    "BstPow",
    "  Avg ",
    "Budget",
    "Rating",
].join(" │ ");

console.log(`║ ${header} ║`);
console.log("╠═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╣");

let currentTier = 0;
for (const row of summaryRows) {
    if (row.tier !== currentTier && row.level === 1) {
        if (currentTier > 0) {
            console.log("╟───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╢");
        }
        currentTier = row.tier;
    }

    const line = [
        row.car.padEnd(20),
        String(row.tier),
        row.archetype.padEnd(9),
        String(row.level).padStart(2),
        String(row.topSpeed).padStart(6),
        String(row.acceleration).padStart(6),
        String(row.handling).padStart(6),
        String(row.boostRegen).padStart(6),
        String(row.boostPower).padStart(6),
        String(row.avgStat).padStart(6),
        String(row.totalBudget).padStart(6),
        String(row.carRating).padStart(6),
    ].join(" │ ");

    console.log(`║ ${line} ║`);
}

console.log("╚═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝");

// ─────────────────────────────────────────────────────────────────────────────
// 8. Validation
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n🔍 Validation:");

let valid = true;

// Check all budgets
for (const [carId, car] of Object.entries(newCars)) {
    const mapping = carMapping[carId];
    if (!mapping) continue;

    for (let lvl = 1; lvl <= 10; lvl++) {
        const levelData = car.levels[String(lvl)];
        const statSum = STAT_KEYS.reduce((s, k) => s + levelData[k], 0);
        const expected = computeStats(mapping.tierOrder, lvl, getFlavorProfile(carId, archetypeProfiles[mapping.archetype], flavorVariance));

        // Validate stat sum matches total budget
        if (Math.abs(statSum - expected.totalBudget) > 0.1) {
            console.error(`  ❌ ${mapping.displayName} Lv${lvl}: stat sum ${statSum.toFixed(2)} != budget ${expected.totalBudget}`);
            valid = false;
        }

        // Validate rating doesn't exceed 1000
        if (levelData.carRating > 1000) {
            console.error(`  ❌ ${mapping.displayName} Lv${lvl}: rating ${levelData.carRating} exceeds 1000`);
            valid = false;
        }
    }
}

// Check archetype differentiation within each tier
for (let tier = 1; tier <= 5; tier++) {
    const tierCars = Object.entries(carMapping).filter(([, m]) => m.tierOrder === tier);
    const lvl10Stats = {};
    for (const [carId, mapping] of tierCars) {
        lvl10Stats[mapping.archetype] = newCars[carId].levels["10"];
    }

    if (lvl10Stats.guardian && lvl10Stats.phantom && lvl10Stats.arcanist) {
        if (lvl10Stats.guardian.boostPower <= lvl10Stats.phantom.boostPower ||
            lvl10Stats.guardian.boostPower <= lvl10Stats.arcanist.boostPower) {
            console.warn(`  ⚠️ Tier ${tier}: Guardian doesn't have highest boostPower`);
        }
        if (lvl10Stats.phantom.topSpeed <= lvl10Stats.guardian.topSpeed ||
            lvl10Stats.phantom.topSpeed <= lvl10Stats.arcanist.topSpeed) {
            console.warn(`  ⚠️ Tier ${tier}: Phantom doesn't have highest topSpeed`);
        }
        if (lvl10Stats.arcanist.handling <= lvl10Stats.guardian.handling ||
            lvl10Stats.arcanist.handling <= lvl10Stats.phantom.handling) {
            console.warn(`  ⚠️ Tier ${tier}: Arcanist doesn't have highest handling`);
        }
    }
}

if (valid) {
    console.log("  ✅ All stat budgets validated successfully!");
    console.log("  ✅ No car rating exceeds 1000");
}

// Print archetype profile comparison
console.log("\n📊 Archetype Profiles:");
for (const arch of Object.keys(archetypeProfiles)) {
    const profile = archetypeProfiles[arch];
    const checkSum = STAT_KEYS.reduce((s, k) => s + profile[k], 0);
    console.log(`  ${arch.padEnd(10)}: topSpd=${profile.topSpeed} accel=${profile.acceleration} handl=${profile.handling} bstReg=${profile.boostRegen} bstPow=${profile.boostPower}  (sum=${checkSum.toFixed(2)})`);
}

// Print tier budget ranges
console.log("\n📊 Tier Budget Ranges (total across 5 stats):");
for (let tier = 1; tier <= 5; tier++) {
    const floor = round2(globalFloor + (tier - 1) * budgetPerTier);
    const ceiling = round2(floor + budgetPerTier);
    const avgFloor = round2(floor / STAT_COUNT);
    const avgCeil = round2(ceiling / STAT_COUNT);
    console.log(`  Tier ${tier}: total ${floor.toFixed(1)} → ${ceiling.toFixed(1)}  |  avg stat ${avgFloor.toFixed(1)} → ${avgCeil.toFixed(1)}  |  rating ${Math.round(avgFloor * 100)} → ${Math.round(avgCeil * 100)}`);
}

console.log(`\n  Global: floor=${globalFloor}, cap=${globalStatCap}, budgetPerTier=${budgetPerTier.toFixed(1)}`);
console.log(`  T5L10 avg stat: ${round2(globalStatCap / STAT_COUNT)}  |  rating: ${Math.round(globalStatCap / STAT_COUNT * ratingMultiplier)}`);
console.log("\n✅ CarsCatalog.json updated successfully!");
console.log(`   Total cars processed: ${Object.keys(newCars).length}`);
