import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import type { CallableRequest } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import {
  ClanBadge,
  ClanType,
  buildSearchFields,
  canManageMembers,
  clanChatCollection,
  clanMembersCollection,
  clanRef,
  clanRequestsCollection,
  clanSummaryProjection,
  clansCollection,
  ClanRole,
  clearPlayerClanProfile,
  clearPlayerClanState,
  getPlayerProfile,
  isLeader,
  playerClanStateRef,
  resolveClanBadge,
  resolveClanType,
  resolveLanguage,
  resolveLocation,
  resolveMinimumTrophies,
  sanitizeDescription,
  sanitizeName,
  setPlayerClanState,
  updatePlayerClanProfile,
} from "./helpers.js";

const db = admin.firestore();
const { FieldValue } = admin.firestore;

const requireOpId = (raw?: unknown): string => {
  if (typeof raw !== "string" || raw.trim().length < 8) {
    throw new HttpsError("invalid-argument", "opId must be a non-empty string.");
  }
  return raw.trim();
};

const sanitizeWith = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    throw new HttpsError("invalid-argument", (error as Error).message);
  }
};

const assertAuthenticated = (request: CallableRequest): string => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  return uid;
};

interface CreateClanRequest {
  opId: string;
  name?: string;
  clanName?: string;
  description?: string;
  type?: ClanType | "invite-only";
  location?: string;
  language?: string;
  badge?: ClanBadge;
  minimumTrophies?: number;
}

interface CreateClanResponse {
  clanId: string;
  name: string;
}

export const createClan = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as CreateClanRequest;
  const opId = requireOpId(payload.opId);

  const name = sanitizeWith(() => sanitizeName(payload.name ?? payload.clanName ?? ""));
  const description = sanitizeWith(() => sanitizeDescription(payload.description));
  const clanType = resolveClanType(payload.type);
  const badge = resolveClanBadge(payload.badge);
  const minimumTrophies = sanitizeWith(() => resolveMinimumTrophies(payload.minimumTrophies));
  const location = sanitizeWith(() => resolveLocation(payload.location));
  const language = sanitizeWith(() => resolveLanguage(payload.language));

  const profile = await getPlayerProfile(uid);
  if (!profile) {
    throw new HttpsError("failed-precondition", "Player profile not initialised.");
  }

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as CreateClanResponse;
  }
  await createInProgressReceipt(uid, opId, "createClan");

  const now = FieldValue.serverTimestamp();
  const clanId = clansCollection().doc().id;
  const clanDocRef = clanRef(clanId);
  const memberRef = clanMembersCollection(clanId).doc(uid);
  const clanStateRef = playerClanStateRef(uid);
  const chatRef = clanChatCollection(clanId).doc();

  const result = await runTransactionWithReceipt<CreateClanResponse>(
    uid,
    opId,
    "createClan",
    async (transaction) => {
      const stateSnap = await transaction.get(clanStateRef);
      if (stateSnap.exists && typeof stateSnap.data()?.clanId === "string") {
        throw new HttpsError("failed-precondition", "Player is already in a clan.");
      }

      transaction.set(clanDocRef, {
        clanId,
        name,
        description,
        type: clanType,
        location,
        language,
        badge,
        leaderUid: uid,
        minimumTrophies,
        stats: {
          members: 1,
          trophies: profile.trophies ?? 0,
          totalWins: 0,
        },
        status: "active",
        search: buildSearchFields(name, location, language),
        createdAt: now,
        updatedAt: now,
      });

      transaction.set(memberRef, {
        uid,
        role: "leader",
        rolePriority: 4,
        trophies: profile.trophies ?? 0,
        joinedAt: now,
        displayName: profile.displayName,
        avatarId: profile.avatarId,
        level: profile.level ?? 1,
        lastPromotedAt: now,
      });

      updatePlayerClanProfile(transaction, uid, {
        clanId,
        clanName: name,
        role: "leader",
      });
      setPlayerClanState(transaction, uid, {
        clanId,
        role: "leader",
        joinedAt: now,
      });

      transaction.set(chatRef, {
        clanId,
        authorUid: null,
        authorDisplayName: "System",
        type: "system",
        text: `${profile.displayName} founded ${name}`,
        createdAt: now,
        payload: { kind: "clan_created", by: uid },
      });

      return { clanId, name };
    },
  );

  return result;
});

