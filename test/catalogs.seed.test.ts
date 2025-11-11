import { existsSync, readFileSync } from "fs";
import path from "path";

const CATALOG_SEED_CANDIDATES = [
  "../../seeds/gameDataCatalogs.v3.normalized.json",
  "../../tools/out/gameDataCatalogs.v3.normalized.json",
  "../../seeds/gameDataCatalogs.v3.json",
  "../../seeds/gameDataCatalogs.fixed.json",
] as const;

const catalogsSeedPath = (() => {
  for (const candidate of CATALOG_SEED_CANDIDATES) {
    const resolved = path.resolve(__dirname, candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  throw new Error(
    `Unable to locate GameData catalog seed. Tried: ${CATALOG_SEED_CANDIDATES.join(", ")}`,
  );
})();

const catalogsSeed = JSON.parse(readFileSync(catalogsSeedPath, "utf8")) as Array<{
  path: string;
  data: any;
}>;

const findCatalogEntry = (catalogPath: string, legacyPath?: string) =>
  catalogsSeed.find(
    (entry) => entry.path === catalogPath || (legacyPath && entry.path === legacyPath),
  );

describe("GameData catalog seeds (v3)", () => {
  it("defines starter crate defaults and loot entries", () => {
    const cratesEntry = findCatalogEntry(
      "/GameData/v1/catalogs/CratesCatalog",
      "/GameData/v1/CratesCatalog.v3",
    );
    expect(cratesEntry).toBeTruthy();

    const cratesData = cratesEntry!.data ?? {};
    const starterCrateId = cratesData.defaults?.starterCrateId;
    const starterCrateSkuId = cratesData.defaults?.starterCrateSkuId;
    const starterKeySkuId = cratesData.defaults?.starterKeySkuId;

    expect(typeof starterCrateId).toBe("string");
    expect(starterCrateId).toMatch(/^crt_/);
    expect(typeof starterCrateSkuId).toBe("string");
    expect(starterCrateSkuId).toMatch(/^sku_/);
    expect(typeof starterKeySkuId).toBe("string");
    expect(starterKeySkuId).toMatch(/^sku_/);

    const starterCrate =
      (starterCrateId ? cratesData.crates?.[starterCrateId] : null) ??
      Object.values<Record<string, unknown>>(cratesData.crates ?? {}).find((crate) =>
        typeof crate === "object" &&
        crate !== null &&
        Array.isArray((crate as { tags?: string[] }).tags) &&
        ((crate as { tags?: string[] }).tags ?? []).includes("starter"),
      ) ??
      null;

    expect(starterCrate).toBeTruthy();
    const resolvedCrateId = (starterCrate as { crateId?: string; itemId?: string }).crateId ??
      (starterCrate as { itemId?: string }).itemId ??
      starterCrateId;
    expect(typeof resolvedCrateId).toBe("string");
    expect(resolvedCrateId).toMatch(/^crt_/);
    expect(typeof (starterCrate as { skuId?: string; crateSkuId?: string }).skuId ??
      (starterCrate as { crateSkuId?: string }).crateSkuId).toBe("string");
    expect(
      ((starterCrate as { skuId?: string; crateSkuId?: string }).skuId ??
        (starterCrate as { crateSkuId?: string }).crateSkuId ??
        "") as string,
    ).toMatch(/^sku_/);
    expect(typeof (starterCrate as { keySkuId?: string }).keySkuId).toBe("string");
    expect((starterCrate as { keySkuId?: string }).keySkuId).toMatch(/^sku_/);

    const resolvedStarterCrateSkuId =
      starterCrateSkuId ??
      ((starterCrate as { skuId?: string; crateSkuId?: string }).skuId ??
        (starterCrate as { crateSkuId?: string }).crateSkuId ??
        "");
    expect(resolvedStarterCrateSkuId).toMatch(/^sku_/);

    const resolvedStarterKeySkuId =
      starterKeySkuId ??
      ((starterCrate as { keySkuId?: string }).keySkuId ?? "");
    expect(resolvedStarterKeySkuId).toMatch(/^sku_/);

    const lootEntries = Object.values<Record<string, unknown>>(
      (starterCrate as { loot?: Record<string, unknown> }).loot ?? {},
    );
    expect(lootEntries.length).toBeGreaterThan(0);
    for (const loot of lootEntries) {
      expect(typeof loot?.skuId).toBe("string");
      expect((loot?.skuId as string) ?? "").toMatch(/^sku_/);
      expect(typeof loot?.weight).toBe("number");
    }
  });

  it("exposes starter crate/key SKUs through ItemsCatalog variants", () => {
    const itemsEntry = findCatalogEntry(
      "/GameData/v1/catalogs/ItemsCatalog",
      "/GameData/v1/ItemsCatalog.v3",
    );
    expect(itemsEntry).toBeTruthy();

    const itemsData = itemsEntry!.data ?? {};
    const items: Record<string, any> = itemsData.items ?? {};

    const cratesEntry = findCatalogEntry(
      "/GameData/v1/catalogs/CratesCatalog",
      "/GameData/v1/CratesCatalog.v3",
    );
    expect(cratesEntry).toBeTruthy();
    const cratesData = cratesEntry!.data ?? {};
    const starterCrateId = cratesData.defaults?.starterCrateId;
    const declaredCrateSkuId = cratesData.defaults?.starterCrateSkuId;
    const declaredKeySkuId = cratesData.defaults?.starterKeySkuId;
    const starterCrateRecord =
      (starterCrateId ? cratesData.crates?.[starterCrateId] : null) ??
      Object.values<Record<string, unknown>>(cratesData.crates ?? {}).find((crate) =>
        typeof crate === "object" &&
        crate !== null &&
        Array.isArray((crate as { tags?: string[] }).tags) &&
        ((crate as { tags?: string[] }).tags ?? []).includes("starter"),
      ) ??
      null;
    expect(starterCrateRecord).toBeTruthy();
    const starterCrateSkuId =
      declaredCrateSkuId ??
      ((starterCrateRecord as { skuId?: string; crateSkuId?: string }).skuId ??
        (starterCrateRecord as { crateSkuId?: string }).crateSkuId ??
        "");
    const starterKeySkuId =
      declaredKeySkuId ??
      ((starterCrateRecord as { keySkuId?: string }).keySkuId ?? "");

    const starterCrateItem =
      Object.values(items).find((item: any) =>
        item &&
        typeof item === "object" &&
        (item.type === "crate" || item.category === "crate") &&
        Array.isArray(item.variants) &&
        item.variants.some(
          (variant: { skuId?: string }) =>
            typeof variant?.skuId === "string" &&
            variant.skuId === starterCrateSkuId,
        ),
      ) ?? null;
    expect(starterCrateItem).toBeTruthy();
    expect(
      (starterCrateItem.variants ?? []).some(
        (variant: { skuId?: string }) =>
          typeof variant?.skuId === "string" && variant.skuId === starterCrateSkuId,
      ),
    ).toBe(true);

    const starterKeyItem =
      Object.values(items).find((item: any) =>
        item &&
        typeof item === "object" &&
        (item.type === "key" || item.category === "key") &&
        Array.isArray(item.variants) &&
        item.variants.some(
          (variant: { skuId?: string }) =>
            typeof variant?.skuId === "string" &&
            variant.skuId === starterKeySkuId,
        ),
      ) ?? null;
    expect(starterKeyItem).toBeTruthy();
    expect(
      (starterKeyItem.variants ?? []).some(
        (variant: { skuId?: string }) =>
          typeof variant?.skuId === "string" &&
          variant.skuId === starterKeySkuId,
      ),
    ).toBe(true);
  });
});
