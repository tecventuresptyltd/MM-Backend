import * as admin from "firebase-admin";
import { Definitions } from "./config.js";
import { achievementState, achievementsRef, advanceProgress, clampRaceStats, DailyState, dailyRef, resolveDaily, RaceContext } from "./state.js";
import { playerClanStateRef } from "../clan/helpers.js";

export const challengeMapId = (value: unknown): string => value === "track_01" ? "0" : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : typeof value === "string" ? value : "";

export async function prepareChallengeRace(tx: FirebaseFirestore.Transaction, defs: Definitions | null, context: Omit<RaceContext, "friendRace" | "clanPoints">, raw: unknown, participants: Array<{ participantId: string | null }>, trophyDelta: number) {
  if (!defs) return null;
  const [dailySnap, achievementSnap, friendsSnap, clanSnap] = await tx.getAll(dailyRef(context.uid), achievementsRef(context.uid), admin.firestore().doc(`Players/${context.uid}/Social/Friends`), playerClanStateRef(context.uid));
  const friends = friendsSnap.data()?.friends ?? {};
  const race: RaceContext = { ...context, friendRace: participants.some(p => !!p.participantId && p.participantId !== context.uid && !!friends[p.participantId]), clanPoints: context.mode === "RANKED" && clanSnap.data()?.clanId ? Math.max(0, trophyDelta) : 0 };
  const daily = resolveDaily(context.uid, context.now, defs, dailySnap.data() as DailyState | undefined);
  const achievements = achievementState(achievementSnap.data());
  const stats = clampRaceStats(raw, race, defs);
  const completed = advanceProgress(defs, daily, achievements, race, stats);
  return { uid: context.uid, daily, achievements, completed };
}
export function applyChallengeRace(tx: FirebaseFirestore.Transaction, plan: Awaited<ReturnType<typeof prepareChallengeRace>>) {
  if (!plan) return { newlyCompletedChallengeIds: [], newlyCompletedAchievementIds: [] };
  tx.set(dailyRef(plan.uid), plan.daily);
  tx.set(achievementsRef(plan.uid), plan.achievements);
  return plan.completed;
}
