import { onSchedule } from "firebase-functions/v2/scheduler";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import { leaderboardDocRef, playerProfileRef } from "./refs.js";
import {
  LEADERBOARD_METRICS,
  LeaderboardEntry,
  LeaderboardMetric,
  PlayerSummary,
} from "./types.js";
import { buildPlayerSummary } from "./summary.js";

const PLAYER_PROFILE_BATCH = 50;
const MAX_ENTRIES = 100;

type ProfileData = FirebaseFirestore.DocumentData;

const normalizeString = (value: unknown, fallback = ""): string => {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
};

const normalizeBadge = (value: unknown): string | null => {
  const normalized = normalizeString(value, "");
  return normalized.length > 0 ? normalized : null;
};

const extractClanId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeMetricValue = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const fetchAllPlayerProfiles = async (): Promise<Map<string, ProfileData>> => {
  const playersSnapshot = await db.collection("Players").get();
  const uids = playersSnapshot.docs.map((doc) => doc.id);
  const profiles = new Map<string, ProfileData>();

  for (let i = 0; i < uids.length; i += PLAYER_PROFILE_BATCH) {
    const slice = uids.slice(i, i + PLAYER_PROFILE_BATCH);
    const refs = slice.map((uid) => playerProfileRef(uid));
    const snapshots = await db.getAll(...refs);
    snapshots.forEach((snap, idx) => {
      if (snap.exists) {
        profiles.set(slice[idx], snap.data() ?? {});
      }
    });
  }

  return profiles;
};

const loadClanSummaries = async (
  clanIds: Set<string>,
): Promise<Map<string, PlayerSummary["clan"]>> => {
  if (clanIds.size === 0) {
    return new Map();
  }
  const refs = Array.from(clanIds).map((clanId) => db.collection("Clans").doc(clanId));
  const snapshots = await db.getAll(...refs);
  const map = new Map<string, PlayerSummary["clan"]>();
  snapshots.forEach((snapshot, idx) => {
    if (snapshot.exists) {
      const data = snapshot.data() ?? {};
      map.set(refs[idx].id, {
        clanId: refs[idx].id,
        name: normalizeString(data.name ?? data.displayName, "Clan"),
        badge: normalizeBadge(data.badge ?? data.badgeId),
      });
    }
  });
  return map;
};

const toLeaderboardEntries = async (
  metric: LeaderboardMetric,
  profiles: Map<string, ProfileData>,
): Promise<LeaderboardEntry[]> => {
  const metricField = LEADERBOARD_METRICS[metric].field;
  const candidates = Array.from(profiles.entries())
    .map(([uid, profile]) => ({
      uid,
      profile,
      value: sanitizeMetricValue(profile[metricField]),
    }))
    .filter((entry) => entry.value >= 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_ENTRIES);

  const clanIds = new Set<string>();
  candidates.forEach((entry) => {
    const clanId = extractClanId(entry.profile?.clanId);
    if (clanId) {
      clanIds.add(clanId);
    }
  });
  const clanSnapshots = await loadClanSummaries(clanIds);

  const entries: LeaderboardEntry[] = [];
  let rank = 1;
  for (const candidate of candidates) {
    const clanId = extractClanId(candidate.profile?.clanId);
    const playerClanSummary = clanId ? clanSnapshots.get(clanId) ?? null : null;
    const summary = buildPlayerSummary(candidate.uid, candidate.profile, playerClanSummary);
    if (!summary) {
      continue;
    }
    entries.push({
      uid: candidate.uid,
      value: candidate.value,
      rank,
      snapshot: summary,
    });
    rank += 1;
  }
  return entries;
};

const persistEntries = async (metric: LeaderboardMetric, entries: LeaderboardEntry[]) => {
  const youCache = entries.reduce<Record<string, { rank: number; value: number }>>(
    (acc, entry) => {
      acc[entry.uid] = { rank: entry.rank, value: entry.value };
      return acc;
    },
    {},
  );

  await leaderboardDocRef(metric).set({
    metric,
    updatedAt: Date.now(),
    top100: entries,
    youCache,
  });
};

export const refreshLeaderboards = async (): Promise<{ metrics: number }> => {
  const profiles = await fetchAllPlayerProfiles();
  for (const metric of Object.keys(LEADERBOARD_METRICS) as LeaderboardMetric[]) {
    const entries = await toLeaderboardEntries(metric, profiles);
    await persistEntries(metric, entries);
    console.log(
      `[leaderboards.refreshAll] Updated metric=${metric} with ${entries.length} entries`,
    );
  }
  return { metrics: Object.keys(LEADERBOARD_METRICS).length };
};

export const leaderboards = {
  refreshAll: onSchedule(
    {
      region: REGION,
      schedule: "every 6 hours",
      timeZone: "Etc/UTC",
    },
    async () => {
      await refreshLeaderboards();
    },
  ),
};
