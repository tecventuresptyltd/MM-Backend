process.env.FUNCTIONS_EMULATOR = "true";
import { admin } from "./setup";
import { wipeFirestore, ensureCatalogsSeeded } from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { __resetV2ConfigCacheForTests } from "../src/core/configV2";
import { recordRaceResult } from "../src/race";

jest.setTimeout(120_000);

const db = admin.firestore();
const uid = "crate-cadence-player";
const race = wrapCallable(recordRaceResult);
const profileRef = db.doc(`Players/${uid}/Profile/Profile`);
const slotsRef = db.doc(`Players/${uid}/Crates/Slots`);
const firstHourRef = db.doc(`Players/${uid}/Progress/FirstHour`);
const configRef = db.doc("GameData/v1/config/CrateSlotsConfig");

const emptySlots = () => slotsRef.set({ slots: [null, null, null, null], maxSlots: 4 });
const occupiedSlot = () => ({
  crateSkuId: "sku_zz3twgp0wx",
  crateId: "commoncrate",
  rarity: "common",
  receivedAt: admin.firestore.Timestamp.now(),
  isUnlocking: false,
  startedAt: null,
  completesAt: null,
  unlockDurationSeconds: 1800,
});
const hasCrate = (result: any): boolean => result.drops.player.type !== "noreward";
const request = (raceId: string) => ({
  data: { raceId, finishOrder: [0, 1], botNames: [], survivalSeconds: 180 },
  auth: { uid, token: {} },
});

async function prepare(raceId: string, gamemode = "RANKED"): Promise<void> {
  const batch = db.batch();
  batch.set(db.doc(`Races/${raceId}`), {
    status: "pending",
    createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - 180_000),
    lobbySnapshot: [{ rating: 0, participantId: uid }, { rating: 0, participantId: null }],
  });
  batch.set(db.doc(`Races/${raceId}/Participants/${uid}`), {
    playerIndex: 0,
    preDeductedTrophies: 0,
    gamemode,
  });
  await batch.commit();
}

async function settle(raceId: string, gamemode = "RANKED"): Promise<any> {
  await prepare(raceId, gamemode);
  return race(request(raceId));
}

beforeEach(async () => {
  await wipeFirestore();
  __resetV2ConfigCacheForTests();
  await ensureCatalogsSeeded();
  const batch = db.batch();
  batch.set(profileRef, { displayName: "Crate Cadence", trophies: 0, highestTrophies: 0, exp: 0, masteryXp: 0, level: 1, totalWins: 0 });
  batch.set(db.doc(`Players/${uid}/Economy/Stats`), { gems: 100, coins: 1000, spellShards: 0 });
  batch.set(db.doc(`Players/${uid}/Garage/Cars`), { cars: {} });
  batch.set(db.doc(`Players/${uid}/SpellDecks/Decks`), { active: 1, decks: {} });
  batch.set(db.doc(`Players/${uid}/Spells/Levels`), { levels: {} });
  batch.set(db.doc("GameData/v1/config/ChallengesConfig"), { enabled: false }, { merge: true });
  await batch.commit();
  await emptySlots();
});

