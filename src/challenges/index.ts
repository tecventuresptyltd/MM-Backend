import * as admin from "firebase-admin";
import { createHash } from "node:crypto";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { getCarEvolutionV2Catalog, getMasteryConfig, getMasteryRank } from "../core/configV2.js";
import { applyRewardBundle, prepareRewardBundle } from "../shared/rewardBundle.js";
import { sanitizeForFirestore } from "../core/idempotency.js";
import { Definitions, eligibleDefinitions, getChallengesDefinitions, Objective } from "./config.js";
import { achievementState, achievementsRef, dailyRef, DailyState, refreshAccountProgress, resolveDaily, rewardView, statusView } from "./state.js";

const db = admin.firestore();
const nowFor = (data: any) => process.env.FUNCTIONS_EMULATOR === "true" && process.env.GCLOUD_PROJECT === "demo-test" && typeof data?.__testNowMs === "number" && Number.isFinite(data.__testNowMs) ? data.__testNowMs : Date.now();
const id = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new HttpsError("invalid-argument", `${name} is invalid.`);
  return value;
};
async function context(request: any) {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to view challenges.");
  const defs = (await getChallengesDefinitions())!;
  const evolution = await getCarEvolutionV2Catalog();
  return { uid, defs, now: nowFor(request.data), maxCarLevel: evolution.maxStarLevel };
}
async function readState(tx: FirebaseFirestore.Transaction, uid: string, defs: Definitions, now: number, maxLevel: number) {
  const [dailySnap, achievementSnap, garage, profile, firstHour] = await tx.getAll(dailyRef(uid), achievementsRef(uid), db.doc(`Players/${uid}/Garage/Cars`), db.doc(`Players/${uid}/Profile/Profile`), db.doc(`Players/${uid}/Progress/FirstHour`));
  if (!profile.exists) throw new HttpsError("failed-precondition", "Player profile not found.");
  const data = profile.data()!;
  const mastery = await getMasteryConfig();
  const rank = Number((typeof data.pinnedMasteryRank === "number" && Number.isFinite(data.pinnedMasteryRank) ? data.pinnedMasteryRank : undefined) ?? (typeof data.masteryXp === "number" ? getMasteryRank(data.masteryXp, mastery) : data.masteryRank ?? 0));
  defs = eligibleDefinitions(defs, rank, firstHour.data(), achievementSnap.data()?.claimed, typeof data.level === "number" && Number.isFinite(data.level) ? data.level : rank, Object.entries(garage.data()?.cars ?? {}).some(([carId, car]: [string, any]) => car && car.owned !== false && !(achievementSnap.data()?.carsRaced ?? []).includes(carId)));
  const daily = resolveDaily(uid, now, defs, dailySnap.data() as DailyState | undefined);
  const achievements = achievementState(achievementSnap.data());
  refreshAccountProgress(defs, achievements, garage.data()?.cars ?? {}, maxLevel);
  return { defs, daily, achievements, profile: profile.data()!, dailyChanged: JSON.stringify(dailySnap.data()) !== JSON.stringify(daily), achievementsChanged: JSON.stringify(achievementSnap.data()) !== JSON.stringify(achievements) };
}
export const getChallengesStatus = onCall(callableOptions(), async request => {
  const { uid, defs, now, maxCarLevel } = await context(request);
  return db.runTransaction(async tx => {
    const state = await readState(tx, uid, defs, now, maxCarLevel);
    if (state.dailyChanged) tx.set(dailyRef(uid), state.daily);
    if (state.achievementsChanged) tx.set(achievementsRef(uid), state.achievements);
    return statusView(now, state.defs, state.daily, state.achievements);
  });
});
type Action = "claimDailyChallenge" | "claimAchievement";
function actionCallable(action: Action) {
  return onCall(callableOptions(), async request => {
    const { uid, defs, now, maxCarLevel } = await context(request);
    const data = request.data ?? {};
    const opId = id(data.opId, "opId");
    const target = id(action === "claimAchievement" ? data.achievementId : data.challengeId, "objectiveId");
    const hash = createHash("sha256").update(JSON.stringify({ action, target })).digest("hex");
    const receipt = db.doc(`Players/${uid}/Receipts/${opId}`);
    const existingReceipt = (await receipt.get()).data();
    if (existingReceipt && (existingReceipt.kind !== action || existingReceipt.inputsHash !== hash)) throw new HttpsError("invalid-argument", "opId belongs to a different action.");
    if (existingReceipt?.status === "completed") return existingReceipt.result;
    if (existingReceipt?.status === "in_progress") throw new HttpsError("aborted", "This action is already in progress.");
    return db.runTransaction(async tx => {
      const receiptSnap = await tx.get(receipt);
      const previous = receiptSnap.data();
      if (previous && (previous.kind !== action || previous.inputsHash !== hash)) throw new HttpsError("invalid-argument", "opId belongs to a different action.");
      if (previous?.status === "completed") return previous.result;
      if (previous?.status === "in_progress") throw new HttpsError("aborted", "This action is already in progress.");

      const state = await readState(tx, uid, defs, now, maxCarLevel);
      const { daily, achievements } = state;
      let reward: { rewards: Objective["rewards"] } = { rewards: [] };
      if (action === "claimDailyChallenge") {
        const challenge = daily.challenges.find(c => c.objective.id === target);
        if (!challenge) throw new HttpsError("not-found", "Challenge is no longer active.");
        if (challenge.claimed || challenge.progress < challenge.objective.target) throw new HttpsError("failed-precondition", "Challenge is not claimable.");
        challenge.claimed = true;
        reward = challenge.objective;
      } else {
        const objective = state.defs.achievements.find(o => o.id === target);
        if (!objective) throw new HttpsError("not-found", "Achievement does not exist.");
        if (achievements.claimed[objective.id] || (achievements.progress[objective.id] ?? 0) < objective.target ||
            (objective.chainId && defs.achievements.some(o => o.chainId === objective.chainId && (o.tier ?? 0) < (objective.tier ?? 0) && !achievements.claimed[o.id]))) throw new HttpsError("failed-precondition", "Achievement is not claimable.");
        achievements.claimed[objective.id] = true;
        reward = objective;
      }
      const bundle = await prepareRewardBundle(tx, uid, reward.rewards);
      const granted = await applyRewardBundle(tx, uid, bundle);
      tx.set(dailyRef(uid), daily);
      tx.set(achievementsRef(uid), achievements);
      const result = { success: true, status: statusView(now, state.defs, daily, achievements), rewards: rewardView(reward), coins: granted.coins, gems: granted.gems, xp: 0 };
      tx.set(receipt, {
        opId,
        status: "completed",
        kind: action,
        inputsHash: hash,
        reason: action,
        createdAtMs: previous?.createdAtMs ?? now,
        result: sanitizeForFirestore(result),
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return result;
    });
  });
}
export const claimDailyChallenge = actionCallable("claimDailyChallenge");
export const claimChallengeMilestone = onCall(callableOptions(), async () => {
  throw new HttpsError("failed-precondition", "Daily chest rewards have been removed.");
});
export const swapDailyChallenge = onCall(callableOptions(), async () => {
  throw new HttpsError("failed-precondition", "Challenge swapping has been removed.");
});
export const claimAchievement = actionCallable("claimAchievement");
