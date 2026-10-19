import { readFileSync } from "node:fs";
import { join } from "node:path";
import { admin } from "./setup";
import { __resetCatalogCacheForTests } from "../src/core/config";
import {
  getCuratedOffers, getRotationConfig, recordRotationEvent, resetRotationConfigCache,
  RotationConfig, RotationState, rotationStateRef, validateRotationConfig,
} from "../src/shop/curatedRotation";
import { Offer } from "../src/shared/types";
import { getDailyOffers } from "../src/shop/offers";
import { wrapCallable } from "./helpers/callable";

jest.setTimeout(60000);
const db = admin.firestore();
const configPath = "GameData/v1/config/ShopRotationConfig";
const offersPath = "GameData/v1/catalogs/OffersCatalog";
const readSeed = (path: string) => JSON.parse(readFileSync(join(__dirname, "../seeds/gamedata", path), "utf8"));
const config: RotationConfig = { ...readSeed("config/ShopRotationConfig.json"), enabled: true, selectionMode: "manual" };
const offerDocument = readSeed("catalogs/OffersCatalog.json");
const offers: Record<string, Offer> = offerDocument.offers;
const uid = "curated-rotation-state-test";
const originals = new Map<string, FirebaseFirestore.DocumentData | undefined>();
const monday = Date.UTC(2026, 9, 19, 12);
let now = monday;
let clock: jest.SpyInstance;
const state = async () => (await rotationStateRef(uid).get()).data() as RotationState;

beforeAll(async () => {
  for (const path of [configPath, offersPath]) originals.set(path, (await db.doc(path).get()).data());
});
beforeEach(async () => {
  now = monday;
  clock = jest.spyOn(Date, "now").mockImplementation(() => now);
  await db.recursiveDelete(db.doc(`Players/${uid}`));
  await db.doc(configPath).set(config);
  await db.doc(offersPath).set(offerDocument);
  resetRotationConfigCache();
  __resetCatalogCacheForTests();
});
afterEach(() => clock.mockRestore());
afterAll(async () => {
  await db.recursiveDelete(db.doc(`Players/${uid}`));
  for (const category of ["micro_hook", "sweet_spot", "whale"]) {
    await db.doc(`System/Offers/TransitionQueue/${uid}_${category}`).delete();
  }
  for (const [path, original] of originals) {
    if (original) await db.doc(path).set(original); else await db.doc(path).delete();
  }
  resetRotationConfigCache();
  __resetCatalogCacheForTests();
});

test("the loaded configuration covers all 30 existing products through 14 daily and seven special trios", async () => {
  expect(await getRotationConfig()).toEqual(config);
  expect(config.ranges.flatMap(range => range.sets)).toHaveLength(14);
  expect(config.specialSets).toHaveLength(7);
  const allSets = [...config.ranges.flatMap(range => range.sets), ...config.specialSets];
  expect(new Set(allSets.flatMap(set => set.offerIds))).toEqual(new Set(Object.keys(offers)));
  expect(Object.keys(offers)).toHaveLength(30);
  expect(() => validateRotationConfig(config, offers)).not.toThrow();
  for (const set of allSets) expect(new Set(set.offerIds).size).toBe(3);
});

test("defaults to the first small trio and repeated refreshes retain the same deadline and order", async () => {
  const first = await getCuratedOffers(uid, config);
  now += 60000;
  const second = await getCuratedOffers(uid, config);
  expect(first.rotation.setId).toBe("A1");
  expect(second.rotation.setId).toBe("A1");
  expect(second.rotating?.map(offer => offer.offerId)).toEqual(config.ranges[0].sets[0].offerIds);
  expect(second.rotating).toHaveLength(3);
  expect(second.special).toEqual([]);
  expect(second.rotation.nextRotationAt).toBe(first.rotation.nextRotationAt);
  expect((await db.doc(`Players/${uid}/Offers/Active`).get()).data()).toEqual(second);
});

