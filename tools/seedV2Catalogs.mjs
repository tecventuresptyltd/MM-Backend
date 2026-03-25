#!/usr/bin/env node
/**
 * Seed V2 Game Data Catalogs to Firestore
 *
 * Uploads all V2 catalogs from seeds/Atul-Final-Seeds to:
 * - /GameData/v1/catalogs/{catalogName}
 * - /GameData/v1/config/{configName}
 *
 * Run with: node seedV2Catalogs.mjs <env>
 * Examples:
 *   node seedV2Catalogs.mjs sandbox
 *   node seedV2Catalogs.mjs prod
 */

import admin from "firebase-admin";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedsDir = join(__dirname, "..", "seeds", "Atul-Final-Seeds");

const env = process.argv[2] || "sandbox";

const credFile =
    env === "prod"
        ? "./backend-production-mystic-motors-prod.json"
        : "./mystic-motors-sandbox-9b64d57718a2.json";

if (!existsSync(credFile)) {
    console.error(`❌ Credential file not found: ${credFile}`);
    console.error("Make sure you are running from the project root directory.");
    process.exit(1);
}

console.log(`\n📦 V2 Catalog Seeder`);
console.log(`Environment: ${env}\n`);

const serviceAccount = JSON.parse(readFileSync(credFile, "utf8"));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db = admin.firestore();

// V2 Catalogs to upload (go to /GameData/v1/catalogs)
const catalogs = [
    { file: "TiersCatalog.json", docName: "TiersCatalog" },
    { file: "CarEvolutionV2Catalog.json", docName: "CarEvolutionV2Catalog" },
    { file: "SpellEvolutionV2Catalog.json", docName: "SpellEvolutionV2Catalog" },
];

// V2 Configs to upload (go to /GameData/v1/config)
const configs = [
    { file: "FuelConfig.json", docName: "FuelConfig" },
    { file: "CrateSlotsConfig.json", docName: "CrateSlotsConfig" },
    { file: "PlayerSlotsConfig.json", docName: "PlayerSlotsConfig" },
    { file: "CarStatsBudgetConfig.json", docName: "CarStatsBudgetConfig" },
    { file: "CrateRewardsConfig.json", docName: "CrateRewardsConfig" },
    { file: "MasteryConfig.json", docName: "MasteryConfig" },
    { file: "BoostersCatalog.json", docName: "BoostersCatalog" },
    { file: "SpeedUpsCatalog.json", docName: "SpeedUpsCatalog" },
    { file: "OffersCatalog.json", docName: "OffersCatalog" },
    { file: "DailyRewardsConfig.json", docName: "DailyRewardsConfig" },
];

async function seedV2Catalogs() {
    console.log("📂 Uploading V2 Catalogs to /GameData/v1/catalogs/...\n");

    for (const catalog of catalogs) {
        const filePath = join(seedsDir, catalog.file);

        if (!existsSync(filePath)) {
            console.warn(`⚠️  Skipping ${catalog.file} - file not found`);
            continue;
        }

        try {
            const data = JSON.parse(readFileSync(filePath, "utf8"));
            const docRef = db.doc(`GameData/v1/catalogs/${catalog.docName}`);

            await docRef.set({
                ...data,
                _uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
                _uploadedBy: "seedV2Catalogs.mjs",
            });

            console.log(`  ✅ ${catalog.docName}`);
        } catch (err) {
            console.error(`  ❌ ${catalog.docName}: ${err.message}`);
        }
    }

    console.log("\n📂 Uploading V2 Configs to /GameData/v1/config/...\n");

    for (const config of configs) {
        const filePath = join(seedsDir, config.file);

        if (!existsSync(filePath)) {
            console.warn(`⚠️  Skipping ${config.file} - file not found`);
            continue;
        }

        try {
            const data = JSON.parse(readFileSync(filePath, "utf8"));
            const docRef = db.doc(`GameData/v1/config/${config.docName}`);

            await docRef.set({
                ...data,
                _uploadedAt: admin.firestore.FieldValue.serverTimestamp(),
                _uploadedBy: "seedV2Catalogs.mjs",
            });

            console.log(`  ✅ ${config.docName}`);
        } catch (err) {
            console.error(`  ❌ ${config.docName}: ${err.message}`);
        }
    }

    console.log("\n───────────────────────────────────────────");
    console.log("✅ V2 Catalogs seeded successfully!");
    console.log("───────────────────────────────────────────\n");

    console.log("Firestore locations:");
    console.log("  Catalogs: /GameData/v1/catalogs/");
    catalogs.forEach((c) => console.log(`    • ${c.docName}`));
    console.log("  Configs:  /GameData/v1/config/");
    configs.forEach((c) => console.log(`    • ${c.docName}`));
    console.log("");
}

seedV2Catalogs()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error("\nFatal error:", err);
        process.exit(1);
    });
