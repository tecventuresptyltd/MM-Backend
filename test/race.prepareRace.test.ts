import { admin } from "./setup";
import { wrapCallable } from "./helpers/callable";
import { prepareRace } from "../src/race/prepareRace";
import { wipeFirestore, wipeAuth, seedMinimalPlayer } from "./helpers/cleanup";

describe("race.prepareRace", () => {
  let uid: string;
  const authFor = (uid: string) => ({ auth: { uid, token: { firebase: { sign_in_provider: "anonymous" } } } });

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    uid = `test-uid-${Date.now()}`;
    await seedMinimalPlayer(uid);

    // Seed minimal CarTuningConfig
    await admin.firestore().doc("/GameData/v1/config/CarTuningConfig").set({
      valueScale: { min: 1, max: 16, step: 0.25 },
      player: {
        topSpeed: { min: 150, max: 350 },
        acceleration: { min: 5, max: 10 },
        handling: { min: 30, max: 45 },
        boostRegen: { min: 10, max: 4 },
        boostPower: { min: 10, max: 25 },
      },
      bot: {
        topSpeed: { min: 140, max: 340 },
        acceleration: { min: 4.5, max: 9.5 },
        handling: { min: 28, max: 44 },
        boostRegen: { min: 11, max: 5 },
        boostPower: { min: 8, max: 22 },
      },
      updatedAt: 0,
    });

    // Seed CarsCatalog with starter car and tuned demo
    await admin.firestore().doc("/GameData/v1/catalogs/CarsCatalog").set({
      cars: {
        car_h4ayzwf31g: {
          carId: "car_h4ayzwf31g",
          displayName: "Starter",
          class: "starter",
          basePrice: 0,
          unlock: { type: "starter" },
          levels: {
            "0": {
              priceCoins: 0,
              topSpeed: 8,
              acceleration: 8,
              handling: 8,
              boostRegen: 8,
              boostPower: 8,
            },
          },
          i18n: { en: "Starter" },
          version: "v1",
        },
        car_tuning_demo: {
          carId: "car_tuning_demo",
          displayName: "Tuning Demo",
          class: "street",
          basePrice: 10000,
          unlock: { type: "shop", minPlayerLevel: 1 },
          levels: {
            "0": {
              priceCoins: 0,
              topSpeed: 8.0,
              acceleration: 8.0,
              handling: 8.0,
              boostRegen: 8.0,
              boostPower: 8.0,
            }
          },
          i18n: { en: "Tuning Demo" },
          version: "v1",
        },
      },
      updatedAt: 0,
    });

    // Seed minimal ItemSkusCatalog for cosmetics
    await admin.firestore().doc("/GameData/v1/catalogs/ItemSkusCatalog").set({
      skus: {
        wheel_a: { skuId: "wheel_a", displayName: "Wheel A", i18n: { en: "Wheel A" }, stackable: false, item: { type: "wheels", id: "wheel_a" } },
        decal_a: { skuId: "decal_a", displayName: "Decal A", i18n: { en: "Decal A" }, stackable: false, item: { type: "decal", id: "decal_a" } },
      },
      updatedAt: 0,
    });

    // Seed minimal SpellsCatalog
    await admin.firestore().doc("/GameData/v1/catalogs/SpellsCatalog").set({
      spells: {
        spell_q4jj8d9kq4: { spellId: "spell_q4jj8d9kq4", displayName: "Shockwave", i18n: { en: "Shockwave" }, baseStats: { impactSec: 2.0, cooldown: 10 }, levels: {} },
      },
      updatedAt: 0,
    });

    // Seed minimal RanksCatalog (required by prepareRace)
    await admin.firestore().doc("/GameData/v1/catalogs/RanksCatalog").set({
      ranks: [
        { rankId: "rank_bronze_1", displayName: "Bronze I", minMmr: 0 },
        { rankId: "rank_bronze_2", displayName: "Bronze II", minMmr: 1000 },
      ],
      updatedAt: 0,
    });

    // Seed BotConfig
    await admin.firestore().doc("/GameData/v1/config/BotConfig").set({
      difficulty: {
        referenceTrophies: 7500,
        clampToBounds: true,
        maxSpeed: { min: 60, max: 120 },
        accel: { min: 5, max: 10 },
        boostTime: { min: 0.8, max: 3.0 },
        boostFreq: { min: 2, max: 10 },
        boostCd: { min: 6, max: 1.5 },
      },
      carUnlockThresholds: [
        { carId: "car_h4ayzwf31g", trophies: 0 },
        { carId: "car_tuning_demo", trophies: 1400 },
      ],
      cosmeticRarityWeights: {
        "0-999": { common: 85, rare: 14, epic: 1, legendary: 0 },
        "1000-1999": { common: 75, rare: 20, epic: 4, legendary: 1 },
        "6000-7000": { common: 35, rare: 35, epic: 20, legendary: 10 },
      },
      spellLevelBands: [
        { minTrophies: 0, maxTrophies: 999, minLevel: 1, maxLevel: 2 },
        { minTrophies: 1000, maxTrophies: 7000, minLevel: 2, maxLevel: 4 },
      ],
      updatedAt: 0,
    });
  });

  it("returns a deterministic payload for a fixed seed and includes player + bots", async () => {
    const wrapped = wrapCallable(prepareRace);
    const seed = "fixed-seed";
    const res1 = await wrapped({ data: { opId: "op_prepare", laps: 3, botCount: 3, seed }, ...authFor(uid) });
    const res2 = await wrapped({ data: { opId: "op_prepare_repeat", laps: 3, botCount: 3, seed }, ...authFor(uid) });

    expect(res1.player.uid).toEqual(uid);
    expect(Array.isArray(res1.bots)).toBe(true);
    expect(res1.bots.length).toBe(3);
    expect(Number.isInteger(res1.preDeductedTrophies)).toBe(true);
    expect(res1.preDeductedTrophies).toBe(res2.preDeductedTrophies);
    expect(res1.player.carStats.real.topSpeed).toBeGreaterThan(0);
    // Determinism check on bot carIds and trophies
    const sig1 = res1.bots.map((b: any) => `${b.carId}:${b.trophies}`).join(";");
    const sig2 = res2.bots.map((b: any) => `${b.carId}:${b.trophies}`).join(";");
    expect(sig1).toEqual(sig2);
  });

  it("rejects unauthenticated calls", async () => {
    const wrapped = wrapCallable(prepareRace);
    await expect(wrapped({ data: { opId: "x" }, auth: undefined as any })).rejects.toBeTruthy();
  });
});
