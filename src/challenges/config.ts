import { createHash } from "node:crypto";
import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";
import { RewardLine, normaliseRewardLines } from "../shared/rewardLines.js";
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
  milestones: Array<{ target: number; rewards: RewardLine[]; shards?: number }>;
}
export interface Definitions { config: ChallengesConfig; challenges: Objective[]; achievements: Objective[]; resetOffsetMinutes: number }
let cached: { at: number; value: Definitions | null } | null = null;
export function resetChallengesCache(): void { cached = null; }
const finite = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isFinite(value) && value >= min;
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
export function parseDefinitions(config: any, challenges: any, achievements: any, offset: number): Definitions {
  if (!config || typeof config.enabled !== "boolean" || !finite(config.dailyCount, 1) || !Number.isInteger(config.dailyCount) ||
      !finite(config.hardCount) || !Number.isInteger(config.hardCount) || config.hardCount > config.dailyCount ||
      !finite(config.swapCost) || !finite(config.swapsPerDay) || !Number.isInteger(config.swapsPerDay) ||
      !finite(config.maxRaceSeconds, 1) || !finite(config.driftMetresPerSecond, 1) || !config.statClamps ||
      !Object.values(config.statClamps).every(v => finite(v)) || !Array.isArray(config.requiredMapIds)) {
    throw new HttpsError("failed-precondition", "Invalid challenges configuration.");
  }
  const parse = (raw: any, achievement: boolean): Objective[] => {
    if (!Array.isArray(raw?.entries)) throw new HttpsError("failed-precondition", "Missing challenges catalog.");
    const ids = new Set<string>();
    return raw.entries.filter((o: any) => o.enabled !== false).map((o: Objective) => {
      if (!validId(o.id) || ids.has(o.id) || !finite(o.target, 1) || typeof o.stat !== "string" ||
          typeof o.title !== "string" || typeof o.description !== "string" || !finite(o.xp ?? 0) ||
          !finite(o.shards ?? 0) || !finite(o.points ?? 0) || (achievement && ![1, 2, 3].includes(o.tier ?? 0))) {
        throw new HttpsError("failed-precondition", "Invalid challenge objective.");
      }
      ids.add(o.id);
      return { ...o, rewards: normaliseRewardLines(o.rewards, o.id) };
    });
  };
  const daily = parse(challenges, false);
  if (daily.filter(o => !!o.hard).length < config.hardCount || daily.filter(o => !o.hard).length < config.dailyCount - config.hardCount) {
    throw new HttpsError("failed-precondition", "Challenge pool is too small.");
  }
  if (!Array.isArray(config.milestones)) throw new HttpsError("failed-precondition", "Missing challenge milestones.");
  config.milestones = config.milestones.map((m: any) => {
    if (!finite(m.target, 1) || m.target > config.dailyCount || !finite(m.shards ?? 0)) throw new HttpsError("failed-precondition", "Invalid milestone.");
    return { ...m, rewards: normaliseRewardLines(m.rewards, "milestone") };
  });
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
