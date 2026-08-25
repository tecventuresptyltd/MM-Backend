import * as admin from "firebase-admin";
import * as fs from "fs";
import * as path from "path";
import { assertBotNamesAreValidUsernames } from "./validateBotNames.js";

/**
 * Seeds all game data catalogs and system configurations into Firestore.
 * Used primarily for setting up the test environment under the Firestore emulator.
 */
export async function seedGameDataCatalogs(): Promise<void> {
  const db = admin.firestore();
  const seedsRoot = path.join(__dirname, "Atul-Final-Seeds");
  
  // 1. Load the normalized catalog file
  const seedFile = path.join(seedsRoot, "gameDataCatalogs.v3.normalized.json");
  if (!fs.existsSync(seedFile)) {
    throw new Error(`Catalog seed file not found at ${seedFile}`);
  }
  
  const seedData = JSON.parse(fs.readFileSync(seedFile, "utf-8"));

  // 2. Extra configs to load
  const configFiles = [
    "BotNamesConfig",
    "BotConfig",
    "SpellUpgradeCosts",
    "CarTuningConfig",
    "CarStatsBudgetConfig",
    "CrateRewardsConfig",
    "CrateSlotsConfig",
    "DailyRewardsConfig",
    "FuelConfig",
    "MasteryConfig",
    "PlayerSlotsConfig",
    "ShopPricingConfig",
    "SpeedUpsCatalog",
    "StarterCrateConfig"
  ];

  for (const configName of configFiles) {
    const file = path.join(seedsRoot, `${configName}.json`);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (configName === "BotNamesConfig") {
        // Bot names are shown next to player names in-race, so they must satisfy the
        // same rules a player's username does. Fail the seed rather than ship a name
        // no player could ever create.
        assertBotNamesAreValidUsernames(data?.data?.names ?? data?.names);
      }
      if (Array.isArray(data)) {
        seedData.push(...data);
      } else if (data && data.path && data.data) {
        seedData.push(data);
      } else {
        seedData.push({ path: `/GameData/v1/config/${configName}`, data });
      }
    }
  }

  // 3. Additional Catalogs to load
  const catalogFiles = [
    "BoostersCatalog",
    "CarEvolutionV2Catalog",
    "SpellEvolutionV2Catalog",
    "TiersCatalog",
    "XpCurve"
  ];

  for (const catalogName of catalogFiles) {
    const file = path.join(seedsRoot, `${catalogName}.json`);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (Array.isArray(data)) {
        seedData.push(...data);
      } else if (data && data.path && data.data) {
        seedData.push(data);
      } else {
        seedData.push({ path: `/GameData/v1/catalogs/${catalogName}`, data });
      }
    }
  }

  // Seeding in a single batch is efficient, but if the count is over 500 we should chunk.
  // Firestore batches are limited to 500 writes.
  const CHUNK_SIZE = 400;
  for (let i = 0; i < seedData.length; i += CHUNK_SIZE) {
    const chunk = seedData.slice(i, i + CHUNK_SIZE);
    const batch = db.batch();
    for (const catalog of chunk) {
      if (catalog && catalog.path && catalog.data) {
        const docRef = db.doc(catalog.path);
        batch.set(docRef, catalog.data);
      }
    }
    await batch.commit();
  }
}
