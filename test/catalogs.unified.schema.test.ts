import { admin } from "./setup";
import { wipeFirestore } from "./helpers/cleanup";
import { seedGameDataCatalogs } from "../seeds/seedGameData";
import { __resetCachedFlagsForTests } from "../src/core/flags";

describe("Unified catalog seed shape", () => {
  beforeAll(async () => {
    process.env.USE_UNIFIED_SKUS = "true";
    __resetCachedFlagsForTests();
    await wipeFirestore();
    await seedGameDataCatalogs();
  });

  afterAll(() => {
    delete process.env.USE_UNIFIED_SKUS;
    __resetCachedFlagsForTests();
  });

  it("ensures ItemSkusCatalog uses the unified structure", async () => {
    const snapshot = await admin
      .firestore()
      .doc("GameData/v1/catalogs/ItemSkusCatalog")
      .get();
    expect(snapshot.exists).toBe(true);
    const data = snapshot.data();
    expect(data?.version).toEqual(expect.any(String));
    expect(data?.skus).toBeDefined();

    const defaults = new Set<string>(
      Object.values<string>(data?.defaults ?? {}),
    );
    const skus: Record<string, any> = data?.skus ?? {};
    const issues: string[] = [];
    for (const [skuId, sku] of Object.entries(skus)) {
      if (typeof sku.displayName !== "string") {
        issues.push(`${skuId} missing displayName`);
        continue;
      }
      if (typeof sku.category !== "string") {
        issues.push(`${skuId} missing category`);
        continue;
      }
      if (["crate", "key", "booster"].includes(sku.category)) {
        if (defaults.has(skuId)) {
          continue; // starter SKUs are granted by flow defaults, not sold in shop
        }
        if (sku.stackable !== true) {
          issues.push(`${skuId} is not stackable`);
        }
        if (!sku?.purchasable) {
          issues.push(`${skuId} missing purchasable block`);
          continue;
        }
        if (typeof sku.purchasable?.currency !== "string") {
          issues.push(`${skuId} missing purchasable.currency`);
        }
        if (typeof sku.purchasable?.amount !== "number") {
          issues.push(`${skuId} missing purchasable.amount`);
        }
        if (sku.category === "booster") {
          expect(typeof sku.subType).toBe("string");
          expect(typeof sku.durationSeconds).toBe("number");
        }
      }
    }
    if (issues.length > 0) {
      console.error("[catalogs.unified]", issues);
    }
    expect(issues).toEqual([]);
  });

  it("ensures CratesCatalog exposes crate rewards", async () => {
    const snapshot = await admin
      .firestore()
      .doc("GameData/v1/catalogs/CratesCatalog")
      .get();
    expect(snapshot.exists).toBe(true);
    const data = snapshot.data();
    expect(data?.version).toEqual(expect.any(String));
    const crates: Record<string, any> = data?.crates ?? {};

    for (const [, crate] of Object.entries(crates)) {
      expect(typeof (crate.crateSkuId ?? crate.skuId)).toBe("string");
      expect(typeof crate.keySkuId).toBe("string");

      const rarityPools = crate.poolsByRarity ?? null;
      const lootTable = crate.loot ?? null;
      expect(rarityPools || lootTable).toBeTruthy();

      if (rarityPools) {
        for (const pool of Object.values<Record<string, any>>(rarityPools)) {
          expect(Array.isArray(pool)).toBe(true);
          for (const skuId of pool as unknown[]) {
            expect(typeof skuId).toBe("string");
          }
        }
      }

      if (lootTable) {
        for (const entry of Object.values<Record<string, any>>(lootTable)) {
          expect(typeof entry?.skuId).toBe("string");
          if (entry?.weight !== undefined) {
            expect(typeof entry.weight).toBe("number");
          }
        }
      }
    }
  });
});
