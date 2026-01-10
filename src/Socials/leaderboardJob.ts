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
import * as admin from "firebase-admin";

const PLAYER_PROFILE_BATCH = 50;
const MAX_ENTRIES = 100;
const FLAG_BATCH_WRITE_LIMIT = 450;

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
  await leaderboardDocRef(metric).set({
    metric,
    updatedAt: Date.now(),
    top100: entries,
  });
};

const loadPreviousEntries = async (
  metric: LeaderboardMetric,
): Promise<LeaderboardEntry[]> => {
  const snapshot = await leaderboardDocRef(metric).get();
  if (!snapshot.exists) {
    return [];
  }
  const data = snapshot.data() ?? {};
  const entries = Array.isArray(data.top100) ? data.top100 : [];
  return entries
    .map((entry: any) => ({
      uid: entry?.uid,
      value: Number(entry?.value ?? 0),
      rank: Number(entry?.rank ?? 0),
      snapshot: entry?.snapshot,
    }))
    .filter((entry) => typeof entry.uid === "string" && entry.uid.length > 0);
};

const chunkArray = <T>(items: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
};

const syncPlayerTop100Flags = async (
  metric: LeaderboardMetric,
  newEntries: LeaderboardEntry[],
  previousEntries: LeaderboardEntry[],
): Promise<void> => {
  const newUids = new Set(newEntries.map((entry) => entry.uid));
  const previousUids = new Set(previousEntries.map((entry) => entry.uid));
  const affected = Array.from(new Set([...newUids, ...previousUids]));

  if (affected.length === 0) {
    return;
  }

  const batches = chunkArray(affected, PLAYER_PROFILE_BATCH);
  for (const batchUids of batches) {
    const refs = batchUids.map((uid) => playerProfileRef(uid));
    const snapshots = await db.getAll(...refs);

    const writes = chunkArray(
      snapshots.map((snapshot, idx) => ({ snapshot, ref: refs[idx], uid: batchUids[idx] })),
      FLAG_BATCH_WRITE_LIMIT,
    );

    for (const writeChunk of writes) {
      const batch = db.batch();
      writeChunk.forEach(({ snapshot, ref, uid }) => {
        if (!snapshot.exists) {
          return;
        }
        const data = snapshot.data() ?? {};
        const rawFlags =
          typeof data.top100Flags === "object" && data.top100Flags !== null ? data.top100Flags : {};
        const top100Flags: Record<string, boolean> = {};
        Object.keys(rawFlags).forEach((key) => {
          top100Flags[key] = rawFlags[key] === true;
        });
        top100Flags[metric] = newUids.has(uid);
        const isInTop100 = Object.values(top100Flags).some((value) => value === true);
        batch.set(
          ref,
          {
            top100Flags,
            isInTop100,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      });
      await batch.commit();
    }
  }
};

export const refreshLeaderboards = async (): Promise<{ metrics: number }> => {
  const profiles = await fetchAllPlayerProfiles();
  for (const metric of Object.keys(LEADERBOARD_METRICS) as LeaderboardMetric[]) {
    const previousEntries = await loadPreviousEntries(metric);
    const entries = await toLeaderboardEntries(metric, profiles);
    await persistEntries(metric, entries);
    await syncPlayerTop100Flags(metric, entries, previousEntries);
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