test("daily rollover advances a complete trio with no empty cooldown and catches up missed days", async () => {
  await getCuratedOffers(uid, config);
  now = Date.UTC(2026, 9, 20);
  const next = await getCuratedOffers(uid, config);
  expect(next.rotation.setId).toBe("A2");
  expect(next.rotating).toHaveLength(3);
  expect(next.rotating?.every(offer => offer.state === "active" && offer.expiresAt > now)).toBe(true);
  now += 4 * config.periodMs;
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("A6");
  now += config.periodMs;
  expect((await getCuratedOffers(uid, config)).rotation.setId).toBe("A1");
});

test("selecting ranges persists and switching back cannot reset rotation", async () => {
  await getCuratedOffers(uid, config);
  now += config.periodMs;
  const standard = config.ranges.find(range => range.sets[0].id === "B1")!;
  const selected = await getCuratedOffers(uid, config, { rangeId: standard.id });
  expect(selected.rotation.setId).toBe("B2");
  expect((await getCuratedOffers(uid, config)).rotation.rangeId).toBe(standard.id);
  expect((await getCuratedOffers(uid, config, { rangeId: config.defaultRangeId })).rotation.setId).toBe("A2");
});

test.each([null, [], "A1", { rangeId: "not-a-range" }, { specialSetId: 5 }])("rejects malformed selection %j without creating player state", async selection => {
  await expect(getCuratedOffers(uid, config, selection)).rejects.toMatchObject({ code: "invalid-argument" });
  expect((await rotationStateRef(uid).get()).exists).toBe(false);
});

test("clients cannot unlock unavailable special sets", async () => {
  await expect(getCuratedOffers(uid, config, { specialSetId: "S6" })).rejects.toMatchObject({ code: "failed-precondition" });
  expect((await rotationStateRef(uid).get()).exists).toBe(false);
});

test("server-earned special can be selected, closed and expires without extending on repeated events", async () => {
  const special = config.specialSets.find(set => set.trigger === "mythical_crate")!;
  await getCuratedOffers(uid, config);
  await recordRotationEvent(uid, { type: "mythical_crate", occurredAt: now });
  const deadline = now + special.durationMs;
  const opened = await getCuratedOffers(uid, config, { specialSetId: special.id });
  expect(opened.rotating?.map(offer => offer.offerId)).toEqual(special.offerIds);
  expect(opened.rotating).toHaveLength(3);
  expect(opened.special).toEqual([]);
  now += 60000;
  await recordRotationEvent(uid, { type: "mythical_crate", occurredAt: monday });
  await recordRotationEvent(uid, { type: "mythical_crate", occurredAt: now });
  expect((await state()).specials[special.id].expiresAt).toBe(deadline);
  expect((await getCuratedOffers(uid, config, { specialSetId: null })).rotation.setId).toBe("A1");
  await getCuratedOffers(uid, config, { specialSetId: special.id });
  now = deadline;
  const expired = await getCuratedOffers(uid, config);
  expect(expired.rotation.selectedSpecialSetId).toBeNull();
  expect(expired.rotation.availableSpecialSets).not.toEqual(expect.arrayContaining([expect.objectContaining({ setId: special.id })]));
  expect(expired.rotating).toHaveLength(3);
  await expect(getCuratedOffers(uid, config, { specialSetId: special.id })).rejects.toMatchObject({ code: "failed-precondition" });
});

test("concurrent repeated trigger deliveries create one window and reject future or stale events", async () => {
  const special = config.specialSets.find(set => set.trigger === "win_streak")!;
  await getCuratedOffers(uid, config);
  await recordRotationEvent(uid, { type: "win_streak", occurredAt: now + 1000 });
  expect((await state()).specials[special.id]).toBeUndefined();
  await Promise.all(Array.from({ length: 3 }, () => recordRotationEvent(uid, { type: "win_streak", occurredAt: now })));
  expect((await state()).specials[special.id].expiresAt).toBe(now + special.durationMs);
  now += special.durationMs + 1;
  await recordRotationEvent(uid, { type: "win_streak", occurredAt: monday });
  expect((await getCuratedOffers(uid, config)).rotation.availableSpecialSets).toEqual([]);
});

