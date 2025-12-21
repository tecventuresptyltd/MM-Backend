import * as admin from "firebase-admin";
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
  await db.runTransaction(async (transaction) => {
    const clanRef = clansCollection().doc(clanId);
    const leaderboardRef = db.collection("ClanLeaderboard").doc("snapshot");
    const [clanSnap, leaderboardSnap] = await Promise.all([
      transaction.get(clanRef),
      transaction.get(leaderboardRef),
    ]);
    if (!leaderboardSnap.exists) {
      return;
    }

    const entries = normalizeEntries(leaderboardSnap.data()?.top);

    if (!clanSnap.exists) {
      const filtered = entries.filter((entry) => entry.clanId !== clanId);
      if (filtered.length === entries.length) {
        return;
      }
      transaction.set(
        leaderboardRef,
        {
          top: filtered,
          updatedAt: Date.now(),
        },
        { merge: true },
      );
      return;
    }

    const clanData = clanSnap.data() ?? {};
    if (clanData.isInTop100 === false) {
      const filtered = entries.filter((entry) => entry.clanId !== clanId);
      if (filtered.length === entries.length) {
        return;
      }
      transaction.set(
        leaderboardRef,
        {
          top: filtered,
          updatedAt: Date.now(),
        },
        { merge: true },
      );
      return;
    }
    if (clanData.isInTop100 !== true) {
      return;
    }

    const updatedEntry = buildEntryFromClanDoc(clanId, clanData);
    const filtered = entries.filter((entry) => entry.clanId !== clanId);
    filtered.push(updatedEntry);
    filtered.sort((a, b) => b.totalTrophies - a.totalTrophies);
    const top = filtered.slice(0, CLAN_LEADERBOARD_LIMIT);

    transaction.set(
      leaderboardRef,
      {
        limit: CLAN_LEADERBOARD_LIMIT,
        top,
        updatedAt: Date.now(),
      },
      { merge: true },
    );
    transaction.set(
      clanRef,
      {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
};
