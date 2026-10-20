process.env.FUNCTIONS_EMULATOR = "true";
import { admin } from "./setup";
import { createHash } from "node:crypto";
import { wipeAuth, wipeFirestore, ensureCatalogsSeeded } from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { getChallengesStatus, claimDailyChallenge, claimChallengeMilestone, swapDailyChallenge, claimAchievement } from "../src/challenges";
import { eligibleDefinitions, getChallengesDefinitions, resetChallengesCache } from "../src/challenges/config";
import { achievementsRef, dailyRef, clampRaceStats, advanceProgress, achievementState, resolveDaily } from "../src/challenges/state";
import { __resetV2ConfigCacheForTests } from "../src/core/configV2";
import { challengeMapId } from "../src/challenges/race";
import * as challengeRace from "../src/challenges/race";
import * as challengeConfig from "../src/challenges/config";
import { recordRaceResult } from "../src/race";
import { initializeUserIfNeeded } from "../src/shared/initializeUser";

jest.setTimeout(60_000);
const db = admin.firestore();
const NOW = Date.UTC(2026, 9, 9, 12);
const uid = "challenge-test-player";
const status = wrapCallable(getChallengesStatus);
const claim = wrapCallable(claimDailyChallenge);
const milestone = wrapCallable(claimChallengeMilestone);
const swap = wrapCallable(swapDailyChallenge);
const achievement = wrapCallable(claimAchievement);
const race = wrapCallable(recordRaceResult);
const request = (data: Record<string, unknown> = {}) => ({ data: { __testNowMs: NOW, ...data }, auth: { uid, token: {} } });
async function complete(count: number) {
  const snap = await dailyRef(uid).get();
  const state = snap.data()!;
  state.challenges.forEach((c: any, index: number) => { if (index < count) c.progress = c.objective.target; });
  await dailyRef(uid).set(state);
  return state;
}
const raceContext = { uid, raceId: "stats-test", now: NOW, createdAtMs: NOW - 10_000, mode: "RANKED", mapId: "track_01", carId: "car-test", place: 1, participants: 8, topSpeedKph: 180, friendRace: false, clanPoints: 0 };
afterEach(() => jest.restoreAllMocks());
beforeEach(async () => {
  await wipeFirestore();
  await wipeAuth();
  __resetV2ConfigCacheForTests();
  resetChallengesCache();
  await ensureCatalogsSeeded();
  const batch = db.batch();
  batch.set(db.doc(`Players/${uid}/Profile/Profile`), { displayName: "Challenge Test", trophies: 0, highestTrophies: 0, exp: 0, masteryXp: 0, level: 1, totalWins: 0 });
  batch.set(db.doc(`Players/${uid}/Garage/Cars`), { cars: {} });
  batch.set(db.doc(`Players/${uid}/SpellDecks/Decks`), { active: 1, decks: {} });
  batch.set(db.doc(`Players/${uid}/Spells/Levels`), { levels: {} });
  await batch.commit();
  await db.doc(`Players/${uid}/Economy/Stats`).set({ gems: 100, coins: 1000, spellShards: 0 }, { merge: true });
});

