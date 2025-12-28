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
  isBot: boolean = false, // Deprecated: only used for backward compatibility, always use false for players
): ResolvedStats => {
  const levelData = carLevelData ?? {};
  const scale = tuningConfig?.valueScale ?? DEFAULT_SCALE;
  const scaleMin = Number.isFinite(scale.min) ? scale.min : DEFAULT_SCALE.min;
  const scaleMax = Number.isFinite(scale.max) ? scale.max : DEFAULT_SCALE.max;
  const denominator = scaleMax - scaleMin || 1;

  // Always use player ranges (bot stats are calculated via calculateBotStatsFromTrophies)
  const ranges = tuningConfig?.player;

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
