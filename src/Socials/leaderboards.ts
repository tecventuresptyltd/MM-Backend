import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { hashOperationInputs } from "../core/hash.js";
import { db } from "../shared/firestore.js";
import {
  LEADERBOARD_METRICS,
  LeaderboardMetric,
  PlayerProfileSeed,
  PlayerSummary,
} from "./types.js";
import { buildPlayerSummary, fetchClanSummary } from "./summary.js";

const PAGE_MIN = 1;
const PAGE_MAX = 100;
const PAGE_DEFAULT = 50;

interface LeaderboardPlayer {
  avatarId: number;
  displayName: string;
  level: number;
  rank: number;
  stat: number;
  uid: string;
  clan?: {
    clanId: string;
    clanName: string;
    clanTag: string;
  } | null;
}

interface LeaderboardResponseEntry {
  rank: number;
  stat: number;
  player: PlayerSummary;
}

const legacyTypeToMetric = (type?: unknown): LeaderboardMetric | null => {
  if (typeof type !== "number") {
    return null;
  }
  return (
    (Object.entries(LEADERBOARD_METRICS).find(
      ([, config]) => config.legacyType === type,
    )?.[0] as LeaderboardMetric | undefined) ?? null
  );
};

const resolveMetric = (rawMetric?: unknown, rawType?: unknown): LeaderboardMetric => {
  if (typeof rawMetric === "string" && rawMetric in LEADERBOARD_METRICS) {
    return rawMetric as LeaderboardMetric;
  }
  const legacyMetric = legacyTypeToMetric(Number(rawType));
  if (legacyMetric) {
    return legacyMetric;
  }
  if (!rawMetric && !rawType) {
    return "trophies";
  }
  throw new HttpsError(
    "invalid-argument",
    "metric must be one of trophies, careerCoins, or totalWins.",
  );
};

const resolvePageSize = (raw?: unknown): number => {
  if (raw === undefined || raw === null) {
    return PAGE_DEFAULT;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < PAGE_MIN || value > PAGE_MAX) {
    throw new HttpsError(
      "invalid-argument",
      `pageSize must be between ${PAGE_MIN} and ${PAGE_MAX}.`,
    );
  }
  return Math.floor(value);
};

const encodePageToken = (metric: LeaderboardMetric, offset: number): string =>
  Buffer.from(JSON.stringify({ metric, offset }), "utf8").toString("base64url");

const decodePageToken = (
  expectedMetric: LeaderboardMetric,
  token?: unknown,
): number => {
  if (!token) {
    return 0;
  }
  if (typeof token !== "string") {
    throw new HttpsError("invalid-argument", "pageToken must be a string.");
  }
  try {
    const payload = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8"),
    ) as { metric?: string; offset?: number };
    if (payload.metric !== expectedMetric) {
      throw new Error("metric mismatch");
    }
    if (!Number.isFinite(payload.offset) || payload.offset! < 0) {
      throw new Error("invalid offset");
    }
    return payload.offset ?? 0;
  } catch {
    throw new HttpsError("invalid-argument", "Invalid pageToken.");
  }
};

const sanitizeMetricValue = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const fallbackSummary = (uid: string): PlayerSummary => ({
  uid,
  displayName: "Racer",
  avatarId: 1,
  level: 1,
  trophies: 0,
  clan: null,
});

const extractClanId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

interface ProfileEntry {
  uid: string;
  profile: FirebaseFirestore.DocumentData;
}

const fetchPlayerProfiles = async (): Promise<ProfileEntry[]> => {
  const snapshot = await db.collectionGroup("Profile").get();
  const result: ProfileEntry[] = [];
  snapshot.forEach((doc) => {
    if (doc.id !== "Profile") {
      return;
    }
    const profileCollection = doc.ref.parent;
    const playerDoc = profileCollection.parent;
    if (!playerDoc) {
      return;
    }
    const playersCollection = playerDoc.parent;
    if (!playersCollection || playersCollection.id !== "Players") {
      return;
    }
    result.push({ uid: playerDoc.id, profile: doc.data() ?? {} });
  });
  return result;
};

const compareEntries = (
  a: { value: number; summaryName: string; uid: string },
  b: { value: number; summaryName: string; uid: string },
) => {
  if (b.value !== a.value) {
    return b.value - a.value;
  }
  const nameCompare = a.summaryName.localeCompare(b.summaryName);
  if (nameCompare !== 0) {
    return nameCompare;
  }
  return a.uid.localeCompare(b.uid);
};

export const getGlobalLeaderboard = onCall(
  callableOptions(),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const metric = resolveMetric(request.data?.metric, request.data?.type);
    const pageSize = resolvePageSize(
      request.data?.pageSize ?? request.data?.limit,
    );
    const offset = decodePageToken(metric, request.data?.pageToken);

    const profiles = await fetchPlayerProfiles();
    const metricField = LEADERBOARD_METRICS[metric].field;

    const sorted = profiles
      .map(({ uid: profileUid, profile }) => {
        const value = sanitizeMetricValue(profile[metricField]);
        const summary = buildPlayerSummary(profileUid, profile, null);
        const summaryName = summary?.displayName ?? "";
        return { uid: profileUid, profile, value, summary, summaryName };
      })
      .sort((a, b) => compareEntries(a, b));

    const totalEntries = sorted.length;
    const slice = sorted.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;
    const pageToken =
      nextOffset < totalEntries ? encodePageToken(metric, nextOffset) : null;

    const clanIds = new Set<string>();
    slice.forEach((entry) => {
      const clanId = extractClanId(entry.profile?.clanId);
      if (clanId) {
        clanIds.add(clanId);
      }
    });

    const clanMap = new Map<string, PlayerSummary["clan"]>();
    await Promise.all(
      Array.from(clanIds).map(async (clanId) => {
        const summary = await fetchClanSummary(clanId);
        clanMap.set(clanId, summary);
      }),
    );

    const entries: LeaderboardResponseEntry[] = slice.map((entry, idx) => {
      const statValue = entry.value;
      const clanId = extractClanId(entry.profile?.clanId);
      const clanSummary = clanId ? clanMap.get(clanId) ?? null : null;
      const playerSummary =
        buildPlayerSummary(entry.uid, entry.profile as PlayerProfileSeed, clanSummary) ??
        entry.summary ??
        fallbackSummary(entry.uid);
      return {
        rank: offset + idx + 1,
        stat: statValue,
        player: playerSummary,
      };
    });

    const players: LeaderboardPlayer[] = entries.map((entry) => ({
      avatarId: entry.player.avatarId,
      displayName: entry.player.displayName,
      level: entry.player.level,
      rank: entry.rank,
      stat: entry.stat,
      uid: entry.player.uid,
      clan: entry.player.clan ? {
        clanId: entry.player.clan.clanId,
        clanName: entry.player.clan.name,
        clanTag: entry.player.clan.tag || "",
      } : null,
    }));

    const youIndex = sorted.findIndex((entry) => entry.uid === uid);
    let myRank: number | null = null;
    if (youIndex >= 0) {
      myRank = youIndex + 1;
    }

    const response = {
      myRank,
      leaderboardType: LEADERBOARD_METRICS[metric].legacyType,
      players,
    };

    return response;
  },
);