describe("sandbox challenges", () => {
  it("hides historical points and strips legacy objective points without erasing history", async () => {
    await status(request());
    await achievementsRef(uid).update({ points: 125 });
    const daily = (await dailyRef(uid).get()).data()!;
    daily.challenges[0].objective.points = 75;
    await dailyRef(uid).set(daily);
    const view = await status(request());
    expect(view.achievementPoints).toBe(0);
    expect(view.challenges.every((o: any) => o.points === undefined)).toBe(true);
    expect(view.achievements.every((o: any) => o.points === undefined)).toBe(true);
    expect((await achievementsRef(uid).get()).data()?.points).toBe(125);
    await db.doc(`Players/${uid}/Garage/Cars`).set({ cars: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`car_${i}`, { owned: true, carLevel: 1 }])) });
    const claimed = await achievement(request({ achievementId: "collector", opId: "no-new-points" }));
    expect(claimed.status.achievementPoints).toBe(0);
    expect(claimed.rewards).toEqual([{ kind: "gems", quantity: 20 }]);
    expect((await achievementsRef(uid).get()).data()?.points).toBe(125);
    expect(await achievement(request({ achievementId: "collector", opId: "no-new-points" }))).toEqual(claimed);
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()?.gems).toBe(120);
  });

  it("normalizes legacy daily rewards to 20 gems and never writes XP or shards", async () => {
    await status(request());
    const daily = (await dailyRef(uid).get()).data()!;
    daily.challenges[0].objective.rewards = [{ kind: "coins", quantity: 9999 }];
    daily.challenges[0].objective.xp = 999;
    daily.challenges[0].objective.shards = 999;
    daily.challenges[0].progress = daily.challenges[0].objective.target;
    await dailyRef(uid).set(daily);
    const profileBefore = (await db.doc(`Players/${uid}/Profile/Profile`).get()).data();
    const view = await status(request());
    expect(view.challenges[0].rewards).toEqual([{ kind: "gems", quantity: 20 }]);
    expect(view.challenges[0].xp).toBeUndefined();
    const result = await claim(request({ challengeId: view.challenges[0].id, opId: "legacy-reward-normalization" }));
    expect(result.rewards).toEqual([{ kind: "gems", quantity: 20 }]);
    expect(result.xp).toBe(0);
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()).toMatchObject({ gems: 120, coins: 1000, spellShards: 0 });
    expect((await db.doc(`Players/${uid}/Profile/Profile`).get()).data()).toEqual(profileBefore);
  });
  it("matches enrolled mode boundaries and legacy access without hidden locked progress", async () => {
    const defs = (await getChallengesDefinitions())!;
    for (const [mode, threshold, stat] of [["ELIMINATION", 5, "eliminationWins"], ["POLICE", 10, "policeEscapes"], ["INFECTED", 15, "infectedWins"]] as const) {
      const below = eligibleDefinitions(defs, threshold - 1, { active: true, racesCompleted: 1 });
      const at = eligibleDefinitions(defs, threshold, { active: true, racesCompleted: 1 });
      expect(below.lockedModes).toContain(mode);
      expect(at.lockedModes).not.toContain(mode);
      expect(below.achievements.some(o => o.stat === stat)).toBe(false);
      const state = achievementState();
      const daily = resolveDaily(uid, NOW, below);
      advanceProgress(below, daily, state, { ...raceContext, mode }, { spellsCast: 150 });
      expect(state.progress).toEqual({});
      expect(state.stats).toEqual({});
    }
    expect(eligibleDefinitions(defs, 0, null).lockedModes).toEqual([]);
    expect(eligibleDefinitions(defs, 150, null, {}, 4).achievements.some(o => ["friendRaces", "clanPoints"].includes(o.stat))).toBe(false);
    expect(eligibleDefinitions(defs, 0, null, {}, 5).achievements.some(o => ["friendRaces", "clanPoints"].includes(o.stat))).toBe(true);
    expect(eligibleDefinitions(defs, 0, { active: true, racesCompleted: 0 }).lockedModes).toContain("UNRANKED");
    expect(eligibleDefinitions(defs, 0, { active: true, racesCompleted: 1 }).lockedModes).not.toContain("UNRANKED");
  });
  it("uses server mastery XP and first-hour state to reject locked achievement claims", async () => {
    await db.doc(`Players/${uid}/Progress/FirstHour`).set({ active: true, racesCompleted: 1 });
    await db.doc(`Players/${uid}/Profile/Profile`).update({ masteryXp: 0, masteryRank: 150 });
    const defs = (await getChallengesDefinitions())!;
    const objective = defs.achievements.find(o => o.stat === "policeEscapes")!;
    await achievementsRef(uid).set({ ...achievementState(), progress: { [objective.id]: objective.target } });
    expect((await status(request())).achievements.some((o: any) => o.id === objective.id)).toBe(false);
    await expect(achievement(request({ achievementId: objective.id, opId: "locked-achievement" }))).rejects.toMatchObject({ code: "not-found" });
  });
  it("replaces only ineligible same-day objectives and tolerates exhausted pools", async () => {
    const defs = (await getChallengesDefinitions())!;
    const locked = { ...defs.challenges[0], id: "locked-police", stat: "policeEscapes" };
    const eligible = eligibleDefinitions({ ...defs, challenges: [locked, ...defs.challenges] }, 0, { active: true, racesCompleted: 1 });
    const daily = resolveDaily(uid, NOW, defs);
    daily.challenges[0] = { objective: locked, progress: 0, claimed: false };
    daily.challenges[1].progress = 1;
    const saved = daily.challenges[1];
    const migrated = resolveDaily(uid, NOW, eligible, daily);
    expect(migrated.challenges.some(c => c.objective.id === locked.id)).toBe(false);
    expect(migrated.challenges.find(c => c.objective.id === saved.objective.id)?.progress).toBe(1);
    daily.challenges[0].claimed = true;
    expect(resolveDaily(uid, NOW, eligible, daily).challenges.some(c => c.objective.id === locked.id && c.claimed)).toBe(true);
    expect(resolveDaily(uid, NOW, { ...eligible, challenges: [] }).challenges).toEqual([]);
    const future = { ...daily, dayIndex: daily.dayIndex + 1 };
    expect(resolveDaily(uid, NOW, eligible, future).dayIndex).toBe(future.dayIndex);
    const withoutCars = eligibleDefinitions(defs, 0, null, {}, 0, false);
    expect(withoutCars.challenges.some(o => o.stat === "newCarWin")).toBe(false);
    const normalOnly = { ...eligible, challenges: eligible.challenges.filter(o => !o.hard) };
    expect(resolveDaily(uid, NOW, normalOnly).challenges.length).toBe(Math.min(5, normalOnly.challenges.length));
  });
  it("keeps historical completed receipts unchanged without granting again", async () => {
    const view = await status(request());
    const challengeId = view.challenges[0].id;
    const result = { success: true, rewards: [{ kind: "coins", quantity: 500 }], xp: 50 };
    const inputsHash = createHash("sha256").update(JSON.stringify({ action: "claimDailyChallenge", target: challengeId })).digest("hex");
    await db.doc(`Players/${uid}/Receipts/historical-reward`).set({ status: "completed", kind: "claimDailyChallenge", inputsHash, result });
    expect(await claim(request({ challengeId, opId: "historical-reward" }))).toEqual(result);
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()).toMatchObject({ gems: 100, coins: 1000, spellShards: 0 });
  });

  it("rejects retired actions without changing state or granting rewards", async () => {
    await status(request());
    await complete(5);
    await dailyRef(uid).update({ swapsUsed: 1 });
    const before = (await dailyRef(uid).get()).data();
    const economyRef = db.doc(`Players/${uid}/Economy/Stats`);
    const economyBefore = (await economyRef.get()).data();
    await expect(swap(request({ challengeId: before!.challenges[0].objective.id, opId: "retired-swap" }))).rejects.toMatchObject({ code: "failed-precondition" });
    await expect(milestone(request({ milestoneIndex: 0, opId: "retired-chest" }))).rejects.toMatchObject({ code: "failed-precondition" });
    expect((await dailyRef(uid).get()).data()).toEqual(before);
    expect((await economyRef.get()).data()).toEqual(economyBefore);
    expect((await db.doc(`Players/${uid}/Receipts/retired-swap`).get()).exists).toBe(false);
    expect((await db.doc(`Players/${uid}/Receipts/retired-chest`).get()).exists).toBe(false);
    await db.doc(`Players/${uid}/Receipts/legacy-retired`).set({ status: "completed", result: { success: true } });
    await expect(swap(request({ challengeId: before!.challenges[0].objective.id, opId: "legacy-retired" }))).rejects.toMatchObject({ code: "failed-precondition" });
    await expect(milestone(request({ milestoneIndex: 0, opId: "legacy-retired" }))).rejects.toMatchObject({ code: "failed-precondition" });
    expect(await status(request())).toMatchObject({ milestones: [], swapsUsed: 0, swapCost: 0, swapsPerDay: 0, dailyClaimableCount: 5 });
  });
  it("ignores retired rewards in older deployed configuration", async () => {
    await db.doc("GameData/v1/config/ChallengesConfig").update({ swapCost: 10, swapsPerDay: 5, milestones: [{ target: 1, rewards: [{ kind: "gems", quantity: 999 }] }] });
    resetChallengesCache();
    await status(request());
    await complete(5);
    expect(await status(request())).toMatchObject({ milestones: [], swapCost: 0, swapsPerDay: 0, dailyClaimableCount: 5 });
  });
  it("loads daily challenges without retired configuration fields", async () => {
    await db.doc("GameData/v1/config/ChallengesConfig").update({ swapCost: admin.firestore.FieldValue.delete(), swapsPerDay: admin.firestore.FieldValue.delete(), milestones: admin.firestore.FieldValue.delete() });
    resetChallengesCache();
    expect(await status(request())).toMatchObject({ dailyCount: 5, milestones: [], swapCost: 0, swapsPerDay: 0 });
  });
  it("bootstraps challenge documents without resetting existing progress", async () => {
    const freshUid = "challenge-bootstrap-player";
    await admin.auth().createUser({ uid: freshUid });
    await initializeUserIfNeeded(freshUid, [], { isGuest: true });
    expect((await dailyRef(freshUid).get()).data()).toMatchObject({ dayIndex: -1, challenges: [], swapsUsed: 0 });
    expect((await achievementsRef(freshUid).get()).data()).toMatchObject({ progress: {}, claimed: {}, points: 0 });
    await achievementsRef(freshUid).update({ points: 25 });
    await initializeUserIfNeeded(freshUid, [], { isGuest: true });
    expect((await achievementsRef(freshUid).get()).data()?.points).toBe(25);
  });
  it("rolls deterministically and expires yesterday's unclaimed progress", async () => {
    const first = await status(request());
    expect(first.challenges).toHaveLength(5);
    expect(first.challenges.filter((c: any) => c.hard)).toHaveLength(1);
    expect(first.resetAtMs).toBe(Date.UTC(2026, 9, 10));
    expect((await status(request())).challenges).toEqual(first.challenges);
    await dailyRef(uid).delete();
    expect((await status(request())).challenges).toEqual(first.challenges);
    await complete(5);
    const tomorrow = await status(request({ __testNowMs: NOW + 86_400_000 }));
    expect(tomorrow.completedCount).toBe(0);
    expect(tomorrow.swapsUsed).toBe(0);
  });
  it("replays a receipt once and rejects a different-op double claim", async () => {
    const first = await status(request());
    await complete(1);
    const data = { challengeId: first.challenges[0].id, opId: "claim-one" };
    const awarded = await claim(request(data));
    const replay = await claim(request(data));
    expect(replay).toEqual(awarded);
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()?.coins).toBe(1000);
    await expect(claim(request({ ...data, opId: "claim-two" }))).rejects.toMatchObject({ code: "failed-precondition" });
    expect((await db.doc(`Players/${uid}/Profile/Profile`).get()).data()?.masteryXp).toBe(0);
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()?.gems).toBe(120);
    expect(awarded.xp).toBe(0);
    expect(awarded.rewards).toEqual([{ kind: "gems", quantity: 20 }]);
  });
  it("binds an opId to its original action and target", async () => {
    const first = await status(request());
    await complete(2);
    await claim(request({ challengeId: first.challenges[0].id, opId: "bound" }));
    await expect(claim(request({ challengeId: first.challenges[1].id, opId: "bound" }))).rejects.toMatchObject({ code: "invalid-argument" });
  });
  it("serializes two devices claiming the same reward", async () => {
    const first = await status(request());
    await complete(1);
    const results = await Promise.allSettled(["device-one", "device-two"].map(opId => claim(request({ challengeId: first.challenges[0].id, opId }))));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()?.coins).toBe(1000);
  });
  it("refreshes account-state achievements and grants gems without points", async () => {
    const cars = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [`car_${index}`, { carLevel: index === 0 ? 10 : 1 }]));
    await db.doc(`Players/${uid}/Garage/Cars`).set({ cars });
    const ready = await status(request());
    expect(ready.achievements.find((a: any) => a.id === "collector").state).toBe("claimable");
    expect(ready.achievements.find((a: any) => a.id === "fully_loaded").state).toBe("claimable");
    const granted = await achievement(request({ achievementId: "collector", opId: "collector-claim" }));
    expect(granted.status.achievementPoints).toBe(0);
    expect((await achievementsRef(uid).get()).data()?.points).toBe(0);
    expect(granted.rewards).toEqual([{ kind: "gems", quantity: 20 }]);
    expect(granted.xp).toBe(0);
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()).toMatchObject({ coins: 1000, gems: 120, spellShards: 0 });
    expect(granted.status.achievements.find((a: any) => a.id === "collector").tier).toBe("Silver");
    await expect(achievement(request({ achievementId: "collector", opId: "collector-again" }))).rejects.toMatchObject({ code: "failed-precondition" });
  });
  it("caps stats by configured maxima, elapsed time and car speed, drops invalid input", async () => {
    const defs = (await getChallengesDefinitions())!;
    const accepted = clampRaceStats({ maxSpeedKph: 9000, driftMetres: 100000, nitroUses: 999, wallHits: -1, timesHit: "0" }, raceContext, defs);
    expect(accepted.maxSpeedKph).toBe(180);
    expect(accepted.driftMetres).toBe(500);
    expect(accepted.nitroUses).toBe(150);
    expect(accepted.wallHits).toBeUndefined();
    expect(accepted.timesHit).toBeUndefined();
  });
  it("never treats absent stats as zero-valued feats", async () => {
    const defs = (await getChallengesDefinitions())!;
    const daily = resolveDaily(uid, NOW, defs);
    daily.challenges = [{ objective: defs.challenges.find(o => o.id === "win_no_nitro")!, progress: 0, claimed: false }];
    advanceProgress(defs, daily, achievementState(), raceContext, {});
    expect(daily.challenges[0].progress).toBe(0);
    advanceProgress(defs, daily, achievementState(), raceContext, { nitroUses: 0 });
    expect(daily.challenges[0].progress).toBe(1);
  });
  it("settles old-client races normally and counts retry exactly once", async () => {
    const raceId = "challenge-old-client-race";
    await db.doc(`Races/${raceId}`).set({ status: "pending", createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - 60_000), trackId: "track_01", lobbySnapshot: [{ rating: 0, participantId: uid }, { rating: 0, participantId: null }] });
    await db.doc(`Races/${raceId}/Participants/${uid}`).set({ playerIndex: 0, preDeductedTrophies: 0, gamemode: "UNRANKED" });
    const payload = request({ raceId, finishOrder: [0, 1], botNames: [] });
    const first = await race(payload);
    expect(first.success).toBe(true);
    expect(first.newlyCompletedAchievementIds).toContain("first_victory");
    expect(await race(payload)).toEqual(first);
    const progress = (await achievementsRef(uid).get()).data()!;
    expect(progress.stats.races).toBe(1);
    expect(progress.progress.first_victory).toBe(1);
    expect(progress.progress.untouchable ?? 0).toBe(0);
  });
  it("rejects invalid settlement before progressing objectives", async () => {
    await expect(race(request({ raceId: "missing", finishOrder: [0] }))).rejects.toMatchObject({ code: "failed-precondition" });
    expect((await achievementsRef(uid).get()).data()?.stats.races).toBeUndefined();
  });
  it("normalizes every current numeric map and requires wins on every configured map", async () => {
    const defs = (await getChallengesDefinitions())!;
    const daily = resolveDaily(uid, NOW, defs);
    const progress = achievementState();
    for (let map = 0; map < 10; map++) {
      expect(challengeMapId(map)).toBe(String(map));
      advanceProgress(defs, daily, progress, { ...raceContext, mapId: challengeMapId(map) }, {});
    }
    expect(challengeMapId("track_01")).toBe("0");
    expect(progress.progress.globetrotter).toBe(10);
    advanceProgress(defs, daily, progress, { ...raceContext, mapId: "0" }, {});
    expect(progress.mapsWon).toHaveLength(10);
  });
  it("rejects fractional zero-condition counters and inconsistent spell type reports", async () => {
    const defs = (await getChallengesDefinitions())!;
    const stats = clampRaceStats({ nitroUses: 0.5, wallHits: 0.5, spellTypesUsed: ["shield"] }, raceContext, defs);
    expect(stats.nitroUses).toBeUndefined();
    expect(stats.wallHits).toBeUndefined();
    expect(stats.spellTypesUsed).toBeUndefined();
  });
  it("commits valid client stats with settlement and ignores altered retries", async () => {
    const raceId = "challenge-reported-stats";
    await db.doc(`Races/${raceId}`).set({ status: "pending", createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - 60_000), trackId: 3, lobbySnapshot: [{ rating: 0, participantId: uid }, { rating: 0, participantId: null }] });
    await db.doc(`Races/${raceId}/Participants/${uid}`).set({ playerIndex: 0, preDeductedTrophies: 0, gamemode: "UNRANKED", challengeTopSpeedKph: 200 });
    await race(request({ raceId, finishOrder: [0, 1], botNames: [], raceStats: { maxSpeedKph: 999, driftMetres: 1000, nitroUses: 0 } }));
    await race(request({ raceId, finishOrder: [0, 1], botNames: [], raceStats: { maxSpeedKph: 999, driftMetres: 99999, nitroUses: 0 } }));
    const state = (await achievementsRef(uid).get()).data()!;
    expect(state.stats.races).toBe(1);
    expect(state.stats.maxSpeedKph).toBe(200);
    expect(state.stats.driftMetres).toBe(1000);
    expect(state.mapsWon).toEqual(["3"]);
  });
  it("never permits challenges in the production project", async () => {
    process.env.GCLOUD_PROJECT = "mystic-motors-prod";
    try {
      await expect(status(request())).rejects.toMatchObject({ code: "unavailable" });
      expect(await getChallengesDefinitions(false)).toBeNull();
    } finally { process.env.GCLOUD_PROJECT = "demo-test"; }
  });
});