interface UpdateClanSettingsRequest {
  opId: string;
  clanId: string;
  name?: string;
  description?: string;
  type?: ClanType;
  location?: string;
  language?: string;
  badge?: ClanBadge;
  minimumTrophies?: number;
}

interface UpdateClanSettingsResponse {
  clanId: string;
  updated: string[];
}

const sanitizeUpdatePayload = (payload: UpdateClanSettingsRequest) => {
  const updates: Record<string, unknown> = {};
  const touched: string[] = [];

  if (payload.name !== undefined) {
    updates.name = sanitizeWith(() => sanitizeName(payload.name));
    touched.push("name");
  }
  if (payload.description !== undefined) {
    updates.description = sanitizeWith(() => sanitizeDescription(payload.description));
    touched.push("description");
  }
  if (payload.type !== undefined) {
    updates.type = resolveClanType(payload.type);
    touched.push("type");
  }
  if (payload.location !== undefined) {
    updates.location = sanitizeWith(() => resolveLocation(payload.location));
    touched.push("location");
  }
  if (payload.language !== undefined) {
    updates.language = sanitizeWith(() => resolveLanguage(payload.language));
    touched.push("language");
  }
  if (payload.badge !== undefined) {
    updates.badge = resolveClanBadge(payload.badge);
    touched.push("badge");
  }
  if (payload.minimumTrophies !== undefined) {
    updates.minimumTrophies = sanitizeWith(() => resolveMinimumTrophies(payload.minimumTrophies));
    touched.push("minimumTrophies");
  }
  if (touched.length === 0) {
    throw new HttpsError("invalid-argument", "At least one setting must be updated.");
  }

  return { updates, touched };
};

export const updateClanSettings = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as UpdateClanSettingsRequest;
  const opId = requireOpId(payload.opId);
  const clanId = typeof payload.clanId === "string" ? payload.clanId.trim() : "";
  if (!clanId) {
    throw new HttpsError("invalid-argument", "clanId is required.");
  }
  const { updates, touched } = sanitizeUpdatePayload(payload);

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as UpdateClanSettingsResponse;
  }
  await createInProgressReceipt(uid, opId, "updateClanSettings");
  const now = FieldValue.serverTimestamp();

  const clanDocRef = clanRef(clanId);
  const memberRef = clanMembersCollection(clanId).doc(uid);

  const result = await runTransactionWithReceipt<UpdateClanSettingsResponse>(
    uid,
    opId,
    "updateClanSettings",
    async (transaction) => {
      const [clanSnap, memberSnap] = await Promise.all([
        transaction.get(clanDocRef),
        transaction.get(memberRef),
      ]);
      if (!clanSnap.exists) {
        throw new HttpsError("not-found", "Clan not found.");
      }
      if (!memberSnap.exists) {
        throw new HttpsError("permission-denied", "Player is not a member of this clan.");
      }
      const memberData = memberSnap.data();
      if (!memberData || !canManageMembers(memberData.role)) {
        throw new HttpsError("permission-denied", "Insufficient permissions to update clan.");
      }

      const clanData = clanSnap.data() ?? {};
      const searchPayload = clanData.search ?? {};
      if (updates.name || updates.location || updates.language) {
        const nameToUse = (updates.name as string) ?? clanData.name;
        const locationToUse = (updates.location as string) ?? searchPayload.location ?? clanData.location;
        const languageToUse = (updates.language as string) ?? searchPayload.language ?? clanData.language;
        updates.search = buildSearchFields(nameToUse, locationToUse, languageToUse);
      }

      transaction.update(clanDocRef, {
        ...updates,
        updatedAt: now,
      });

      return { clanId, updated: touched };
    },
  );

  return result;
});

interface DeleteClanRequest {
  opId: string;
  clanId: string;
}

interface DeleteClanResponse {
  clanId: string;
  deleted: boolean;
}

