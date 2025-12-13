/**
 * Infinite Leveling EXP Curve
 * Implements the "Gold Standard" power curve:
 * C(L) = K * ((L - 1 + s)^p - s^p)
 * Reference Config: K=50.0, p=1.7, s=1.0
 */

// Configuration constants
const K = 50.0;
const P = 1.7;
const S = 1.0;

/**
 * Continuous cumulative XP to ARRIVE at 'level' (start of that level).
 * Internal helper, returns float.
 */
function _cContinuous(level: number): number {
  if (level <= 1.0) return 0.0;
  // K * ((level - 1 + s)^p - s^p)
  return K * (Math.pow(level - 1.0 + S, P) - Math.pow(S, P));
}

/**
 * Returns the integer cumulative XP required to reach the given level.
 * Level 1 is considered the starting point (0 XP).
 */
export function expRequiredForLevel(level: number): number {
  // Uses rounded continuous cumulative to avoid fractional XP.
  return Math.max(0, Math.round(_cContinuous(level)));
}

/**
 * Returns the XP required to go from level -> level + 1.
 * Calculated as difference of cumulatives to ensure mathematical stability.
 */
export function expToNext(level: number): number {
  const cur = expRequiredForLevel(level);
  const nxt = expRequiredForLevel(level + 1);
  return Math.max(1, nxt - cur);
}

export interface LevelInfo {
  level: number;
  expInLevel: number;
  expToNext: number;
}

/**
 * Given a cumulative XP total, returns the active level, progress within current level,
 * and XP required to advance.
 * Uses an analytic inverse formula for O(1) performance.
 */
export function getLevelInfo(cumulativeExp: number): LevelInfo {
  const xpTotal = Math.max(0, Math.floor(cumulativeExp));

  // 1. Analytic Inverse Guess
  // L* = 1 - s + ( s^p + xp_total/K )^(1/p)
  let level = 1;
  if (xpTotal > 0) {
    const rhs = Math.pow(S, P) + (xpTotal / K);
    const lStar = 1.0 - S + Math.pow(rhs, 1.0 / P);
    level = Math.max(1, Math.floor(lStar));
  }

  // 2. Local Adjustments (corrects for floating point rounding jitter)
  // Adjust downwards if we overshot
  while (level > 1 && expRequiredForLevel(level) > xpTotal) {
    level -= 1;
  }
  // Adjust upwards if we undershot
  while (expRequiredForLevel(level + 1) <= xpTotal) {
    level += 1;
  }

  // 3. Calculate Remainder
  const curCum = expRequiredForLevel(level);
  const nextCum = expRequiredForLevel(level + 1);
  const expInLevel = xpTotal - curCum;
  // The XP needed to finish this level is the gap to the next cumulative milestone
  const expToNextLevel = Math.max(0, nextCum - xpTotal);

  return {
    level,
    expInLevel,
    expToNext: expToNextLevel,
  };
}
