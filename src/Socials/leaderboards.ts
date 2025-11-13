import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { hashOperationInputs } from "../core/hash.js";
import { leaderboardDocRef, playerProfileRef } from "./refs.js";
import {
  LEADERBOARD_METRICS,
  LeaderboardMetric,
  LeaderboardDocument,
} from "./types.js";
import { buildPlayerSummary, fetchClanSummary } from "./summary.js";

const PAGE_MIN = 1;
const PAGE_MAX = 100;
const PAGE_DEFAULT = 50;

interface LegacyPlayerResponse {
  uid: string;
  displayName: string;
  avatarId: number;
  level: number;
  rank: number;
  stat: number;
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

    const snapshot = await leaderboardDocRef(metric).get();
    if (!snapshot.exists) {
      throw new HttpsError(
        "failed-precondition",
        "Leaderboard is still warming up. Please retry later.",
      );
    }

    const payload = snapshot.data() as LeaderboardDocument;
    const entries = Array.isArray(payload.top100) ? payload.top100 : [];
    const slice = entries.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;
    const pageToken =
      nextOffset < entries.length ? encodePageToken(metric, nextOffset) : null;

    const legacyPlayers: LegacyPlayerResponse[] = slice.map((entry) => ({
      uid: entry.uid,
      displayName: entry.snapshot.displayName,
      avatarId: entry.snapshot.avatarId,
      level: entry.snapshot.level,
      rank: entry.rank,
      stat: entry.value,
    }));

    const youCache = payload.youCache ?? {};
    const playerProfileSnap = await playerProfileRef(uid).get();
    const profileData = playerProfileSnap.exists ? playerProfileSnap.data() ?? {} : {};
    const clanId =
      typeof profileData?.clanId === "string" && profileData.clanId.trim().length > 0
        ? profileData.clanId.trim()
        : null;
    const clanSummary = clanId ? await fetchClanSummary(clanId) : null;
    const youSummary = buildPlayerSummary(uid, profileData, clanSummary);
    const youValue = sanitizeMetricValue(profileData[LEADERBOARD_METRICS[metric].field]);
    const youRank = youCache[uid]?.rank ?? null;

    const response = {
      ok: true,
      data: {
        metric,
        updatedAt: payload.updatedAt ?? null,
        entries: slice.map((entry) => ({
          rank: entry.rank,
          value: entry.value,
          player: entry.snapshot,
        })),
        pageToken,
        you: youSummary
          ? {
              rank: youRank,
              value: youValue,
              player: youSummary,
            }
          : null,
        watermark: hashOperationInputs({
          metric,
          updatedAt: payload.updatedAt ?? null,
          version: "v1",
        }),
      },
      leaderboardType: LEADERBOARD_METRICS[metric].legacyType,
      totalPlayers: legacyPlayers.length,
      players: legacyPlayers,
      callerRank: youRank,
      success: true,
    };

    return response;
  },
);
