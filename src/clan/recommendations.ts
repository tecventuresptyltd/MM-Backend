import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import { clansCollection, requireAuth } from "./helpers.js";

const RECOMMENDED_POOL_LIMIT = 10;
const HEALTHY_MIN_MEMBERS = 1;
const HEALTHY_MAX_MEMBERS = 45;
const CANDIDATE_FETCH_LIMIT = RECOMMENDED_POOL_LIMIT * 2;

export interface RecommendedClanPoolEntry {
  id: string;
  minimumTrophies: number;
  name: string;
  badge: string | null;
  type: string;
  members: number;
  totalTrophies: number;
}

const recommendedClansDocRef = () => db.collection("System").doc("RecommendedClans");

const normalizeRequirement = (value: unknown): number => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return 0;
  }
  return Math.floor(numericValue);
};

const fetchCandidateClans = async (): Promise<RecommendedClanPoolEntry[]> => {
  const snapshot = await clansCollection()
    .orderBy("stats.members", "desc")
    .limit(CANDIDATE_FETCH_LIMIT)
    .get();

  const candidates: RecommendedClanPoolEntry[] = [];
  snapshot.docs.some((doc) => {
    const data = doc.data() ?? {};
    const stats = data.stats ?? {};
    const members = Number(stats.members ?? 0);
    if (data.status !== "active") {
      return false;
    }
    if (data.type !== "anyone can join") {
      return false;
    }
    if (members < HEALTHY_MIN_MEMBERS || members > HEALTHY_MAX_MEMBERS) {
      return false;
    }
    candidates.push({
      id: data.clanId ?? doc.id,
      minimumTrophies: normalizeRequirement(data.minimumTrophies ?? 0),
      name: typeof data.name === "string" && data.name.trim().length > 0 ? data.name : "Clan",
      badge: typeof data.badge === "string" && data.badge.trim().length > 0 ? data.badge : null,
      type: typeof data.type === "string" ? data.type : "anyone can join",
      members,
      totalTrophies: Number(stats.trophies ?? 0),
    });
    return candidates.length >= RECOMMENDED_POOL_LIMIT;
  });
  return candidates;
};

const shuffleEntries = (entries: RecommendedClanPoolEntry[]): RecommendedClanPoolEntry[] => {
  const clone = [...entries];
  for (let i = clone.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [clone[i], clone[j]] = [clone[j], clone[i]];
  }
  return clone;
};

export const rebuildRecommendedClansPool = async (): Promise<{ processed: number }> => {
  const candidates = await fetchCandidateClans();
  const shuffled = shuffleEntries(candidates);
  const payload = {
    updatedAt: admin.firestore.Timestamp.now(),
    poolSize: shuffled.length,
    pool: shuffled,
  };
  await recommendedClansDocRef().set(payload);
  return { processed: shuffled.length };
};

export const recommendedClansPoolJob = onSchedule(
  {
    region: REGION,
    schedule: "every 60 minutes",
    timeZone: "Etc/UTC",
  },
  async () => {
    await rebuildRecommendedClansPool();
  },
);

const normalizePoolEntries = (input: unknown): RecommendedClanPoolEntry[] => {
  if (!Array.isArray(input)) {
    return [];
  }
  const normalized: RecommendedClanPoolEntry[] = [];
  input.forEach((item) => {
    if (!item || typeof item !== "object") {
      return;
    }
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id : null;
    if (!id) {
      return;
    }
    const minimumTrophies = normalizeRequirement(candidate.minimumTrophies ?? candidate.req);
    normalized.push({
      id,
      minimumTrophies,
      name: typeof candidate.name === "string" ? candidate.name : "Clan",
      badge: typeof candidate.badge === "string" ? candidate.badge : null,
      type: typeof candidate.type === "string" ? candidate.type : "anyone can join",
      members: Number(candidate.members ?? 0),
      totalTrophies: Number(candidate.totalTrophies ?? 0),
    });
  });
  return normalized;
};

export const getRecommendedClansPool = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async (request) => {
  requireAuth(request);
  let snapshot = await recommendedClansDocRef().get();
  if (!snapshot.exists) {
    try {
      await rebuildRecommendedClansPool();
    } catch (error) {
      console.error("Failed to rebuild recommended clans pool:", error);
      throw new HttpsError("internal", "Recommendation pool rebuild failed.");
    }
    snapshot = await recommendedClansDocRef().get();
    if (!snapshot.exists) {
      throw new HttpsError("failed-precondition", "Recommendation pool not ready.");
    }
  }
  const data = snapshot.data() ?? {};
  const updatedAt = data.updatedAt instanceof admin.firestore.Timestamp ? data.updatedAt.toMillis() : null;
  const pool = normalizePoolEntries(data.pool);
  return {
    updatedAt,
    pool,
  };
});
