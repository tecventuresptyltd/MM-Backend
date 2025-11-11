import { admin } from "./setup";
import {
  purchaseCar,
  upgradeCar,
  equipCosmetic,
  openCrate,
  grantItem,
  purchaseCrateItem,
} from "../src/garage";
import { wipeFirestore, wipeAuth, seedMinimalPlayer } from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import {
  pickCosmeticSkus,
  findPurchasableCrate,
  pickUpgradeableCar,
} from "./helpers/catalog";
import { withDeterministicRng } from "./helpers/random";
import { getItemSkusCatalog, listSkusForItem, resolveSkuOrThrow } from "../src/core/config";
import type { ItemSku } from "../src/shared/types";

jest.setTimeout(20000);

type SummaryTotals = Record<string, unknown> | undefined;

const db = admin.firestore();

const authFor = (uid: string) => ({
  auth: {
    uid,
    token: { firebase: { sign_in_provider: "anonymous" } },
  },
});

const readSummaryCount = (totals: SummaryTotals, key: string): number => {
  if (!totals) {
    return 0;
  }
  const value = totals[key];
  if (typeof value === "number") {
    return value;
  }
  const pluralValue = totals[`${key}s`];
  return typeof pluralValue === "number" ? pluralValue : 0;
};

const ensureReceipt = async (uid: string, opId: string) => {
  const snapshot = await db.doc(`Players/${uid}/Receipts/${opId}`).get();
  expect(snapshot.exists).toBe(true);
  return snapshot;
};

