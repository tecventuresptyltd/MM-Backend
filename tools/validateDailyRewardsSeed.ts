/**
 * Validates seeds/Atul-Final-Seeds/DailyRewardsConfig.json before it is seeded.
 *
 * Catches the failure mode that would otherwise only show up as a runtime error
 * on a player's claim: an item/crate reward pointing at a skuId that does not
 * exist in ItemSkusCatalog. `txUpdateInventorySummary` resolves every SKU against
 * the catalog and throws on an unknown one, so a bad ID here means a player taps
 * "Claim" and gets an internal error.
 *
 * Run with:  npx tsx tools/validateDailyRewardsSeed.ts
 */

import * as fs from "fs";
import * as path from "path";

import { normaliseRewardLines } from "../src/shared/rewardLines.js";

const seedDir = path.join(__dirname, "..", "seeds", "Atul-Final-Seeds");

interface CatalogSku {
  skuId?: string;
  id?: string;
  displayName?: string;
  category?: string;
  type?: string;
}

const readJson = (file: string): any => {
  const full = path.join(seedDir, file);
  if (!fs.existsSync(full)) {
    throw new Error(`Seed file not found: ${full}`);
  }
  return JSON.parse(fs.readFileSync(full, "utf8"));
};

const config = readJson("DailyRewardsConfig.json");
const catalog = readJson("ItemSkusCatalog.json");

const rawSkus = catalog.skus ?? catalog;
const skuList: CatalogSku[] = Array.isArray(rawSkus) ? rawSkus : Object.values(rawSkus);
const skuById = new Map<string, CatalogSku>();
for (const sku of skuList) {
  const id = sku.skuId ?? sku.id;
  if (id) {
    skuById.set(id, sku);
  }
}

let failures = 0;
const fail = (message: string): void => {
  console.error(`  ✗ ${message}`);
  failures += 1;
};

console.log("\nDailyRewardsConfig validation");
console.log("─".repeat(60));
console.log(
  `version=${config.version}  cycleLength=${config.cycleLength}  ` +
    `graceDays=${config.graceDays}  loopCycle=${config.loopCycle}  ` +
    `resetOffsetMinutes=${config.resetOffsetMinutes}`,
);
console.log(`known SKUs in catalog: ${skuById.size}\n`);

const cycleLength = Number(config.cycleLength);
if (!Number.isInteger(cycleLength) || cycleLength < 1) {
  fail(`cycleLength must be a positive integer (got ${config.cycleLength})`);
}

const slotKeys = Object.keys(config.slots ?? {});
if (slotKeys.length !== cycleLength) {
  fail(`slots has ${slotKeys.length} entries but cycleLength is ${cycleLength}`);
}

for (let day = 1; day <= cycleLength; day += 1) {
  const slot = config.slots?.[String(day)];
  if (!slot) {
    fail(`missing slot "${day}"`);
    continue;
  }
  if (slot.day !== day) {
    fail(`slot "${day}" has day=${slot.day}`);
  }

  let lines;
  try {
    // The exact validator the runtime loader uses.
    lines = normaliseRewardLines(slot.rewards, `slot ${day}`);
  } catch (error) {
    fail(`slot ${day} rejected: ${(error as Error).message}`);
    continue;
  }

  const described = lines.map((line) => {
    if (line.kind === "coins" || line.kind === "gems") {
      if (line.skuId) {
        fail(`slot ${day}: currency reward must not carry a skuId (found "${line.skuId}")`);
      }
      return `${line.quantity.toLocaleString()} ${line.kind}`;
    }

    const sku = skuById.get(line.skuId!);
    if (!sku) {
      fail(`slot ${day}: skuId "${line.skuId}" is not in ItemSkusCatalog — claims would fail`);
      return `${line.quantity}× ${line.skuId} (MISSING)`;
    }
    return `${line.quantity}× ${sku.displayName} [${sku.category ?? sku.type}]`;
  });

  const flag = slot.isMilestone ? " ★" : "  ";
  console.log(`  day ${String(day).padStart(2)}${flag} ${described.join("  +  ")}`);
}

console.log("─".repeat(60));
if (failures === 0) {
  console.log("✅ Seed is valid — safe to upload.\n");
  process.exit(0);
} else {
  console.error(`❌ ${failures} problem(s) found. Fix before seeding.\n`);
  process.exit(1);
}
