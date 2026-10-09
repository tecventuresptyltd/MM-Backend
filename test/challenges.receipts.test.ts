process.env.FUNCTIONS_EMULATOR = "true";

import { createHash } from "node:crypto";
import { admin } from "./setup";
import { ensureCatalogsSeeded } from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { getChallengesStatus, claimDailyChallenge } from "../src/challenges";
import { swapDailyChallenge } from "../src/challenges";
import { resetChallengesCache } from "../src/challenges/config";
import { dailyRef } from "../src/challenges/state";
import { __resetV2ConfigCacheForTests } from "../src/core/configV2";
import * as rewardBundle from "../src/shared/rewardBundle";

jest.setTimeout(60_000);

const db = admin.firestore();
const uid = "challenge-receipt-retry-test";
const NOW = Date.UTC(2026, 9, 9, 12);
const status = wrapCallable(getChallengesStatus);
const claim = wrapCallable(claimDailyChallenge);
const swap = wrapCallable(swapDailyChallenge);
const request = (data: Record<string, unknown> = {}) => ({ data: { __testNowMs: NOW, ...data }, auth: { uid, token: {} } });
let applyRewardBundleSpy: jest.SpyInstance | undefined;
let deletedMasteryFixture: Record<string, unknown> | null = null;

beforeEach(async () => {
  await db.recursiveDelete(db.doc(`Players/${uid}`));
  await ensureCatalogsSeeded();
  resetChallengesCache();
  __resetV2ConfigCacheForTests();
  const batch = db.batch();
  batch.set(db.doc(`Players/${uid}/Profile/Profile`), { displayName: "Receipt Retry Test", masteryXp: 0, level: 1 });
  batch.set(db.doc(`Players/${uid}/Garage/Cars`), { cars: {} });
  batch.set(db.doc(`Players/${uid}/Economy/Stats`), { gems: 100, coins: 0, spellShards: 0 });
  await batch.commit();
  await status(request());
});

afterEach(async () => {
  applyRewardBundleSpy?.mockRestore();
  applyRewardBundleSpy = undefined;
  if (deletedMasteryFixture) {
    await db.doc("GameData/v1/config/MasteryConfig").set(deletedMasteryFixture);
    deletedMasteryFixture = null;
  }
  __resetV2ConfigCacheForTests();
  await db.recursiveDelete(db.doc(`Players/${uid}`));
});

async function completeFirstChallenge() {
  const daily = (await dailyRef(uid).get()).data()!;
  const challenge = daily.challenges[0];
  challenge.progress = challenge.objective.target;
  await dailyRef(uid).set(daily);
  return challenge.objective.id as string;
}