test("mastery catch-up unlocks reached ranks only and cannot restart a consumed or expired milestone", async () => {
  await db.doc(`Players/${uid}/Profile/Profile`).set({ masteryRank: 10 });
  const result = await getCuratedOffers(uid, config);
  const mastery = config.specialSets.filter(set => set.trigger === "mastery");
  expect(result.rotation.availableSpecialSets.map(set => set.setId).sort()).toEqual(mastery.filter(set => set.rank! <= 10).map(set => set.id).sort());
  now += 3 * config.periodMs;
  await recordRotationEvent(uid, { type: "mastery", rank: 10, occurredAt: now });
  expect((await getCuratedOffers(uid, config)).rotation.availableSpecialSets).toEqual([]);
});

test("a non-mastery event before the first shop visit does not suppress existing mastery rewards", async () => {
  await db.doc(`Players/${uid}/Profile/Profile`).set({ masteryRank: 20 });
  await recordRotationEvent(uid, { type: "mythical_crate", occurredAt: now });
  expect((await rotationStateRef(uid).get()).exists).toBe(true);
  expect((await state()).masteryInitialized).not.toBe(true);
  now += 1000;
  const first = await getCuratedOffers(uid, config);
  const masteryIds = config.specialSets.filter(set => set.trigger === "mastery").map(set => set.id);
  expect(first.rotation.availableSpecialSets.map(set => set.setId)).toEqual(expect.arrayContaining(masteryIds));
  expect((await state()).masteryInitialized).toBe(true);
  const firstWindows = (await state()).specials;
  now += 1000;
  await getCuratedOffers(uid, config);
  expect((await state()).specials).toEqual(firstWindows);
});

test("weekend window uses one Saturday deadline and refreshes cannot reopen a consumed offer", async () => {
  now = Date.UTC(2026, 9, 24, 10);
  const special = config.specialSets.find(set => set.trigger === "weekend")!;
  const result = await getCuratedOffers(uid, config);
  const deadline = Date.UTC(2026, 9, 25);
  expect(result.rotation.availableSpecialSets).toContainEqual({ setId: special.id, offerId: special.featuredOfferId, expiresAt: deadline });
  await rotationStateRef(uid).update({ [`specials.${special.id}.consumed`]: true });
  expect((await getCuratedOffers(uid, config)).rotation.availableSpecialSets).toEqual([]);
  now = deadline;
  expect((await getCuratedOffers(uid, config)).rotation.availableSpecialSets).toEqual([]);
  now = Date.UTC(2026, 9, 31, 10);
  expect((await getCuratedOffers(uid, config)).rotation.availableSpecialSets.map(set => set.setId)).toContain(special.id);
});

test("production and unknown project names cannot enable curated rotation even with enabled configuration", async () => {
  const original = process.env.GCLOUD_PROJECT;
  try {
    for (const project of ["mystic-motors-prod", "other-project"]) {
      process.env.GCLOUD_PROJECT = project;
      resetRotationConfigCache();
      expect(await getRotationConfig()).toBeNull();
    }
  } finally {
    process.env.GCLOUD_PROJECT = original;
    resetRotationConfigCache();
  }
});

test("disabling sandbox configuration restores the legacy path", async () => {
  await db.doc(configPath).update({ enabled: false });
  resetRotationConfigCache();
  expect(await getRotationConfig()).toBeNull();
});

test("disabling rotation converts existing curated cards to exactly three legacy cards and removes active metadata", async () => {
  await getCuratedOffers(uid, config);
  await db.doc(configPath).update({ enabled: false });
  resetRotationConfigCache();
  const result = await wrapCallable(getDailyOffers)({ auth: { uid, token: {} }, data: {} });
  expect(result.rotating).toHaveLength(3);
  expect(result.rotating.map((offer: { category: string }) => offer.category)).toEqual(["micro_hook", "sweet_spot", "whale"]);
  expect(result.rotation).toBeUndefined();
  const active = (await db.doc(`Players/${uid}/Offers/Active`).get()).data()!;
  expect(active.rotating).toHaveLength(3);
  expect(active.rotation).toBeUndefined();
});