export const deleteClan = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as DeleteClanRequest;
  const opId = requireOpId(payload.opId);
  if (typeof payload.clanId !== "string" || payload.clanId.trim().length === 0) {
    throw new HttpsError("invalid-argument", "clanId is required.");
  }

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as DeleteClanResponse;
  }
  await createInProgressReceipt(uid, opId, "deleteClan");
  const clanDocRef = clanRef(payload.clanId);
  const memberRef = clanMembersCollection(payload.clanId).doc(uid);

  const result = await runTransactionWithReceipt<DeleteClanResponse>(
    uid,
    opId,
    "deleteClan",
    async (transaction) => {
      const [clanSnap, memberSnap] = await Promise.all([
        transaction.get(clanDocRef),
        transaction.get(memberRef),
      ]);
      if (!clanSnap.exists) {
        throw new HttpsError("not-found", "Clan not found.");
      }
      if (!memberSnap.exists) {
        throw new HttpsError("permission-denied", "Player is not a member of this clan.");
      }
      const memberData = memberSnap.data();
      if (!memberData || !isLeader(memberData.role)) {
        throw new HttpsError("permission-denied", "Only the leader can delete a clan.");
      }
      const clanData = clanSnap.data() ?? {};
      if (Number(clanData?.stats?.members ?? 0) > 1) {
        throw new HttpsError("failed-precondition", "Transfer leadership or kick members before deleting.");
      }

      transaction.delete(memberRef);
      clearPlayerClanProfile(transaction, uid);
      clearPlayerClanState(transaction, uid);

      transaction.delete(clanDocRef);

      return { clanId: payload.clanId, deleted: true };
    },
  );

  await admin.firestore().recursiveDelete(clanDocRef);
  return result;
});

interface GetClanDetailsRequest {
  clanId: string;
}

interface ClanMemberView {
  uid: string;
  role: string;
  trophies: number;
  displayName: string;
  avatarId: number | null;
  level: number | null;
  joinedAt?: number;
}

interface ClanRequestView {
  uid: string;
  displayName: string;
  trophies: number;
  message?: string;
  requestedAt?: number;
}

interface GetClanDetailsResponse {
  clan: ReturnType<typeof clanSummaryProjection>;
  members: ClanMemberView[];
  membership: {
    role: string;
    joinedAt?: number;
  } | null;
  requests?: ClanRequestView[];
}

const loadClanDetails = async (clanId: string, uid: string): Promise<GetClanDetailsResponse> => {
  const clanDocRef = clanRef(clanId);
  const clanSnap = await clanDocRef.get();
  if (!clanSnap.exists) {
    throw new HttpsError("not-found", "Clan not found.");
  }
  const clanData = clanSnap.data() ?? {};
  if (clanData.status && clanData.status !== "active") {
    throw new HttpsError("failed-precondition", "Clan is inactive.");
  }

  const membersSnap = await clanMembersCollection(clanId)
    .orderBy("rolePriority", "desc")
    .orderBy("trophies", "desc")
    .limit(100)
    .get();

  const members: ClanMemberView[] = membersSnap.docs.map((doc) => {
    const data = doc.data() ?? {};
    return {
      uid: doc.id,
      role: data.role ?? "member",
      trophies: Number(data.trophies ?? 0),
      displayName: data.displayName ?? "Racer",
      avatarId: typeof data.avatarId === "number" ? data.avatarId : Number(data.avatarId) || null,
      level: typeof data.level === "number" ? data.level : Number(data.level) || null,
      joinedAt: data.joinedAt?.toMillis?.(),
    };
  });

  const membershipDoc = await clanMembersCollection(clanId).doc(uid).get();
  const membership = membershipDoc.exists
    ? {
        role: membershipDoc.data()?.role ?? "member",
        joinedAt: membershipDoc.data()?.joinedAt?.toMillis?.(),
      }
    : null;

  let requests: ClanRequestView[] | undefined;
  if (membership?.role && canManageMembers(membership.role as ClanRole)) {
    const requestsSnap = await clanRequestsCollection(clanId)
      .orderBy("requestedAt", "asc")
      .limit(25)
      .get();
    requests = requestsSnap.docs.map((doc) => {
      const data = doc.data() ?? {};
      return {
        uid: doc.id,
        displayName: data.displayName ?? "Racer",
        trophies: Number(data.trophies ?? 0),
        message: data.message,
        requestedAt: data.requestedAt?.toMillis?.(),
      };
    });
  }

  return {
    clan: clanSummaryProjection(clanData),
    members,
    membership,
    requests,
  };
};

