/**
 * Daily reward day-boundary math.
 *
 * Everything here is pure: no `Date`, no `Date.now()`, no Firestore. The caller
 * passes server epoch milliseconds in. That makes the whole state machine unit
 * testable at arbitrary points in time, and — more importantly — means the
 * player's device clock and timezone are never an input.
 *
 * A "game day" is an absolute integer index counted from the Unix epoch, shifted
 * by a globally configured offset. Because the index only ever increases with
 * real time, "have they already claimed today?" reduces to an integer compare
 * against a value we persisted inside a transaction. There is no clock a client
 * can move to make a stale index look fresh.
 */

export const DAY_MS = 86_400_000;

/**
 * The absolute game-day index containing `nowMs`.
 *
 * `resetOffsetMinutes` shifts the daily boundary away from 00:00 UTC — e.g. 240
 * puts the rollover at 04:00 UTC. It is a single global value, never per-player:
 * a per-player timezone would let someone mint a new day by changing a setting.
 */
export function gameDayIndex(nowMs: number, resetOffsetMinutes: number): number {
  return Math.floor((nowMs - resetOffsetMinutes * 60_000) / DAY_MS);
}

/** Epoch ms at which the given game-day index begins. */
export function dayIndexStartMs(dayIndex: number, resetOffsetMinutes: number): number {
  return dayIndex * DAY_MS + resetOffsetMinutes * 60_000;
}

export interface DailyRewardStatusState {
  /** Slot (1..cycleLength) the player will claim next. */
  streakDay: number;
  /** Absolute game-day index of the last successful claim; null if never claimed. */
  lastClaimedDayIndex: number | null;
}

export interface DayBoundaryConfig {
  cycleLength: number;
  resetOffsetMinutes: number;
  graceDays: number;
  loopCycle: boolean;
}

export interface ResolvedClaimState {
  /** Whether a claim is allowed right now. */
  isClaimable: boolean;
  /** The slot that a claim right now would award. */
  slot: number;
  /** Current absolute game-day index on the server. */
  todayIndex: number;
  /** Epoch ms when the next claim becomes possible. */
  nextClaimAtMs: number;
  /**
   * Epoch ms after which the streak breaks and the ladder falls back to slot 1.
   * Null when there is nothing to lose yet (never claimed).
   */
  streakExpiresAtMs: number | null;
  /** True when the resolved slot is 1 because the player let the streak lapse. */
  streakBroken: boolean;
}

/**
 * The whole state machine. Given persisted state, config, and the server clock,
 * decide what (if anything) the player may claim.
 */
export function resolveClaimState(
  status: DailyRewardStatusState | null | undefined,
  config: DayBoundaryConfig,
  nowMs: number,
): ResolvedClaimState {
  const { resetOffsetMinutes, graceDays, cycleLength } = config;
  const todayIndex = gameDayIndex(nowMs, resetOffsetMinutes);
  const last = status?.lastClaimedDayIndex ?? null;

  // Never claimed: slot 1 is available immediately, and there is no streak to lose.
  if (last === null) {
    return {
      isClaimable: true,
      slot: 1,
      todayIndex,
      nextClaimAtMs: nowMs,
      streakExpiresAtMs: null,
      streakBroken: false,
    };
  }

  const streakDay = clampSlot(status?.streakDay ?? 1, cycleLength);
  // The last game day on which a claim still continues the streak.
  const streakDeadlineIndex = last + 1 + graceDays;
  const streakExpiresAtMs = dayIndexStartMs(streakDeadlineIndex + 1, resetOffsetMinutes);

  // Already claimed today. `todayIndex < last` can only happen if the server clock
  // moved backwards; treating it as "already claimed" keeps the anchor monotonic
  // and fails closed rather than handing out a second reward.
  if (todayIndex <= last) {
    return {
      isClaimable: false,
      slot: streakDay,
      todayIndex,
      nextClaimAtMs: dayIndexStartMs(last + 1, resetOffsetMinutes),
      streakExpiresAtMs,
      streakBroken: false,
    };
  }

  // A new day. The gap decides whether the streak survives.
  //   gap === 1                  -> claimed yesterday, perfect streak
  //   gap - 1 <= graceDays       -> missed days, but within the grace allowance
  //   otherwise                  -> streak broken, back to slot 1
  const gap = todayIndex - last;
  const streakBroken = gap - 1 > graceDays;

  return {
    isClaimable: true,
    slot: streakBroken ? 1 : streakDay,
    todayIndex,
    nextClaimAtMs: nowMs,
    streakExpiresAtMs,
    streakBroken,
  };
}

/**
 * The slot that follows `slot` once it has been claimed.
 * Loops back to 1 at the end of the cycle when `loopCycle` is set, otherwise
 * parks on the final slot.
 */
export function nextSlotAfter(slot: number, config: DayBoundaryConfig): number {
  const { cycleLength, loopCycle } = config;
  if (slot >= cycleLength) {
    return loopCycle ? 1 : cycleLength;
  }
  return slot + 1;
}

function clampSlot(slot: number, cycleLength: number): number {
  if (!Number.isFinite(slot) || slot < 1) {
    return 1;
  }
  return Math.min(Math.floor(slot), cycleLength);
}
