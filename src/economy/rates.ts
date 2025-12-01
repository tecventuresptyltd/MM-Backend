const BAND_SIZE = 500;
const MAX_BAND_INDEX = 14;
const CAP_BASE = 1000;
const CAP_GROWTH = 1.37;
const SCALE_MIN_TROPHIES = 0;
const SCALE_MAX_TROPHIES = 2000;
const SCALE_START = 20;
const SCALE_END = 10;

const EV_WEIGHTS = [0.12, 0.16, 0.18, 0.18, 0.16, 0.1, 0.06, 0.04];
const EV_MULTIPLIERS = [1.0, 0.75, 0.6, 0.55, 0.55, 0.55, 0.55, 0.55];

const sum = (values: number[]): number => values.reduce((acc, value) => acc + value, 0);

const expectedValue = (() => {
  const weightSum = sum(EV_WEIGHTS);
  if (weightSum === 0) {
    return 0.0;
  }
  return (
    EV_WEIGHTS.reduce(
      (acc, weight, index) => acc + weight * (EV_MULTIPLIERS[index] ?? EV_MULTIPLIERS[EV_MULTIPLIERS.length - 1]),
      0,
    ) / weightSum
  );
})();

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

export const calculateGemConversionRate = (trophiesInput: number): number => {
  const trophies = Number.isFinite(trophiesInput) ? Math.max(0, Math.floor(trophiesInput)) : 0;
  const bandIndex = clamp(Math.floor(trophies / BAND_SIZE), 0, MAX_BAND_INDEX);
  const cap = CAP_BASE * Math.pow(CAP_GROWTH, bandIndex);

  const clampedForScale = clamp(trophies, SCALE_MIN_TROPHIES, SCALE_MAX_TROPHIES);
  const scaleRange = SCALE_START - SCALE_END;
  const scale =
    SCALE_START -
    (scaleRange * (clampedForScale - SCALE_MIN_TROPHIES)) / (SCALE_MAX_TROPHIES - SCALE_MIN_TROPHIES);

  const rate = Math.round((cap * expectedValue * scale) / 100);
  return Math.max(1, rate);
};
