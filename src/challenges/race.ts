import * as admin from "firebase-admin";
import { getMasteryConfig, getMasteryRank } from "../core/configV2.js";
import { Definitions, eligibleDefinitions } from "./config.js";
import { achievementState, achievementsRef, advanceProgress, clampRaceStats, DailyState, dailyRef, resolveDaily, RaceContext } from "./state.js";
import { playerClanStateRef } from "../clan/helpers.js";

export const challengeMapId = (value: unknown): string => value === "track_01" ? "0" : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : typeof value === "string" ? value : "";

export async function prepareChallengeRace(tx: FirebaseFirestore.Transaction, defs: Definitions | null, context: Omit<RaceContext, "friendRace" | "clanPoints">, raw: unknown, participants: Array<{ participantId: string | null }>, trophyDelta: number) {
  if (!defs) return null;
  const [dailySnap, achievementSnap, friendsSnap, clanSnap, profileSnap, firstHourSnap, garageSnap] = await tx.getAll(dailyRef(context.uid), achievementsRef(context.uid), admin.firestore().doc(`Players/${context.uid}/Social/Friends`), playerClanStateRef(context.uid), admin.firestore().doc(`Players/${context.uid}/Profile/Profile`), admin.firestore().doc(`Players/${context.uid}/Progress/FirstHour`), admin.firestore().doc(`Players/${context.uid}/Garage/Cars`));
  const profile = profileSnap.data() ?? {};
  const mastery = await getMasteryConfig();
  const rank = Number((typeof profile.pinnedMasteryRank === "number" && Number.isFinite(profile.pinnedMasteryRank) ? profile.pinnedMasteryRank : undefined) ?? (typeof profile.masteryXp === "number" ? getMasteryRank(profile.masteryXp, mastery) : profile.masteryRank ?? 0));
  defs = eligibleDefinitions(defs, rank, firstHourSnap.data(), achievementSnap.data()?.claimed, typeof profile.level === "number" && Number.isFinite(profile.level) ? profile.level : rank, Object.entries(garageSnap.data()?.cars ?? {}).some(([carId, car]: [string, any]) => car && car.owned !== false && !(achievementSnap.data()?.carsRaced ?? []).includes(carId)));
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
