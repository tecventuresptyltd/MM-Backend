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
      tag: normalizeString(data.tag ?? data.clanTag ?? "", "") || undefined,
      badge: normalizeString(data.badge ?? data.badgeId ?? "", "") || null,
    };
  } catch (error) {
    console.warn("[social.summary] Failed to fetch clan summary", clanId, error);
    return null;
  }
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
