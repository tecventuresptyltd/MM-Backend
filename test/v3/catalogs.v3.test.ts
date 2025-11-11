import {
  getItemsCatalog,
  getCratesCatalogDoc,
  getOffersCatalog,
  assertAllVariantSkuIdsUnique,
} from "../../src/core/config";
import { ensureCatalogsSeeded } from "../helpers/cleanup";

process.env.USE_UNIFIED_SKUS = process.env.USE_UNIFIED_SKUS || "true";

describe("Catalog integrity (v3)", () => {
  beforeAll(async () => {
    await ensureCatalogsSeeded();
  });

  const collectValidSkus = async (): Promise<Set<string>> => {
    const { items } = await getItemsCatalog();
    const skuSet = new Set<string>();
    for (const item of Object.values(items)) {
      for (const variant of item.variants ?? []) {
        skuSet.add(variant.skuId);
      }
    }
    return skuSet;
  };

  it("ensures all variant skuIds are unique and well-formed", async () => {
    await expect(assertAllVariantSkuIdsUnique()).resolves.not.toThrow();
  });

  it("ensures crate loot references existing skuIds", async () => {
    const skuSet = await collectValidSkus();
    const cratesDoc = await getCratesCatalogDoc();

    for (const crate of Object.values(cratesDoc.crates)) {
      const lootEntries = Object.values(crate.loot ?? {}).filter(
        (entry): entry is { skuId: string } =>
          Boolean(entry && typeof entry === "object" && "skuId" in entry),
      );
      expect(lootEntries.length).toBeGreaterThan(0);
      for (const entry of lootEntries) {
        expect(skuSet.has(entry.skuId)).toBe(true);
      }
    }
  });

  it("ensures offer entitlements reference existing skuIds", async () => {
    const skuSet = await collectValidSkus();
    const offers = await getOffersCatalog();

    for (const offer of Object.values(offers)) {
      for (const entitlement of offer.entitlements ?? []) {
        if (entitlement.type === "gems" || entitlement.type === "coins") {
          continue;
        }
        expect(entitlement.id.startsWith("sku_")).toBe(true);
        expect(skuSet.has(entitlement.id)).toBe(true);
      }
    }
  });
});
