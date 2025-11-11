import { admin } from "./setup";

const EPS = 1e-6;

function approx(a: number, b: number, eps = EPS) {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);
}

function toReal(value: number, min: number, max: number) {
  const t = (value - 1) / (16 - 1);
  const real = min + t * (max - min);
  if (min <= max) {
    return Math.max(min, Math.min(max, real));
  }
  return Math.min(min, Math.max(max, real));
}

describe("GameData Car Tuning Config and CarsCatalog mapping", () => {
  beforeEach(async () => {
    // Wipe relevant docs before each test
    await admin.firestore().recursiveDelete(admin.firestore().doc("GameData/v1"));
  });

  it("creates CarTuningConfig and validates value->real mapping in CarsCatalog", async () => {
    // Seed CarTuningConfig
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

    // Minimal CarsCatalog example with two levels
    await admin.firestore().doc("/GameData/v1/catalogs/CarsCatalog").set({
      cars: {
        car_tuning_demo: {
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
            },
            "1": {
              priceCoins: 100,
              topSpeed: 8.25,
              acceleration: 8.25,
              handling: 8.25,
              boostRegen: 8.25,
              boostPower: 8.25,
            },
          },
          i18n: { en: "Tuning Demo" },
          version: "v2025.10.25",
        },
      },
      updatedAt: 0,
    });

    // Read back the docs
    const tuningDoc = await admin.firestore().doc("/GameData/v1/config/CarTuningConfig").get();
    expect(tuningDoc.exists).toBe(true);
    const tuning = tuningDoc.data()!;

    const carsDoc = await admin.firestore().doc("/GameData/v1/catalogs/CarsCatalog").get();
    expect(carsDoc.exists).toBe(true);
    const cars = carsDoc.data()!.cars;
    const levels = cars.car_tuning_demo.levels;

    const expectedReal = {
      "0": {
        topSpeed: 243.3333333333,
        acceleration: 7.3333333333,
        handling: 37.0,
        boostRegen: 7.2,
        boostPower: 17.0,
      },
      "1": {
        topSpeed: 246.6666666667,
        acceleration: 7.4166666667,
        handling: 37.25,
        boostRegen: 7.1,
        boostPower: 17.25,
      },
    } as const;

    for (const lvl of ["0", "1"] as const) {
      const L = levels[lvl];
      // Values in [1,16]
      const values = [
        L.topSpeed,
        L.acceleration,
        L.handling,
        L.boostRegen,
        L.boostPower,
      ];
      values.forEach((v) => {
        expect(typeof v).toBe("number");
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(16);
      });

      // Recompute real via linear mapping and compare with expected constants
      approx(
        toReal(L.topSpeed, tuning.player.topSpeed.min, tuning.player.topSpeed.max),
        expectedReal[lvl].topSpeed
      );
      approx(
        toReal(L.acceleration, tuning.player.acceleration.min, tuning.player.acceleration.max),
        expectedReal[lvl].acceleration
      );
      approx(
        toReal(L.handling, tuning.player.handling.min, tuning.player.handling.max),
        expectedReal[lvl].handling
      );
      approx(
        toReal(L.boostRegen, tuning.player.boostRegen.min, tuning.player.boostRegen.max),
        expectedReal[lvl].boostRegen
      );
      approx(
        toReal(L.boostPower, tuning.player.boostPower.min, tuning.player.boostPower.max),
        expectedReal[lvl].boostPower
      );

      // Ensure no legacy multiplier fields remain
      const keys = Object.keys(L);
      const legacyMult = keys.filter((k) => k.endsWith("Multiplier"));
      const legacyValueKeys = keys.filter((k) => k.includes("_value") || k.includes("_real"));
      expect(legacyMult.length).toBe(0);
      expect(legacyValueKeys.length).toBe(0);
    }
  });
});
