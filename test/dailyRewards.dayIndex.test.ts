/**
 * Pure unit tests for the daily-reward state machine.
 *
 * Deliberately free of Firestore so they run without the emulator (and without
 * Java). Everything here is the logic that decides *whether* and *what* a player
 * may claim; the Firestore wiring is covered by dailyRewards.test.ts.
 */

import {
  DAY_MS,
  DayBoundaryConfig,
  claimTimersAfter,
  dayIndexStartMs,
  gameDayIndex,
  nextSlotAfter,
  resolveClaimState,
} from "../src/dailyRewards/lib/dayIndex";

const HOUR = 60 * 60 * 1000;
const BASE_MS = Date.UTC(2026, 0, 5, 0, 0, 0); // a Monday, 00:00 UTC

const CFG: DayBoundaryConfig = {
  cycleLength: 7,
  resetOffsetMinutes: 0,
  graceDays: 1,
  loopCycle: true,
};

/** Shorthand: state as of `days` whole days after BASE_MS (plus optional hours). */
const at = (days: number, hours = 0) => BASE_MS + days * DAY_MS + hours * HOUR;
const dayOf = (ms: number, offset = 0) => gameDayIndex(ms, offset);

describe("gameDayIndex", () => {
  it("is stable across a whole day and increments exactly at the boundary", () => {
    const d0 = dayOf(BASE_MS);
    expect(dayOf(BASE_MS + 1)).toBe(d0);
    expect(dayOf(BASE_MS + 23 * HOUR + 59 * 60_000 + 59_000)).toBe(d0);
    expect(dayOf(BASE_MS + DAY_MS)).toBe(d0 + 1);
    expect(dayOf(BASE_MS + DAY_MS - 1)).toBe(d0);
  });

  it("moves forward one index per elapsed day over a long span", () => {
    const d0 = dayOf(BASE_MS);
    for (const n of [1, 7, 30, 365, 1000]) {
      expect(dayOf(BASE_MS + n * DAY_MS)).toBe(d0 + n);
    }
  });

  it("honours a non-zero reset offset", () => {
    const offset = 240; // 04:00 UTC rollover
    // 03:59 UTC still belongs to the previous game day...
    expect(dayOf(BASE_MS + 3 * HOUR + 59 * 60_000, offset)).toBe(dayOf(BASE_MS - HOUR, offset));
    // ...and 04:01 starts the new one.
    expect(dayOf(BASE_MS + 4 * HOUR + 60_000, offset)).toBe(dayOf(BASE_MS + 3 * HOUR, offset) + 1);
  });

  it("round-trips through dayIndexStartMs", () => {
    for (const offset of [0, 240, -120]) {
      const idx = dayOf(BASE_MS + 9 * HOUR, offset);
      const start = dayIndexStartMs(idx, offset);
      expect(dayOf(start, offset)).toBe(idx);
      expect(dayOf(start - 1, offset)).toBe(idx - 1);
    }
  });

  it("is unaffected by the process timezone", () => {
    // The function takes epoch ms and never constructs a Date, so a TZ change
    // cannot shift the boundary. Asserted explicitly because this is the whole
    // anti-cheat premise.
    const original = process.env.TZ;
    try {
      process.env.TZ = "Asia/Kolkata";
      const a = dayOf(BASE_MS + 12 * HOUR);
      process.env.TZ = "America/Los_Angeles";
      const b = dayOf(BASE_MS + 12 * HOUR);
      expect(a).toBe(b);
    } finally {
      process.env.TZ = original;
    }
  });
});

