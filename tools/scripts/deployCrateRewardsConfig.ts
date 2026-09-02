/**
 * Seed CrateRewardsConfig to Firestore
 * 
 * Reads from seeds/CrateRewardsConfig.json and uploads to
 * /GameData/v1/config/CrateRewardsConfig in Firestore.
 * 
 * Usage:
 *   npx ts-node tools/scripts/deployCrateRewardsConfig.ts
 * 
 * This deploys to whichever Firebase project is currently active.
 * Make sure you're pointing at SANDBOX before running!
 */

import * as fs from "fs";
import * as path from "path";
import * as admin from "firebase-admin";

// Initialize Firebase Admin
const app = admin.initializeApp();
const db = admin.firestore();

async function deploy() {
    // Read seed file
    const seedPath = path.resolve(__dirname, "..", "..", "seeds", "Atul-Final-Seeds", "CrateRewardsConfig.json");

    if (!fs.existsSync(seedPath)) {
        console.error(`❌ Seed file not found: ${seedPath}`);
        process.exit(1);
    }

    const raw = fs.readFileSync(seedPath, "utf-8");
    const config = JSON.parse(raw);

    // Stamp the current time
    config.updatedAt = Date.now();

    console.log("Deploying CrateRewardsConfig to Firestore...");
    console.log(`  Seed file: ${seedPath}`);

    const docRef = db.collection("GameData").doc("v1").collection("config").doc("CrateRewardsConfig");

    await docRef.set(config);

    console.log("✅ CrateRewardsConfig deployed to /GameData/v1/config/CrateRewardsConfig");
    console.log(`   Version: ${config.version}`);
    console.log(`   Rarities: ${Object.keys(config.rewardsByRarity).join(", ")}`);

    for (const [rarity, pool] of Object.entries(config.rewardsByRarity)) {
        const p = pool as { cosmeticCount: number; catalogItemCount: number; rewardPool: unknown[] };
        console.log(`   ${rarity}: ${p.cosmeticCount} cosmetics + ${p.catalogItemCount} catalog items (pool size: ${p.rewardPool.length})`);
    }

    process.exit(0);
}

deploy().catch((err) => {
    console.error("❌ Failed to deploy CrateRewardsConfig:", err);
    process.exit(1);
});
