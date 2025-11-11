import { wrapCallable } from "../helpers/callable";
import { admin } from "../setup";
import { wipeFirestore, seedMinimalPlayer, ensureCatalogsSeeded } from "../helpers/cleanup";
import { initializeUserIfNeeded } from "../../src/shared/initializeUser";
import { loadStarterRewards } from "../../src/shared/starterRewards";
import { purchaseOffer } from "../../src/shop/purchaseOffer";
import { purchaseShopSku } from "../../src/shop/purchaseShopSku";
import { activateBooster } from "../../src/shop/activateBooster";
import { openCrate } from "../../src/crates/openCrate";
import { prepareRace } from "../../src/race/prepareRace";
import { getCratesCatalogDoc } from "../../src/core/config";
import {
  loadBoosterSkuMap,
  loadCrateSkuMap,
  loadKeySkuMap,
} from "../helpers/catalog";
import { withDeterministicRng } from "../helpers/random";

process.env.USE_UNIFIED_SKUS = process.env.USE_UNIFIED_SKUS || "true";

jest.setTimeout(120000);

const authContext = (uid: string) => ({
  auth: {
    uid,
    token: { firebase: { sign_in_provider: "password" } },
  },
});

describe("Runtime flows (v3 SKU mode)", () => {
  const db = admin.firestore();
  let crateSkus: Record<string, string>;
  let keySkus: Record<string, string>;
  let boosterSkus: Record<string, string>;
  let starterCrateId: string;

  beforeAll(async () => {
    await ensureCatalogsSeeded();
    const cratesDoc = await getCratesCatalogDoc();
    const { crates, starterCrateId: defaultCrateId } = await loadCrateSkuMap();
    const keyMap = await loadKeySkuMap();
    const boosterMap = await loadBoosterSkuMap();

    crateSkus = { ...crates };
    starterCrateId = defaultCrateId;
    keySkus = {
      common: keyMap.common ?? "",
      rare: keyMap.rare ?? "",
      exotic: keyMap.exotic ?? "",
      legendary: keyMap.legendary ?? "",
      mythical: keyMap.mythical ?? "",
    };
    boosterSkus = {
      coin: boosterMap.coin ?? "",
      exp: boosterMap.exp ?? "",
    };

    for (const [crateId, crate] of Object.entries(cratesDoc.crates ?? {})) {
      if (!crateSkus[crateId]) {
        const fallback = crate.crateSkuId ?? crate.skuId ?? "";
        if (fallback) {
          crateSkus[crateId] = fallback;
        }
      }
    }

    if (!starterCrateId || !crateSkus[starterCrateId]) {
      throw new Error("Starter crate SKU missing from catalog.");
    }
    const requiredRarities = ["common", "rare", "exotic", "legendary", "mythical"] as const;
    for (const rarity of requiredRarities) {
      if (!keySkus[rarity]) {
        throw new Error(`Missing key SKU for rarity ${rarity}`);
      }
    }
    if (!boosterSkus.coin || !boosterSkus.exp) {
      throw new Error("Missing booster SKUs for coin or xp.");
    }
  });

  beforeEach(async () => {
    await wipeFirestore();
    await ensureCatalogsSeeded();
  });

  it("initializeUser grants starter crate and key skuIds", async () => {
    const uid = `init-${Date.now()}`;
    const starter = await loadStarterRewards();
    const opId = `op-init-${Date.now()}`;
    await initializeUserIfNeeded(uid, [], { opId });

    const crateDoc = await db.doc(`Players/${uid}/Inventory/${starter.crateSkuId}`).get();
    const keyDoc = await db.doc(`Players/${uid}/Inventory/${starter.keySkuId}`).get();
    expect(crateDoc.exists).toBe(true);
    expect(keyDoc.exists).toBe(true);
    expect(crateDoc.data()?.quantity ?? crateDoc.data()?.qty).toBe(1);
    expect(keyDoc.data()?.quantity ?? keyDoc.data()?.qty).toBe(1);

    const receiptSnap = await db.doc(`Players/${uid}/Receipts/${opId}`).get();
    expect(receiptSnap.exists).toBe(true);
    const grants: Array<{ skuId?: string }> = receiptSnap.data()?.result?.grants ?? [];
    const grantSkuIds = grants.map((grant) => grant.skuId);
    expect(grantSkuIds).toContain(starter.crateSkuId);
    expect(grantSkuIds).toContain(starter.keySkuId);

    const summaryDoc = await db.doc(`Players/${uid}/Inventory/_summary`).get();
    expect(summaryDoc.exists).toBe(true);
    const totals = summaryDoc.data()?.totalsByCategory ?? {};
    expect(totals.crate ?? 0).toBeGreaterThanOrEqual(1);
    expect(totals.key ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("purchaseOffer grants exact sku variants and updates summary", async () => {
    const uid = `offer-${Date.now()}`;
    await seedMinimalPlayer(uid);
    await db.doc(`Players/${uid}/Economy/Stats`).set(
      {
        gems: 2000,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const opId = `op-offer-${Date.now()}`;
    const wrapped = wrapCallable(purchaseOffer);
    const result = await wrapped({
      data: { opId, offerId: "offer_3jaky2p2" },
      ...authContext(uid),
    });

    expect(result.success).toBe(true);
    const grants = result.grants ?? [];
    const grantedSkuIds = grants.filter((grant: any) => grant.skuId).map((grant: any) => grant.skuId);
    expect(grantedSkuIds.length).toBeGreaterThan(0);

    for (const skuId of grantedSkuIds) {
      const inventoryDoc = await db.doc(`Players/${uid}/Inventory/${skuId}`).get();
      expect(inventoryDoc.exists).toBe(true);
      expect((inventoryDoc.data()?.quantity ?? inventoryDoc.data()?.qty) ?? 0).toBeGreaterThan(0);
    }

    const summaryDoc = await db.doc(`Players/${uid}/Inventory/_summary`).get();
    expect(summaryDoc.exists).toBe(true);
    const totals = summaryDoc.data()?.totalsByCategory ?? {};
    expect(Object.keys(totals).length).toBeGreaterThan(0);

    const receiptDoc = await db.doc(`Players/${uid}/Receipts/${opId}`).get();
    expect(receiptDoc.exists).toBe(true);
    const receiptGrants: Array<{ skuId?: string }> = receiptDoc.data()?.result?.grants ?? [];
    expect(receiptGrants.length).toBeGreaterThan(0);
  });

  it("purchaseShopSku increments sku inventory and summary counts", async () => {
    const uid = `shop-${Date.now()}`;
    await seedMinimalPlayer(uid);
    const skuId = keySkus.rare;
    await db.doc(`Players/${uid}/Economy/Stats`).set(
      {
        gems: 2000,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const opId = `op-shop-${Date.now()}`;
    const wrapped = wrapCallable(purchaseShopSku);
    const response = await wrapped({
      data: { opId, skuId, quantity: 2 },
      ...authContext(uid),
    });

    expect(response.success).toBe(true);
    expect(response.skuId).toBe(skuId);
    const inventoryDoc = await db.doc(`Players/${uid}/Inventory/${skuId}`).get();
    expect(inventoryDoc.exists).toBe(true);
    const quantity = (inventoryDoc.data()?.quantity ?? inventoryDoc.data()?.qty) ?? 0;
    expect(quantity).toBeGreaterThanOrEqual(2);

    const summaryDoc = await db.doc(`Players/${uid}/Inventory/_summary`).get();
    const totals = summaryDoc.data()?.totalsByCategory ?? {};
    expect((totals.key ?? 0)).toBeGreaterThanOrEqual(2);

    const receiptDoc = await db.doc(`Players/${uid}/Receipts/${opId}`).get();
    expect(receiptDoc.exists).toBe(true);
    expect(receiptDoc.data()?.status).toBe("completed");
  });

  it("activateBooster consumes booster skuId and extends activeUntil", async () => {
    const uid = `booster-${Date.now()}`;
    await seedMinimalPlayer(uid);

    const boosterSkuId = boosterSkus.coin;
    const now = admin.firestore.FieldValue.serverTimestamp();
    await db.doc(`Players/${uid}/Inventory/${boosterSkuId}`).set(
      {
        skuId: boosterSkuId,
        quantity: 1,
        qty: 1,
        createdAt: now,
        updatedAt: now,
      },
      { merge: true },
    );

    const opId = `op-booster-${Date.now()}`;
    const wrapped = wrapCallable(activateBooster);
    const result = await wrapped({
      data: { opId, boosterId: boosterSkuId },
      ...authContext(uid),
    });

    expect(result.success).toBe(true);
    expect(result.boosterSkuId).toBe(boosterSkuId);
    expect(result.remaining).toBeGreaterThanOrEqual(0);

    const inventoryDoc = await db.doc(`Players/${uid}/Inventory/${boosterSkuId}`).get();
    expect((inventoryDoc.data()?.quantity ?? inventoryDoc.data()?.qty) ?? 0).toBe(result.remaining);

    const profileDoc = await db.doc(`Players/${uid}/Profile/Profile`).get();
    const boosters = profileDoc.data()?.boosters ?? {};
    expect(boosters.coin?.activeUntil ?? 0).toBeGreaterThan(Date.now());

    const summaryDoc = await db.doc(`Players/${uid}/Inventory/_summary`).get();
    const totals = summaryDoc.data()?.totalsByCategory ?? {};
    expect(totals.booster).toBeUndefined();

    const receiptDoc = await db.doc(`Players/${uid}/Receipts/${opId}`).get();
    expect(receiptDoc.exists).toBe(true);
    expect(receiptDoc.data()?.result?.remaining).toBe(result.remaining);
  });

  it("openCrate consumes crate/key and awards a variant skuId", async () => {
    const uid = `crate-${Date.now()}`;
    await seedMinimalPlayer(uid);

    const targetCrateId = starterCrateId || Object.keys(crateSkus)[0];
    const crateSkuId = targetCrateId ? crateSkus[targetCrateId] : "";
    expect(crateSkuId).toMatch(/^sku_/);
    expect(targetCrateId).toMatch(/^crt_/);
    const keySkuId = keySkus.common;
    const now = admin.firestore.FieldValue.serverTimestamp();
    await db.doc(`Players/${uid}/Inventory/${crateSkuId}`).set(
      {
        skuId: crateSkuId,
        quantity: 1,
        qty: 1,
        createdAt: now,
        updatedAt: now,
      },
      { merge: true },
    );
    await db.doc(`Players/${uid}/Inventory/${keySkuId}`).set(
      {
        skuId: keySkuId,
        quantity: 1,
        qty: 1,
        createdAt: now,
        updatedAt: now,
      },
      { merge: true },
    );

    const opId = `op-crate-${Date.now()}`;
    const wrapped = wrapCallable(openCrate);
    const response = await wrapped({
      data: { opId, crateId: targetCrateId },
      ...authContext(uid),
    });

    expect(response.success).toBe(true);
    expect(response.awarded.skuId.startsWith("sku_")).toBe(true);

    const awardedDoc = await db.doc(`Players/${uid}/Inventory/${response.awarded.skuId}`).get();
    expect(awardedDoc.exists).toBe(true);

    const crateDocAfter = await db.doc(`Players/${uid}/Inventory/${crateSkuId}`).get();
    const keyDocAfter = await db.doc(`Players/${uid}/Inventory/${keySkuId}`).get();
    expect((crateDocAfter.data()?.quantity ?? crateDocAfter.data()?.qty) ?? 0).toBe(0);
    expect((keyDocAfter.data()?.quantity ?? keyDocAfter.data()?.qty) ?? 0).toBe(0);

    const summaryDoc = await db.doc(`Players/${uid}/Inventory/_summary`).get();
    const totals = summaryDoc.data()?.totalsByCategory ?? {};
    expect(totals.crate ?? 0).toBe(0);
    expect(totals.key ?? 0).toBe(0);

    const receiptDoc = await db.doc(`Players/${uid}/Receipts/${opId}`).get();
    expect(receiptDoc.exists).toBe(true);
    expect(receiptDoc.data()?.result?.awarded?.skuId).toBe(response.awarded.skuId);
  });

  it("prepareRace selects bot cosmetics by skuId according to rarity bands", async () => {
    const uid = `race-${Date.now()}`;
    await seedMinimalPlayer(uid);

    const wrapped = wrapCallable(prepareRace);
    const result = await withDeterministicRng("race-seed-1337", () =>
      wrapped({
        data: {
          opId: `op-race-${Date.now()}`,
          botCount: 3,
          laps: 3,
          seed: "race_seed_1337",
        },
        ...authContext(uid),
      }),
    );

    expect(result.raceId).toBeDefined();
    expect(Array.isArray(result.bots)).toBe(true);
    expect(result.bots.length).toBe(3);

    for (const bot of result.bots) {
      if (bot.cosmetics?.wheelsSkuId) {
        expect(bot.cosmetics.wheelsSkuId.startsWith("sku_")).toBe(true);
      }
      if (bot.cosmetics?.decalSkuId) {
        expect(bot.cosmetics.decalSkuId.startsWith("sku_")).toBe(true);
      }
    }
  });
});