describe("race crate cadence", () => {
  it("grants two or three crates in every rolling ten eligible races with space", async () => {
    const granted: number[] = [];
    for (let i = 1; i <= 14; i++) {
      await emptySlots();
      const result = await settle(`cadence-${i}`);
      granted.push(hasCrate(result) ? 1 : 0);
      expect((await slotsRef.get()).data()!.slots.filter(Boolean)).toHaveLength(hasCrate(result) ? 1 : 0);
    }
    for (let start = 0; start <= granted.length - 10; start++) {
      expect([2, 3]).toContain(granted.slice(start, start + 10).reduce((sum, count) => sum + count, 0));
    }
    expect(granted.map((count, index) => count ? index + 1 : 0).filter(Boolean)).toEqual([4, 8, 12]);
  });

  it("counts concurrent and later retries of one race only once", async () => {
    await profileRef.update({ raceCrateProgress: 3 });
    await prepare("same-race");
    const results = await Promise.all([race(request("same-race")), race(request("same-race"))]);
    expect(results[0]).toEqual(results[1]);
    expect(hasCrate(results[0])).toBe(true);
    expect(await race(request("same-race"))).toEqual(results[0]);
    expect((await profileRef.get()).data()).toMatchObject({ raceCrateProgress: 0, totalRaces: 1 });
    expect((await slotsRef.get()).data()!.slots.filter(Boolean)).toHaveLength(1);
  });

  it("serializes different concurrent race settlements without losing progress", async () => {
    await profileRef.update({ raceCrateProgress: 2 });
    await Promise.all([prepare("concurrent-a"), prepare("concurrent-b")]);
    const results = await Promise.all([race(request("concurrent-a")), race(request("concurrent-b"))]);
    expect(results.filter(hasCrate)).toHaveLength(1);
    expect((await profileRef.get()).data()).toMatchObject({ raceCrateProgress: 0, totalRaces: 2 });
    expect((await slotsRef.get()).data()!.slots.filter(Boolean)).toHaveLength(1);
  });

  it("pauses progress when all slots are full and resumes when one is free", async () => {
    await profileRef.update({ raceCrateProgress: 3 });
    const fullSlots = Array.from({ length: 4 }, occupiedSlot);
    await slotsRef.set({ slots: fullSlots, maxSlots: 4 });
    const full = await settle("full-slots");
    expect(full.drops.player).toEqual({ type: "noreward", skuId: null });
    expect((await slotsRef.get()).data()!.slots).toEqual(fullSlots);
    expect((await profileRef.get()).data()!.raceCrateProgress).toBe(3);
    await slotsRef.update({ slots: [null, ...fullSlots.slice(1)] });
    expect(hasCrate(await settle("free-slot"))).toBe(true);
    expect((await slotsRef.get()).data()!.slots.filter(Boolean)).toHaveLength(4);
  });

  it("preserves the tutorial crate and grants three crates in the first ten races", async () => {
    await firstHourRef.set({ active: true, racesCompleted: 0, starterCratePending: true, starterCrateSkuId: "sku_zz3twgp0wx", starterCrateRarity: "common", modeFirstRaceDone: {} });
    const awardedAt: number[] = [];
    for (let i = 1; i <= 10; i++) {
      await emptySlots();
      const result = await settle(`tutorial-${i}`);
      if (hasCrate(result)) awardedAt.push(i);
      if (i <= 2) expect((await profileRef.get()).data()!.raceCrateProgress).toBeUndefined();
    }
    expect(awardedAt).toEqual([2, 6, 10]);
    expect((await firstHourRef.get()).data()).toMatchObject({ racesCompleted: 10, starterCratePending: false });
  });

  it("does not grant the tutorial crate into full slots", async () => {
    await firstHourRef.set({ active: true, racesCompleted: 1, starterCratePending: true, starterCrateSkuId: "sku_zz3twgp0wx", starterCrateRarity: "common", modeFirstRaceDone: {} });
    await slotsRef.set({ slots: Array.from({ length: 4 }, occupiedSlot), maxSlots: 4 });
    const result = await settle("tutorial-full");
    expect(hasCrate(result)).toBe(false);
    expect(result.firstHour.starterCrateGranted).toBe(false);
    expect((await slotsRef.get()).data()!.slots.filter(Boolean)).toHaveLength(4);
  });

  it("excludes unranked races from crate progress", async () => {
    await profileRef.update({ raceCrateProgress: 3 });
    expect(hasCrate(await settle("unranked", "UNRANKED"))).toBe(false);
    expect((await profileRef.get()).data()!.raceCrateProgress).toBe(3);
    expect(hasCrate(await settle("ranked-after-unranked"))).toBe(true);
  });

  it.each(["ELIMINATION", "POLICE", "INFECTED"])("applies the cadence to %s races", async (gamemode) => {
    await profileRef.update({ raceCrateProgress: 3 });
    expect(hasCrate(await settle(`mode-${gamemode}`, gamemode))).toBe(true);
    expect((await profileRef.get()).data()!.raceCrateProgress).toBe(0);
  });

  it("uses the cached catalog interval and supports older configuration", async () => {
    await configRef.update({ raceDropEveryRaces: 2 });
    __resetV2ConfigCacheForTests();
    expect(hasCrate(await settle("configured-first"))).toBe(false);
    expect(hasCrate(await settle("configured-second"))).toBe(true);
    await configRef.update({ raceDropEveryRaces: admin.firestore.FieldValue.delete() });
    __resetV2ConfigCacheForTests();
    await profileRef.update({ raceCrateProgress: 3 });
    expect(hasCrate(await settle("legacy-config"))).toBe(true);
  });
});
