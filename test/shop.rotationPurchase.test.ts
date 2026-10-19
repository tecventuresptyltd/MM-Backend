import { readFileSync } from "node:fs";
import { join } from "node:path";
import { admin } from "./setup";
import { wrapCallable } from "./helpers/callable";
import { verifyIapPurchase } from "../src/shop/iap";
import { isReceiptVerificationEnabled } from "../src/shop/iapConfig";
import * as verification from "../src/shop/receiptVerification";
import { __resetCatalogCacheForTests } from "../src/core/config";
import { __resetGemPacksCacheForTests } from "../src/game-data/catalogs/GemPacksCatalog";
import { getCuratedOffers, recordRotationEvent, resetRotationConfigCache, RotationConfig, rotationStateRef } from "../src/shop/curatedRotation";

jest.mock("../src/shop/receiptVerification", () => ({
  ReceiptRejected: class ReceiptRejected extends Error {},
  VerifierNotConfigured: class VerifierNotConfigured extends Error {},
  verifyReceipt: jest.fn(),
}));
jest.mock("../src/shop/iapConfig", () => ({ isReceiptVerificationEnabled: jest.fn() }));
jest.mock("../src/shop/offerScheduler", () => ({ scheduleOfferTransition: jest.fn(), cancelScheduledTransition: jest.fn() }));

jest.setTimeout(60000);
const db = admin.firestore();
const readSeed = (path: string) => JSON.parse(readFileSync(join(__dirname, "../seeds/gamedata", path), "utf8"));
const config: RotationConfig = { ...readSeed("config/ShopRotationConfig.json"), enabled: true, selectionMode: "manual" };
const offerDocument = readSeed("catalogs/OffersCatalog.json");
const fixtures: Record<string, unknown> = { "GameData/v1/config/ShopRotationConfig": config };
for (const catalog of ["OffersCatalog", "ItemsCatalog", "ItemsIndex", "GemPacksCatalog"]) {
  fixtures[`GameData/v1/catalogs/${catalog}`] = readSeed(`catalogs/${catalog}.json`);
}
const originals = new Map<string, FirebaseFirestore.DocumentData | undefined>();
const uid = "curated-rotation-receipt-test";
const ledgers = new Set<string>();
const verify = wrapCallable(verifyIapPurchase);
const request = (offerId: string, transactionId: string, presentation?: unknown) => {
  ledgers.add(`android.${transactionId}`);
  return { auth: { uid, token: {} }, data: { platform: "android", productId: offerDocument.offers[offerId].productId,
    receipt: transactionId, transactionId, shopPresentation: presentation } };
};
const presentation = (view: Awaited<ReturnType<typeof getCuratedOffers>>) => ({
  version: view.rotation.version, rangeId: view.rotation.rangeId, setId: view.rotation.setId, expiresAt: view.rotating![0].expiresAt,
  revision: view.rotation.revision,
});
const clearLedgers = async () => { for (const id of ledgers) await db.doc(`IapTransactions/${id}`).delete(); };
const resetCaches = () => { resetRotationConfigCache(); __resetCatalogCacheForTests(); __resetGemPacksCacheForTests(); };

test("automatic verified purchases advance the global cursor once, show the upsell, and reject stale presentation advancement", async () => {
  const automatic: RotationConfig = { ...config, selectionMode: "automatic" };
  await db.doc("GameData/v1/config/ShopRotationConfig").set(automatic);
  resetCaches();
  let now = Date.UTC(2026, 9, 19, 12);
  const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const initial = await getCuratedOffers(uid, automatic);
    const firstInput = request(initial.rotating![0].offerId, "automatic-first", presentation(initial));
    await Promise.all([verify(firstInput), verify(firstInput)]);
    expect((await rotationStateRef(uid).get()).get("automaticCursor")).toBe(1);
    expect((await getCuratedOffers(uid, automatic)).rotation.setId).toBe("S1");
    now += 900001;
    const next = await getCuratedOffers(uid, automatic);
    expect(next.rotation.setId).toBe("B1");
    expect(next.rotation.nextRotationAt).toBe(initial.rotation.nextRotationAt);
    await verify(firstInput);
    await verify(request(next.rotating![0].offerId, "automatic-stale", presentation(initial)));
    expect((await rotationStateRef(uid).get()).get("automaticCursor")).toBe(1);
    now += 900001;
    const current = await getCuratedOffers(uid, automatic);
    expect(current.rotation.setId).toBe("B1");
    await verify(request(current.rotating![0].offerId, "automatic-current", presentation(current)));
    expect((await rotationStateRef(uid).get()).get("automaticCursor")).toBe(2);
    now += 900001;
    expect((await getCuratedOffers(uid, automatic)).rotation.setId).toBe("C1");
  } finally {
    clock.mockRestore();
    resetCaches();
  }
});

