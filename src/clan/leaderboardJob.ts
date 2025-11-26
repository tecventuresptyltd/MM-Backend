import { onSchedule } from "firebase-functions/v2/scheduler";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import { clansCollection } from "./helpers.js";

const CLAN_LEADERBOARD_LIMIT = 100;

interface ClanLeaderboardEntry {
  clanId: string;
  name: string;
  badge: string | null;
  type: string;
  members: number;
  totalTrophies: number;
}

const fetchTopClanEntries = async (): Promise<ClanLeaderboardEntry[]> => {
  const snapshot = await clansCollection()
    .where("status", "==", "active")
    .orderBy("stats.trophies", "desc")
    .limit(CLAN_LEADERBOARD_LIMIT)
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data() ?? {};
    const stats = data.stats ?? {};
    return {
      clanId: data.clanId ?? doc.id,
      name: data.name ?? "Clan",
      badge: typeof data.badge === "string" ? data.badge : null,
      type: data.type ?? "anyone can join",
      members: Number(stats.members ?? 0),
      totalTrophies: Number(stats.trophies ?? 0),
    };
  });
};

const persistClanLeaderboard = async (
  entries: ClanLeaderboardEntry[],
): Promise<void> => {
  await db.collection("Leaderboards").doc("Clans").set({
    limit: CLAN_LEADERBOARD_LIMIT,
    updatedAt: Date.now(),
    top: entries,
  });
};

export const refreshClanLeaderboard = async (): Promise<{
  processed: number;
}> => {
  const entries = await fetchTopClanEntries();
  await persistClanLeaderboard(entries);
  return { processed: entries.length };
};

export const clanLeaderboardJob = {
  refresh: onSchedule(
    {
      region: REGION,
      schedule: "every 6 hours",
      timeZone: "Etc/UTC",
    },
    async () => {
      await refreshClanLeaderboard();
    },
  ),
};
