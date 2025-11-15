import * as admin from "firebase-admin";
import type { CallableRequest } from "firebase-functions/v2/https";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../shared/firestore.js";

export type ClanType = "open" | "invite" | "closed";
export type ClanRole = "leader" | "coLeader" | "elder" | "member";

export interface ClanBadge {
  frameId: string;
  backgroundId: string;
  emblemId: string;
}

export interface PlayerProfileData {
  uid: string;
  displayName: string;
  avatarId: number;
  trophies: number;
  clanId?: string | null;
  clanTag?: string | null;
  clanName?: string | null;
  language?: string | null;
  location?: string | null;
}

export interface PlayerClanState {
  clanId: string | null;
  role?: ClanRole | null;
  joinedAt?: admin.firestore.Timestamp | admin.firestore.FieldValue | null;
  lastVisitedClanChatAt?: admin.firestore.Timestamp | admin.firestore.FieldValue | null;
  lastVisitedGlobalChatAt?: admin.firestore.Timestamp | admin.firestore.FieldValue | null;
  bookmarkedClanIds?: string[];
  updatedAt?: admin.firestore.Timestamp | admin.firestore.FieldValue;
}

export interface ClanMemberDoc {
  uid: string;
  role: ClanRole;
  rolePriority: number;
  trophies: number;
  joinedAt: admin.firestore.Timestamp | admin.firestore.FieldValue;
  displayName: string;
  lastPromotedAt?: admin.firestore.Timestamp | admin.firestore.FieldValue;
}

export const REGION = "us-central1";
export const MIN_CLAN_NAME_LENGTH = 3;
export const MAX_CLAN_NAME_LENGTH = 24;
export const MIN_CLAN_DESCRIPTION_LENGTH = 0;
export const MAX_CLAN_DESCRIPTION_LENGTH = 140;
export const MIN_MEMBER_LIMIT = 5;
export const MAX_MEMBER_LIMIT = 50;
export const MIN_TROPHY_REQUIREMENT = 0;
export const MAX_TROPHY_REQUIREMENT = 100000;

const EMPTY_CLAN_BADGE: ClanBadge = {
  frameId: "frame_default",
  backgroundId: "bg_default",
  emblemId: "emblem_default",
};

export const CLAN_ROLE_ORDER: Record<ClanRole, number> = {
  leader: 4,
  coLeader: 3,
  elder: 2,
  member: 1,
};

export const canInviteMembers = (role: ClanRole): boolean =>
  role === "leader" || role === "coLeader" || role === "elder";

export const canManageMembers = (role: ClanRole): boolean => role === "leader" || role === "coLeader";

export const isLeader = (role: ClanRole): boolean => role === "leader";

export const requireAuth = (request: CallableRequest): string => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  return uid;
};

export const clansCollection = () => db.collection("Clans");
export const clanRef = (clanId: string) => clansCollection().doc(clanId);
export const clanMembersCollection = (clanId: string) => clanRef(clanId).collection("Members");
export const clanRequestsCollection = (clanId: string) => clanRef(clanId).collection("Requests");
export const clanChatCollection = (clanId: string) => clanRef(clanId).collection("Chat");
export const clanTagRef = (tagUpper: string) => db.collection("ClanTags").doc(tagUpper);

export const playersCollection = () => db.collection("Players");
export const playerProfileRef = (uid: string) => playersCollection().doc(uid).collection("Profile").doc("Profile");
export const playerSocialCollection = (uid: string) => playersCollection().doc(uid).collection("Social");
export const playerClanStateRef = (uid: string) => playerSocialCollection(uid).doc("Clan");
export const playerClanInvitesRef = (uid: string) => playerSocialCollection(uid).doc("ClanInvites");
export const playerClanBookmarksRef = (uid: string) => playerSocialCollection(uid).doc("ClanBookmarks");
export const playerChatRateRef = (uid: string) => playerSocialCollection(uid).doc("ChatRate");

export const sanitizeName = (value?: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("Clan name must be a string.");
  }
  const trimmed = value.trim();
  if (trimmed.length < MIN_CLAN_NAME_LENGTH || trimmed.length > MAX_CLAN_NAME_LENGTH) {
    throw new Error(
      `Clan name must be between ${MIN_CLAN_NAME_LENGTH} and ${MAX_CLAN_NAME_LENGTH} characters.`,
    );
  }
  return trimmed;
};

export const sanitizeTag = (value?: unknown): string => {
  if (typeof value !== "string") {
    throw new Error("Clan tag must be a string.");
  }
  const candidate = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,5}$/.test(candidate)) {
    throw new Error("Clan tag must be 2-5 alphanumeric characters.");
  }
  return candidate;
};

export const sanitizeDescription = (value?: unknown): string => {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error("Description must be a string.");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_CLAN_DESCRIPTION_LENGTH) {
    throw new Error(`Description must be under ${MAX_CLAN_DESCRIPTION_LENGTH} characters.`);
  }
  return trimmed;
};

export const resolveClanType = (value?: unknown): ClanType => {
  if (value === "open" || value === "invite" || value === "closed") {
    return value;
  }
  if (value === "invite-only") {
    return "invite";
  }
  return "open";
};

export const resolveClanBadge = (value?: unknown): ClanBadge => {
  if (!value || typeof value !== "object") {
    return EMPTY_CLAN_BADGE;
  }
  const bag = value as Partial<ClanBadge>;
  return {
    frameId: typeof bag.frameId === "string" && bag.frameId.trim().length > 0 ? bag.frameId : EMPTY_CLAN_BADGE.frameId,
    backgroundId:
      typeof bag.backgroundId === "string" && bag.backgroundId.trim().length > 0
        ? bag.backgroundId
        : EMPTY_CLAN_BADGE.backgroundId,
    emblemId:
      typeof bag.emblemId === "string" && bag.emblemId.trim().length > 0
        ? bag.emblemId
        : EMPTY_CLAN_BADGE.emblemId,
  };
};

