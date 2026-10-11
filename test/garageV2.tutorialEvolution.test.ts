import { admin } from "./setup";
import { wipeAuth, wipeFirestore, seedMinimalPlayer, ensureCatalogsSeeded } from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { startCarEvolutionV2, skipCarEvolutionV2 } from "../src/garageV2/evolutionV2";
import { getEvolutionCostForCar } from "../src/core/configV2";

describe("tutorial car evolution", () => {
  let uid: string;
  const carId = "car_h4ayzwf31g";
  const authFor = (uid: string) => ({ auth: { uid, token: { firebase: { sign_in_provider: "anonymous" } } } });

  beforeAll(async () => { await ensureCatalogsSeeded(); });
  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    uid = `tutorial-evolution-${Date.now()}`;
    await seedMinimalPlayer(uid);
  });

  it("charges the catalog price once and completes the same evolution with a free tutorial skip", async () => {
    const start = wrapCallable(startCarEvolutionV2);
    const skip = wrapCallable(skipCarEvolutionV2);
    const economyRef = admin.firestore().doc(`Players/${uid}/Economy/Stats`);
    const initialCoins = Number((await economyRef.get()).data()?.coins ?? 0);
    const expectedCost = await getEvolutionCostForCar(carId, 1);
    const started = await start({ data: { carId, opId: "tutorial-car-start", tutorial: true }, ...authFor(uid) });
    expect(started.success).toBe(true);
    expect(started.targetCarLevel).toBe(2);
    expect(started.coinsSpent).toBe(expectedCost?.coins);
    expect(Number((await economyRef.get()).data()?.coins)).toBe(initialCoins - Number(expectedCost?.coins));

    const repeatedStart = await start({ data: { carId, opId: "tutorial-car-start", tutorial: true }, ...authFor(uid) });
    expect(repeatedStart).toEqual(started);
    await expect(start({ data: { carId, opId: "tutorial-car-start-again", tutorial: true }, ...authFor(uid) })).rejects.toHaveProperty("code", "already-exists");
    const afterRepeatedStart = Number((await economyRef.get()).data()?.coins);
    expect(afterRepeatedStart).toBe(initialCoins - Number(expectedCost?.coins));

    const initialGems = Number((await economyRef.get()).data()?.gems ?? 0);
    const skipped = await skip({ data: { carId, opId: "tutorial-car-skip", tutorial: true }, ...authFor(uid) });
    expect(skipped).toMatchObject({ success: true, gemsSpent: 0, newCarLevel: 2 });
    const repeatedSkip = await skip({ data: { carId, opId: "tutorial-car-skip", tutorial: true }, ...authFor(uid) });
    expect(repeatedSkip).toEqual(skipped);
    const economy = (await economyRef.get()).data();
    expect(economy?.coins).toBe(afterRepeatedStart);
    expect(economy?.gems).toBe(initialGems);
    const garage = (await admin.firestore().doc(`Players/${uid}/Garage/Cars`).get()).data();
    expect(garage?.cars?.[carId]?.starLevel).toBe(2);
    expect((await admin.firestore().doc(`Players/${uid}/Queues/PitCrew`).get()).data()?.slots).toHaveLength(0);
  });

  it("allows only one concurrent tutorial evolution start", async () => {
    const start = wrapCallable(startCarEvolutionV2);
    const economyRef = admin.firestore().doc(`Players/${uid}/Economy/Stats`);
    const initialCoins = Number((await economyRef.get()).data()?.coins ?? 0);
    const results = await Promise.allSettled([
      start({ data: { carId, opId: "concurrent-tutorial-a", tutorial: true }, ...authFor(uid) }),
      start({ data: { carId, opId: "concurrent-tutorial-b", tutorial: true }, ...authFor(uid) }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const expectedCost = await getEvolutionCostForCar(carId, 1);
    expect(Number((await economyRef.get()).data()?.coins)).toBe(initialCoins - Number(expectedCost?.coins));
    const queue = (await admin.firestore().doc(`Players/${uid}/Queues/PitCrew`).get()).data();
    expect(queue?.slots).toHaveLength(1);
    expect(queue?.slots?.[0]?.tutorial).toBe(true);
  });

  it("accepts the tutorial skip after the timer auto-completed and removed its queue entry", async () => {
    const start = wrapCallable(startCarEvolutionV2);
    const skip = wrapCallable(skipCarEvolutionV2);
    await start({ data: { carId, opId: "auto-tutorial-start", tutorial: true }, ...authFor(uid) });
    await admin.firestore().doc(`Players/${uid}/Garage/Cars`).update({
      [`cars.${carId}.starLevel`]: 2,
      [`cars.${carId}.carLevel`]: 2,
    });
    await admin.firestore().doc(`Players/${uid}/Queues/PitCrew`).set({ slots: [] }, { merge: true });
    const result = await skip({ data: { carId, opId: "auto-tutorial-skip", tutorial: true }, ...authFor(uid) });
    expect(result).toMatchObject({ success: true, gemsSpent: 0, newCarLevel: 2 });
  });

  it("rejects tutorial bypasses for other cars, completed tutorials, and non-tutorial queue entries", async () => {
    const start = wrapCallable(startCarEvolutionV2);
    const skip = wrapCallable(skipCarEvolutionV2);
    await expect(start({ data: { carId: "car_1wp1gr2p", opId: "wrong-car", tutorial: true }, ...authFor(uid) })).rejects.toHaveProperty("code", "failed-precondition");
    await admin.firestore().doc(`Players/${uid}/Progress/Initial`).set({ tutorialComplete: true }, { merge: true });
    await expect(start({ data: { carId, opId: "completed-account", tutorial: true }, ...authFor(uid) })).rejects.toHaveProperty("code", "failed-precondition");

    await admin.firestore().doc(`Players/${uid}/Progress/Initial`).set({ tutorialComplete: false }, { merge: true });
    await admin.firestore().doc(`Players/${uid}/Garage/Cars`).update({ [`cars.${carId}.isXpCapped`]: true });
    await start({ data: { carId, opId: "normal-evolution" }, ...authFor(uid) });
    await expect(skip({ data: { carId, opId: "wrong-free-skip", tutorial: true }, ...authFor(uid) })).rejects.toHaveProperty("code", "failed-precondition");
  });
});
