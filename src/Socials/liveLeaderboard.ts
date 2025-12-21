import { db } from "../shared/firestore.js";
import { leaderboardDocRef, playerProfileRef } from "./refs.js";
import { buildPlayerSummary } from "./summary.js";
import { LeaderboardEntry, LeaderboardMetric, PlayerProfileSeed } from "./types.js";

const MAX_ENTRIES = 100;

const normalizeEntries = (raw: unknown): LeaderboardEntry[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry: any) => ({
      uid: typeof entry?.uid === "string" ? entry.uid : "",
      value: Number(entry?.value ?? 0),
      rank: Number(entry?.rank ?? 0),
      snapshot: entry?.snapshot,
    }))
    .filter((entry) => entry.uid.length > 0);
};

const buildSummaryFromProfile = (
  uid: string,
  profile: FirebaseFirestore.DocumentData | undefined,
): ReturnType<typeof buildPlayerSummary> => {
  const data = (profile ?? {}) as PlayerProfileSeed;
  const clanId = typeof data.clanId === "string" && data.clanId.trim().length > 0 ? data.clanId.trim() : null;
  const clan =
    clanId !== null
      ? {
          clanId,
          name:
            typeof data.clanName === "string" && data.clanName.trim().length > 0
              ? data.clanName.trim()
              : "Clan",
          badge: typeof data.clanBadge === "string" && data.clanBadge.trim().length > 0 ? data.clanBadge.trim() : null,
        }
      : null;
  return buildPlayerSummary(uid, data, clan);
};

export const updatePlayerLeaderboardEntry = async (
  metric: LeaderboardMetric,
  uid: string,
  metricValue: number,
): Promise<void> => {
  const sanitizedValue = Number.isFinite(metricValue) ? metricValue : 0;
  await db.runTransaction(async (transaction) => {
    const leaderboardRef = leaderboardDocRef(metric);
    const leaderboardSnap = await transaction.get(leaderboardRef);
    if (!leaderboardSnap.exists) {
      return;
    }
    const profileSnap = await transaction.get(playerProfileRef(uid));
    if (!profileSnap.exists) {
      return;
    }
    const profileData = profileSnap.data() ?? {};
    const flags = profileData.top100Flags ?? {};
    if (!flags || flags[metric] !== true) {
      return;
    }

    const entries = normalizeEntries(leaderboardSnap.data()?.top100);
    const summary = buildSummaryFromProfile(uid, profileData);
    if (!summary) {
      return;
    }

    const filtered = entries.filter((entry) => entry.uid !== uid);
    filtered.push({
      uid,
      value: sanitizedValue,
      rank: 0,
      snapshot: summary,
    });

    filtered.sort((a, b) => b.value - a.value);
    const updated = filtered.slice(0, MAX_ENTRIES).map((entry, idx) => ({
      ...entry,
      rank: idx + 1,
    }));

    transaction.set(
      leaderboardRef,
      {
        metric,
        updatedAt: Date.now(),
        top100: updated,
      },
      { merge: true },
    );
  });
};
