import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import { leaderboardDocRef, playerProfileRef } from "./refs.js";
import {
  LEADERBOARD_METRICS,
  LeaderboardEntry,
  LeaderboardMetric,
} from "./types.js";
import { buildPlayerSummary } from "./summary.js";

const PLAYER_PROFILE_BATCH = 50;
const MAX_ENTRIES = 100;

type ProfileData = FirebaseFirestore.DocumentData;

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
): Promise<Map<string, FirebaseFirestore.DocumentData>> => {
  if (clanIds.size === 0) {
    return new Map();
  }
  const refs = Array.from(clanIds).map((clanId) => db.collection("Clans").doc(clanId));
  const snapshots = await db.getAll(...refs);
  const map = new Map<string, FirebaseFirestore.DocumentData>();
  snapshots.forEach((snapshot, idx) => {
    if (snapshot.exists) {
      map.set(refs[idx].id, snapshot.data() ?? {});
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
    const clanId =
      typeof entry.profile?.clanId === "string" && entry.profile.clanId.trim().length > 0
        ? entry.profile.clanId.trim()
        : null;
    if (clanId) {
      clanIds.add(clanId);
    }
  });
  const clanSnapshots = await loadClanSummaries(clanIds);

  const entries: LeaderboardEntry[] = [];
  let rank = 1;
  for (const candidate of candidates) {
    const clanId =
      typeof candidate.profile?.clanId === "string" && candidate.profile.clanId.trim().length > 0
        ? candidate.profile.clanId.trim()
        : null;
    const rawClanSummary = clanId ? clanSnapshots.get(clanId) : null;
    const playerClanSummary =
      clanId && rawClanSummary
        ? {
            clanId,
            name: String(rawClanSummary.name ?? rawClanSummary.displayName ?? "Clan"),
            tag: rawClanSummary.tag ? String(rawClanSummary.tag).toUpperCase() : undefined,
            badge: rawClanSummary.badge ?? rawClanSummary.badgeId ?? null,
          }
        : null;
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
      schedule: "every 15 minutes",
      timeZone: "Etc/UTC",
    },
    async () => {
      await refreshLeaderboards();
    },
  ),
};
