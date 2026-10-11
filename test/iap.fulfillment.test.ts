import { admin } from "./setup";
import { wrapCallable } from "./helpers/callable";
import { verifyIapPurchase } from "../src/shop/iap";
import { purchaseOffer } from "../src/shop/purchaseOffer";
import * as verification from "../src/shop/receiptVerification";
import { isReceiptVerificationEnabled } from "../src/shop/iapConfig";
import { __resetGemPacksCacheForTests } from "../src/game-data/catalogs/GemPacksCatalog";
import { __resetCatalogCacheForTests } from "../src/core/config";

jest.mock("../src/shop/receiptVerification", () => ({
  ReceiptRejected: class ReceiptRejected extends Error {},
  VerifierNotConfigured: class VerifierNotConfigured extends Error {},
  verifyReceipt: jest.fn(),
}));
jest.mock("../src/shop/offerScheduler", () => ({ scheduleOfferTransition: jest.fn(), cancelScheduledTransition: jest.fn() }));
jest.mock("../src/shop/iapConfig", () => ({ isReceiptVerificationEnabled: jest.fn() }));

jest.setTimeout(60000);
const db = admin.firestore();
const verify = wrapCallable(verifyIapPurchase);
const buyOffer = wrapCallable(purchaseOffer);
const uid = "analytics-iap-owner";
const other = "analytics-iap-other";
const originalDocs = new Map<string, FirebaseFirestore.DocumentData | undefined>();
const catalogPaths = ["GameData/v1/catalogs/GemPacksCatalog", "GameData/v1/catalogs/OffersCatalog"];
const ledgerIds = new Set<string>();
const request = (tx: string, productId = "test.gems", user = uid) => {
  ledgerIds.add("android." + tx);
  return { auth: { uid: user, token: {} }, data: { platform: "android", productId, transactionId: tx, receipt: tx } };
};

beforeAll(async () => {
  for (const path of catalogPaths) originalDocs.set(path, (await db.doc(path).get()).data());
});
beforeEach(async () => {
  jest.mocked(isReceiptVerificationEnabled).mockResolvedValue(true);
  jest.mocked(verification.verifyReceipt).mockClear();
  await db.recursiveDelete(db.doc(`Players/${uid}`));
  await db.recursiveDelete(db.doc(`Players/${other}`));
  for (const id of ledgerIds) await db.collection("IapTransactions").doc(id).delete();
  await db.doc(`Players/${uid}/Economy/Stats`).set({ gems: 10, coins: 20 });
  await db.doc(`Players/${other}/Economy/Stats`).set({ gems: 0, coins: 0 });
  await db.doc(catalogPaths[0]).set({ packs: {
    test: { iapId: "testpack", productId: "test.gems", gemAmount: 100, displayName: "Test", priceUsd: 1, sortOrder: 0 },
    second: { iapId: "testpack2", productId: "test.gems2", gemAmount: 200, displayName: "Test2", priceUsd: 2, sortOrder: 1 },
  } });
  await db.doc(catalogPaths[1]).set({ offers: {
    testoffer: { offerId: "testoffer", productId: "test.offer", currency: "USD", amount: 3,
      entitlements: [{ type: "gems", id: "cur_gems", quantity: 50 }, { type: "coins", id: "cur_coins", quantity: 80 }] },
  } });
  __resetGemPacksCacheForTests();
  __resetCatalogCacheForTests();
  jest.mocked(verification.verifyReceipt).mockImplementation(async (_platform, _receipt, productId, transactionId) => ({ transactionId: transactionId!, productId }));
});
afterAll(async () => {
  for (const [path, data] of originalDocs) {
    if (data) await db.doc(path).set(data); else await db.doc(path).delete();
  }
  for (const id of ledgerIds) await db.collection("IapTransactions").doc(id).delete();
  await db.recursiveDelete(db.doc(`Players/${uid}`));
  await db.recursiveDelete(db.doc(`Players/${other}`));
  __resetGemPacksCacheForTests();
  __resetCatalogCacheForTests();
});

test("concurrent gem deliveries return success and grant only once", async () => {
  const results = await Promise.all([verify(request("gem-concurrent")), verify(request("gem-concurrent"))]);
  expect(results[0]).toEqual(results[1]);
  expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).get("gems")).toBe(110);
  expect(await verify(request("gem-concurrent"))).toEqual(results[0]);
});

test("a transaction cannot move to another account or product", async () => {
  await verify(request("gem-owned"));
  await expect(verify(request("gem-owned", "test.gems", other))).rejects.toThrow("another purchase or player");
  await expect(verify(request("gem-owned", "test.gems2"))).rejects.toThrow("another purchase or player");
  expect((await db.doc(`Players/${other}/Economy/Stats`).get()).get("gems")).toBe(0);
});

test("verified paid offers recover after expiration and concurrent callbacks do not grant twice", async () => {
  await db.doc(`Players/${uid}/Offers/Active`).set({ rotating: [], special: [{ offerId: "testoffer", expiresAt: 1 }] });
  const results = await Promise.all([verify(request("offer-concurrent", "test.offer")), verify(request("offer-concurrent", "test.offer"))]);
  expect(results[0]).toEqual(results[1]);
  const stats = (await db.doc(`Players/${uid}/Economy/Stats`).get()).data()!;
  expect(stats.gems).toBe(60);
  expect(stats.coins).toBe(100);
  expect(await verify(request("offer-concurrent", "test.offer"))).toEqual(results[0]);
  await expect(verify(request("offer-concurrent", "test.offer", other))).rejects.toThrow("another purchase or player");
});

test("legacy offer endpoint cannot grant a store offer without a receipt", async () => {
  await expect(buyOffer({ auth: { uid, token: {} }, data: { opId: "unverified", offerId: "testoffer", isIapPurchase: true } })).rejects.toThrow("valid receipt");
  expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).get("gems")).toBe(10);
});

test("receipt rejection creates neither grant nor transaction ledger", async () => {
  jest.mocked(verification.verifyReceipt).mockRejectedValue(new verification.ReceiptRejected("invalid"));
  await expect(verify(request("rejected"))).rejects.toThrow("could not be verified");
  expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).get("gems")).toBe(10);
  expect((await db.doc("IapTransactions/android.rejected").get()).exists).toBe(false);
});

test.each(["test.gems", "test.offer"])("verification disabled fulfills %s without contacting the store outside the emulator runtime", async (productId) => {
  const emulator = process.env.FUNCTIONS_EMULATOR;
  delete process.env.FUNCTIONS_EMULATOR;
  jest.mocked(isReceiptVerificationEnabled).mockResolvedValue(false);
  jest.mocked(verification.verifyReceipt).mockRejectedValue(new verification.ReceiptRejected("store unavailable"));
  try {
    const result = await verify(request("disabled-" + productId, productId));
    expect(result).toMatchObject({ success: true, verified: false });
    expect(verification.verifyReceipt).not.toHaveBeenCalled();
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).get("gems")).toBe(productId === "test.gems" ? 110 : 60);
    expect(await verify(request("disabled-" + productId, productId))).toEqual(result);
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).get("gems")).toBe(productId === "test.gems" ? 110 : 60);
  } finally {
    if (emulator === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = emulator;
  }
});

test("already granted receipts recover without another store verification call", async () => {
  const first = await verify(request("store-offline-replay"));
  jest.mocked(verification.verifyReceipt).mockRejectedValue(new verification.ReceiptRejected("store unavailable"));
  expect(await verify(request("store-offline-replay"))).toEqual(first);
  expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).get("gems")).toBe(110);
});