describe("resolveClaimState", () => {
  const claimedAt = (ms: number, streakDay = 2) => ({
    streakDay,
    lastClaimedDayIndex: dayOf(ms),
    lastClaimedAtMs: ms,
  });

  it("offers slot 1 immediately to a player who has never claimed", () => {
    const state = resolveClaimState(null, CFG, BASE_MS);
    expect(state).toMatchObject({
      isClaimable: true,
      slot: 1,
      streakBroken: false,
      streakExpiresAtMs: null,
    });
  });

  it("blocks a second claim until 24h after the last one", () => {
    const last = at(0, 6);
    const state = resolveClaimState(claimedAt(last), CFG, last + 8 * HOUR);
    expect(state.isClaimable).toBe(false);
    expect(state.slot).toBe(2);
    expect(state.nextClaimAtMs).toBe(last + DAY_MS);
  });

  it("does not open at the UTC day boundary, only after the full interval", () => {
    const lateNight = at(0, 23);
    const state = resolveClaimState(claimedAt(lateNight), CFG, at(1, 1));
    expect(state.isClaimable).toBe(false);
    expect(state.nextClaimAtMs).toBe(lateNight + DAY_MS);
  });

  it("continues the streak exactly 24h later", () => {
    const last = at(0, 6);
    const state = resolveClaimState(claimedAt(last, 3), CFG, last + DAY_MS);
    expect(state).toMatchObject({ isClaimable: true, slot: 3, streakBroken: false });
  });

  it("gives graceDays * 24h to claim before the streak breaks", () => {
    const last = at(0, 6);
    const forgiven = resolveClaimState(claimedAt(last, 4), CFG, last + 2 * DAY_MS - 1);
    expect(forgiven).toMatchObject({ slot: 4, streakBroken: false });

    const broken = resolveClaimState(claimedAt(last, 4), CFG, last + 2 * DAY_MS);
    expect(broken).toMatchObject({ slot: 1, streakBroken: true });
  });

  it("breaks the moment the reward opens when graceDays is 0", () => {
    const strict = { ...CFG, graceDays: 0 };
    const last = at(0, 6);
    expect(resolveClaimState(claimedAt(last, 5), strict, last + DAY_MS - 1).isClaimable).toBe(false);
    expect(resolveClaimState(claimedAt(last, 5), strict, last + DAY_MS))
      .toMatchObject({ slot: 1, streakBroken: true });
  });

  it("survives a long absence by restarting rather than erroring", () => {
    const state = resolveClaimState(claimedAt(BASE_MS, 7), CFG, at(400));
    expect(state).toMatchObject({ isClaimable: true, slot: 1, streakBroken: true });
  });

  it("refuses to re-open a claim if the clock moves backwards", () => {
    for (const rewind of [1, 5, 400]) {
      const state = resolveClaimState(claimedAt(BASE_MS, 3), CFG, BASE_MS - rewind * DAY_MS);
      expect(state.isClaimable).toBe(false);
    }
  });

  it("reports timers relative to the last claim", () => {
    const last = at(0, 6);
    const state = resolveClaimState(claimedAt(last), CFG, at(0, 7));
    expect(state.nextClaimAtMs).toBe(last + DAY_MS);
    expect(state.streakExpiresAtMs).toBe(last + 2 * DAY_MS);
    expect(claimTimersAfter(last, CFG)).toEqual({
      nextClaimAtMs: last + DAY_MS,
      streakExpiresAtMs: last + 2 * DAY_MS,
    });
  });

  it("migrates a status that only has a day index by anchoring on that day's start", () => {
    const last = dayOf(at(0, 15));
    const state = resolveClaimState({ streakDay: 2, lastClaimedDayIndex: last }, CFG, at(0, 20));
    expect(state.isClaimable).toBe(false);
    expect(state.nextClaimAtMs).toBe(dayIndexStartMs(last + 1, 0));
    expect(resolveClaimState({ streakDay: 2, lastClaimedDayIndex: last }, CFG, at(1)).isClaimable).toBe(true);
  });

  it("clamps a corrupted streakDay into the ladder", () => {
    expect(resolveClaimState(claimedAt(BASE_MS, 99), CFG, at(1)).slot).toBe(7);
    expect(resolveClaimState(claimedAt(BASE_MS, 0), CFG, at(1)).slot).toBe(1);
    expect(resolveClaimState(claimedAt(BASE_MS, NaN), CFG, at(1)).slot).toBe(1);
  });
});

describe("nextSlotAfter", () => {
  it("advances within the cycle", () => {
    for (let slot = 1; slot < CFG.cycleLength; slot += 1) {
      expect(nextSlotAfter(slot, CFG)).toBe(slot + 1);
    }
  });

  it("wraps to slot 1 at the end when looping", () => {
    expect(nextSlotAfter(7, CFG)).toBe(1);
  });

  it("parks on the final slot when not looping", () => {
    expect(nextSlotAfter(7, { ...CFG, loopCycle: false })).toBe(7);
  });
});

describe("full 7-day walkthrough", () => {
  it("runs a perfect week, loops, then breaks and restarts", () => {
    let status = {
      streakDay: 1,
      lastClaimedDayIndex: null as number | null,
      lastClaimedAtMs: null as number | null,
    };
    const claimed: number[] = [];

    // Seven consecutive days.
    for (let day = 0; day < 7; day += 1) {
      const state = resolveClaimState(status, CFG, at(day));
      expect(state.isClaimable).toBe(true);
      claimed.push(state.slot);
      status = {
        streakDay: nextSlotAfter(state.slot, CFG),
        lastClaimedDayIndex: state.todayIndex,
        lastClaimedAtMs: at(day),
      };
    }
    expect(claimed).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(status.streakDay).toBe(1); // looped

    // Day 8 continues into the next cycle at slot 1.
    const day8 = resolveClaimState(status, CFG, at(7));
    expect(day8).toMatchObject({ slot: 1, streakBroken: false });

    // Now vanish for three days: the ladder restarts.
    const returned = resolveClaimState(status, CFG, at(11));
    expect(returned).toMatchObject({ slot: 1, streakBroken: true });
  });
});
