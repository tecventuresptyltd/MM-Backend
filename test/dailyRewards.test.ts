// Enable the emulator-only clock override before the functions module loads.
process.env.FUNCTIONS_EMULATOR = "true";

import { admin } from "./setup";
import { wipeAuth, wipeFirestore, seedMinimalPlayer, ensureCatalogsSeeded } from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { getDailyRewardStatus, claimDailyReward } from "../src/dailyRewards/dailyRewards";
import { __resetV2ConfigCacheForTests } from "../src/core/configV2";
import { DAY_MS, gameDayIndex, resolveClaimState, nextSlotAfter } from "../src/dailyRewards/lib/dayIndex";

const db = () => admin.firestore();

// A fixed, arbitrary UTC midnight to anchor the simulated clock.
const BASE_MS = Date.UTC(2026, 0, 5, 0, 0, 0);
const HOUR = 60 * 60 * 1000;

describe("dailyRewards", () => {
  let uid: string;

  const status = wrapCallable(getDailyRewardStatus);
  const claim = wrapCallable(claimDailyReward);

  const authFor = (userId: string) => ({
    auth: { uid: userId, token: { firebase: { sign_in_provider: "anonymous" } } },
  });

  /** Claim at a simulated wall-clock time. */
  const claimAt = (nowMs: number, opId: string, userId = uid) =>
    claim({ data: { opId, __testNowMs: nowMs }, ...authFor(userId) });

  const statusAt = (nowMs: number, userId = uid) =>
    status({ data: { __testNowMs: nowMs }, ...authFor(userId) });

  const readStatusDoc = async (userId = uid) =>
    (await db().doc(`Players/${userId}/DailyRewards/Status`).get()).data();

  const readEconomy = async (userId = uid) =>
    (await db().doc(`Players/${userId}/Economy/Stats`).get()).data();

  const readInventoryQty = async (skuId: string, userId = uid) => {
    const snap = await db().doc(`Players/${userId}/Inventory/${skuId}`).get();
    return snap.exists ? snap.data()?.quantity ?? snap.data()?.qty ?? 0 : 0;
  };

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    __resetV2ConfigCacheForTests();

    uid = `uid-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await seedMinimalPlayer(uid);
    await ensureCatalogsSeeded();
    __resetV2ConfigCacheForTests();
  });

  // ===========================================================================
  // Pure day math — no Firestore involved
  // ===========================================================================

  describe("day index math", () => {
    it("advances exactly once per 24h and is stable within a day", () => {
      const d0 = gameDayIndex(BASE_MS, 0);
      expect(gameDayIndex(BASE_MS + 23 * HOUR + 59 * 60_000, 0)).toBe(d0);
      expect(gameDayIndex(BASE_MS + DAY_MS, 0)).toBe(d0 + 1);
      expect(gameDayIndex(BASE_MS + 10 * DAY_MS, 0)).toBe(d0 + 10);
    });

    it("shifts the boundary by resetOffsetMinutes", () => {
      // With a 04:00 UTC rollover, 03:00 UTC is still the previous day.
      const offset = 240;
      expect(gameDayIndex(BASE_MS + 3 * HOUR, offset)).toBe(gameDayIndex(BASE_MS - HOUR, offset));
      expect(gameDayIndex(BASE_MS + 5 * HOUR, offset)).toBe(gameDayIndex(BASE_MS + 3 * HOUR, offset) + 1);
    });

    it("never re-opens a claim when the clock moves backwards", () => {
      const cfg = { cycleLength: 7, resetOffsetMinutes: 0, graceDays: 1, loopCycle: true };
      const today = gameDayIndex(BASE_MS, 0);
      const state = resolveClaimState(
        { streakDay: 3, lastClaimedDayIndex: today },
        cfg,
        BASE_MS - 5 * DAY_MS, // server clock jumped back five days
      );
      expect(state.isClaimable).toBe(false);
    });

    it("loops the slot at the end of the cycle", () => {
      const cfg = { cycleLength: 7, resetOffsetMinutes: 0, graceDays: 1, loopCycle: true };
      expect(nextSlotAfter(6, cfg)).toBe(7);
      expect(nextSlotAfter(7, cfg)).toBe(1);
      expect(nextSlotAfter(7, { ...cfg, loopCycle: false })).toBe(7);
    });
  });

  // ===========================================================================
  // Claim flow
  // ===========================================================================

  it("grants slot 1 on the first ever claim and credits coins", async () => {
    const before = await readEconomy();
    const result = await claimAt(BASE_MS, "op_d1");

    expect(result.success).toBe(true);
    expect(result.claimedDay).toBe(1);
    expect(result.nextStreakDay).toBe(2);
    expect(result.streakBroken).toBe(false);
    expect(result.rewards).toEqual([
      { kind: "coins", quantity: 1000, skuId: null, displayName: "Sack of Coins" },
    ]);

    const economy = await readEconomy();
    expect(Number(economy?.coins ?? 0)).toBe(Number(before?.coins ?? 0) + 1000);

    const doc = await readStatusDoc();
    expect(doc?.streakDay).toBe(2);
    expect(doc?.lastClaimedDayIndex).toBe(gameDayIndex(BASE_MS, 0));
    expect(doc?.totalClaims).toBe(1);
  });

  it("rejects a second claim on the same day", async () => {
    await claimAt(BASE_MS, "op_d1");
    await expect(claimAt(BASE_MS + 6 * HOUR, "op_d1_again")).rejects.toMatchObject({
      code: "failed-precondition",
    });

    const doc = await readStatusDoc();
    expect(doc?.totalClaims).toBe(1);
  });

  it("advances the streak on the next day and grants the item SKU", async () => {
    await claimAt(BASE_MS, "op_d1");
    const result = await claimAt(BASE_MS + DAY_MS, "op_d2");

    expect(result.claimedDay).toBe(2);
    expect(result.streakBroken).toBe(false);
    // Day 2 = 2× Speed Up (15m)
    expect(await readInventoryQty("sku_spd15m_j8k2")).toBe(2);
  });

  it("treats one minute past the boundary as a new day", async () => {
    // Claim at 23:59, then again two minutes later — a different game day.
    const lateNight = BASE_MS + 23 * HOUR + 59 * 60_000;
    await claimAt(lateNight, "op_late");
    const result = await claimAt(lateNight + 2 * 60_000, "op_justafter");
    expect(result.claimedDay).toBe(2);
  });

  it("forgives a single missed day (graceDays = 1)", async () => {
    await claimAt(BASE_MS, "op_d1");
    // Skip one whole day, claim on the day after.
    const result = await claimAt(BASE_MS + 2 * DAY_MS, "op_d2_late");

    expect(result.claimedDay).toBe(2);
    expect(result.streakBroken).toBe(false);
  });

  it("resets to slot 1 after two consecutive missed days", async () => {
    await claimAt(BASE_MS, "op_d1");
    await claimAt(BASE_MS + DAY_MS, "op_d2");
    // Now skip days 3 and 4 entirely, return on day 5.
    const result = await claimAt(BASE_MS + 4 * DAY_MS, "op_back");

    expect(result.claimedDay).toBe(1);
    expect(result.streakBroken).toBe(true);
    expect(result.nextStreakDay).toBe(2);
  });

  it("completes the 7-day cycle and loops back to slot 1", async () => {
    for (let day = 0; day < 7; day += 1) {
      const result = await claimAt(BASE_MS + day * DAY_MS, `op_cycle_${day}`);
      expect(result.claimedDay).toBe(day + 1);
    }

    const doc = await readStatusDoc();
    expect(doc?.streakDay).toBe(1);
    expect(doc?.cycleCount).toBe(1);
    expect(doc?.totalClaims).toBe(7);

    // Day 7 is the milestone: rare crate + gems.
    expect(await readInventoryQty("sku_72wnqwtfmx")).toBe(1);

    const eighth = await claimAt(BASE_MS + 7 * DAY_MS, "op_cycle_7");
    expect(eighth.claimedDay).toBe(1);
    expect(eighth.streakBroken).toBe(false);
  });

  // ===========================================================================
  // Idempotency + concurrency
  // ===========================================================================

  it("replays the cached result for a repeated opId without granting twice", async () => {
    const first = await claimAt(BASE_MS, "op_same");
    const economyAfterFirst = await readEconomy();

    const second = await claimAt(BASE_MS, "op_same");
    expect(second.claimedDay).toBe(first.claimedDay);

    const economyAfterSecond = await readEconomy();
    expect(Number(economyAfterSecond?.coins ?? 0)).toBe(Number(economyAfterFirst?.coins ?? 0));

    const doc = await readStatusDoc();
    expect(doc?.totalClaims).toBe(1);
  });

  it("lets exactly one of two concurrent claims win", async () => {
    const results = await Promise.allSettled([
      claimAt(BASE_MS, "op_race_a"),
      claimAt(BASE_MS, "op_race_b"),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const doc = await readStatusDoc();
    expect(doc?.totalClaims).toBe(1);

    const logs = await db().collection(`Players/${uid}/DailyRewards/Status/Log`).get();
    expect(logs.size).toBe(1);
  });

  it("writes one immutable log entry per claimed day", async () => {
    await claimAt(BASE_MS, "op_l1");
    await claimAt(BASE_MS + DAY_MS, "op_l2");

    const logs = await db().collection(`Players/${uid}/DailyRewards/Status/Log`).get();
    expect(logs.size).toBe(2);

    const slots = logs.docs.map((d) => d.data().slot).sort();
    expect(slots).toEqual([1, 2]);
    expect(logs.docs.map((d) => d.id)).toContain(String(gameDayIndex(BASE_MS, 0)));
  });

  it("still grants when the player has no Economy/Stats doc", async () => {
    await db().doc(`Players/${uid}/Economy/Stats`).delete();

    const result = await claimAt(BASE_MS, "op_noeconomy");
    expect(result.claimedDay).toBe(1);

    const economy = await readEconomy();
    expect(Number(economy?.coins ?? 0)).toBe(1000);
  });

  // ===========================================================================
  // Status callable
  // ===========================================================================

  it("returns the full ladder with per-slot state and the server clock", async () => {
    const res = await statusAt(BASE_MS);

    expect(res.cycleLength).toBe(7);
    expect(res.serverNowMs).toBe(BASE_MS);
    expect(res.isClaimable).toBe(true);
    expect(res.streakDay).toBe(1);
    expect(res.ladder).toHaveLength(7);
    expect(res.ladder[0]).toMatchObject({ day: 1, state: "claimable" });
    expect(res.ladder[1]).toMatchObject({ day: 2, state: "locked" });
    expect(res.ladder[6]).toMatchObject({ day: 7, isMilestone: true });
  });

  it("reports the countdown to the next boundary after claiming", async () => {
    await claimAt(BASE_MS + 6 * HOUR, "op_s1");
    const res = await statusAt(BASE_MS + 7 * HOUR);

    expect(res.isClaimable).toBe(false);
    expect(res.streakDay).toBe(2);
    expect(res.ladder[0].state).toBe("claimed");
    expect(res.ladder[1].state).toBe("locked");
    // Next boundary is midnight UTC, 17h after the 07:00 read.
    expect(res.msUntilNextClaim).toBe(17 * HOUR);
    expect(res.nextClaimAtMs).toBe(BASE_MS + DAY_MS);
  });

  it("does not mutate any state when status is polled", async () => {
    await claimAt(BASE_MS, "op_poll");
    const before = await readStatusDoc();

    await statusAt(BASE_MS + 10 * DAY_MS);
    await statusAt(BASE_MS + 20 * DAY_MS);

    const after = await readStatusDoc();
    expect(after).toEqual(before);
  });

  it("shows a lapsed streak as back to slot 1 before the player claims", async () => {
    await claimAt(BASE_MS, "op_x1");
    await claimAt(BASE_MS + DAY_MS, "op_x2");

    const res = await statusAt(BASE_MS + 5 * DAY_MS);
    expect(res.streakDay).toBe(1);
    expect(res.isClaimable).toBe(true);
    expect(res.ladder[0].state).toBe("claimable");
    expect(res.ladder[1].state).toBe("locked");
  });

  it("requires authentication", async () => {
    await expect(claim({ data: { opId: "op_noauth" } })).rejects.toMatchObject({
      code: "unauthenticated",
    });
    await expect(status({ data: {} })).rejects.toMatchObject({
      code: "unauthenticated",
    });
  });

  it("requires a non-empty opId", async () => {
    await expect(claim({ data: { opId: "" }, ...authFor(uid) })).rejects.toMatchObject({
      code: "invalid-argument",
    });
  });
});
