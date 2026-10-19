import { readFileSync } from "node:fs";
import { join } from "node:path";
import { admin } from "./setup";
import { __resetCatalogCacheForTests } from "../src/core/config";
import {
  applyRotationPurchase, automaticRotationSets, getCuratedOffers, prepareRotationState,
  recordRotationEvent, resetRotationConfigCache, RotationConfig, RotationState, rotationStateRef, writeRotation,
} from "../src/shop/curatedRotation";

jest.setTimeout(60000);
const db = admin.firestore();
const readSeed = (path: string) => JSON.parse(readFileSync(join(__dirname, "../seeds/gamedata", path), "utf8"));
const config: RotationConfig = { ...readSeed("config/ShopRotationConfig.json"), enabled: true };
const offers = readSeed("catalogs/OffersCatalog.json");
const uid = "automatic-rotation-test";
const configRef = db.doc("GameData/v1/config/ShopRotationConfig");
const activeRef = db.doc(`Players/${uid}/Offers/Active`);
const profileRef = db.doc(`Players/${uid}/Profile/Profile`);
const monday = Date.UTC(2026, 9, 19, 12);
let now = monday;
let clock: jest.SpyInstance;
const originals = new Map<string, FirebaseFirestore.DocumentData | undefined>();

beforeAll(async () => {
  for (const path of [configRef.path, "GameData/v1/catalogs/OffersCatalog"]) originals.set(path, (await db.doc(path).get()).data());
});
beforeEach(async () => {
  now = monday;
  clock = jest.spyOn(Date, "now").mockImplementation(() => now);
  await db.recursiveDelete(db.doc(`Players/${uid}`));
  await configRef.set(config);
  await db.doc("GameData/v1/catalogs/OffersCatalog").set(offers);
  resetRotationConfigCache();
  __resetCatalogCacheForTests();
});
afterEach(() => clock.mockRestore());
afterAll(async () => {
  await db.recursiveDelete(db.doc(`Players/${uid}`));
  for (const [path, original] of originals) {
    if (original) await db.doc(path).set(original); else await db.doc(path).delete();
  }
  resetRotationConfigCache();
  __resetCatalogCacheForTests();
});

test("daily automatic rotation visits all 14 interleaved ordinary trios and catches up missed days", async () => {
  const ordinaryConfig = { ...config, specialSets: [] };
  const expected = ["A1", "B1", "C1", "D1", "A2", "B2", "C2", "D2", "A3", "C3", "D3", "A4", "A5", "A6"];
  const seen = new Set<string>();
  for (const setId of expected) {
    const view = await getCuratedOffers(uid, ordinaryConfig);
    expect(view.rotation.setId).toBe(setId);
    expect(view.rotating).toHaveLength(3);
    expect(view.special).toEqual([]);
    view.rotating!.forEach(offer => seen.add(offer.offerId));
    now += config.periodMs;
  }
  expect(seen.size).toBe(23);
  expect((await getCuratedOffers(uid, ordinaryConfig)).rotation.setId).toBe("A1");
  now += 3 * config.periodMs;
  expect((await getCuratedOffers(uid, ordinaryConfig)).rotation.setId).toBe("D1");
});

test("all seven eligible specials become visible without selection and complete coverage of all 30 offers", async () => {
  const seen = new Set(automaticRotationSets(config).flatMap(entry => entry.set.offerIds));
  for (const special of config.specialSets) {
    await rotationStateRef(uid).delete();
    await activeRef.delete();
    now = monday;
    if (special.trigger === "weekend") now = Date.UTC(2026, 9, 24, 12);
    else await recordRotationEvent(uid, { type: special.trigger, rank: special.rank, occurredAt: now });
    if (special.id === "S3") now += config.specialTiePeriodMs!;
    if (special.id === "S4") now += config.periodMs;
    const view = await getCuratedOffers(uid, config);
    expect(view.rotation.setId).toBe(special.id);
    expect(view.rotating!.map(offer => offer.offerId)).toEqual(special.offerIds);
    expect(view.rotating).toHaveLength(3);
    expect(view.special).toEqual([]);
    view.rotating!.forEach(offer => seen.add(offer.offerId));
  }
  expect(seen).toEqual(new Set(Object.keys(offers.offers)));
  expect(seen.size).toBe(30);
});

test("equal-expiry mastery specials alternate every 15 minutes without extending deadlines", async () => {
  await profileRef.set({ masteryRank: 20 });
  const first = await getCuratedOffers(uid, config);
  expect(first.rotation.setId).toBe("S2");
  const deadline = first.rotating![0].expiresAt;
  expect(first.rotation.nextRotationAt).toBe(now + config.specialTiePeriodMs!);
  now += config.specialTiePeriodMs!;
  const second = await getCuratedOffers(uid, config);
  expect(second.rotation.setId).toBe("S3");
  expect(second.rotation.revision).toBeGreaterThan(first.rotation.revision);
  expect(second.rotating![0].expiresAt).toBe(deadline);
  now += config.specialTiePeriodMs!;
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("S2");
  now = deadline;
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("S4");
  now = monday + 2 * config.periodMs;
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("C1");
});

test("shortest-expiry special takes precedence then falls back without replay extending a window", async () => {
  await getCuratedOffers(uid, config);
  await recordRotationEvent(uid, { type: "mythical_crate", occurredAt: now });
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("S6");
  await recordRotationEvent(uid, { type: "win_streak", occurredAt: now });
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("S5");
  await recordRotationEvent(uid, { type: "purchase", occurredAt: now });
  const first = await getCuratedOffers(uid, config);
  expect(first.rotation.setId).toBe("S1");
  now += 1000;
  await recordRotationEvent(uid, { type: "purchase", occurredAt: now });
  expect((await getCuratedOffers(uid, config)).rotating![0].expiresAt).toBe(first.rotating![0].expiresAt);
  now = monday + 900000;
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("S5");
  now = monday + 3600000;
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("S6");
  now = monday + 28800000;
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("A1");
});

test("automatic selection ignores old navigation requests and consumes a purchased special without losing the ordinary cursor", async () => {
  await getCuratedOffers(uid, config);
  expect((await getCuratedOffers(uid, config, { rangeId: "large", specialSetId: "S6" })).rotation.setId).toBe("A1");
  await recordRotationEvent(uid, { type: "mythical_crate", occurredAt: now });
  const active = await getCuratedOffers(uid, config);
  const special = config.specialSets.find(entry => entry.id === "S6")!;
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(rotationStateRef(uid));
    const state = prepareRotationState(snapshot.data() as RotationState, config, now);
    applyRotationPurchase(state, config, special.featuredOfferId, active, now, {
      ...active.rotation, expiresAt: active.rotating![0].expiresAt,
    });
    writeRotation(tx, uid, state, config, now);
  });
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("A1");
  now += 1000;
  await recordRotationEvent(uid, { type: "mythical_crate", occurredAt: now });
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("A1");
});

test("manual-to-automatic migration retains existing special expiry and consumed state", async () => {
  const manual = { ...config, selectionMode: "manual" as const, version: "curated-sandbox-v1" };
  await getCuratedOffers(uid, manual, { rangeId: "standard" });
  await rotationStateRef(uid).update({ specials: { S6: { expiresAt: now + 60000, consumed: true } } });
  const previous = (await rotationStateRef(uid).get()).data()!;
  const migrated = await getCuratedOffers(uid, config);
  expect(migrated.rotation.setId).toBe("B1");
  expect(migrated.rotation.revision).toBeGreaterThan(previous.revision);
  expect((await rotationStateRef(uid).get()).get("specials")).toEqual(previous.specials);
});