beforeAll(async () => {
  for (const path of Object.keys(fixtures)) originals.set(path, (await db.doc(path).get()).data());
});
beforeEach(async () => {
  await db.recursiveDelete(db.doc(`Players/${uid}`));
  await clearLedgers();
  for (const [path, data] of Object.entries(fixtures)) await db.doc(path).set(data as FirebaseFirestore.DocumentData);
  await db.doc(`Players/${uid}/Economy/Stats`).set({ gems: 10, coins: 20 });
  resetCaches();
  jest.mocked(isReceiptVerificationEnabled).mockResolvedValue(true);
  jest.mocked(verification.verifyReceipt).mockReset();
  jest.mocked(verification.verifyReceipt).mockImplementation(async (_platform, _receipt, productId, transactionId) => ({ productId, transactionId: transactionId! }));
});
afterAll(async () => {
  await db.recursiveDelete(db.doc(`Players/${uid}`));
  await clearLedgers();
  for (const [path, original] of originals) {
    if (original) await db.doc(path).set(original); else await db.doc(path).delete();
  }
  resetCaches();
});

test("a verified purchase grants existing rewards and advances the complete trio atomically; concurrent replay does neither twice", async () => {
  const initial = await getCuratedOffers(uid, config);
  const offerId = initial.rotating![0].offerId;
  const input = request(offerId, "curated-concurrent", presentation(initial));
  const results = await Promise.all([verify(input), verify(input)]);
  expect(results[0]).toEqual(results[1]);
  const current = await getCuratedOffers(uid, config);
  expect(current.rotation.setId).toBe("A2");
  expect(current.rotation.nextRotationAt).toBe(initial.rotation.nextRotationAt);
  expect(current.rotating).toHaveLength(3);
  const gems = offerDocument.offers[offerId].entitlements.find((entitlement: any) => entitlement.type === "gems").quantity;
  expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).get("gems")).toBe(10 + gems);
  const inventoryBeforeReplay = (await db.collection(`Players/${uid}/Inventory`).get()).docs.map(doc => [doc.id, doc.get("quantity") ?? null]);
  expect(current.rotation.availableSpecialSets.map(set => set.setId)).toContain("S1");
  expect(await verify(input)).toEqual(results[0]);
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("A2");
  expect((await db.collection(`Players/${uid}/Inventory`).get()).docs.map(doc => [doc.id, doc.get("quantity") ?? null])).toEqual(inventoryBeforeReplay);
  expect((await db.doc(`Players/${uid}/Offers/State`).get()).get("totalIapPurchases")).toBe(1);
});

test("a rejected receipt changes no rewards, trio or special window", async () => {
  const initial = await getCuratedOffers(uid, config);
  jest.mocked(verification.verifyReceipt).mockRejectedValue(new verification.ReceiptRejected("invalid"));
  await expect(verify(request(initial.rotating![0].offerId, "curated-rejected", presentation(initial)))).rejects.toMatchObject({ code: "permission-denied" });
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("A1");
  expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).get("gems")).toBe(10);
  expect((await db.doc("IapTransactions/android.curated-rejected").get()).exists).toBe(false);
  expect((await rotationStateRef(uid).get()).get("specials.S1")).toBeUndefined();
});

test("late verified receipt grants rewards without advancing a different presentation", async () => {
  const initial = await getCuratedOffers(uid, config);
  const selected = await getCuratedOffers(uid, config, { rangeId: "standard" });
  await verify(request(initial.rotating![0].offerId, "curated-late", presentation(initial)));
  const current = await getCuratedOffers(uid, config);
  expect(current.rotation.setId).toBe(selected.rotation.setId);
  expect(current.rotation.rangeId).toBe("standard");
  expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).get("gems")).toBeGreaterThan(10);
});

test("a receipt without presentation context grants rewards without advancing the current trio", async () => {
  const initial = await getCuratedOffers(uid, config);
  const result = await verify(request(initial.rotating![0].offerId, "curated-context-missing"));
  expect(result).toMatchObject({ success: true, verified: true });
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("A1");
  expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).get("gems")).toBeGreaterThan(10);
});