describe("Garage Functions", () => {
  let uid: string;
  let statsRef: FirebaseFirestore.DocumentReference;
  let upgradeableCar: { carId: string; basePrice: number; upgradeCost: number };
  let cosmeticSkus: ItemSku[];
  let crateInfo: { crateId: string; crateSkuId: string; keySkuId: string | null };
  let crateSku: ItemSku;
  let keySku: ItemSku | null;
  let startingCoins: number;
  const STARTING_GEMS = 5000;
  let dataLoaded = false;

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();

    uid = `test-uid-${Date.now()}`;
    await seedMinimalPlayer(uid);

    if (!dataLoaded) {
      upgradeableCar = await pickUpgradeableCar();
      startingCoins = upgradeableCar.basePrice + upgradeableCar.upgradeCost + 5000;
      cosmeticSkus = await pickCosmeticSkus({ subType: "wheels" }, 2);
      crateInfo = await findPurchasableCrate({ requireKey: true });
      const itemSkusCatalog = await getItemSkusCatalog();
      crateSku = itemSkusCatalog[crateInfo.crateSkuId];
      if (!crateSku) {
        throw new Error(`Crate SKU ${crateInfo.crateSkuId} missing from catalog.`);
      }
      keySku = crateInfo.keySkuId ? itemSkusCatalog[crateInfo.keySkuId] ?? null : null;
      dataLoaded = true;
    }

    statsRef = db.doc(`Players/${uid}/Economy/Stats`);
    await statsRef.set(
      {
        coins: startingCoins,
        gems: STARTING_GEMS,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  describe("purchaseCar and upgradeCar", () => {
    it("purchases and upgrades an owned car exactly once per opId", async () => {
      const purchase = wrapCallable(purchaseCar);
      const upgrade = wrapCallable(upgradeCar);

      const statsBefore = await statsRef.get();
      const coinsBefore = Number(statsBefore.data()?.coins ?? 0);

      const purchaseOp = `op_purchase_${Date.now()}`;
      const purchaseResult = await purchase({
        data: { carId: upgradeableCar.carId, opId: purchaseOp },
        ...authFor(uid),
      });
      expect(purchaseResult).toMatchObject({
        success: true,
        opId: purchaseOp,
        carId: upgradeableCar.carId,
      });

      const purchaseReceipt = await ensureReceipt(uid, purchaseOp);
      expect(purchaseReceipt.data()?.result?.carId).toBe(upgradeableCar.carId);

      const carDoc = await db.doc(`Players/${uid}/Garage/${upgradeableCar.carId}`).get();
      expect(carDoc.exists).toBe(true);
      expect(carDoc.data()?.upgradeLevel ?? 0).toBe(0);

      const afterPurchase = await statsRef.get();
      expect(Number(afterPurchase.data()?.coins ?? 0)).toBe(
        coinsBefore - upgradeableCar.basePrice,
      );

      const purchaseRetry = await purchase({
        data: { carId: upgradeableCar.carId, opId: purchaseOp },
        ...authFor(uid),
      });
      expect(purchaseRetry).toEqual(purchaseResult);

      const upgradeOp = `op_upgrade_${Date.now()}`;
      const upgradeResult = await upgrade({
        data: { carId: upgradeableCar.carId, opId: upgradeOp },
        ...authFor(uid),
      });
      expect(upgradeResult).toMatchObject({
        success: true,
        opId: upgradeOp,
        carId: upgradeableCar.carId,
        levelAfter: 1,
      });

      const upgradeReceipt = await ensureReceipt(uid, upgradeOp);
      const recordedLevel =
        upgradeReceipt.data()?.result?.levelAfter ??
        upgradeReceipt.data()?.result?.newLevel ??
        null;
      expect(recordedLevel).toBe(1);

      const upgradedDoc = await db.doc(`Players/${uid}/Garage/${upgradeableCar.carId}`).get();
      expect(upgradedDoc.data()?.upgradeLevel ?? 0).toBe(1);

      const afterUpgrade = await statsRef.get();
      expect(Number(afterUpgrade.data()?.coins ?? 0)).toBe(
        coinsBefore - upgradeableCar.basePrice - upgradeableCar.upgradeCost,
      );

      const upgradeRetry = await upgrade({
        data: { carId: upgradeableCar.carId, opId: upgradeOp },
        ...authFor(uid),
      });
      expect(upgradeRetry).toEqual(upgradeResult);

      const afterRetry = await statsRef.get();
      expect(Number(afterRetry.data()?.coins ?? 0)).toBe(
        coinsBefore - upgradeableCar.basePrice - upgradeableCar.upgradeCost,
      );
    });
  });

  describe("equipCosmetic", () => {
    it("equips an owned cosmetic to the active loadout with receipts and idempotency", async () => {
      const [primaryCosmetic] = cosmeticSkus;
      const grant = wrapCallable(grantItem);
      const summaryRef = db.doc(`Players/${uid}/Inventory/_summary`);
      const summaryBefore = (await summaryRef.get()).data()?.totalsByCategory ?? {};

      const grantOp = `op_grant_cosmetic_${Date.now()}`;
      const grantResult = await grant({
        data: {
          skuId: primaryCosmetic.skuId,
          quantity: 1,
          opId: grantOp,
          reason: "test_grant_cosmetic",
        },
        ...authFor(uid),
      });
      expect(grantResult.success).toBe(true);
      await ensureReceipt(uid, grantOp);

      const summaryAfterGrant = (await summaryRef.get()).data()?.totalsByCategory ?? {};
      expect(readSummaryCount(summaryAfterGrant, primaryCosmetic.type)).toBe(
        readSummaryCount(summaryBefore, primaryCosmetic.type) + 1,
      );

      const equip = wrapCallable(equipCosmetic);
      const equipOp = `op_equip_${Date.now()}`;
      const equipResult = await equip({
        data: {
          loadoutId: "Active",
          slot: "wheels",
          skuId: primaryCosmetic.skuId,
          opId: equipOp,
        },
        ...authFor(uid),
      });
      expect(equipResult).toMatchObject({ success: true, opId: equipOp });

      await ensureReceipt(uid, equipOp);

      const loadoutDoc = await db.doc(`Players/${uid}/Loadouts/Active`).get();
      const cosmetics = (loadoutDoc.data()?.cosmetics ?? {}) as Record<string, unknown>;
      expect(cosmetics.wheelsSkuId).toBe(primaryCosmetic.skuId);
      expect(cosmetics.wheelsItemId).toBe(primaryCosmetic.itemId);

      const equipRetry = await equip({
        data: {
          loadoutId: "Active",
          slot: "wheels",
          skuId: primaryCosmetic.skuId,
          opId: equipOp,
        },
        ...authFor(uid),
      });
      expect(equipRetry).toEqual(equipResult);

      const summaryAfterEquip = (await summaryRef.get()).data()?.totalsByCategory ?? {};
      expect(readSummaryCount(summaryAfterEquip, primaryCosmetic.type)).toBe(
        readSummaryCount(summaryAfterGrant, primaryCosmetic.type),
      );
    });

    it("replaces an equipped cosmetic when equipping a different SKU", async () => {
      const [primaryCosmetic, alternateCosmetic] = cosmeticSkus;
      const grant = wrapCallable(grantItem);

      await grant({
        data: {
          skuId: primaryCosmetic.skuId,
          quantity: 1,
          opId: `op_grant_primary_${Date.now()}`,
          reason: "test_primary",
        },
        ...authFor(uid),
      });
      await grant({
        data: {
          skuId: alternateCosmetic.skuId,
          quantity: 1,
          opId: `op_grant_alt_${Date.now()}`,
          reason: "test_alternate",
        },
        ...authFor(uid),
      });

      const equip = wrapCallable(equipCosmetic);
      await equip({
        data: {
          loadoutId: "Active",
          slot: "wheels",
          skuId: primaryCosmetic.skuId,
          opId: `op_equip_primary_${Date.now()}`,
        },
        ...authFor(uid),
      });

      const swapOp = `op_swap_${Date.now()}`;
      const swapResult = await equip({
        data: {
          loadoutId: "Active",
          slot: "wheels",
          skuId: alternateCosmetic.skuId,
          opId: swapOp,
        },
        ...authFor(uid),
      });
      expect(swapResult.success).toBe(true);
      await ensureReceipt(uid, swapOp);

      const loadoutDoc = await db.doc(`Players/${uid}/Loadouts/Active`).get();
      const cosmetics = (loadoutDoc.data()?.cosmetics ?? {}) as Record<string, unknown>;
      expect(cosmetics.wheelsSkuId).toBe(alternateCosmetic.skuId);
      expect(cosmetics.wheelsItemId).toBe(alternateCosmetic.itemId);
    });

    it("blocks equip when the cosmetic is no longer owned", async () => {
      const [primaryCosmetic] = cosmeticSkus;
      const grant = wrapCallable(grantItem);

      const grantOp = `op_grant_own_${Date.now()}`;
      await grant({
        data: {
          skuId: primaryCosmetic.skuId,
          quantity: 1,
          opId: grantOp,
          reason: "test_grant_missing",
        },
        ...authFor(uid),
      });
      await ensureReceipt(uid, grantOp);

      const equip = wrapCallable(equipCosmetic);
      await equip({
        data: {
          loadoutId: "Active",
          slot: "wheels",
          skuId: primaryCosmetic.skuId,
          opId: `op_initial_equip_${Date.now()}`,
        },
        ...authFor(uid),
      });

      await db.doc(`Players/${uid}/Inventory/${primaryCosmetic.skuId}`).set(
        { quantity: 0, qty: 0, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true },
      );

      const itemsRef = db.doc(`Players/${uid}/Inventory/Items`);
      await itemsRef.set(
        {
          [`counts.${primaryCosmetic.itemId}`]: 0,
          [`owned.${primaryCosmetic.itemId}`]: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      await expect(
        equip({
          data: {
            loadoutId: "Active",
            slot: "wheels",
            skuId: primaryCosmetic.skuId,
            opId: `op_retry_without_inventory_${Date.now()}`,
          },
          ...authFor(uid),
        }),
      ).rejects.toHaveProperty("code", "failed-precondition");
    });
  });

  describe("grantItem and openCrate", () => {
    it("grants crate/key SKUs and opens the crate for catalog loot", async () => {
      const grant = wrapCallable(grantItem);
      const summaryRef = db.doc(`Players/${uid}/Inventory/_summary`);
      const baseTotals = (await summaryRef.get()).data()?.totalsByCategory ?? {};

      const crateGrantOp = `op_grant_crate_${Date.now()}`;
      await grant({
        data: {
          skuId: crateInfo.crateSkuId,
          quantity: 1,
          opId: crateGrantOp,
          reason: "test_grant_crate",
        },
        ...authFor(uid),
      });
      await ensureReceipt(uid, crateGrantOp);

      if (crateInfo.keySkuId) {
        const keyGrantOp = `op_grant_key_${Date.now()}`;
        await grant({
          data: {
            skuId: crateInfo.keySkuId,
            quantity: 1,
            opId: keyGrantOp,
            reason: "test_grant_key",
          },
          ...authFor(uid),
        });
        await ensureReceipt(uid, keyGrantOp);
      }

      const afterGrantTotals = (await summaryRef.get()).data()?.totalsByCategory ?? {};
      expect(readSummaryCount(afterGrantTotals, crateSku.type)).toBe(
        readSummaryCount(baseTotals, crateSku.type) + 1,
      );
      if (keySku) {
        expect(readSummaryCount(afterGrantTotals, keySku.type)).toBe(
          readSummaryCount(baseTotals, keySku.type) + 1,
        );
      }

      const open = wrapCallable(openCrate);
      const openOp = `op_open_${Date.now()}`;
      const openResult = await withDeterministicRng(openOp, async () =>
        open({
          data: { crateId: crateInfo.crateId, opId: openOp },
          ...authFor(uid),
        }),
      );

      expect(openResult.success).toBe(true);
      expect(openResult.crateSkuId).toBe(crateInfo.crateSkuId);

      const rewardSku = await resolveSkuOrThrow(openResult.awarded.skuId);
      expect(rewardSku.itemId).toBe(openResult.awarded.itemId);
      if (openResult.awarded.itemId) {
        const variants = await listSkusForItem(openResult.awarded.itemId);
        const variantIds = variants.map((variant) => variant.skuId);
        expect(variantIds).toContain(rewardSku.skuId);
      }
      const rewardDoc = await db.doc(`Players/${uid}/Inventory/${rewardSku.skuId}`).get();
      expect(rewardDoc.exists).toBe(true);
      expect(
        Number(rewardDoc.data()?.quantity ?? rewardDoc.data()?.qty ?? 0),
      ).toBeGreaterThanOrEqual(openResult.awarded.quantity);

      const openReceipt = await ensureReceipt(uid, openOp);
      expect(openReceipt.data()?.result?.awarded?.skuId).toBe(rewardSku.skuId);

      const openRetry = await open({
        data: { crateId: crateInfo.crateId, opId: openOp },
        ...authFor(uid),
      });
      expect(openRetry).toEqual(openResult);

      const totalsAfterOpen = (await summaryRef.get()).data()?.totalsByCategory ?? {};
      expect(readSummaryCount(totalsAfterOpen, crateSku.type)).toBe(
        readSummaryCount(baseTotals, crateSku.type),
      );
      if (keySku) {
        expect(readSummaryCount(totalsAfterOpen, keySku.type)).toBe(
          readSummaryCount(baseTotals, keySku.type),
        );
      }
      const rewardCategory = rewardSku.type ?? rewardSku.category ?? "reward";
      expect(readSummaryCount(totalsAfterOpen, rewardCategory)).toBeGreaterThan(
        readSummaryCount(baseTotals, rewardCategory),
      );
    });

    it("fails to open when the crate quantity is zero", async () => {
      await db
        .doc(`Players/${uid}/Inventory/${crateInfo.crateSkuId}`)
        .set(
          {
            skuId: crateInfo.crateSkuId,
            quantity: 0,
            qty: 0,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

      if (crateInfo.keySkuId) {
        await db
          .doc(`Players/${uid}/Inventory/${crateInfo.keySkuId}`)
          .set(
            {
              skuId: crateInfo.keySkuId,
              quantity: 1,
              qty: 1,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true },
          );
      }

      const open = wrapCallable(openCrate);
      await expect(
        open({
          data: { crateId: crateInfo.crateId, opId: `op_open_empty_${Date.now()}` },
          ...authFor(uid),
        }),
      ).rejects.toHaveProperty("code", "failed-precondition");
    });
  });

  describe("purchaseCrateItem", () => {
    const getEconomySnapshot = async () => {
      const snap = await statsRef.get();
      return snap.data() ?? {};
    };

    it("purchases crate and key SKUs, updates inventory, summary, and receipts", async () => {
      const purchase = wrapCallable(purchaseCrateItem);
      const summaryRef = db.doc(`Players/${uid}/Inventory/_summary`);
      const baseTotals = (await summaryRef.get()).data()?.totalsByCategory ?? {};
      const economyBefore = await getEconomySnapshot();

      const crateQuantity = 2;
      const cratePurchaseOp = `op_buy_crate_${Date.now()}`;
      const crateResult = await purchase({
        data: {
          crateId: crateInfo.crateId,
          kind: "crate",
          quantity: crateQuantity,
          opId: cratePurchaseOp,
        },
        ...authFor(uid),
      });
      expect(crateResult).toMatchObject({
        success: true,
        opId: cratePurchaseOp,
        crateId: crateInfo.crateId,
        skuId: crateInfo.crateSkuId,
        quantity: crateQuantity,
      });
      await ensureReceipt(uid, cratePurchaseOp);

      const crateDoc = await db.doc(`Players/${uid}/Inventory/${crateInfo.crateSkuId}`).get();
      expect(crateDoc.exists).toBe(true);
      expect(Number(crateDoc.data()?.quantity ?? crateDoc.data()?.qty ?? 0)).toBe(
        crateQuantity,
      );

      const summaryAfterCrate = (await summaryRef.get()).data()?.totalsByCategory ?? {};
      expect(readSummaryCount(summaryAfterCrate, crateSku.type)).toBe(
        readSummaryCount(baseTotals, crateSku.type) + crateQuantity,
      );

      const economyAfterCrate = await getEconomySnapshot();
      const crateCurrency = crateSku.purchasable?.currency ?? "gems";
      const cratePrice = (crateSku.purchasable?.amount ?? 0) * crateQuantity;
      if (crateCurrency === "gems") {
        expect(Number(economyAfterCrate.gems ?? 0)).toBe(
          Number(economyBefore.gems ?? 0) - cratePrice,
        );
      } else {
        expect(Number(economyAfterCrate.coins ?? 0)).toBe(
          Number(economyBefore.coins ?? 0) - cratePrice,
        );
      }

      if (crateInfo.keySkuId && keySku) {
        const keyPurchaseOp = `op_buy_key_${Date.now()}`;
        const keyResult = await purchase({
          data: {
            crateId: crateInfo.crateId,
            kind: "key",
            quantity: 1,
            opId: keyPurchaseOp,
          },
          ...authFor(uid),
        });
        expect(keyResult).toMatchObject({
          success: true,
          skuId: crateInfo.keySkuId,
          quantity: 1,
        });
        await ensureReceipt(uid, keyPurchaseOp);

        const keyDoc = await db.doc(`Players/${uid}/Inventory/${crateInfo.keySkuId}`).get();
        expect(keyDoc.exists).toBe(true);
        expect(Number(keyDoc.data()?.quantity ?? keyDoc.data()?.qty ?? 0)).toBe(1);

        const summaryAfterKey = (await summaryRef.get()).data()?.totalsByCategory ?? {};
        expect(readSummaryCount(summaryAfterKey, keySku.type)).toBe(
          readSummaryCount(summaryAfterCrate, keySku.type) + 1,
        );

        const economyAfterKey = await getEconomySnapshot();
        const keyCurrency = keySku.purchasable?.currency ?? "gems";
        const keyPrice = keySku.purchasable?.amount ?? 0;
        if (keyCurrency === "gems") {
          expect(Number(economyAfterKey.gems ?? 0)).toBe(
            Number(economyAfterCrate.gems ?? 0) - keyPrice,
          );
        } else {
          expect(Number(economyAfterKey.coins ?? 0)).toBe(
            Number(economyAfterCrate.coins ?? 0) - keyPrice,
          );
        }

        const keyRetry = await purchase({
          data: {
            crateId: crateInfo.crateId,
            kind: "key",
            quantity: 1,
            opId: keyPurchaseOp,
          },
          ...authFor(uid),
        });
        expect(keyRetry).toEqual(keyResult);
      }

      const crateRetry = await purchase({
        data: {
          crateId: crateInfo.crateId,
          kind: "crate",
          quantity: crateQuantity,
          opId: cratePurchaseOp,
        },
        ...authFor(uid),
      });
      expect(crateRetry).toEqual(crateResult);
    });

    it("rejects when the player lacks the required currency", async () => {
      const purchase = wrapCallable(purchaseCrateItem);
      const crateCurrency = crateSku.purchasable?.currency ?? "gems";

      if (crateCurrency === "gems") {
        await statsRef.set({ gems: 0 }, { merge: true });
      } else {
        await statsRef.set({ coins: 0 }, { merge: true });
      }

      await expect(
        purchase({
          data: {
            crateId: crateInfo.crateId,
            kind: "crate",
            quantity: 1,
            opId: `op_buy_insufficient_${Date.now()}`,
          },
          ...authFor(uid),
        }),
      ).rejects.toThrow(
        crateCurrency === "gems" ? "Insufficient gems." : "Insufficient coins.",
      );
    });
  });
});
