import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { db } from "../shared/firestore.js";
import { playerProfileRef } from "./refs.js";
import { LEADERBOARD_METRICS, LeaderboardMetric } from "./types.js";

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
export const getGlobalLeaderboard = onCall(
  callableOptions(),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const metric = resolveMetric(request.data?.metric, request.data?.type);

    const doc = await db.collection("Leaderboards_v1").doc(metric).get();
    if (!doc.exists) {
      throw new HttpsError(
        "failed-precondition",
        "Leaderboard not built yet. Try again later.",
      );
    }
    const data = doc.data() ?? {};
    const entries = (data.top100 ?? []) as any[];
    const youCache =
      (data.youCache as Record<string, { rank: number; value: number }>) ?? {};
    const myRank = youCache[uid]?.rank ?? null;

    const players = entries.map((entry) => ({
      avatarId: entry.snapshot.avatarId,
      displayName: entry.snapshot.displayName,
      level: entry.snapshot.level,
      rank: entry.rank,
      stat: entry.value,
      uid: entry.snapshot.uid,
      clan: entry.snapshot.clan
        ? {
            clanId: entry.snapshot.clan.clanId,
            name: entry.snapshot.clan.name,
            badge: entry.snapshot.clan.badge ?? null,
          }
        : null,
    }));

    return {
      myRank,
      leaderboardType: LEADERBOARD_METRICS[metric].legacyType,
      players,
      updatedAt: data.updatedAt ?? null,
    };
  },
);

export const getMyLeaderboardRank = onCall(
  callableOptions(),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const metric = resolveMetric(request.data?.metric, request.data?.type);
    const metricField = LEADERBOARD_METRICS[metric].field;

    const profileSnap = await playerProfileRef(uid).get();
    if (!profileSnap.exists) {
      throw new HttpsError("failed-precondition", "Player profile missing.");
    }
    const profile = profileSnap.data() ?? {};
    const rawValue = profile[metricField];
    const statValue = typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : 0;

    const query = db
      .collectionGroup("Profile")
      .where(metricField as string, ">", statValue);

    const countSnap = await query.count().get();
    const higherCount = countSnap.data().count ?? 0;

    return {
      metric,
      leaderboardType: LEADERBOARD_METRICS[metric].legacyType,
      value: statValue,
      rank: higherCount + 1,
    };
  },
);
