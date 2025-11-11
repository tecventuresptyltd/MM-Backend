/**
 * XP progression helpers derived entirely from runtime formulas (no Firestore lookups).
 *
 * The curve is defined as a geometric series with a gentle growth factor so that
 * early levels require minimal XP while later levels scale exponentially toward
 * the long-tail progression target.
 */

const BASE_XP = 100;
const GROWTH_RATE = 1.045;

/**
 * Returns the cumulative XP required to reach the given level.
 * Level 1 is considered the starting point (0 XP).
 */
export function expRequiredForLevel(level: number): number {
  if (level <= 1) {
    return 0;
  }
  const exp =
    BASE_XP * ((Math.pow(GROWTH_RATE, level - 1) - 1) / (GROWTH_RATE - 1));
  return Math.round(exp);
}

export interface LevelInfo {
  level: number;
  expInLevel: number;
  expToNext: number;
}

/**
 * Given a cumulative XP total, returns the active level, progress within the current
 * level, and the XP required to advance to the next level.
 */
export function getLevelInfo(cumulativeExp: number): LevelInfo {
  const safeExp = Math.max(0, Math.floor(cumulativeExp));

  let level = 1;
  while (expRequiredForLevel(level + 1) <= safeExp) {
    level += 1;
  }

  const expForCurrent = expRequiredForLevel(level);
  const expForNext = expRequiredForLevel(level + 1);
  const expInLevel = safeExp - expForCurrent;
  const expToNext = Math.max(expForNext - expForCurrent, 1);

  return {
    level,
    expInLevel,
    expToNext,
  };
}
