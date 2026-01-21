import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { db } from "../shared/firestore.js";
import { leaderboardDocRef, playerProfileRef } from "./refs.js";
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
  callableOptions({ cpu: 1, concurrency: 80 }),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const metric = resolveMetric(request.data?.metric, request.data?.type);

    const doc = await leaderboardDocRef(metric).get();
    if (!doc.exists) {
      throw new HttpsError(
        "failed-precondition",
        "Leaderboard not built yet. Try again later.",
      );
    }
    const data = doc.data() ?? {};
    const entries = (data.top100 ?? []) as any[];
    const myEntry = entries.find((entry) => entry.snapshot?.uid === uid);
    const myRank = myEntry?.rank ?? null;

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
  callableOptions({ cpu: 1, concurrency: 80 }, true),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const profileSnap = await playerProfileRef(uid).get();
    if (!profileSnap.exists) {
      throw new HttpsError("failed-precondition", "Player profile missing.");
    }
    const profile = profileSnap.data() ?? {};

    const metrics = Object.keys(LEADERBOARD_METRICS) as LeaderboardMetric[];

    const rankings = await Promise.all(
      metrics.map(async (metric) => {
        const config = LEADERBOARD_METRICS[metric];
        const metricField = config.field;

        const rawValue = profile[metricField];
        const statValue = typeof rawValue === "number" && Number.isFinite(rawValue) ? rawValue : 0;

        let higherCount = 0;
        try {
          const countSnap = await db
            .collectionGroup("Profile")
            .where(metricField as string, ">", statValue)
            .count()
            .get();

          higherCount = countSnap.data().count ?? 0;
        } catch (error) {
          // If the query fails (e.g., field doesn't exist on many documents),
          // default to rank 1 (no one has a higher value)
          console.warn(
            `[getMyLeaderboardRank] Failed to query ${metricField} for uid ${uid}:`,
            error instanceof Error ? error.message : error
          );
          higherCount = 0;
        }

        return {
          metric,
          leaderboardType: config.legacyType,
          value: statValue,
          rank: higherCount + 1,
        };
      })
    );

    return { rankings };
  },
);