test.each([
  ["version", { version: "obsolete-version" }],
  ["expired", { expiresAt: 1 }],
] as const)("a %s-mismatched presentation grants a verified receipt without advancing", async (label, override) => {
  const initial = await getCuratedOffers(uid, config);
  await verify(request(initial.rotating![0].offerId, `curated-mismatch-${label}`, { ...presentation(initial), ...override }));
  const current = await getCuratedOffers(uid, config);
  expect(current.rotation.setId).toBe("A1");
  expect(current.rotation.revision).toBe(initial.rotation.revision);
  expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).get("gems")).toBeGreaterThan(10);
});

test("a late receipt cannot advance a later visit to the same set after a full same-day cycle", async () => {
  const original = await getCuratedOffers(uid, config, { rangeId: "standard" });
  expect(original.rotation.setId).toBe("B1");
  const offerId = original.rotating![1].offerId;
  await verify(request(offerId, "curated-cycle-first", presentation(original)));
  const second = await getCuratedOffers(uid, config);
  expect(second.rotation.setId).toBe("B2");
  await verify(request(second.rotating![1].offerId, "curated-cycle-second", presentation(second)));
  const returned = await getCuratedOffers(uid, config);
  expect(returned.rotation.setId).toBe("B1");
  expect(returned.rotation.revision).toBeGreaterThan(original.rotation.revision);
  expect(returned.rotating![0].expiresAt).toBe(original.rotating![0].expiresAt);
  const gemsBefore = (await db.doc(`Players/${uid}/Economy/Stats`).get()).get("gems");
  await verify(request(offerId, "curated-cycle-late", presentation(original)));
  const afterLate = await getCuratedOffers(uid, config);
  expect(afterLate.rotation.setId).toBe("B1");
  expect(afterLate.rotation.revision).toBe(returned.rotation.revision);
  expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).get("gems")).toBeGreaterThan(gemsBefore);
});

test("verification-disabled fulfillment grants rewards without advancing daily sets, consuming specials or opening upsells", async () => {
  jest.mocked(isReceiptVerificationEnabled).mockResolvedValue(false);
  const initial = await getCuratedOffers(uid, config);
  const ordinary = await verify(request(initial.rotating![0].offerId, "curated-unverified-daily", presentation(initial)));
  expect(ordinary).toMatchObject({ success: true, verified: false });
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("A1");
  expect((await rotationStateRef(uid).get()).get("specials.S1")).toBeUndefined();
  expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).get("gems")).toBeGreaterThan(10);

  await recordRotationEvent(uid, { type: "mythical_crate", occurredAt: Date.now() - 1 });
  const special = await getCuratedOffers(uid, config, { specialSetId: "S6" });
  const featured = config.specialSets.find(set => set.id === "S6")!.featuredOfferId;
  const bought = await verify(request(featured, "curated-unverified-special", presentation(special)));
  expect(bought).toMatchObject({ success: true, verified: false });
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("S6");
  const finalState = await rotationStateRef(uid).get();
  expect(finalState.get("specials.S6.consumed")).toBe(false);
  expect(finalState.get("specials.S1")).toBeUndefined();
  expect(verification.verifyReceipt).not.toHaveBeenCalled();
});

test("special companion purchase keeps the special open; featured purchase consumes it and returns to the normal trio", async () => {
  await getCuratedOffers(uid, config);
  await recordRotationEvent(uid, { type: "mythical_crate", occurredAt: Date.now() - 1 });
  const special = await getCuratedOffers(uid, config, { specialSetId: "S6" });
  await verify(request(special.rotating![0].offerId, "curated-companion", presentation(special)));
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("S6");
  const featured = config.specialSets.find(set => set.id === "S6")!.featuredOfferId;
  await verify(request(featured, "curated-featured", presentation(special)));
  const current = await getCuratedOffers(uid, config);
  expect(current.rotation.setId).toBe("A1");
  expect(current.rotating).toHaveLength(3);
  expect((await rotationStateRef(uid).get()).get("specials.S6.consumed")).toBe(true);
  await expect(getCuratedOffers(uid, config, { specialSetId: "S6" })).rejects.toMatchObject({ code: "failed-precondition" });
});

test("failed fulfillment rolls back rotation and purchase eligibility along with the grant", async () => {
  const initial = await getCuratedOffers(uid, config);
  await db.doc(`Players/${uid}/Economy/Stats`).delete();
  await expect(verify(request(initial.rotating![0].offerId, "curated-grant-failure", presentation(initial)))).rejects.toMatchObject({ code: "failed-precondition" });
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("A1");
  expect((await db.doc("IapTransactions/android.curated-grant-failure").get()).exists).toBe(false);
  expect((await rotationStateRef(uid).get()).get("specials.S1")).toBeUndefined();
});
