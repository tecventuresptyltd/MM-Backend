import * as admin from "firebase-admin";
import { playerProfileRef } from "./refs.js";
import type { PlayerClanSummary, PlayerProfileSeed, PlayerSummary } from "./types.js";
import { db } from "../shared/firestore.js";

const normalizeString = (value: unknown, fallback = ""): string => {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
};

const normalizeNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const extractClanId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const buildPlayerSummary = (
  uid: string,
  profile: PlayerProfileSeed | undefined,
  clan?: PlayerClanSummary | null,
): PlayerSummary | null => {
  if (!profile) {
    return null;
  }
  return {
    uid,
    displayName: normalizeString(profile.displayName, "Racer"),
    avatarId: normalizeNumber(profile.avatarId, 1),
    level: normalizeNumber(profile.level, 1),
    trophies: normalizeNumber(profile.trophies, 0),
    clan: clan ?? null,
  };
};

export const fetchClanSummary = async (
  clanId: string,
  transaction?: admin.firestore.Transaction,
): Promise<PlayerClanSummary | null> => {
  try {
    const ref = db.collection("Clans").doc(clanId);
    const snapshot = transaction ? await transaction.get(ref) : await ref.get();
    if (!snapshot.exists) {
      return null;
    }
    const data = snapshot.data() ?? {};
    return {
      clanId,
      name: normalizeString(data.name ?? data.displayName, "Clan"),
      badge: normalizeString(data.badge ?? data.badgeId ?? "", "") || null,
    };
  } catch (error) {
    console.warn("[social.summary] Failed to fetch clan summary", clanId, error);
    return null;
  }
};

const fetchClanSummaryMap = async (
  clanIds: string[],
): Promise<Map<string, PlayerClanSummary>> => {
  if (clanIds.length === 0) {
    return new Map();
  }
  const refs = clanIds.map((id) => db.collection("Clans").doc(id));
  const snapshots = await db.getAll(...refs);
  const result = new Map<string, PlayerClanSummary>();
  snapshots.forEach((snapshot, idx) => {
    if (!snapshot.exists) {
      return;
    }
    const data = snapshot.data() ?? {};
    const clanId = refs[idx].id;
    result.set(clanId, {
      clanId,
      name: normalizeString(data.name ?? data.displayName ?? clanId, "Clan"),
      badge: normalizeString(data.badge ?? data.badgeId ?? "", "") || null,
    });
  });
  return result;
};

export const getPlayerSummary = async (
  uid: string,
  transaction?: admin.firestore.Transaction,
): Promise<PlayerSummary | null> => {
  const profileSnapshot = transaction
    ? await transaction.get(playerProfileRef(uid))
    : await playerProfileRef(uid).get();
  if (!profileSnapshot.exists) {
    return null;
  }
  const profileData = profileSnapshot.data() as PlayerProfileSeed;
  const clanId = extractClanId(profileData?.clanId);
  const clanSummary = clanId ? await fetchClanSummary(clanId, transaction) : null;
  return buildPlayerSummary(uid, profileData, clanSummary);
};

export const getPlayerSummaries = async (
  uids: string[],
): Promise<Map<string, PlayerSummary>> => {
  const unique = Array.from(
    new Set(
      uids.filter(
        (uid): uid is string => typeof uid === "string" && uid.trim().length > 0,
      ),
    ),
  );
  if (unique.length === 0) {
    return new Map();
  }
  const refs = unique.map((uid) => playerProfileRef(uid));
  const snapshots = await db.getAll(...refs);
  const clanIds = new Set<string>();
  const profileMap = new Map<string, FirebaseFirestore.DocumentData>();

  snapshots.forEach((snapshot, idx) => {
    if (!snapshot.exists) {
      return;
    }
    const data = snapshot.data() ?? {};
    profileMap.set(unique[idx], data);
    const clanId = extractClanId(data?.clanId);
    if (clanId) {
      clanIds.add(clanId);
    }
  });

  const clanMap = await fetchClanSummaryMap(Array.from(clanIds));
  const summaries = new Map<string, PlayerSummary>();

  profileMap.forEach((profileData, uid) => {
    const clanId = extractClanId(profileData?.clanId);
    const clan = clanId ? clanMap.get(clanId) ?? null : null;
    const summary = buildPlayerSummary(uid, profileData as PlayerProfileSeed, clan);
    if (summary) {
      summaries.set(uid, summary);
    }
  });

  return summaries;
};
