import { onSchedule } from "firebase-functions/v2/scheduler";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import { clansCollection } from "./helpers.js";
import * as admin from "firebase-admin";

const CLAN_LEADERBOARD_LIMIT = 100;
const CLAN_FLAG_BATCH_LIMIT = 450;

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
  await db.collection("ClanLeaderboard").doc("snapshot").set({
    limit: CLAN_LEADERBOARD_LIMIT,
    updatedAt: Date.now(),
    top: entries,
  });
};

const loadPreviousClanEntries = async (): Promise<ClanLeaderboardEntry[]> => {
  const snapshot = await db.collection("ClanLeaderboard").doc("snapshot").get();
  if (!snapshot.exists) {
    return [];
  }
  const data = snapshot.data() ?? {};
  const entries = Array.isArray(data.top) ? data.top : [];
  return entries
    .map((entry: any) => ({
      clanId: entry?.clanId ?? entry?.id ?? "",
      name: entry?.name ?? "Clan",
      badge: typeof entry?.badge === "string" ? entry.badge : null,
      type: entry?.type ?? "anyone can join",
      members: Number(entry?.members ?? 0),
      totalTrophies: Number(entry?.totalTrophies ?? 0),
      location: entry?.location,
    }))
    .filter((entry) => typeof entry.clanId === "string" && entry.clanId.length > 0);
};

const chunkArray = <T>(items: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
};

const syncClanTop100Flags = async (
  newEntries: ClanLeaderboardEntry[],
  previousEntries: ClanLeaderboardEntry[],
): Promise<void> => {
  const newIds = new Set(newEntries.map((entry) => entry.clanId));
  const previousIds = new Set(previousEntries.map((entry) => entry.clanId));
  const affected = Array.from(new Set([...newIds, ...previousIds]));
  if (affected.length === 0) {
    return;
  }

  const batches = chunkArray(affected, CLAN_FLAG_BATCH_LIMIT);
  for (const batchIds of batches) {
    const refs = batchIds.map((clanId) => clansCollection().doc(clanId));
    const snapshots = await db.getAll(...refs);
    const writeBatch = db.batch();

    snapshots.forEach((snapshot, idx) => {
      if (!snapshot.exists) {
        return;
      }
      const inTop = newIds.has(batchIds[idx]);
      writeBatch.set(
        refs[idx],
        {
          isInTop100: inTop,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    await writeBatch.commit();
  }
};

export const refreshClanLeaderboard = async (): Promise<{
  processed: number;
}> => {
  const entries = await fetchTopClanEntries();
  const previousEntries = await loadPreviousClanEntries();
  await persistClanLeaderboard(entries);
  await syncClanTop100Flags(entries, previousEntries);
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