describe("challenge action receipts", () => {
  it("can retry the same opId after a config read fails before the reward transaction", async () => {
    const challengeId = await completeFirstChallenge();
    const opId = "same-op-after-config-error";
    const masteryRef = db.doc("GameData/v1/config/MasteryConfig");
    const mastery = (await masteryRef.get()).data()!;

    await masteryRef.delete();
    __resetV2ConfigCacheForTests();
    await expect(claim(request({ challengeId, opId }))).rejects.toThrow(/MasteryConfig not found/);
    expect((await db.doc(`Players/${uid}/Receipts/${opId}`).get()).exists).toBe(false);

    await masteryRef.set(mastery);
    __resetV2ConfigCacheForTests();
    const result = await claim(request({ challengeId, opId }));
    expect(result.success).toBe(true);
    expect((await db.doc(`Players/${uid}/Receipts/${opId}`).get()).data()?.status).toBe("completed");
    expect(await claim(request({ challengeId, opId }))).toEqual(result);

    const coinReward = result.rewards.find((reward: any) => reward.kind === "coins")?.quantity ?? 0;
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()?.coins).toBe(coinReward);
  });

  it("serializes simultaneous calls with the same opId and grants once", async () => {
    const challengeId = await completeFirstChallenge();
    const opId = "simultaneous-same-op";
    const input = request({ challengeId, opId });
    const [first, second] = await Promise.all([claim(input), claim(input)]);

    expect(first).toEqual(second);
    expect((await db.doc(`Players/${uid}/Receipts/${opId}`).get()).data()?.status).toBe("completed");
    const coinReward = first.rewards.find((reward: any) => reward.kind === "coins")?.quantity ?? 0;
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()?.coins).toBe(coinReward);
  });

  it("continues to reject an in-progress receipt created by an older function instance", async () => {
    const challengeId = await completeFirstChallenge();
    const opId = "legacy-in-progress";
    const inputsHash = createHash("sha256").update(JSON.stringify({ action: "claimDailyChallenge", target: challengeId })).digest("hex");
    await db.doc(`Players/${uid}/Receipts/${opId}`).set({ opId, status: "in_progress", kind: "claimDailyChallenge", inputsHash, createdAtMs: NOW });

    await expect(claim(request({ challengeId, opId }))).rejects.toMatchObject({ code: "aborted" });
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()?.coins).toBe(0);
  });

  it("retries a swap after mastery config recovers and charges its gem cost once", async () => {
    const first = (await status(request())).challenges[0];
    const opId = "swap-same-op-after-config-error";
    const masteryRef = db.doc("GameData/v1/config/MasteryConfig");
    deletedMasteryFixture = (await masteryRef.get()).data()!;

    await masteryRef.delete();
    __resetV2ConfigCacheForTests();
    await expect(swap(request({ challengeId: first.id, opId }))).rejects.toThrow(/MasteryConfig not found/);
    expect((await db.doc(`Players/${uid}/Receipts/${opId}`).get()).exists).toBe(false);
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()?.gems).toBe(100);

    await masteryRef.set(deletedMasteryFixture);
    deletedMasteryFixture = null;
    __resetV2ConfigCacheForTests();
    const result = await swap(request({ challengeId: first.id, opId }));
    expect(result.gems.after).toBe(90);
    expect(result.status.swapsUsed).toBe(1);
    expect(await swap(request({ challengeId: first.id, opId }))).toEqual(result);
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()?.gems).toBe(90);
  });

  it("rolls back queued reward writes after a failure and can retry the same opId", async () => {
    const challengeId = await completeFirstChallenge();
    const opId = "retry-after-reward-write-error";
    const dailyBefore = (await dailyRef(uid).get()).data();
    const achievementsBefore = (await db.doc(`Players/${uid}/Achievements/Progress`).get()).data();
    const economyBefore = (await db.doc(`Players/${uid}/Economy/Stats`).get()).data();
    const original = rewardBundle.applyRewardBundle;
    applyRewardBundleSpy = jest.spyOn(rewardBundle, "applyRewardBundle").mockImplementation(async (...args) => {
      await original(...args);
      throw new Error("Injected failure after reward writes were queued");
    });

    await expect(claim(request({ challengeId, opId }))).rejects.toThrow(/Injected failure/);
    expect((await dailyRef(uid).get()).data()).toEqual(dailyBefore);
    expect((await db.doc(`Players/${uid}/Achievements/Progress`).get()).data()).toEqual(achievementsBefore);
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()).toEqual(economyBefore);
    expect((await db.doc(`Players/${uid}/Receipts/${opId}`).get()).exists).toBe(false);

    applyRewardBundleSpy.mockRestore();
    applyRewardBundleSpy = undefined;
    const result = await claim(request({ challengeId, opId }));
    expect(result.status.challenges.find((challenge: any) => challenge.id === challengeId).state).toBe("claimed");
    expect((await db.doc(`Players/${uid}/Receipts/${opId}`).get()).data()?.status).toBe("completed");
    const coinReward = result.rewards.find((reward: any) => reward.kind === "coins")?.quantity ?? 0;
    expect((await db.doc(`Players/${uid}/Economy/Stats`).get()).data()?.coins).toBe(coinReward);
  });
});
