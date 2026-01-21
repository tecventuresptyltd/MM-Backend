import * as admin from "firebase-admin";
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
  metric: LeaderboardMetric,
  metricValue: number,
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
  return buildPlayerSummary(uid, data, clan, metricValue);
};

export const updatePlayerLeaderboardEntry = async (
  metric: LeaderboardMetric,
  uid: string,
  metricValue: number,
): Promise<void> => {
  const sanitizedValue = Number.isFinite(metricValue) ? metricValue : 0;
  await db.runTransaction(async (transaction) => {
    const leaderboardRef = leaderboardDocRef(metric);
    const profileRef = playerProfileRef(uid);
    const [leaderboardSnap, profileSnap] = await Promise.all([
      transaction.get(leaderboardRef),
      transaction.get(profileRef),
    ]);
    if (!profileSnap.exists) {
      return;
    }
    const profileData = profileSnap.data() ?? {};
    const rawFlags = profileData.top100Flags ?? {};
    const top100Flags: Record<string, boolean> = {};
    Object.keys(rawFlags).forEach((key) => {
      top100Flags[key] = rawFlags[key] === true;
    });

    const summary = buildSummaryFromProfile(uid, profileData, metric, sanitizedValue);
    if (!summary) {
      return;
    }

    if (!leaderboardSnap.exists) {
      top100Flags[metric] = true;
      const isInTop100 = Object.values(top100Flags).some((value) => value === true);
      transaction.set(
        profileRef,
        {
          top100Flags,
          isInTop100,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      transaction.set(
        leaderboardRef,
        {
          metric,
          updatedAt: Date.now(),
          top100: [
            {
              uid,
              value: sanitizedValue,
              rank: 1,
              snapshot: summary,
            },
          ],
        },
        { merge: true },
      );
      return;
    }

    const entries = normalizeEntries(leaderboardSnap.data()?.top100);
    const hasSpace = entries.length < MAX_ENTRIES;
    const isFlagged = top100Flags[metric] === true;
    if (!isFlagged && !hasSpace) {
      return;
    }
    if (!isFlagged && hasSpace) {
      top100Flags[metric] = true;
      const isInTop100 = Object.values(top100Flags).some((value) => value === true);
      transaction.set(
        profileRef,
        {
          top100Flags,
          isInTop100,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
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

export const refreshPlayerLeaderboardSnapshots = async (uid: string): Promise<void> => {
  try {
    const profileSnap = await playerProfileRef(uid).get();
    if (!profileSnap.exists) {
      return;
    }
    const profileData = profileSnap.data() ?? {};
    const values: Record<LeaderboardMetric, number> = {
      trophies: Number(profileData.trophies ?? 0),
      eliminationTrophies: Number(profileData.eliminationTrophies ?? 0),
      careerCoins: Number(profileData.careerCoins ?? 0),
      totalWins: Number(profileData.totalWins ?? 0),
    };
    await Promise.all(
      (Object.keys(values) as LeaderboardMetric[]).map((metric) =>
        updatePlayerLeaderboardEntry(metric, uid, Number.isFinite(values[metric]) ? values[metric] : 0),
      ),
    );
  } catch (error) {
    console.warn("[liveLeaderboard.refreshPlayerLeaderboardSnapshots] failed", { uid, error });
  }
};
