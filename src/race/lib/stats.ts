import { CarLevel, CarTuningConfig, StatRange } from "../../shared/types.js";

type StatKey = "topSpeed" | "acceleration" | "handling" | "boostRegen" | "boostPower";

const STAT_KEYS: StatKey[] = ["topSpeed", "acceleration", "handling", "boostRegen", "boostPower"];

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return min;
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

const coerceNumber = (value: unknown, fallback = 0): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const resolveRange = (range?: StatRange): StatRange => {
  if (!range) {
    return { min: 0, max: 1 };
  }
  const min = Number.isFinite(range.min) ? range.min : 0;
  const max = Number.isFinite(range.max) ? range.max : min;
  if (max === min) {
    return { min, max: min };
  }
  return { min, max };
};

const DEFAULT_SCALE = { min: 1, max: 16 };

interface ResolvedStats {
  display: Record<StatKey, number>;
  real: Record<StatKey, number>;
}

/**
 * Picks the catalog level block for a car at a given upgrade level, falling back to
 * the level below, then level 0, then whatever exists.
 *
 * Shared by prepareRace and getCarStats so the open-world lobby resolves a car to the
 * exact same level block a race would. Do not inline a copy of this — if the two drift,
 * cars handle differently in the lobby than in races.
 */
export const resolveCarLevel = (
  car: { levels?: Record<string, CarLevel> } | null | undefined,
  targetLevel: number,
): Partial<CarLevel> | null => {
  if (!car || typeof car !== "object") {
    return null;
  }
  const levels = (car as { levels?: Record<string, CarLevel> }).levels;
  if (!levels || typeof levels !== "object") {
    return null;
  }
  const normalizedLevel = Math.max(0, Math.floor(Number.isFinite(targetLevel) ? targetLevel : 0));
  const direct = levels[String(normalizedLevel)];
  if (direct) {
    return direct;
  }
  if (normalizedLevel > 0) {
    const fallback = levels[String(normalizedLevel - 1)];
    if (fallback) {
      return fallback;
    }
  }
  const firstAvailable = levels["0"] ?? Object.values(levels)[0];
  return firstAvailable ?? null;
};

/**
 * Calculate bot stats for new AI difficulty system.
 * Returns empty stat objects - Unity only uses aiLevel and performanceRanges (added by prepareRace).
 */
export const calculateBotStatsFromTrophies = (
  trophies: number,
  statRanges: {
    aiSpeed: { min: number; max: number };
    aiBoostPower: { min: number; max: number };
    aiAcceleration: { min: number; max: number };
    endGameDifficulty: number;
  },
  carLevelData: Partial<CarLevel> | null | undefined,
): ResolvedStats => {
  // Get display values from car catalog (for UI display only)
  const levelData = carLevelData ?? {};
  const display: Record<StatKey, number> = {
    topSpeed: coerceNumber(levelData.topSpeed ?? levelData.topSpeed_value, 8),
    acceleration: coerceNumber(levelData.acceleration ?? levelData.acceleration_value, 8),
    handling: coerceNumber(levelData.handling ?? levelData.handling_value, 8),
    boostRegen: coerceNumber(levelData.boostRegen ?? levelData.boostRegen_value, 8),
    boostPower: coerceNumber(levelData.boostPower ?? levelData.boostPower_value, 8),
  };

  // Return empty real stats - prepareRace adds aiLevel and performanceRanges
  const real: Record<StatKey, number> = {
    topSpeed: 0,
    acceleration: 0,
    handling: 0,
    boostRegen: 0,
    boostPower: 0,
  };

  return { display, real };
};

export const resolveCarStats = (
  carLevelData: Partial<CarLevel> | null | undefined,
  tuningConfig: CarTuningConfig,
  isBot: boolean = false,
): ResolvedStats => {
  const levelData = carLevelData ?? {};
  const scale = tuningConfig?.valueScale ?? DEFAULT_SCALE;
  const scaleMin = Number.isFinite(scale.min) ? scale.min : DEFAULT_SCALE.min;
  const scaleMax = Number.isFinite(scale.max) ? scale.max : DEFAULT_SCALE.max;
  const denominator = scaleMax - scaleMin || 1;

  // Bots convert through their own (slightly narrower) band so an upgraded player car
  // keeps a measured edge. Falls back to the player band if no bot band is configured.
  const ranges = isBot ? (tuningConfig?.bot ?? tuningConfig?.player) : tuningConfig?.player;

  const display: Record<StatKey, number> = {
    topSpeed: coerceNumber(levelData.topSpeed ?? levelData.topSpeed_value, scaleMin),
    acceleration: coerceNumber(levelData.acceleration ?? levelData.acceleration_value, scaleMin),
    handling: coerceNumber(levelData.handling ?? levelData.handling_value, scaleMin),
    boostRegen: coerceNumber(levelData.boostRegen ?? levelData.boostRegen_value, scaleMin),
    boostPower: coerceNumber(levelData.boostPower ?? levelData.boostPower_value, scaleMin),
  };

  const real: Record<StatKey, number> = {
    topSpeed: 0,
    acceleration: 0,
    handling: 0,
    boostRegen: 0,
    boostPower: 0,
  };

  STAT_KEYS.forEach((key) => {
    const targetRange = resolveRange(ranges?.[key]);
    const pct = clamp((display[key] - scaleMin) / denominator, 0, 1);
    real[key] = targetRange.min + pct * (targetRange.max - targetRange.min);
  });

  return { display, real };
};