async function faultRace(raceId: string) {
  await db.doc(`Races/${raceId}`).set({ status: "pending", createdAt: admin.firestore.Timestamp.fromMillis(Date.now() - 60_000), trackId: "track_01", lobbySnapshot: [{ rating: 0, participantId: uid }, { rating: 0, participantId: null }] });
  await db.doc(`Races/${raceId}/Participants/${uid}`).set({ playerIndex: 0, preDeductedTrophies: 0, gamemode: "UNRANKED" });
  return request({ raceId, finishOrder: [0, 1], botNames: [] });
}
async function expectBaseSettlementOnce(payload: ReturnType<typeof request>) {
  const first = await race(payload);
  expect(first.success).toBe(true);
  expect(first.rewards.baseCoins).toBeGreaterThan(0);
  expect(first.newlyCompletedAchievementIds).toBeUndefined();
  expect(first.newlyCompletedChallengeIds).toBeUndefined();
  const economyRef = db.doc(`Players/${uid}/Economy/Stats`);
  const after = (await economyRef.get()).data()!;
  expect(after.coins).toBe(1000 + first.rewards.baseCoins + first.rewards.boosterCoins);
  expect(await race(payload)).toEqual(first);
  expect((await economyRef.get()).data()).toEqual(after);
  return first;
}
describe("challenge race fault isolation", () => {
  it("settles normal rewards when the enabled catalog is malformed", async () => {
    const payload = await faultRace("bad-challenge-catalog");
    await db.doc("GameData/v1/catalogs/ChallengesCatalog").set({ entries: [] });
    await expectBaseSettlementOnce(payload);
    expect((await achievementsRef(uid).get()).exists).toBe(false);
  });
  it("settles normal rewards when the optional config loader throws", async () => {
    const payload = await faultRace("challenge-config-outage");
    jest.spyOn(challengeConfig, "getChallengesDefinitions").mockRejectedValue(new Error("Injected challenge config outage"));
    await expectBaseSettlementOnce(payload);
  });
  it("leaves corrupt challenge state untouched while settling normal rewards", async () => {
    const payload = await faultRace("corrupt-challenge-state");
    const corrupt = { carsRaced: null, mapsWon: null };
    await achievementsRef(uid).set(corrupt);
    await expectBaseSettlementOnce(payload);
    expect((await achievementsRef(uid).get()).data()).toEqual(corrupt);
  });
  it("rolls back queued challenge writes before retrying normal settlement", async () => {
    const payload = await faultRace("challenge-write-failure");
    const original = challengeRace.applyChallengeRace;
    jest.spyOn(challengeRace, "applyChallengeRace").mockImplementation((tx, plan) => {
      original(tx, plan);
      throw new Error("Injected error after queued challenge writes");
    });
    await expectBaseSettlementOnce(payload);
    expect((await dailyRef(uid).get()).exists).toBe(false);
    expect((await achievementsRef(uid).get()).exists).toBe(false);
  });
  it("does not bypass race validation when challenge config is unavailable", async () => {
    jest.spyOn(challengeConfig, "getChallengesDefinitions").mockRejectedValue(new Error("Injected challenge config outage"));
    await expect(race(request({ raceId: "missing", finishOrder: [0] }))).rejects.toMatchObject({ code: "failed-precondition" });
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()?.coins).toBe(1000);
  });
  it("resumes challenge progress on a later race after repairing the catalog", async () => {
    const catalogRef = db.doc("GameData/v1/catalogs/ChallengesCatalog");
    const catalog = (await catalogRef.get()).data()!;
    await catalogRef.set({ entries: [] });
    await expectBaseSettlementOnce(await faultRace("before-challenge-recovery"));
    await catalogRef.set(catalog);
    resetChallengesCache();
    const result = await race(await faultRace("after-challenge-recovery"));
    expect(result.success).toBe(true);
    expect(result.newlyCompletedAchievementIds).toContain("first_victory");
    expect((await achievementsRef(uid).get()).data()?.stats.races).toBe(1);
  });
});
