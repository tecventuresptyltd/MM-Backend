import * as admin from "firebase-admin";
import type { CallableRequest } from "firebase-functions/v2/https";
import { HttpsError } from "firebase-functions/v2/https";
import { db } from "../shared/firestore.js";

export type ClanType = "anyone can join" | "invite only" | "closed";
export type ClanRole = "leader" | "coLeader" | "member";

export type ClanBadge = string;

export interface PlayerProfileData {
  uid: string;
  displayName: string;
  avatarId: number;
  level: number;
  trophies: number;
  clanId?: string | null;
  clanName?: string | null;
  language?: string | null;
  location?: string | null;
  assignedChatRoomId?: string | null;
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
  avatarId: number;
  level: number;
  lastPromotedAt?: admin.firestore.Timestamp | admin.firestore.FieldValue;
}

export const REGION = "us-central1";
export const MIN_CLAN_NAME_LENGTH = 3;
export const MAX_CLAN_NAME_LENGTH = 24;
export const MIN_CLAN_DESCRIPTION_LENGTH = 0;
export const MAX_CLAN_DESCRIPTION_LENGTH = 500;
export const MIN_TROPHY_REQUIREMENT = 0;
export const MAX_TROPHY_REQUIREMENT = 100000;

const DEFAULT_CLAN_BADGE: ClanBadge = "badge_default";

export const CLAN_ROLE_ORDER: Record<ClanRole, number> = {
  leader: 3,
  coLeader: 2,
  member: 1,
};

export const canInviteMembers = (role: ClanRole): boolean =>
  role === "leader" || role === "coLeader" || role === "member";

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
  if (value === "anyone can join" || value === "invite only" || value === "closed") {
    return value;
  }
  if (value === "open" || value === "anyone_can_join" || value === "open_join") {
    return "anyone can join";
  }
  if (value === "invite" || value === "invite-only" || value === "invite_only") {
    return "invite only";
  }
  return "anyone can join";
};

export const resolveClanBadge = (value?: unknown): ClanBadge => {
  if (typeof value !== "string") {
    return DEFAULT_CLAN_BADGE;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_CLAN_BADGE;
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
  if (typeof value !== "string") {
    return "GLOBAL";
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : "GLOBAL";
};

export const resolveLanguage = (value?: unknown): string => {
  if (typeof value !== "string") {
    return "unknown";
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : "unknown";
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
    level: typeof data.level === "number" && Number.isFinite(data.level) ? data.level : Number(data.level) || 1,
    trophies: typeof data.trophies === "number" && Number.isFinite(data.trophies)
      ? data.trophies
      : Number(data.trophies) || 0,
    clanId: typeof data.clanId === "string" ? data.clanId : null,
    clanName: typeof data.clanName === "string" ? data.clanName : null,
    language: typeof data.language === "string" ? data.language : null,
    location: typeof data.location === "string" ? data.location : null,
    assignedChatRoomId: typeof data.assignedChatRoomId === "string" ? data.assignedChatRoomId : null,
  };
};

export const updatePlayerClanProfile = (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  payload: {
    clanId: string;
    clanName: string;
  },
) => {
  transaction.set(
    playerProfileRef(uid),
    {
      clanId: payload.clanId,
      clanName: payload.clanName,
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

export const buildSearchFields = (name: string, location: string, language: string) => ({
  nameLower: name.toLowerCase(),
  location,
  language,
});

export const clanSummaryProjection = (data: FirebaseFirestore.DocumentData) => ({
  clanId: data.clanId,
  name: data.name,
  description: data.description ?? "",
  type: data.type,
  location: data.location,
  language: data.language,
  badge: typeof data.badge === "string" ? data.badge : DEFAULT_CLAN_BADGE,
  minimumTrophies: data.minimumTrophies,
  stats: data.stats ?? { members: 0, trophies: 0 },
});

export const nowTimestamp = () => admin.firestore.Timestamp.now();

type ClanMemberMirrorFields = Partial<
  Pick<ClanMemberDoc, "displayName" | "avatarId" | "level" | "trophies">
>;

export const updateClanMemberSnapshot = async (
  uid: string,
  fields: ClanMemberMirrorFields,
) => {
  if (!fields || Object.keys(fields).length === 0) {
    return;
  }
  const stateSnap = await playerClanStateRef(uid).get();
  const clanId = stateSnap.data()?.clanId;
  if (typeof clanId !== "string" || clanId.length === 0) {
    return;
  }
  await clanMembersCollection(clanId).doc(uid).set(fields, { merge: true });
};
