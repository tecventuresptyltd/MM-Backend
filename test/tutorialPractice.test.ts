import { admin } from "./setup";
import { wipeAuth, wipeFirestore, seedMinimalPlayer, ensureCatalogsSeeded } from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { completeTutorialPractice } from "../src/onboarding/tutorialPractice";
import { completeTutorialSpellUpgrade } from "../src/onboarding/tutorialSpellUpgrade";
import { startCarEvolutionV2 } from "../src/garageV2/evolutionV2";
import { startSpellResearchV2 } from "../src/spellsV2/researchV2";
import { getMasteryConfig, getMasteryProgress, getMasteryRank, getResearchCostForLevel, getSpellEvolutionV2Catalog } from "../src/core/configV2";

describe("completeTutorialPractice", () => {
  let uid: string;
  const carId = "car_h4ayzwf31g";
  const spellId = "spell_2382r2jk";
  const authFor = (uid: string) => ({ auth: { uid, token: { firebase: { sign_in_provider: "anonymous" } } } });

  const finishCarEvolutionAndPractice = async (userId: string, prefix: string) => {
    const startCar = wrapCallable(startCarEvolutionV2);
    await startCar({ data: { carId, opId: `${prefix}-car-start`, tutorial: true }, ...authFor(userId) });
    await admin.firestore().doc(`Players/${userId}/Garage/Cars`).update({
      [`cars.${carId}.starLevel`]: 2,
      [`cars.${carId}.carLevel`]: 2,
    });
    await admin.firestore().doc(`Players/${userId}/Queues/PitCrew`).set({ slots: [] }, { merge: true });
    const practice = wrapCallable(completeTutorialPractice);
    await practice({ data: { opId: `${prefix}-practice` }, ...authFor(userId) });
  };

  beforeAll(async () => { await ensureCatalogsSeeded(); });
  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    uid = `tutorial-practice-${Date.now()}`;
    await seedMinimalPlayer(uid);
    await admin.firestore().doc(`Players/${uid}/Spells/Levels`).set({
      spells: { [spellId]: { level: 1, xp: 0, isXpCapped: false } },
    }, { merge: true });
  });

  it("fills Ice Lock level-one XP and tops up research shards once, then starts paid research", async () => {
    const startCar = wrapCallable(startCarEvolutionV2);
    await startCar({ data: { carId, opId: "practice-car-start", tutorial: true }, ...authFor(uid) });
    await admin.firestore().doc(`Players/${uid}/Garage/Cars`).update({
      [`cars.${carId}.starLevel`]: 2,
      [`cars.${carId}.carLevel`]: 2,
    });
    await admin.firestore().doc(`Players/${uid}/Queues/PitCrew`).set({ slots: [] }, { merge: true });

    const catalog = await getSpellEvolutionV2Catalog();
    const cost = await getResearchCostForLevel(2);
    const masteryConfig = await getMasteryConfig();
    const xpCap = catalog.spellXpConfig.xpCapPerLevel["1"];
    const masteryBefore = (await admin.firestore().doc(`Players/${uid}/Profile/Profile`).get()).data()?.masteryXp ?? 0;
    const masteryXpGranted = Math.round(xpCap * masteryConfig.spellWeight);
    const masteryAfter = masteryBefore + masteryXpGranted;
    const practice = wrapCallable(completeTutorialPractice);
    const result = await practice({ data: { opId: "practice-reward" }, ...authFor(uid) });
    expect(result).toMatchObject({
      success: true,
      spellId,
      xpGranted: xpCap,
      spellShardsGranted: cost?.shards,
      masteryXpGranted,
      masteryXp: masteryAfter,
      masteryRank: getMasteryRank(masteryAfter, masteryConfig),
      spell: { level: 1, xp: xpCap, isXpCapped: true },
      balances: { spellShards: cost?.shards },
    });
    const profileAfter = (await admin.firestore().doc(`Players/${uid}/Profile/Profile`).get()).data();
    expect(profileAfter?.masteryXp).toBe(masteryAfter);
    expect(profileAfter?.masteryRank).toBe(getMasteryRank(masteryAfter, masteryConfig));
    expect(profileAfter?.level).toBe(getMasteryRank(masteryAfter, masteryConfig));
    expect(profileAfter?.expProgress).toBe(getMasteryProgress(masteryAfter, masteryConfig).expProgress);
    expect(await practice({ data: { opId: "practice-reward" }, ...authFor(uid) })).toEqual(result);
    expect((await admin.firestore().doc(`Players/${uid}/Profile/Profile`).get()).data()?.masteryXp).toBe(masteryAfter);
    await expect(practice({ data: { opId: "practice-reward-again" }, ...authFor(uid) })).rejects.toHaveProperty("code", "already-exists");

    const research = wrapCallable(startSpellResearchV2);
    const researchResult = await research({ data: { spellId, opId: "paid-ice-research" }, ...authFor(uid) });
    expect(researchResult).toMatchObject({ success: true, spellId, targetLevel: 2, shardsSpent: cost?.shards });
    const economy = (await admin.firestore().doc(`Players/${uid}/Economy/Stats`).get()).data();
    expect(economy?.spellShards).toBe(0);
    const library = (await admin.firestore().doc(`Players/${uid}/Queues/Library`).get()).data();
    expect(library?.slots?.[0]?.spellId).toBe(spellId);
    expect(library?.slots?.[0]?.targetLevel).toBe(2);
  });

  it("preserves higher Ice Lock levels and rejects unauthenticated or completed accounts", async () => {
    const startCar = wrapCallable(startCarEvolutionV2);
    await startCar({ data: { carId, opId: "higher-car-start", tutorial: true }, ...authFor(uid) });
    await admin.firestore().doc(`Players/${uid}/Garage/Cars`).update({ [`cars.${carId}.starLevel`]: 2 });
    await admin.firestore().doc(`Players/${uid}/Progress/Initial`).set({ tutorialComplete: true }, { merge: true });
    const practice = wrapCallable(completeTutorialPractice);
    await expect(practice({ data: { opId: "completed-practice" }, ...authFor(uid) })).rejects.toHaveProperty("code", "failed-precondition");
    await expect(practice({ data: { opId: "unauthenticated-practice" } })).rejects.toHaveProperty("code", "unauthenticated");

    await admin.firestore().doc(`Players/${uid}/Progress/Initial`).set({ tutorialComplete: false }, { merge: true });
    await admin.firestore().doc(`Players/${uid}/Spells/Levels`).set({
      spells: { [spellId]: { level: 4, xp: 217, isXpCapped: true } },
    }, { merge: true });
    const result = await practice({ data: { opId: "higher-practice" }, ...authFor(uid) });
    expect(result.spell).toEqual({ level: 4, xp: 217, isXpCapped: true });
    const persistedSpell = (await admin.firestore().doc(`Players/${uid}/Spells/Levels`).get()).data()?.spells?.[spellId];
    expect(persistedSpell).toEqual({ level: 4, xp: 217, isXpCapped: true });
  });

  it("preserves a pinned mastery rank while adding practice XP once", async () => {
    const startCar = wrapCallable(startCarEvolutionV2);
    await startCar({ data: { carId, opId: "pinned-car-start", tutorial: true }, ...authFor(uid) });
    await admin.firestore().doc(`Players/${uid}/Garage/Cars`).update({ [`cars.${carId}.starLevel`]: 2 });
    const pinnedRank = 7;
    await admin.firestore().doc(`Players/${uid}/Profile/Profile`).set({ pinnedMasteryRank: pinnedRank, masteryRank: pinnedRank, level: pinnedRank }, { merge: true });

    const catalog = await getSpellEvolutionV2Catalog();
    const masteryConfig = await getMasteryConfig();
    const xpCap = catalog.spellXpConfig.xpCapPerLevel["1"];
    const expectedMasteryXp = Math.round(xpCap * masteryConfig.spellWeight);
    const practice = wrapCallable(completeTutorialPractice);
    const result = await practice({ data: { opId: "pinned-practice" }, ...authFor(uid) });
    expect(result).toMatchObject({ masteryXp: expectedMasteryXp, masteryRank: pinnedRank, masteryXpGranted: expectedMasteryXp });
    const profile = (await admin.firestore().doc(`Players/${uid}/Profile/Profile`).get()).data();
    expect(profile).toMatchObject({
      masteryXp: expectedMasteryXp,
      masteryRank: pinnedRank,
      level: pinnedRank,
      expProgress: 0,
      expToNextLevel: 0,
      expProgressDisplay: "Max Rank",
    });
    await practice({ data: { opId: "pinned-practice" }, ...authFor(uid) });
    expect((await admin.firestore().doc(`Players/${uid}/Profile/Profile`).get()).data()?.masteryXp).toBe(expectedMasteryXp);
  });

  it("charges the live shard cost and instantly completes level two without a queue", async () => {
    await finishCarEvolutionAndPractice(uid, "instant-spell");
    const cost = await getResearchCostForLevel(2);
    const upgrade = wrapCallable(completeTutorialSpellUpgrade);
    const result = await upgrade({ data: { opId: "tutorial-spell-complete" }, ...authFor(uid) });
    expect(result).toMatchObject({
      success: true,
      spellId,
      spell: { level: 2, xp: 0, isXpCapped: false },
      shardsSpent: cost?.shards,
      completedExistingResearch: false,
      balances: { spellShards: 0 },
    });
    expect((await admin.firestore().doc(`Players/${uid}/Spells/Levels`).get()).data()?.spells?.[spellId]).toEqual({
      level: 2,
      xp: 0,
      isXpCapped: false,
    });
    expect((await admin.firestore().doc(`Players/${uid}/Queues/Library`).get()).data()?.slots ?? []).toHaveLength(0);

    await admin.firestore().doc(`Players/${uid}/Progress/Initial`).set({ tutorialComplete: true }, { merge: true });
    expect(await upgrade({ data: { opId: "tutorial-spell-complete" }, ...authFor(uid) })).toMatchObject(result);
    await expect(upgrade({ data: { opId: "tutorial-spell-complete-new" }, ...authFor(uid) })).rejects.toHaveProperty("code", "failed-precondition");
  });

  it("completes an existing paid tutorial research queue without charging twice", async () => {
    await finishCarEvolutionAndPractice(uid, "queued-spell");
    const cost = await getResearchCostForLevel(2);
    const research = wrapCallable(startSpellResearchV2);
    await research({ data: { spellId, opId: "tutorial-spell-start" }, ...authFor(uid) });
    expect((await admin.firestore().doc(`Players/${uid}/Economy/Stats`).get()).data()?.spellShards).toBe(0);

    const upgrade = wrapCallable(completeTutorialSpellUpgrade);
    const result = await upgrade({ data: { opId: "tutorial-spell-complete-queued" }, ...authFor(uid) });
    expect(result).toMatchObject({
      success: true,
      spellId,
      spell: { level: 2, xp: 0, isXpCapped: false },
      shardsSpent: 0,
      completedExistingResearch: true,
      balances: { spellShards: 0 },
    });
    expect((await admin.firestore().doc(`Players/${uid}/Spells/Levels`).get()).data()?.spells?.[spellId]?.level).toBe(2);
    expect((await admin.firestore().doc(`Players/${uid}/Queues/Library`).get()).data()?.slots ?? []).toHaveLength(0);
    expect((await admin.firestore().doc(`Players/${uid}/Economy/Stats`).get()).data()?.spellShards).toBe(0);
    expect(cost?.shards).toBeGreaterThan(0);
  });

  it("preserves a higher spell level and same-opId retries return the latest state", async () => {
    await finishCarEvolutionAndPractice(uid, "higher-spell");
    await admin.firestore().doc(`Players/${uid}/Spells/Levels`).set({
      spells: { [spellId]: { level: 4, xp: 217, isXpCapped: true } },
    }, { merge: true });
    const higherResearchSlot = { spellId, targetLevel: 5, shardsPaid: 45 };
    await admin.firestore().doc(`Players/${uid}/Queues/Library`).set({ slots: [higherResearchSlot] }, { merge: true });
    const upgrade = wrapCallable(completeTutorialSpellUpgrade);
    const result = await upgrade({ data: { opId: "tutorial-spell-preserve" }, ...authFor(uid) });
    expect(result.spell).toEqual({ level: 4, xp: 217, isXpCapped: true });
    expect((await admin.firestore().doc(`Players/${uid}/Queues/Library`).get()).data()?.slots).toEqual([higherResearchSlot]);

    await admin.firestore().doc(`Players/${uid}/Progress/Initial`).set({ tutorialComplete: true }, { merge: true });
    await admin.firestore().doc(`Players/${uid}/Spells/Levels`).update({ [`spells.${spellId}.xp`]: 321 });
    const retried = await upgrade({ data: { opId: "tutorial-spell-preserve" }, ...authFor(uid) });
    expect(retried.spell).toEqual({ level: 4, xp: 321, isXpCapped: true });
    expect(retried.balances).toEqual(result.balances);
  });
});
