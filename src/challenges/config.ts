import { createHash } from "node:crypto";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { RewardLine } from "../shared/rewardLines.js";
import { getDailyRewardsConfig } from "../core/configV2.js";

export interface Objective {
  id: string; title: string; description: string; iconKey: string; stat: string; target: number;
  hard?: boolean; unit?: string; aggregation?: "sum" | "max"; filters?: Record<string, string | number>;
  rewards: RewardLine[]; shards?: number; xp?: number; category?: string; tier?: number; points?: number;
  hidden?: boolean; chainId?: string;
}
export interface ChallengesConfig {
  version: string; enabled: boolean; dailyCount: number; hardCount: number; swapCost: number; swapsPerDay: number;
  maxRaceSeconds: number; driftMetresPerSecond: number; statClamps: Record<string, number>; requiredMapIds: string[];
  modeUnlockRanks?: Record<string, number>; socialUnlockRank?: number; unrankedUnlockRaces?: number;
  milestones: Array<{ target: number; rewards: RewardLine[]; shards?: number }>;
}
export interface Definitions { isObjectiveEligible?: (objective: Objective) => boolean; lockedModes?: string[]; config: ChallengesConfig; challenges: Objective[]; achievements: Objective[]; resetOffsetMinutes: number }
let cached: { at: number; value: Definitions | null } | null = null;
export function resetChallengesCache(): void { cached = null; }
const finite = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isFinite(value) && value >= min;
export function normalizeObjective(o: Objective): Objective {
  const { xp, shards, points, ...objective } = o;
  return { ...objective, rewards: [{ kind: "gems", quantity: 20 }] };
}
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
export function parseDefinitions(config: any, challenges: any, achievements: any, offset: number): Definitions {
  if (!config || typeof config.enabled !== "boolean" || !finite(config.dailyCount, 1) || !Number.isInteger(config.dailyCount) ||
      !finite(config.hardCount) || !Number.isInteger(config.hardCount) || config.hardCount > config.dailyCount ||
      !finite(config.maxRaceSeconds, 1) || !finite(config.driftMetresPerSecond, 1) || !config.statClamps ||
      !Object.values(config.statClamps).every(v => finite(v)) || !Array.isArray(config.requiredMapIds)) {
    throw new HttpsError("failed-precondition", "Invalid challenges configuration.");
  }
  const parse = (raw: any, achievement: boolean): Objective[] => {
    if (!Array.isArray(raw?.entries)) throw new HttpsError("failed-precondition", "Missing challenges catalog.");
    const ids = new Set<string>();
    return raw.entries.filter((o: any) => o.enabled !== false).map((o: Objective) => {
      if (!validId(o.id) || ids.has(o.id) || !finite(o.target, 1) || typeof o.stat !== "string" ||
          typeof o.title !== "string" || typeof o.description !== "string" || (achievement && ![1, 2, 3].includes(o.tier ?? 0))) {
        throw new HttpsError("failed-precondition", "Invalid challenge objective.");
      }
      ids.add(o.id);
      return normalizeObjective(o);
    });
  };
  const daily = parse(challenges, false);
  if (daily.filter(o => !!o.hard).length < config.hardCount || daily.filter(o => !o.hard).length < config.dailyCount - config.hardCount) {
    throw new HttpsError("failed-precondition", "Challenge pool is too small.");
  }
  const modeUnlockRanks = Object.fromEntries(Object.entries({ ELIMINATION: 5, POLICE: 10, INFECTED: 15 }).map(([mode, fallback]) => [mode, finite(config.modeUnlockRanks?.[mode]) ? config.modeUnlockRanks[mode] : fallback]));
  config = { ...config, milestones: [], swapCost: 0, swapsPerDay: 0,
    modeUnlockRanks,
    socialUnlockRank: finite(config.socialUnlockRank) ? config.socialUnlockRank : 5, unrankedUnlockRaces: finite(config.unrankedUnlockRaces) ? config.unrankedUnlockRaces : 1 };
  return { config, challenges: daily, achievements: parse(achievements, true), resetOffsetMinutes: offset };
}
export async function getChallengesDefinitions(required = true): Promise<Definitions | null> {
  if (cached && !process.env.FIRESTORE_EMULATOR_HOST && Date.now() - cached.at < 60_000) {
    if (required && !cached.value) throw new HttpsError("unavailable", "Challenges are not enabled.");
    return cached.value;
  }
  const db = admin.firestore();
  const snaps = await db.getAll(db.doc("GameData/v1/config/ChallengesConfig"), db.doc("GameData/v1/catalogs/ChallengesCatalog"), db.doc("GameData/v1/catalogs/AchievementsCatalog"));
  if (!snaps[0].exists || snaps[0].data()?.enabled !== true) {
    cached = { at: Date.now(), value: null };
    if (required) throw new HttpsError("unavailable", "Challenges are not enabled.");
    return null;
  }
  const rewards = await getDailyRewardsConfig();
  const value = parseDefinitions(snaps[0].data(), snaps[1].data(), snaps[2].data(), rewards.resetOffsetMinutes);
  cached = { at: Date.now(), value };
  return value;
}
export const stableOrder = (entries: Objective[], seed: string): Objective[] => [...entries].sort((a, b) => {
  const hash = (id: string) => createHash("sha256").update(`${seed}:${id}`).digest("hex");
  return hash(a.id).localeCompare(hash(b.id));
});

export function eligibleDefinitions(defs: Definitions, rank: number, firstHour: any, claimed: Record<string, boolean> = {}, socialLevel = rank, hasUnracedCar = true): Definitions {
  const lockedModes = firstHour?.active === true ? Object.entries(defs.config.modeUnlockRanks ?? { ELIMINATION: 5, POLICE: 10, INFECTED: 15 }).filter(([, required]) => rank < required).map(([mode]) => mode) : [];
  if (firstHour?.active === true && Number(firstHour.racesCompleted ?? 0) < (defs.config.unrankedUnlockRaces ?? 1)) lockedModes.push("UNRANKED");
  const eligible = (o: Objective) => {
    const mode = o.filters?.mode ?? ({ policeEscapes: "POLICE", eliminationWins: "ELIMINATION", infectedWins: "INFECTED" } as Record<string, string>)[o.stat];
    return !(o.stat === "newCarWin" && !hasUnracedCar) && !(typeof mode === "string" && lockedModes.includes(mode)) && !(["friendRaces", "clanPoints"].includes(o.stat) && socialLevel < (defs.config.socialUnlockRank ?? 5));
  };
  return { ...defs, lockedModes, isObjectiveEligible: eligible, challenges: defs.challenges.filter(eligible), achievements: defs.achievements.filter(o => eligible(o) || claimed[o.id]) };
}
