import { readFileSync } from "node:fs";
import { join } from "node:path";
import { admin } from "./setup";
import { __resetCatalogCacheForTests } from "../src/core/config";
import { getCuratedOffers, prepareRotationState, recordRotationEvent, resetRotationConfigCache, RotationConfig, RotationState, rotationStateRef } from "../src/shop/curatedRotation";

jest.setTimeout(60000);
const db = admin.firestore();
const readSeed = (path: string) => JSON.parse(readFileSync(join(__dirname, "../seeds/gamedata", path), "utf8"));
const config: RotationConfig = { ...readSeed("config/ShopRotationConfig.json"), enabled: true };
const uid = "recurring-mastery-test";
const configRef = db.doc("GameData/v1/config/ShopRotationConfig");
const offersRef = db.doc("GameData/v1/catalogs/OffersCatalog");
const profileRef = db.doc(`Players/${uid}/Profile/Profile`);
const monday = Date.UTC(2026, 9, 19, 12);
let now = monday;
let clock: jest.SpyInstance;
const originals = new Map<string, FirebaseFirestore.DocumentData | undefined>();
const state = async () => (await rotationStateRef(uid).get()).data() as RotationState;
const occurrence = (rank: number, previousRank?: number, occurredAt = now) => recordRotationEvent(uid, {
  type: "mastery", rank, ...(previousRank === undefined ? {} : { previousRank }), occurredAt,
});

beforeAll(async () => {
  for (const ref of [configRef, offersRef]) originals.set(ref.path, (await ref.get()).data());
});
beforeEach(async () => {
  now = monday;
  clock = jest.spyOn(Date, "now").mockImplementation(() => now);
  await db.recursiveDelete(db.doc(`Players/${uid}`));
  await configRef.set(config);
  await offersRef.set(readSeed("catalogs/OffersCatalog.json"));
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

test.each([
  ["S2", [5, 15, 25], 86400000],
  ["S3", [10, 20, 30], 86400000],
  ["S4", [20, 30, 40], 172800000],
] as const)("%s reopens at each configured ten-rank milestone after consumption", async (id, ranks, duration) => {
  expect(config.specialSets.find(set => set.id === id)?.repeatEveryRanks).toBe(10);
  for (const rank of ranks) {
    await occurrence(rank, rank - 1);
    const current = await state();
    expect(current.milestoneRanks?.[id]).toBe(rank);
    expect(current.specials[id]).toEqual({ expiresAt: now + duration, consumed: false });
    expect((await db.doc(`Players/${uid}/Offers/Active`).get()).get("rotating")).toHaveLength(3);
    await rotationStateRef(uid).update({ [`specials.${id}.consumed`]: true });
    now += 3600000;
  }
});

test("a newly crossed milestone gets its full window even while the prior occurrence is active", async () => {
  await occurrence(5, 4);
  const first = (await state()).specials.S2.expiresAt;
  now += 3600000;
  await occurrence(15, 14);
  expect((await state()).specials.S2.expiresAt).toBe(now + 86400000);
  expect((await state()).specials.S2.expiresAt).toBeGreaterThan(first);
  const next = await state();
  await Promise.all(Array.from({ length: 3 }, () => occurrence(15, 14)));
  expect((await state()).specials).toEqual(next.specials);
  expect((await state()).milestoneRanks).toEqual(next.milestoneRanks);
});

test("non-milestone ranks, refreshes and replay cannot reopen an expired or consumed occurrence", async () => {
  await occurrence(15, 14);
  await rotationStateRef(uid).update({ "specials.S2.consumed": true, masteryInitialized: true });
  const consumed = (await state()).specials.S2;
  now += 1000;
  await occurrence(16, 15);
  await getCuratedOffers(uid, config);
  expect((await state()).specials.S2).toEqual(consumed);
  now += 2 * config.periodMs;
  await occurrence(15, 14, monday);
  await occurrence(17, 16);
  expect((await state()).specials.S2).toEqual(consumed);
  expect((await state()).milestoneRanks?.S2).toBe(15);
});

test("a rank jump records only the latest crossed occurrence per offer without a backlog", async () => {
  await occurrence(37, 4);
  const current = await state();
  expect(current.milestoneRanks).toMatchObject({ S2: 35, S3: 30, S4: 30 });
  expect(Object.keys(current.specials).sort()).toEqual(["S2", "S3", "S4"]);
  expect(current.specials.S2.expiresAt).toBe(now + 86400000);
  expect(current.specials.S3.expiresAt).toBe(now + 86400000);
  expect(current.specials.S4.expiresAt).toBe(now + 172800000);
  now += 1000;
  await occurrence(38, 37);
  expect((await state()).specials).toEqual(current.specials);
});

test("a newer non-milestone delivery does not hide a delayed actual milestone", async () => {
  await occurrence(16, 15);
  expect((await state()).specials.S2).toBeUndefined();
  const occurredAt = now - 1000;
  await occurrence(15, 14, occurredAt);
  expect((await state()).milestoneRanks?.S2).toBe(15);
  expect((await state()).specials.S2.expiresAt).toBe(occurredAt + 86400000);
  expect((await state()).eventTimes.mastery).toBe(now);
});

test("an older delayed milestone cannot downgrade a newer occurrence or its deadline", async () => {
  await occurrence(25, 24);
  const latest = (await state()).specials.S2;
  await occurrence(15, 14, now - 1000);
  expect((await state()).milestoneRanks?.S2).toBe(25);
  expect((await state()).specials.S2).toEqual(latest);
});

test("delivery after an occurrence's original expiry cannot create a fresh countdown", async () => {
  await occurrence(15, 14, now - 2 * config.periodMs);
  const current = await state();
  expect(current.specials.S2?.expiresAt ?? 0).toBeLessThanOrEqual(now);
  expect((await getCuratedOffers(uid, config)).rotation.availableSpecialSets.map(set => set.setId)).not.toContain("S2");
});

test("legacy one-time state does not grant retroactively on a non-threshold rank but permits the next recurrence", async () => {
  const legacy = prepareRotationState(undefined, config, now);
  legacy.milestones = ["S2", "S3", "S4"];
  delete legacy.milestoneRanks;
  legacy.masteryInitialized = true;
  legacy.specials.S2 = { expiresAt: now - 1000, consumed: true };
  await rotationStateRef(uid).set(legacy);
  await occurrence(26, 25);
  expect((await state()).specials.S2).toEqual(legacy.specials.S2);
  expect((await state()).specials.S3).toBeUndefined();
  now += 1000;
  await occurrence(35, 34);
  expect((await state()).milestoneRanks?.S2).toBe(35);
  expect((await state()).specials.S2).toEqual({ expiresAt: now + 86400000, consumed: false });
});

test("first shop catch-up uses the latest reached occurrence once for an existing high-rank player", async () => {
  await profileRef.set({ masteryRank: 37 });
  await getCuratedOffers(uid, config);
  const initial = await state();
  expect(initial.milestoneRanks).toMatchObject({ S2: 35, S3: 30, S4: 30 });
  now += 1000;
  await getCuratedOffers(uid, config);
  expect((await state()).specials).toEqual(initial.specials);
});

test("a config without recurrence keeps its original once-only mastery behavior", async () => {
  const once = { ...config, specialSets: config.specialSets.map(({ repeatEveryRanks, ...special }) => special) };
  await configRef.set(once);
  resetRotationConfigCache();
  await occurrence(5, 4);
  const first = (await state()).specials.S2;
  now += 1000;
  await occurrence(15, 14);
  expect((await state()).specials.S2).toEqual(first);
});
