import { admin } from "./setup";
import { ensureCatalogsSeeded, wipeFirestore } from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { startCarEvolutionV2, claimCarEvolutionV2, skipCarEvolutionV2, getPitCrewStatusV2, grantCarXP } from "../src/garageV2/evolutionV2";
import { getEvolutionCostForCar, __resetV2ConfigCacheForTests } from "../src/core/configV2";
import { loadGameDataDocuments } from "../seeds/runner/loadGameData";
import { CarsCatalog } from "../src/shared/typesV2";

jest.mock("../src/upgrades/upgradeScheduler", () => ({
  scheduleUpgradeCompletion: jest.fn().mockResolvedValue(undefined),
  cancelUpgradeCompletion: jest.fn().mockResolvedValue(undefined),
}));

describe("car evolution catalog costs", () => {
  const carId = "car_h4ayzwf31g";
  const uid = "evolution-cost-regression";
  const auth = { uid, token: { firebase: { sign_in_provider: "anonymous" } } };
  const db = admin.firestore();
  const economyRef = db.doc(`Players/${uid}/Economy/Stats`);
  const garageRef = db.doc(`Players/${uid}/Garage/Cars`);
  const queueRef = db.doc(`Players/${uid}/Queues/PitCrew`);

  beforeEach(async () => {
    __resetV2ConfigCacheForTests();
    await wipeFirestore();
    await ensureCatalogsSeeded();
    await economyRef.set({ coins: 20000 });
  });

  it.each([
    [1, 1600, 60],
    [9, 10500, 10800],
  ])("charges the destination cost and schedules its duration from level %i", async (level, coins, seconds) => {
    await garageRef.set({ cars: { [carId]: { starLevel: level, carLevel: level, xp: 500, isXpCapped: true } } });
    const start = wrapCallable(startCarEvolutionV2);
    const result = await start({ data: { carId, opId: `level-${level}` }, auth });
    expect(result).toMatchObject({ success: true, targetCarLevel: level + 1, coinsSpent: coins });
    expect((await economyRef.get()).data()?.coins).toBe(20000 - coins);
    const slot = (await queueRef.get()).data()?.slots[0];
    expect(slot.targetCarLevel).toBe(level + 1);
    expect(slot.completesAt.toMillis() - slot.startedAt.toMillis()).toBe(seconds * 1000);
    expect((await garageRef.get()).data()?.cars[carId].carLevel).toBe(level);
  });

  it("rejects evolution past the maximum level without spending coins", async () => {
    await garageRef.set({ cars: { [carId]: { starLevel: 10, carLevel: 10, xp: 0, isXpCapped: true } } });
    await expect(getEvolutionCostForCar(carId, 10)).resolves.toBeNull();
    await expect(wrapCallable(startCarEvolutionV2)({ data: { carId, opId: "max-level" }, auth }))
      .rejects.toHaveProperty("code", "failed-precondition");
    expect((await economyRef.get()).data()?.coins).toBe(20000);
    expect((await queueRef.get()).exists).toBe(false);
  });
  it("uses each destination row across all 15 cars and 135 upgrade transitions", async () => {
    const catalog = loadGameDataDocuments().find(entry => entry.path === "/GameData/v1/catalogs/CarsCatalog")!.data as unknown as CarsCatalog;
    expect(Object.keys(catalog.cars)).toHaveLength(15);
    let transitions = 0;
    let maxLevels = 0;
    for (const [id, car] of Object.entries(catalog.cars)) {
      for (const [key, row] of Object.entries(car.levels)) {
        const level = Number(key);
        const cost = await getEvolutionCostForCar(id, level);
        if (row.xpToNext === 0) {
          expect({ carId: id, cost }).toEqual({ carId: id, cost: null });
          maxLevels++;
          continue;
        }
        const target = car.levels[String(level + 1)];
        expect(target.priceCoins).toBeGreaterThan(0);
        expect(target.upgradeTimerSeconds).toBeGreaterThan(0);
        expect({ carId: id, level, cost }).toEqual({
          carId: id,
          level,
          cost: { targetStarLevel: level + 1, coins: target.priceCoins, durationSeconds: target.upgradeTimerSeconds },
        });
        transitions++;
      }
    }
    expect(transitions).toBe(135);
    expect(maxLevels).toBe(15);
  });

  it.each([
    [1, 1600, 60],
    [9, 10500, 10800],
  ])("charges only once for duplicate starts at level %i", async (level, coins, seconds) => {
    await garageRef.set({ cars: { [carId]: { starLevel: level, carLevel: level, xp: 500, isXpCapped: true } } });
    const start = wrapCallable(startCarEvolutionV2);
    const results = await Promise.allSettled([
      start({ data: { carId, opId: "duplicate-a" }, auth }),
      start({ data: { carId, opId: "duplicate-b" }, auth }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason).toHaveProperty("code", "already-exists");
    expect((await economyRef.get()).data()?.coins).toBe(20000 - coins);
    const slots = (await queueRef.get()).data()?.slots;
    expect(slots).toHaveLength(1);
    expect(slots[0].targetCarLevel).toBe(level + 1);
    expect(slots[0].completesAt.toMillis() - slots[0].startedAt.toMillis()).toBe(seconds * 1000);
  }, 30000);

  it("progresses Chevaro ZLE from level 1 to 10 with current-level XP and destination costs", async () => {
    const start = wrapCallable(startCarEvolutionV2);
    const claim = wrapCallable(claimCarEvolutionV2);
    const skip = wrapCallable(skipCarEvolutionV2);
    const status = wrapCallable(getPitCrewStatusV2);
    const xpCaps = [150, 150, 200, 250, 250, 350, 400, 450, 500];
    const prices = [1600, 2100, 3200, 4300, 5400, 6400, 8600, 10500, 10500];
    const timers = [60, 900, 1200, 1800, 2700, 3600, 5400, 7200, 10800];
    let coinsRemaining = 100000;
    await economyRef.set({ coins: coinsRemaining, gems: 100 });
    await garageRef.set({ cars: { [carId]: { starLevel: 1, carLevel: 1, xp: 0, isXpCapped: false } } });
    const grantXp = (amount: number) => db.runTransaction(transaction =>
      grantCarXP(transaction, uid, carId, amount, admin.firestore.FieldValue.serverTimestamp()));

    for (let level = 1; level < 10; level++) {
      const index = level - 1;
      await expect(grantXp(xpCaps[index] - 1)).resolves.toMatchObject({
        newXp: xpCaps[index] - 1, isNowCapped: false, carLevel: level,
      });
      await expect(start({ data: { carId, opId: `xp-gate-${level}` }, auth }))
        .rejects.toHaveProperty("code", "failed-precondition");
      expect((await economyRef.get()).data()?.coins).toBe(coinsRemaining);
      await expect(grantXp(100)).resolves.toMatchObject({ newXp: xpCaps[index], isNowCapped: true });
      await expect(start({ data: { carId, opId: `journey-start-${level}` }, auth }))
        .resolves.toMatchObject({ success: true, targetCarLevel: level + 1, coinsSpent: prices[index] });
      coinsRemaining -= prices[index];
      expect((await economyRef.get()).data()?.coins).toBe(coinsRemaining);
      const slot = (await queueRef.get()).data()?.slots[0];
      expect(slot.completesAt.toMillis() - slot.startedAt.toMillis()).toBe(timers[index] * 1000);
      expect((await garageRef.get()).data()?.cars[carId].carLevel).toBe(level);
      const queueStatus = await status({ data: {}, auth });
      expect(queueStatus.slots[0].skipCostGems === 0).toBe(level === 1);
      await expect(claim({ data: { carId, opId: `early-claim-${level}` }, auth }))
        .rejects.toHaveProperty("code", "failed-precondition");

      if (level === 1) {
        await expect(skip({ data: { carId, opId: "first-free-skip" }, auth }))
          .resolves.toMatchObject({ success: true, newCarLevel: 2, gemsSpent: 0 });
        expect((await economyRef.get()).data()?.gems).toBe(100);
      } else {
        await queueRef.update({ slots: [{ ...slot, completesAt: admin.firestore.Timestamp.fromMillis(Date.now() - 1000) }] });
        await expect(claim({ data: { carId, opId: `journey-claim-${level}` }, auth }))
          .resolves.toMatchObject({ success: true, newCarLevel: level + 1 });
      }
      expect((await garageRef.get()).data()?.cars[carId]).toMatchObject({
        starLevel: level + 1, carLevel: level + 1, xp: 0, isXpCapped: false,
      });
      expect((await queueRef.get()).data()?.slots).toHaveLength(0);
    }
    await expect(grantXp(1000)).resolves.toMatchObject({ newXp: 0, isNowCapped: true, carLevel: 10 });
    await expect(start({ data: { carId, opId: "journey-max-level" }, auth }))
      .rejects.toHaveProperty("code", "failed-precondition");
    expect((await economyRef.get()).data()?.coins).toBe(coinsRemaining);
    expect((await queueRef.get()).data()?.slots).toHaveLength(0);
  }, 30000);
});