export const resolveMemberLimit = (value?: unknown): number => {
  if (value === undefined || value === null) {
    return 50;
  }
  const limit = Math.floor(Number(value));
  if (!Number.isFinite(limit) || limit < MIN_MEMBER_LIMIT || limit > MAX_MEMBER_LIMIT) {
    throw new Error(`memberLimit must be between ${MIN_MEMBER_LIMIT} and ${MAX_MEMBER_LIMIT}.`);
  }
  return limit;
};

export const resolveMinimumTrophies = (value?: unknown): number => {
  if (value === undefined || value === null) {
    return 0;
  }
  const trophies = Math.floor(Number(value));
  if (
    !Number.isFinite(trophies) ||
    trophies < MIN_TROPHY_REQUIREMENT ||
    trophies > MAX_TROPHY_REQUIREMENT
  ) {
    throw new Error(
      `minimumTrophies must be between ${MIN_TROPHY_REQUIREMENT} and ${MAX_TROPHY_REQUIREMENT}.`,
    );
  }
  return trophies;
};

export const resolveLocation = (value?: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "GLOBAL";
  }
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{2,3}$/.test(normalized) && normalized !== "GLOBAL") {
    throw new Error("location must be a 2-3 letter ISO code or GLOBAL.");
  }
  return normalized;
};

export const resolveLanguage = (value?: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "en";
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z]{2,5}$/.test(normalized)) {
    throw new Error("language must be a lowercase locale code.");
  }
  return normalized;
};

export const getPlayerProfile = async (
  uid: string,
  transaction?: FirebaseFirestore.Transaction,
): Promise<PlayerProfileData | null> => {
  const ref = playerProfileRef(uid);
  const snapshot = transaction ? await transaction.get(ref) : await ref.get();
  if (!snapshot.exists) {
    return null;
  }
  const data = snapshot.data() ?? {};
  return {
    uid,
    displayName: typeof data.displayName === "string" && data.displayName.trim().length > 0
      ? data.displayName.trim()
      : "Racer",
    avatarId: typeof data.avatarId === "number" && Number.isFinite(data.avatarId)
      ? data.avatarId
      : Number(data.avatarId) || 1,
    trophies: typeof data.trophies === "number" && Number.isFinite(data.trophies)
      ? data.trophies
      : Number(data.trophies) || 0,
    clanId: typeof data.clanId === "string" ? data.clanId : null,
    clanTag: typeof data.clanTag === "string" ? data.clanTag : null,
    clanName: typeof data.clanName === "string" ? data.clanName : null,
    language: typeof data.language === "string" ? data.language : null,
    location: typeof data.location === "string" ? data.location : null,
  };
};

export const updatePlayerClanProfile = (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  payload: {
    clanId: string;
    clanName: string;
    clanTag: string;
    role: ClanRole;
  },
) => {
  transaction.set(
    playerProfileRef(uid),
    {
      clanId: payload.clanId,
      clanName: payload.clanName,
      clanTag: payload.clanTag,
      clanRole: payload.role,
    },
    { merge: true },
  );
};

export const clearPlayerClanProfile = (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
) => {
  transaction.set(
    playerProfileRef(uid),
    {
      clanId: admin.firestore.FieldValue.delete(),
      clanName: admin.firestore.FieldValue.delete(),
      clanTag: admin.firestore.FieldValue.delete(),
      clanRole: admin.firestore.FieldValue.delete(),
    },
    { merge: true },
  );
};

export const setPlayerClanState = (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  state: PlayerClanState,
) => {
  transaction.set(
    playerClanStateRef(uid),
    {
      ...state,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
};

export const clearPlayerClanState = (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
) => {
  transaction.set(
    playerClanStateRef(uid),
    {
      clanId: null,
      role: null,
      joinedAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
};

export const rolePriority = (role: ClanRole): number => CLAN_ROLE_ORDER[role];

export const applyMemberRole = (
  transaction: FirebaseFirestore.Transaction,
  clanId: string,
  uid: string,
  role: ClanRole,
) => {
  transaction.update(clanMembersCollection(clanId).doc(uid), {
    role,
    rolePriority: rolePriority(role),
    lastPromotedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
};

export const getClanMemberDoc = async (
  clanId: string,
  uid: string,
  transaction?: FirebaseFirestore.Transaction,
): Promise<FirebaseFirestore.DocumentSnapshot<FirebaseFirestore.DocumentData>> => {
  const ref = clanMembersCollection(clanId).doc(uid);
  return transaction ? transaction.get(ref) : ref.get();
};

export const buildSearchFields = (name: string, tag: string, location: string, language: string) => ({
  nameLower: name.toLowerCase(),
  tagUpper: tag,
  location,
  language,
});

export const clanSummaryProjection = (data: FirebaseFirestore.DocumentData) => ({
  clanId: data.clanId,
  name: data.name,
  tag: data.tag,
  description: data.description ?? "",
  type: data.type,
  location: data.location,
  language: data.language,
  badge: data.badge ?? EMPTY_CLAN_BADGE,
  minimumTrophies: data.minimumTrophies,
  memberLimit: data.memberLimit,
  stats: data.stats ?? { members: 0, trophies: 0 },
});

export const nowTimestamp = () => admin.firestore.Timestamp.now();
