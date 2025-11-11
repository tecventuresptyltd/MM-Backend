import { admin } from "./setup";
import {
  wipeAuth,
  wipeFirestore,
  seedMinimalPlayer,
  ensureCatalogsSeeded,
} from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { purchaseCrateItem } from "../src/garage";
import { findPurchasableCrate } from "./helpers/catalog";
import { getItemSkusCatalog } from "../src/core/config";

describe("purchaseCrateItem (legacy wrapper)", () => {
  let uid: string;
  const authFor = (userId: string) => ({
    auth: {
      uid: userId,
      token: { firebase: { sign_in_provider: "anonymous" } },
    },
  });

  let crateInfo: Awaited<ReturnType<typeof findPurchasableCrate>>;
  let crateCurrency: string;
  let cratePrice: number;
  let keyCurrency: string;
  let keyPrice: number;
  const STARTING_GEMS = 1000;
  const STARTING_COINS = 1000;

  beforeAll(async () => {
    await ensureCatalogsSeeded();
    crateInfo = await findPurchasableCrate({ requireKey: true });
    const itemSkus = await getItemSkusCatalog();
    const crateSku = itemSkus[crateInfo.crateSkuId];
    if (!crateSku) {
      throw new Error(`Crate SKU ${crateInfo.crateSkuId} missing from catalog.`);
    }
    crateCurrency = crateSku.purchasable?.currency ?? "gems";
    cratePrice = crateSku.purchasable?.amount ?? 0;

    if (!crateInfo.keySkuId) {
      throw new Error(`Crate ${crateInfo.crateId} is missing a key SKU.`);
    }
    const keySku = itemSkus[crateInfo.keySkuId];
    if (!keySku) {
      throw new Error(`Key SKU ${crateInfo.keySkuId} missing from catalog.`);
    }
    keyCurrency = keySku.purchasable?.currency ?? "gems";
    keyPrice = keySku.purchasable?.amount ?? 0;
  });

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();

    uid = `uid-${Date.now()}`;
    await seedMinimalPlayer(uid);

    await admin.firestore().doc(`Players/${uid}/Economy/Stats`).set(
      {
        gems: STARTING_GEMS,
        coins: STARTING_COINS,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  it("purchases a crate and preserves the legacy response shape", async () => {
    const wrapped = wrapCallable(purchaseCrateItem);
    const opId = `op_legacy_crate_${Date.now()}`;
    const result = await wrapped({
      data: {
        crateId: crateInfo.crateId,
        kind: "crate",
        quantity: 1,
        opId,
      },
      ...authFor(uid),
    });

    expect(result).toMatchObject({
      success: true,
      opId,
      crateId: crateInfo.crateId,
      kind: "crate",
      skuId: crateInfo.crateSkuId,
      quantity: 1,
    });

    if (crateCurrency === "gems") {
      expect(result.totalCostGems).toBe(cratePrice);
      expect(result.gemsBefore).toBeGreaterThanOrEqual(cratePrice);
      expect(result.gemsAfter).toBe(result.gemsBefore - cratePrice);
    } else {
      expect(result.totalCostCoins).toBe(cratePrice);
      expect(result.coinsBefore).toBeGreaterThanOrEqual(cratePrice);
      expect(result.coinsAfter).toBe(result.coinsBefore - cratePrice);
    }

    const receiptDoc = await admin
      .firestore()
      .doc(`Players/${uid}/Receipts/${opId}`)
      .get();
    expect(receiptDoc.exists).toBe(true);
    expect(receiptDoc.data()?.result?.skuId).toBe(crateInfo.crateSkuId);

    const inventoryDoc = await admin
      .firestore()
      .doc(`Players/${uid}/Inventory/${crateInfo.crateSkuId}`)
      .get();
    expect(Number(inventoryDoc.data()?.quantity ?? inventoryDoc.data()?.qty ?? 0)).toBe(1);
  });

  it("purchases keys and is idempotent via the wrapper", async () => {
    const wrapped = wrapCallable(purchaseCrateItem);
    const opId = `op_legacy_key_${Date.now()}`;

    const first = await wrapped({
      data: {
        crateId: crateInfo.crateId,
        kind: "key",
        quantity: 2,
        opId,
      },
      ...authFor(uid),
    });
    const second = await wrapped({
      data: {
        crateId: crateInfo.crateId,
        kind: "key",
        quantity: 2,
        opId,
      },
      ...authFor(uid),
    });

    expect(second).toEqual(first);
    if (keyCurrency === "gems") {
      expect(first.totalCostGems).toBe(keyPrice * 2);
    } else {
      expect(first.totalCostCoins).toBe(keyPrice * 2);
    }

    const receiptDoc = await admin
      .firestore()
      .doc(`Players/${uid}/Receipts/${opId}`)
      .get();
    expect(receiptDoc.exists).toBe(true);
    expect(receiptDoc.data()?.result?.skuId).toBe(crateInfo.keySkuId);

    const inventoryDoc = await admin
      .firestore()
      .doc(`Players/${uid}/Inventory/${crateInfo.keySkuId}`)
      .get();
    expect(Number(inventoryDoc.data()?.quantity ?? inventoryDoc.data()?.qty ?? 0)).toBe(2);
  });
});
