import { admin } from "./setup";
import { ensureCatalogsSeeded, wipeFirestore } from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { startCarEvolutionV2 } from "../src/garageV2/evolutionV2";
import { getEvolutionCostForCar } from "../src/core/configV2";
import { loadGameDataDocuments } from "../seeds/runner/loadGameData";
import { CarsCatalog } from "../src/shared/typesV2";

jest.mock("../src/upgrades/upgradeScheduler", () => ({
  scheduleUpgradeCompletion: jest.fn().mockResolvedValue(undefined),
  cancelUpgradeCompletion: jest.fn().mockResolvedValue(undefined),
}));

describe("car evolution catalog costs", () => {
  const carId = "car_1wp1gr2p";
  const uid = "evolution-cost-regression";
  const auth = { uid, token: { firebase: { sign_in_provider: "anonymous" } } };
  const db = admin.firestore();
  const economyRef = db.doc(`Players/${uid}/Economy/Stats`);
  const garageRef = db.doc(`Players/${uid}/Garage/Cars`);
  const queueRef = db.doc(`Players/${uid}/Queues/PitCrew`);

  beforeEach(async () => {
    await wipeFirestore();
    await ensureCatalogsSeeded();
    await economyRef.set({ coins: 20000 });
  });

  it.each([
    [1, 1100, 0],
    [9, 10500, 7200],
  ])("charges level %i's cost and schedules its duration", async (level, coins, seconds) => {
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
  it("uses each current row across all 15 cars and 135 upgrade transitions", async () => {
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
        expect({ carId: id, level, cost }).toEqual({
          carId: id,
          level,
          cost: { targetStarLevel: level + 1, coins: row.priceCoins, durationSeconds: row.upgradeTimerSeconds },
        });
        transitions++;
      }
    }
    expect(transitions).toBe(135);
    expect(maxLevels).toBe(15);
  });

  it.each([
    [1, 1100, 0],
    [9, 10500, 7200],
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
  });

});
