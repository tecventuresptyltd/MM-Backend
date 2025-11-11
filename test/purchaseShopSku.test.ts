import { admin } from "./setup";
import { wipeFirestore, wipeAuth, seedMinimalPlayer, ensureCatalogsSeeded } from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { purchaseShopSku } from "../src/shop";
import { findPurchasableCrate, loadBoosterSkuMap } from "./helpers/catalog";

describe("purchaseShopSku", () => {
  let uid: string;
  let crateSkuId: string;
  let cratePrice: number;
  let boosterSkuId: string;
  let boosterPrice: number;
  let initialGemBalance: number;
  const authFor = (userId: string) => ({
    auth: { uid: userId, token: { firebase: { sign_in_provider: "anonymous" } } },
  });

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();

    uid = `uid-${Date.now()}`;
    await seedMinimalPlayer(uid);
    await ensureCatalogsSeeded();

    const crateInfo = await findPurchasableCrate({ requireKey: true });
    crateSkuId = crateInfo.crateSkuId;
    const itemsSnap = await admin.firestore().doc("GameData/v1/catalogs/ItemsCatalog").get();
    const items = (itemsSnap.data()?.items ?? {}) as Record<string, any>;

    const findVariantBySku = (skuId: string) => {
      for (const item of Object.values(items)) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const variants = Array.isArray((item as { variants?: unknown[] }).variants)
          ? ((item as { variants?: any[] }).variants ?? [])
          : [];
        const variant = variants.find((entry) => entry?.skuId === skuId) ?? null;
        if (variant) {
          return { variant, item };
        }
      }
      return { variant: null, item: null };
    };

    const crateLookup = findVariantBySku(crateSkuId);
    if (!crateLookup.variant) {
      throw new Error(`Unable to resolve crate SKU ${crateSkuId} in ItemsCatalog.`);
    }
    cratePrice = Number(crateLookup.variant?.gemPrice ?? crateLookup.item?.gemPrice ?? 0);
    if (cratePrice <= 0) {
      throw new Error(`Crate SKU ${crateSkuId} must have a positive gem price.`);
    }

    const boosterMap = await loadBoosterSkuMap();
    boosterSkuId = boosterMap.coin ?? "";
    const boosterLookup = boosterSkuId ? findVariantBySku(boosterSkuId) : { variant: null, item: null };
    if (!boosterLookup.variant) {
      throw new Error(`Unable to resolve booster SKU ${boosterSkuId} in ItemsCatalog.`);
    }
    boosterPrice = Number(boosterLookup.variant?.gemPrice ?? boosterLookup.item?.gemPrice ?? 0);
    if (boosterPrice <= 0) {
      throw new Error(`Booster SKU ${boosterSkuId} must have a positive gem price.`);
    }

    initialGemBalance = Math.max(500, cratePrice * 4 + boosterPrice * 2);
    const statsRef = admin.firestore().doc(`Players/${uid}/Economy/Stats`);
    await statsRef.set(
      {
        gems: initialGemBalance,
        coins: 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  it("purchases a crate sku and updates inventory, summary, and receipts", async () => {
    const wrapped = wrapCallable(purchaseShopSku);
    const economyRef = admin.firestore().doc(`Players/${uid}/Economy/Stats`);
    const summaryRef = admin.firestore().doc(`Players/${uid}/Inventory/_summary`);

    const summaryBefore = await summaryRef.get();
    const baseCrateTotal = Number(summaryBefore.data()?.totalsByCategory?.crate ?? 0);

    const result = await wrapped({
      data: { opId: "op_shop_crate", skuId: crateSkuId, quantity: 2 },
      ...authFor(uid),
    });

    expect(result.success).toBe(true);
    expect(result.totalCostGems).toBe(cratePrice * 2);
    expect(result.gemsBefore).toBe(initialGemBalance);
    expect(result.gemsAfter).toBe(initialGemBalance - cratePrice * 2);

    const inventoryDoc = await admin.firestore()
      .doc(`Players/${uid}/Inventory/${crateSkuId}`)
      .get();
    expect(inventoryDoc.exists).toBe(true);
    expect(inventoryDoc.data()?.quantity ?? inventoryDoc.data()?.qty).toBe(2);

    const economySnap = await economyRef.get();
    expect(economySnap.data()?.gems).toBe(initialGemBalance - cratePrice * 2);

    const summaryAfter = await summaryRef.get();
    expect(Number(summaryAfter.data()?.totalsByCategory?.crate ?? 0)).toBe(
      baseCrateTotal + 2,
    );

    const receiptDoc = await admin.firestore()
      .doc(`Players/${uid}/Receipts/op_shop_crate`)
      .get();
    expect(receiptDoc.exists).toBe(true);
    expect(receiptDoc.data()?.status).toBe("completed");
    expect(receiptDoc.data()?.result?.skuId).toBe(crateSkuId);
  });

  it("purchases a booster sku and records the booster stack", async () => {
    const wrapped = wrapCallable(purchaseShopSku);

    const result = await wrapped({
      data: { opId: "op_shop_booster", skuId: boosterSkuId, quantity: 1 },
      ...authFor(uid),
    });

    expect(result.success).toBe(true);
    expect(result.totalCostGems).toBe(boosterPrice);

    const inventoryDoc = await admin.firestore()
      .doc(`Players/${uid}/Inventory/${boosterSkuId}`)
      .get();
    expect(inventoryDoc.exists).toBe(true);
    expect(inventoryDoc.data()?.quantity ?? inventoryDoc.data()?.qty).toBe(1);

    const summaryDoc = await admin.firestore()
      .doc(`Players/${uid}/Inventory/_summary`)
      .get();
    expect(Number(summaryDoc.data()?.totalsByCategory?.booster ?? 0)).toBe(1);
  });

  it("fails when the player does not have enough gems", async () => {
    const wrapped = wrapCallable(purchaseShopSku);
    await admin.firestore().doc(`Players/${uid}/Economy/Stats`).set({ gems: 1 }, { merge: true });

    await expect(
      wrapped({
        data: { opId: "op_insufficient", skuId: crateSkuId, quantity: 1 },
        ...authFor(uid),
      }),
    ).rejects.toHaveProperty("code", "resource-exhausted");
  });

  it("fails with not-found when the sku does not exist", async () => {
    const wrapped = wrapCallable(purchaseShopSku);
    await expect(
      wrapped({
        data: { opId: "op_missing_sku", skuId: "sku_does_not_exist", quantity: 1 },
        ...authFor(uid),
      }),
    ).rejects.toHaveProperty("code", "not-found");
  });

  it("is idempotent for repeated opIds", async () => {
    const wrapped = wrapCallable(purchaseShopSku);
    const economyRef = admin.firestore().doc(`Players/${uid}/Economy/Stats`);

    const first = await wrapped({
      data: { opId: "op_repeat", skuId: crateSkuId, quantity: 1 },
      ...authFor(uid),
    });
    const second = await wrapped({
      data: { opId: "op_repeat", skuId: crateSkuId, quantity: 1 },
      ...authFor(uid),
    });

    expect(second).toEqual(first);

    const economySnap = await economyRef.get();
    expect(economySnap.data()?.gems).toBe(first.gemsAfter);
  });
});
