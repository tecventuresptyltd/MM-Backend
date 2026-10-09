import * as admin from "firebase-admin";
import { createHash } from "node:crypto";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { assertNotInMaintenance } from "../shared/maintenanceCheck.js";
import { getCarEvolutionV2Catalog, getMasteryConfig, getMasteryRank, getMasteryProgress } from "../core/configV2.js";
import { applyRewardBundle, prepareRewardBundle } from "../shared/rewardBundle.js";
import { sanitizeForFirestore } from "../core/idempotency.js";
import { Definitions, getChallengesDefinitions, Objective, stableOrder } from "./config.js";
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
  await assertNotInMaintenance(uid);
  const evolution = await getCarEvolutionV2Catalog();
  return { uid, defs, now: nowFor(request.data), maxCarLevel: evolution.maxStarLevel };
}
async function readState(tx: FirebaseFirestore.Transaction, uid: string, defs: Definitions, now: number, maxLevel: number) {
  const [dailySnap, achievementSnap, garage, profile] = await tx.getAll(dailyRef(uid), achievementsRef(uid), db.doc(`Players/${uid}/Garage/Cars`), db.doc(`Players/${uid}/Profile/Profile`));
  if (!profile.exists) throw new HttpsError("failed-precondition", "Player profile not found.");
  const daily = resolveDaily(uid, now, defs, dailySnap.data() as DailyState | undefined);
  const achievements = achievementState(achievementSnap.data());
  refreshAccountProgress(defs, achievements, garage.data()?.cars ?? {}, maxLevel);
  return { daily, achievements, profile: profile.data()!, dailyChanged: JSON.stringify(dailySnap.data()) !== JSON.stringify(daily), achievementsChanged: JSON.stringify(achievementSnap.data()) !== JSON.stringify(achievements) };
}
export const getChallengesStatus = onCall(callableOptions(), async request => {
  const { uid, defs, now, maxCarLevel } = await context(request);
  return db.runTransaction(async tx => {
    const state = await readState(tx, uid, defs, now, maxCarLevel);
    if (state.dailyChanged) tx.set(dailyRef(uid), state.daily);
    if (state.achievementsChanged) tx.set(achievementsRef(uid), state.achievements);
    return statusView(now, defs, state.daily, state.achievements);
  });
});
type Action = "claimDailyChallenge" | "claimChallengeMilestone" | "swapDailyChallenge" | "claimAchievement";
function actionCallable(action: Action) {
  return onCall(callableOptions(), async request => {
    const { uid, defs, now, maxCarLevel } = await context(request);
    const data = request.data ?? {};
    const opId = id(data.opId, "opId");
    const target = action === "claimChallengeMilestone" ? data.milestoneIndex : id(action === "claimAchievement" ? data.achievementId : data.challengeId, "objectiveId");
    if (action === "claimChallengeMilestone" && (!Number.isInteger(target) || target < 0 || target >= defs.config.milestones.length)) throw new HttpsError("invalid-argument", "milestoneIndex is invalid.");
    const hash = createHash("sha256").update(JSON.stringify({ action, target })).digest("hex");
    const receipt = db.doc(`Players/${uid}/Receipts/${opId}`);
    const existingReceipt = (await receipt.get()).data();
    if (existingReceipt && (existingReceipt.kind !== action || existingReceipt.inputsHash !== hash)) throw new HttpsError("invalid-argument", "opId belongs to a different action.");
    if (existingReceipt?.status === "completed") return existingReceipt.result;
    if (existingReceipt?.status === "in_progress") throw new HttpsError("aborted", "This action is already in progress.");
    const mastery = await getMasteryConfig();
    return db.runTransaction(async tx => {
      const receiptSnap = await tx.get(receipt);
      const previous = receiptSnap.data();
      if (previous && (previous.kind !== action || previous.inputsHash !== hash)) throw new HttpsError("invalid-argument", "opId belongs to a different action.");
      if (previous?.status === "completed") return previous.result;
      if (previous?.status === "in_progress") throw new HttpsError("aborted", "This action is already in progress.");

      const state = await readState(tx, uid, defs, now, maxCarLevel);
      const { daily, achievements } = state;
      let reward: { rewards: Objective["rewards"]; shards?: number; xp?: number } = { rewards: [] };
      if (action === "claimDailyChallenge" || action === "swapDailyChallenge") {
        const challenge = daily.challenges.find(c => c.objective.id === target);
        if (!challenge) throw new HttpsError("not-found", "Challenge is no longer active.");
        if (action === "claimDailyChallenge") {
          if (challenge.claimed || challenge.progress < challenge.objective.target) throw new HttpsError("failed-precondition", "Challenge is not claimable.");
          challenge.claimed = true;
          reward = challenge.objective;
        } else {
          if (challenge.claimed || challenge.progress >= challenge.objective.target || daily.swapsUsed >= defs.config.swapsPerDay) throw new HttpsError("failed-precondition", "Challenge cannot be swapped.");
          const excluded = new Set([...daily.retiredIds, ...daily.challenges.map(c => c.objective.id)]);
          const replacement = stableOrder(defs.challenges.filter(o => !!o.hard === !!challenge.objective.hard && !excluded.has(o.id)), `${uid}:${daily.dayIndex}:swap:${daily.swapsUsed}`)[0];
          if (!replacement) throw new HttpsError("failed-precondition", "No replacement challenge is available.");
          daily.retiredIds.push(challenge.objective.id);
          challenge.objective = replacement;
          challenge.progress = 0;
          daily.swapsUsed++;
        }
      } else if (action === "claimChallengeMilestone") {
        const index = Number(target);
        const milestone = defs.config.milestones[index];
        if (daily.milestonesClaimed.includes(index) || daily.challenges.filter(c => c.progress >= c.objective.target).length < milestone.target) throw new HttpsError("failed-precondition", "Milestone is not claimable.");
        daily.milestonesClaimed.push(index);
        reward = milestone;
      } else {
        const objective = defs.achievements.find(o => o.id === target);
        if (!objective) throw new HttpsError("not-found", "Achievement does not exist.");
        if (achievements.claimed[objective.id] || (achievements.progress[objective.id] ?? 0) < objective.target ||
            (objective.chainId && defs.achievements.some(o => o.chainId === objective.chainId && (o.tier ?? 0) < (objective.tier ?? 0) && !achievements.claimed[o.id]))) throw new HttpsError("failed-precondition", "Achievement is not claimable.");
        achievements.claimed[objective.id] = true;
        achievements.points += objective.points ?? 0;
        reward = objective;
      }
      const bundle = await prepareRewardBundle(tx, uid, reward.rewards);
      if (action === "swapDailyChallenge" && bundle.economyBefore.gems < defs.config.swapCost) throw new HttpsError("resource-exhausted", "Not enough gems.");
      const granted = await applyRewardBundle(tx, uid, bundle);
      if (action === "swapDailyChallenge") {
        tx.set(bundle.economyRef, { gems: admin.firestore.FieldValue.increment(-defs.config.swapCost) }, { merge: true });
        granted.gems.after -= defs.config.swapCost;
      }
      if (reward.shards) tx.set(bundle.economyRef, { spellShards: admin.firestore.FieldValue.increment(reward.shards) }, { merge: true });
      if (reward.xp) {
        const masteryXp = Number(state.profile.masteryXp ?? 0) + reward.xp;
        const rank = state.profile.pinnedMasteryRank ?? getMasteryRank(masteryXp, mastery);
        const progress = getMasteryProgress(masteryXp, mastery);
        tx.set(db.doc(`Players/${uid}/Profile/Profile`), { masteryXp, masteryRank: rank, level: rank,
          expProgress: state.profile.pinnedMasteryRank ? 0 : progress.expProgress,
          expToNextLevel: state.profile.pinnedMasteryRank ? 0 : progress.expToNextLevel,
          expProgressDisplay: state.profile.pinnedMasteryRank ? "Max Rank" : progress.expProgressDisplay }, { merge: true });
      }
      tx.set(dailyRef(uid), daily);
      tx.set(achievementsRef(uid), achievements);
      const result = { success: true, status: statusView(now, defs, daily, achievements), rewards: rewardView(reward), coins: granted.coins, gems: granted.gems, xp: reward.xp ?? 0 };
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
export const claimChallengeMilestone = actionCallable("claimChallengeMilestone");
export const swapDailyChallenge = actionCallable("swapDailyChallenge");
export const claimAchievement = actionCallable("claimAchievement");
