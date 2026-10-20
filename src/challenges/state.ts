import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { Definitions, Objective, normalizeObjective, stableOrder } from "./config.js";
import { gameDayIndex, dayIndexStartMs } from "../dailyRewards/lib/dayIndex.js";

export interface DailyState { dayIndex: number; challenges: Array<{ objective: Objective; progress: number; claimed: boolean }>; milestonesClaimed: number[]; swapsUsed: number; retiredIds: string[] }
export interface AchievementState { progress: Record<string, number>; claimed: Record<string, boolean>; points: number; stats: Record<string, number>; carsRaced: string[]; mapsWon: string[] }
export const emptyAchievements = (): AchievementState => ({ progress: {}, claimed: {}, points: 0, stats: {}, carsRaced: [], mapsWon: [] });
export const dailyRef = (uid: string) => admin.firestore().doc(`Players/${uid}/Challenges/Daily`);
export const achievementsRef = (uid: string) => admin.firestore().doc(`Players/${uid}/Achievements/Progress`);
export function resolveDaily(uid: string, now: number, defs: Definitions, raw?: DailyState): DailyState {
  const dayIndex = gameDayIndex(now, defs.resetOffsetMinutes);
  const pool = stableOrder(defs.challenges, `${uid}:${dayIndex}`);
  const current = raw && raw.dayIndex >= dayIndex && Array.isArray(raw.challenges) ? raw : undefined;
  const valid = new Set(pool.map(o => o.id));
  const kept = current?.challenges.filter(c => c.claimed || (c.objective.stat === "newCarWin" && c.progress >= c.objective.target) || (valid.has(c.objective.id) && (!defs.isObjectiveEligible || defs.isObjectiveEligible(c.objective)))).map(c => ({ ...c, objective: normalizeObjective(c.objective) })) ?? [];
  const excluded = new Set([...kept.map(c => c.objective.id), ...(current?.retiredIds ?? [])]);
  const available = pool.filter(o => !excluded.has(o.id));
  const wantedHard = Math.max(0, defs.config.hardCount - kept.filter(c => c.objective.hard).length);
  const replacements = available.filter(o => o.hard).slice(0, wantedHard);
  replacements.push(...available.filter(o => !o.hard).slice(0, Math.max(0, defs.config.dailyCount - kept.length - replacements.length)));
  replacements.push(...available.filter(o => !replacements.some(r => r.id === o.id)).slice(0, Math.max(0, defs.config.dailyCount - kept.length - replacements.length)));
  const additions = replacements.slice(0, Math.max(0, defs.config.dailyCount - kept.length));
  if (!current) additions.sort((a, b) => Number(!!a.hard) - Number(!!b.hard));
  const challenges = [...kept, ...additions.map(objective => ({ objective, progress: 0, claimed: false }))];
  return { ...(current ?? { milestonesClaimed: [], swapsUsed: 0, retiredIds: [] }), dayIndex: current?.dayIndex ?? dayIndex, challenges };

}
export function achievementState(raw?: Partial<AchievementState>): AchievementState { return { ...emptyAchievements(), ...raw }; }
export function rewardView(o: { rewards: unknown[]; shards?: number }) {
  return [...o.rewards, ...(o.shards ? [{ kind: "spellShards", quantity: o.shards, skuId: null }] : [])];
}
export function statusView(now: number, defs: Definitions, daily: DailyState, achievements: AchievementState) {
  const challenges = daily.challenges.map(c => ({ ...c.objective, rewards: rewardView(c.objective), progress: Math.min(c.progress, c.objective.target), state: c.claimed ? "claimed" : c.progress >= c.objective.target ? "claimable" : "in_progress" }));
  const completedCount = challenges.filter(c => c.state !== "in_progress").length;
  const milestones = defs.config.milestones.map((m, index) => ({ index, target: m.target, rewards: rewardView(m), state: daily.milestonesClaimed.includes(index) ? "claimed" : completedCount >= m.target ? "claimable" : "in_progress" }));
  const visible = defs.achievements.filter(o => !o.chainId || !defs.achievements.some(other => other.chainId === o.chainId && (other.tier ?? 0) < (o.tier ?? 0) && !achievements.claimed[other.id]));
  const entries = visible.filter(o => !o.chainId || !achievements.claimed[o.id] || !defs.achievements.some(other => other.chainId === o.chainId && (other.tier ?? 0) > (o.tier ?? 0))).map(o => {
    const progress = Math.min(achievements.progress[o.id] ?? 0, o.target);
    const hidden = !!o.hidden && progress < o.target && !achievements.claimed[o.id];
    return { ...o, tier: ["Bronze", "Silver", "Gold"][(o.tier ?? 1) - 1], title: hidden ? "???" : o.title, description: hidden ? "Keep racing to reveal" : o.description, rewards: rewardView(o), progress, state: achievements.claimed[o.id] ? "completed" : progress >= o.target ? "claimable" : hidden ? "hidden" : "in_progress" };
  });
  return { serverNowMs: now, resetAtMs: dayIndexStartMs(daily.dayIndex + 1, defs.resetOffsetMinutes), dayIndex: daily.dayIndex, challenges, milestones, achievements: entries, completedCount,
    dailyCount: daily.challenges.length, swapsUsed: 0, swapCost: 0, swapsPerDay: 0,
    dailyClaimableCount: challenges.filter(c => c.state === "claimable").length + milestones.filter(m => m.state === "claimable").length,
    achievementClaimableCount: entries.filter(a => a.state === "claimable").length, achievementPoints: 0 };
}
export interface RaceContext {
  uid: string; raceId: string; now: number; createdAtMs: number; mode: string; mapId: string; carId: string;
  place: number; participants: number; topSpeedKph: number; friendRace: boolean; clanPoints: number;
}
export function clampRaceStats(raw: unknown, context: RaceContext, defs: Definitions): Record<string, number> {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const values: Record<string, number> = {};
  const seconds = Math.min(defs.config.maxRaceSeconds, Math.max(0, (context.now - context.createdAtMs) / 1000));
  for (const [key, max] of Object.entries(defs.config.statClamps)) {
    if (!(key in data)) continue;
    const value = data[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (key !== "driftMetres" && key !== "maxSpeedKph" && !Number.isInteger(value))) {
      logger.warn("challenges.statDropped", { uid: context.uid, raceId: context.raceId, stat: key });
      continue;
    }
    let cap = max;
    if (key === "driftMetres") cap = Math.min(cap, seconds * defs.config.driftMetresPerSecond, seconds * Math.max(0, context.topSpeedKph) / 3.6);
    if (key === "maxSpeedKph") cap = Math.min(cap, Math.max(0, context.topSpeedKph));
    if (key === "startPosition") cap = Math.min(cap, context.participants);
    values[key] = Math.min(value, cap);
    if (key !== "driftMetres" && key !== "maxSpeedKph") values[key] = Math.floor(values[key]);
    if (values[key] !== value) logger.warn("challenges.statClamped", { uid: context.uid, raceId: context.raceId, stat: key, reported: value, accepted: values[key] });
  }
  if ((values.spellsCast ?? 0) > 0 && Array.isArray(data.spellTypesUsed) && data.spellTypesUsed.length <= values.spellsCast && data.spellTypesUsed.every(v => typeof v === "string" && v.length <= 80)) {
    values.spellTypesUsed = new Set(data.spellTypesUsed).size;
  }
  return values;
}
function objectiveValue(o: Objective, event: Record<string, number | string>): number | null {
  for (const [key, expected] of Object.entries(o.filters ?? {})) {
    if (!(key in event) || event[key] !== expected) return null;
  }
  const value = event[o.stat];
  return typeof value === "number" ? value : null;
}
export function advanceProgress(defs: Definitions, daily: DailyState, state: AchievementState, context: RaceContext, stats: Record<string, number>) {
  if (defs.lockedModes?.includes(context.mode)) return { newlyCompletedChallengeIds: [], newlyCompletedAchievementIds: [] };
  const won = context.place === 1;
  const newCar = !!context.carId && !state.carsRaced.includes(context.carId);
  const event: Record<string, number | string> = { ...stats, races: 1, wins: won ? 1 : 0, mode: context.mode, map: context.mapId, car: context.carId, position: context.place,
    policeEscapes: context.mode === "POLICE" && won ? 1 : 0, eliminationWins: context.mode === "ELIMINATION" && won ? 1 : 0,
    friendRaces: context.friendRace ? 1 : 0, clanPoints: context.clanPoints, newCarWin: won && newCar ? 1 : 0 };
  if (stats.startPosition === context.participants && context.participants > 1) {
    event.comebackWins = won ? 1 : 0; event.comebackTopThree = context.place <= 3 ? 1 : 0;
  }
  const newlyCompletedChallengeIds: string[] = [];
  const newlyCompletedAchievementIds: string[] = [];
  for (const c of daily.challenges) {
    const value = objectiveValue(c.objective, event);
    if (value === null || c.claimed || c.progress >= c.objective.target) continue;
    c.progress = Math.min(c.objective.target, c.objective.aggregation === "max" ? Math.max(c.progress, value) : c.progress + value);
    if (c.progress >= c.objective.target) newlyCompletedChallengeIds.push(c.objective.id);
  }
  if (context.carId && !state.carsRaced.includes(context.carId)) state.carsRaced.push(context.carId);
  if (won && context.mapId && defs.config.requiredMapIds.includes(context.mapId) && !state.mapsWon.includes(context.mapId)) state.mapsWon.push(context.mapId);
  event.mapsWon = state.mapsWon.length;
  for (const o of defs.achievements) {
    const value = objectiveValue(o, event);
    if (value === null) continue;
    const before = state.progress[o.id] ?? 0;
    state.progress[o.id] = Math.min(o.target, o.aggregation === "max" ? Math.max(before, value) : before + value);
    if (before < o.target && state.progress[o.id] >= o.target && !state.claimed[o.id]) newlyCompletedAchievementIds.push(o.id);
  }
  for (const [key, value] of Object.entries(event)) if (typeof value === "number") state.stats[key] = key === "maxSpeedKph" ? Math.max(state.stats[key] ?? 0, value) : (state.stats[key] ?? 0) + value;
  return { newlyCompletedChallengeIds, newlyCompletedAchievementIds };
}
export function refreshAccountProgress(defs: Definitions, state: AchievementState, cars: Record<string, any>, maxCarLevel: number): void {
  const owned = Object.values(cars).filter(c => c && c.owned !== false);
  const account: Record<string, number> = { carsOwned: owned.length, maxedCars: owned.filter(c => Number(c.carLevel ?? c.starLevel ?? c.upgradeLevel ?? 0) >= maxCarLevel).length };
  for (const o of defs.achievements) if (o.stat in account) state.progress[o.id] = Math.min(o.target, Math.max(state.progress[o.id] ?? 0, account[o.stat]));
}