export const getClanDetails = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as GetClanDetailsRequest;
  if (typeof payload.clanId !== "string" || payload.clanId.trim().length === 0) {
    throw new HttpsError("invalid-argument", "clanId is required.");
  }
  return loadClanDetails(payload.clanId.trim(), uid);
});

export const getMyClanDetails = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const stateSnap = await playerClanStateRef(uid).get();
  const clanId = stateSnap.data()?.clanId;
  if (typeof clanId !== "string" || clanId.length === 0) {
    throw new HttpsError("failed-precondition", "Player is not in a clan.");
  }
  return loadClanDetails(clanId, uid);
});

interface SearchClansRequest {
  query?: string;
  location?: string;
  language?: string;
  type?: ClanType | "any";
  limit?: number;
  minMembers?: number;
  maxMembers?: number;
  minTrophies?: number;
  requireOpenSpots?: boolean;
}

interface SearchClansResponse {
  clans: ReturnType<typeof clanSummaryProjection>[];
}

const clampLimit = (value?: unknown, fallback = 25, max = 50): number => {
  if (value === undefined || value === null) {
    return fallback;
  }
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) {
    throw new HttpsError("invalid-argument", `limit must be between 1 and ${max}.`);
  }
  return parsed;
};

export const searchClans = onCall(callableOptions(), async (request) => {
  assertAuthenticated(request);
  const payload = (request.data ?? {}) as SearchClansRequest;
  const limit = clampLimit(payload.limit);
  const requireOpenSpots = Boolean(payload.requireOpenSpots);

  const queryText = typeof payload.query === "string" ? payload.query.trim() : "";
  let query: FirebaseFirestore.Query = clansCollection().where("status", "==", "active");
  if (payload.location) {
    const location = sanitizeWith(() => resolveLocation(payload.location));
    query = query.where("search.location", "==", location);
  }
  if (payload.language) {
    const language = sanitizeWith(() => resolveLanguage(payload.language));
    query = query.where("search.language", "==", language);
  }
  if (payload.type && payload.type !== "any") {
    query = query.where("type", "==", resolveClanType(payload.type));
  }
  if (payload.minMembers !== undefined) {
    query = query.where("stats.members", ">=", Number(payload.minMembers));
  }
  if (payload.maxMembers !== undefined) {
    query = query.where("stats.members", "<=", Number(payload.maxMembers));
  }
  if (payload.minTrophies !== undefined) {
    query = query.where("stats.trophies", ">=", Number(payload.minTrophies));
  }

  query = query.orderBy("stats.trophies", "desc").limit(limit * 2);
  const snapshot = await query.get();
  const lowerQuery = queryText.toLowerCase();

  const results = snapshot.docs
    .map((doc: FirebaseFirestore.QueryDocumentSnapshot) => clanSummaryProjection(doc.data() ?? {}))
    .filter((clan: ReturnType<typeof clanSummaryProjection>) => {
      if (lowerQuery.length === 0) {
        return true;
      }
      return clan.name.toLowerCase().includes(lowerQuery);
    })
    .slice(0, limit);

  return { clans: results };
});

interface GetClanLeaderboardRequest {
  limit?: number;
  location?: string;
}

interface GetClanLeaderboardResponse {
  clans: ReturnType<typeof clanSummaryProjection>[];
}

export const getClanLeaderboard = onCall(callableOptions(), async (request) => {
  assertAuthenticated(request);
  const payload = (request.data ?? {}) as GetClanLeaderboardRequest;
  const limit = clampLimit(payload.limit, 25, 100);

  let query: FirebaseFirestore.Query = clansCollection()
    .where("status", "==", "active")
    .orderBy("stats.trophies", "desc")
    .limit(limit);

  if (payload.location) {
    const location = sanitizeWith(() => resolveLocation(payload.location));
    query = clansCollection()
      .where("status", "==", "active")
      .where("search.location", "==", location)
      .orderBy("stats.trophies", "desc")
      .limit(limit);
  }

  const snapshot = await query.get();
  return {
    clans: snapshot.docs.map((doc: FirebaseFirestore.QueryDocumentSnapshot) =>
      clanSummaryProjection(doc.data() ?? {}),
    ),
  };
});
