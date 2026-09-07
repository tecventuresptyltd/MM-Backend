/**
 * Daily reward timing math.
 *
 * Everything here is pure: no `Date`, no `Date.now()`, no Firestore. The caller
 * passes server epoch milliseconds in. That makes the whole state machine unit
 * testable at arbitrary points in time, and — more importantly — means the
 * player's device clock and timezone are never an input.
 *
 * Timing is anchored on the player's own last claim instead of a global day
 * boundary: the next reward opens exactly one claim interval after the previous
 * claim, and the player then has a grace window to take it before the ladder
 * falls back to slot 1. The absolute game-day index is kept only as the key of
 * the per-claim audit log.
 */

export const DAY_MS = 86_400_000;

export const CLAIM_INTERVAL_MS = DAY_MS;

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
  /** Epoch ms of the last successful claim; null if never claimed. */
  lastClaimedAtMs?: number | null;
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

export interface ClaimTimers {
  nextClaimAtMs: number;
  streakExpiresAtMs: number;
}

/** Timers that a claim made at `claimedAtMs` produces. */
export function claimTimersAfter(claimedAtMs: number, config: DayBoundaryConfig): ClaimTimers {
  const nextClaimAtMs = claimedAtMs + CLAIM_INTERVAL_MS;
  return {
    nextClaimAtMs,
    streakExpiresAtMs: nextClaimAtMs + Math.max(0, config.graceDays) * DAY_MS,
  };
}

/** Epoch ms of the last claim, migrating pre-timer status docs off their day index. */
export function resolveLastClaimedAtMs(
  status: DailyRewardStatusState | null | undefined,
  resetOffsetMinutes: number,
): number | null {
  const lastAt = status?.lastClaimedAtMs;
  if (typeof lastAt === "number" && Number.isFinite(lastAt) && lastAt > 0) {
    return lastAt;
  }
  const lastIndex = status?.lastClaimedDayIndex;
  if (typeof lastIndex === "number" && Number.isFinite(lastIndex)) {
    return dayIndexStartMs(lastIndex, resetOffsetMinutes);
  }
  return null;
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
  const { resetOffsetMinutes, cycleLength } = config;
  const todayIndex = gameDayIndex(nowMs, resetOffsetMinutes);
  const lastAt = resolveLastClaimedAtMs(status, resetOffsetMinutes);

  if (lastAt === null) {
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
  const { nextClaimAtMs, streakExpiresAtMs } = claimTimersAfter(lastAt, config);

  if (nowMs < nextClaimAtMs) {
    return {
      isClaimable: false,
      slot: streakDay,
      todayIndex,
      nextClaimAtMs,
      streakExpiresAtMs,
      streakBroken: false,
    };
  }

  const streakBroken = nowMs >= streakExpiresAtMs;

  return {
    isClaimable: true,
    slot: streakBroken ? 1 : streakDay,
    todayIndex,
    nextClaimAtMs,
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
