import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
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
  location?: string;
}

const normalizeEntries = (raw: unknown): ClanLeaderboardEntry[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry: any) => ({
      clanId: typeof entry?.clanId === "string" ? entry.clanId : "",
      name: typeof entry?.name === "string" ? entry.name : "Clan",
      badge: typeof entry?.badge === "string" ? entry.badge : null,
      type: typeof entry?.type === "string" ? entry.type : "anyone can join",
      members: Number(entry?.members ?? 0),
      totalTrophies: Number(entry?.totalTrophies ?? 0),
      location: entry?.location,
    }))
    .filter((entry) => entry.clanId.length > 0);
};

const buildEntryFromClanDoc = (
  clanId: string,
  data: FirebaseFirestore.DocumentData,
): ClanLeaderboardEntry => {
  const stats = data.stats ?? {};
  return {
    clanId,
    name: typeof data.name === "string" ? data.name : "Clan",
    badge: typeof data.badge === "string" ? data.badge : null,
    type: typeof data.type === "string" ? data.type : "anyone can join",
    members: Number(stats.members ?? 0),
    totalTrophies: Number(stats.trophies ?? 0),
    location: data.location,
  };
};

export const updateClanLeaderboardEntry = async (clanId: string): Promise<void> => {
  logger.info("[clan.liveLeaderboard] begin upsert", { clanId });
  try {
    const snapshot = await db
      .collection("Clans")
      .where("status", "==", "active")
      .orderBy("stats.trophies", "desc")
      .limit(CLAN_LEADERBOARD_LIMIT)
      .get();

    const top = snapshot.docs.map((doc) => buildEntryFromClanDoc(doc.id, doc.data() ?? {}));
    await db
      .collection("ClanLeaderboard")
      .doc("snapshot")
      .set(
        {
          limit: CLAN_LEADERBOARD_LIMIT,
          top,
          updatedAt: Date.now(),
        },
        { merge: true },
      );
    await clansCollection()
      .doc(clanId)
      .set(
        {
          isInTop100: top.some((entry) => entry.clanId === clanId),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    logger.info("[clan.liveLeaderboard] upserted clan leaderboard entry", {
      clanId,
      topCount: top.length,
    });
  } catch (error) {
    logger.error("Failed to refresh clan leaderboard entry", {
      clanId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    });
  }
};
