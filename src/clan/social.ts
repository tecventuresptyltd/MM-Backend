import * as admin from "firebase-admin";
import type { CallableRequest } from "firebase-functions/v2/https";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import {
  canInviteMembers,
  clanMembersCollection,
  clanRef,
  clanSummaryProjection,
  rolePriority,
  playerChatRateRef,
  playerClanBookmarksRef,
  playerClanInvitesRef,
  playerClanStateRef,
  setPlayerClanState,
  updatePlayerClanProfile,
  getPlayerProfile,
  clanChatCollection,
} from "./helpers.js";

const { FieldValue } = admin.firestore;
const roomsCollection = () => admin.firestore().collection("Rooms");
const GLOBAL_CHAT_HISTORY_LIMIT = 100;
const CLAN_CHAT_HISTORY_LIMIT = 100;
const CHAT_FETCH_LIMIT = 25;

const assertAuthenticated = (request: CallableRequest): string => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  return uid;
};

const requireOpId = (value?: unknown): string => {
  if (typeof value !== "string" || value.trim().length < 3) {
    throw new HttpsError("invalid-argument", "opId must be provided.");
  }
  return value.trim();
};

const requireClanId = (value?: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpsError("invalid-argument", "clanId is required.");
  }
  return value.trim();
};

const requireTargetUid = (value?: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpsError("invalid-argument", "targetUid is required.");
  }
  return value.trim();
};

const requireRoomId = (value?: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpsError("invalid-argument", "roomId is required.");
  }
  return value.trim();
};

const sanitizeMessage = (value?: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", "message must be a string.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(0, 200);
};

const MAX_CHAT_LENGTH = 256;
const MIN_CHAT_LENGTH = 1;

const sanitizeChatText = (value?: unknown): string => {
  if (typeof value !== "string") {
    throw new HttpsError("invalid-argument", "text must be a string.");
  }
  const trimmed = value.trim();
  if (trimmed.length < MIN_CHAT_LENGTH) {
    throw new HttpsError("invalid-argument", "Message is too short.");
  }
  if (trimmed.length > MAX_CHAT_LENGTH) {
    throw new HttpsError("invalid-argument", `Message exceeds ${MAX_CHAT_LENGTH} characters.`);
  }
  return trimmed;
};

const trimMessages = async (
  collection: FirebaseFirestore.CollectionReference,
  limit: number,
) => {
  if (!Number.isFinite(limit) || limit <= 0) {
    return;
  }
  const snapshot = await collection.orderBy("createdAt", "desc").offset(limit).limit(20).get();
  if (snapshot.empty) {
    return;
  }
  const batch = admin.firestore().batch();
  snapshot.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
};

const clampFetchLimit = (value?: unknown): number => {
  if (value === undefined || value === null) {
    return CHAT_FETCH_LIMIT;
  }
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new HttpsError("invalid-argument", "limit must be a positive number.");
  }
  return Math.min(parsed, CHAT_FETCH_LIMIT);
};

const fetchClanSummaryLite = async (
  clanId?: string | null,
): Promise<{ clanId: string; name: string | null; badge: unknown } | null> => {
  if (!clanId) {
    return null;
  }
  try {
    const snapshot = await clanRef(clanId).get();
    if (!snapshot.exists) {
      return null;
    }
    const data = snapshot.data() ?? {};
    return {
      clanId,
      name: typeof data.name === "string" ? data.name : null,
      badge: data.badge ?? null,
    };
  } catch (error) {
    console.warn("[clan.social] failed to fetch clan summary", clanId, error);
    return null;
  }
};

const serializeChatMessage = (
  doc: FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>,
) => {
  const data = doc.data() ?? {};
  const createdAt =
    data.createdAt && typeof data.createdAt.toMillis === "function" ? data.createdAt.toMillis() : null;
  return {
    messageId: doc.id,
    roomId: data.roomId ?? null,
    clanId: data.clanId ?? null,
    authorUid: data.authorUid ?? null,
    authorDisplayName: data.authorDisplayName ?? null,
    authorAvatarId: data.authorAvatarId ?? null,
    authorTrophies: data.authorTrophies ?? null,
    authorClanName: data.authorClanName ?? null,
    authorClanBadge: data.authorClanBadge ?? null,
    type: data.type ?? "text",
    text: data.text ?? "",
    clientCreatedAt: data.clientCreatedAt ?? null,
    createdAt,
    deleted: Boolean(data.deleted),
    deletedReason: data.deletedReason ?? null,
  };
};

const queueClanSystemMessage = (
  transaction: FirebaseFirestore.Transaction,
  clanId: string,
  text: string,
  payload: Record<string, unknown>,
  timestamp: FirebaseFirestore.FieldValue,
) => {
  transaction.set(clanChatCollection(clanId).doc(), {
    clanId,
    authorUid: null,
    authorDisplayName: "System",
    type: "system",
    text,
    payload,
    createdAt: timestamp,
  });
};

interface ClanActionResponse {
  clanId: string;
}

interface InviteToClanRequest {
  opId: string;
  clanId: string;
  targetUid: string;
  message?: string;
}

export const inviteToClan = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as InviteToClanRequest;
  const opId = requireOpId(payload.opId);
  const clanId = requireClanId(payload.clanId);
  const targetUid = requireTargetUid(payload.targetUid);
  const message = sanitizeMessage(payload.message);

  if (targetUid === uid) {
    throw new HttpsError("invalid-argument", "Cannot invite yourself.");
  }

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ClanActionResponse;
  }
  await createInProgressReceipt(uid, opId, "inviteToClan");
  const now = FieldValue.serverTimestamp();

  const clanDocRef = clanRef(clanId);
  const actorMemberRef = clanMembersCollection(clanId).doc(uid);
  const targetStateRef = playerClanStateRef(targetUid);
  const inviteDocRef = playerClanInvitesRef(targetUid);

  const result = await runTransactionWithReceipt<ClanActionResponse>(
    uid,
    opId,
    "inviteToClan",
    async (transaction) => {
      const [clanSnap, actorSnap, targetStateSnap] = await Promise.all([
        transaction.get(clanDocRef),
        transaction.get(actorMemberRef),
        transaction.get(targetStateRef),
      ]);
      if (!clanSnap.exists) {
        throw new HttpsError("not-found", "Clan not found.");
      }
      if (!actorSnap.exists) {
        throw new HttpsError("permission-denied", "Not a clan member.");
      }
      const actorRole = actorSnap.data()?.role ?? "member";
      if (!canInviteMembers(actorRole)) {
        throw new HttpsError("permission-denied", "Insufficient rank to send invites.");
      }
      if (targetStateSnap.exists && typeof targetStateSnap.data()?.clanId === "string") {
        throw new HttpsError("failed-precondition", "Target player already belongs to a clan.");
      }

      const clanData = clanSnap.data() ?? {};
      transaction.set(
        inviteDocRef,
        {
          updatedAt: now,
          invites: {
            [clanId]: {
              clanId,
              clanName: clanData.name ?? "Clan",
              fromUid: uid,
              fromRole: actorRole,
              createdAt: now,
              message,
            },
          },
        },
        { merge: true },
      );

      return { clanId };
    },
  );

  return result;
});

interface AcceptClanInviteRequest {
  opId: string;
  clanId: string;
}

export const acceptClanInvite = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as AcceptClanInviteRequest;
  const opId = requireOpId(payload.opId);
  const clanId = requireClanId(payload.clanId);

  const profile = await getPlayerProfile(uid);
  if (!profile) {
    throw new HttpsError("failed-precondition", "Player profile not initialised.");
  }

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ClanActionResponse;
  }
  await createInProgressReceipt(uid, opId, "acceptClanInvite");
  const now = FieldValue.serverTimestamp();

  const clanDocRef = clanRef(clanId);
  const memberRef = clanMembersCollection(clanId).doc(uid);
  const stateRef = playerClanStateRef(uid);
  const inviteDocRef = playerClanInvitesRef(uid);

  const result = await runTransactionWithReceipt<ClanActionResponse>(
    uid,
    opId,
    "acceptClanInvite",
    async (transaction) => {
      const [clanSnap, stateSnap, inviteSnap] = await Promise.all([
        transaction.get(clanDocRef),
        transaction.get(stateRef),
        transaction.get(inviteDocRef),
      ]);
      if (!clanSnap.exists) {
        throw new HttpsError("not-found", "Clan not found.");
      }
      if (stateSnap.exists && typeof stateSnap.data()?.clanId === "string") {
        throw new HttpsError("failed-precondition", "Player already belongs to a clan.");
      }
      const inviteData = inviteSnap.data()?.invites?.[clanId];
      if (!inviteData) {
        throw new HttpsError("failed-precondition", "No invite found for this clan.");
      }
      const clanData = clanSnap.data() ?? {};
      if (clanData.status && clanData.status !== "active") {
        throw new HttpsError("failed-precondition", "Clan is not accepting members.");
      }
      const minTrophies = Number(clanData.minimumTrophies ?? 0);
      if ((profile.trophies ?? 0) < minTrophies) {
        throw new HttpsError("failed-precondition", "Not enough trophies to join this clan.");
      }

      transaction.set(memberRef, {
        uid,
        role: "member",
        rolePriority: rolePriority("member"),
        trophies: profile.trophies ?? 0,
        joinedAt: now,
        displayName: profile.displayName,
        avatarId: profile.avatarId,
        level: profile.level ?? 1,
      });
      transaction.update(clanDocRef, {
        "stats.members": FieldValue.increment(1),
        "stats.trophies": FieldValue.increment(profile.trophies ?? 0),
        updatedAt: now,
      });
      transaction.set(
        inviteDocRef,
        {
          updatedAt: now,
          invites: { [clanId]: FieldValue.delete() },
        },
        { merge: true },
      );

      updatePlayerClanProfile(transaction, uid, {
        clanId,
        clanName: clanData.name ?? "Clan",
        role: "member",
      });
      setPlayerClanState(transaction, uid, {
        clanId,
        role: "member",
        joinedAt: now,
      });

      queueClanSystemMessage(transaction, clanId, `${profile.displayName} joined the clan`, {
        kind: "member_joined",
        uid,
      }, now);

      return { clanId };
    },
  );

  return result;
});

interface DeclineClanInviteRequest {
  opId: string;
  clanId: string;
}

export const declineClanInvite = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as DeclineClanInviteRequest;
  const opId = requireOpId(payload.opId);
  const clanId = requireClanId(payload.clanId);

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ClanActionResponse;
  }
  await createInProgressReceipt(uid, opId, "declineClanInvite");
  const result = await runTransactionWithReceipt<ClanActionResponse>(
    uid,
    opId,
    "declineClanInvite",
    async (transaction) => {
      transaction.set(
        playerClanInvitesRef(uid),
        {
          updatedAt: FieldValue.serverTimestamp(),
          invites: { [clanId]: FieldValue.delete() },
        },
        { merge: true },
      );
      return { clanId };
    },
  );
  return result;
});

interface BookmarkClanRequest {
  opId: string;
  clanId: string;
}

export const bookmarkClan = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as BookmarkClanRequest;
  const opId = requireOpId(payload.opId);
  const clanId = requireClanId(payload.clanId);

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ClanActionResponse;
  }
  await createInProgressReceipt(uid, opId, "bookmarkClan");
  const clanSnap = await clanRef(clanId).get();
  if (!clanSnap.exists) {
    throw new HttpsError("not-found", "Clan not found.");
  }
  const clanData = clanSnap.data() ?? {};
  const now = FieldValue.serverTimestamp();

  const result = await runTransactionWithReceipt<ClanActionResponse>(
    uid,
    opId,
    "bookmarkClan",
    async (transaction) => {
      transaction.set(
        playerClanBookmarksRef(uid),
        {
          updatedAt: now,
          bookmarks: {
            [clanId]: {
              clanId,
              clanName: clanData.name ?? "Clan",
              addedAt: now,
            },
          },
          bookmarkedClanIds: FieldValue.arrayUnion(clanId),
        },
        { merge: true },
      );
      return { clanId };
    },
  );

  return result;
});

export const unbookmarkClan = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as BookmarkClanRequest;
  const opId = requireOpId(payload.opId);
  const clanId = requireClanId(payload.clanId);

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ClanActionResponse;
  }
  await createInProgressReceipt(uid, opId, "unbookmarkClan");
  const result = await runTransactionWithReceipt<ClanActionResponse>(
    uid,
    opId,
    "unbookmarkClan",
    async (transaction) => {
      transaction.set(
        playerClanBookmarksRef(uid),
        {
          updatedAt: FieldValue.serverTimestamp(),
          bookmarks: { [clanId]: FieldValue.delete() },
          bookmarkedClanIds: FieldValue.arrayRemove(clanId),
        },
        { merge: true },
      );
      return { clanId };
    },
  );

  return result;
});

export const getBookmarkedClans = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const doc = await playerClanBookmarksRef(uid).get();
  const bookmarks = doc.data()?.bookmarks ?? {};
  const clanIds = Object.keys(bookmarks);
  if (clanIds.length === 0) {
    return { clans: [] };
  }
  const refs = clanIds.map((id) => clanRef(id));
  const snapshots = await admin.firestore().getAll(...refs);
  const clans = snapshots
    .map((snap, idx) =>
      snap.exists ? clanSummaryProjection(snap.data() ?? {}) : bookmarks[clanIds[idx]] ?? null,
    )
    .filter((entry): entry is ReturnType<typeof clanSummaryProjection> => Boolean(entry));
  return { clans };
});

interface SendGlobalChatMessageRequest {
  opId: string;
  roomId: string;
  text: string;
  clientCreatedAt?: string;
}

interface ChatResponse {
  messageId: string;
  roomId?: string;
  clanId?: string;
}

export const sendGlobalChatMessage = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as SendGlobalChatMessageRequest;
  const opId = requireOpId(payload.opId);
  const roomId = requireRoomId(payload.roomId);
  const text = sanitizeChatText(payload.text);

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ChatResponse;
  }
  const profile = await getPlayerProfile(uid);
  if (!profile) {
    throw new HttpsError("failed-precondition", "Player profile not initialised.");
  }
  const clanSummary = await fetchClanSummaryLite(profile.clanId);
  await createInProgressReceipt(uid, opId, "sendGlobalChatMessage");
  const now = FieldValue.serverTimestamp();
  const roomRef = roomsCollection().doc(roomId);
  const rateRef = playerChatRateRef(uid);
  const messageRef = roomRef.collection("Messages").doc();

  const result = await runTransactionWithReceipt<ChatResponse>(
    uid,
    opId,
    "sendGlobalChatMessage",
    async (transaction) => {
      const [roomSnap, rateSnap] = await Promise.all([transaction.get(roomRef), transaction.get(rateRef)]);
      if (!roomSnap.exists) {
        throw new HttpsError("not-found", "Room not found.");
      }
      const roomData = roomSnap.data() ?? {};
      const slowModeSeconds = Number(roomData.slowModeSeconds ?? 3);
      const maxMessages = Number(roomData.maxMessages ?? 200);
      const lastSentAt = Number(rateSnap.data()?.rooms?.[roomId]?.lastSentAt ?? 0);
      const nowMs = Date.now();
      if (slowModeSeconds > 0 && nowMs - lastSentAt < slowModeSeconds * 1000) {
        throw new HttpsError("resource-exhausted", "Slow mode in effect. Please wait.");
      }

      transaction.set(messageRef, {
        roomId,
        authorUid: uid,
        authorDisplayName: profile.displayName,
        authorAvatarId: profile.avatarId,
        authorTrophies: profile.trophies ?? 0,
        authorClanName: clanSummary?.name ?? profile.clanName ?? null,
        authorClanBadge: clanSummary?.badge ?? null,
        type: "text",
        text,
        clientCreatedAt: typeof payload.clientCreatedAt === "string" ? payload.clientCreatedAt : null,
        createdAt: now,
        deleted: false,
        deletedReason: null,
      });
      transaction.set(
        rateRef,
        {
          updatedAt: now,
          rooms: { [roomId]: { lastSentAt: nowMs } },
        },
        { merge: true },
      );

      return { messageId: messageRef.id, roomId };
    },
  );

  await trimMessages(roomRef.collection("Messages"), GLOBAL_CHAT_HISTORY_LIMIT);
  return { roomId, messageId: result.messageId };
});

interface SendClanChatMessageRequest {
  opId: string;
  clanId?: string;
  text: string;
  clientCreatedAt?: string;
}

export const sendClanChatMessage = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as SendClanChatMessageRequest;
  const opId = requireOpId(payload.opId);
  const payloadClanId = typeof payload.clanId === "string" ? payload.clanId.trim() : "";
  const text = sanitizeChatText(payload.text);

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ChatResponse;
  }
  await createInProgressReceipt(uid, opId, "sendClanChatMessage");

  const now = FieldValue.serverTimestamp();
  const stateRef = playerClanStateRef(uid);
  const rateRef = playerChatRateRef(uid);
  const profile = await getPlayerProfile(uid);
  if (!profile) {
    throw new HttpsError("failed-precondition", "Player profile not initialised.");
  }

  const result = await runTransactionWithReceipt<ChatResponse & { clanId: string }>(
    uid,
    opId,
    "sendClanChatMessage",
    async (transaction) => {
      const stateSnap = await transaction.get(stateRef);
      const clanId = stateSnap.data()?.clanId;
      if (typeof clanId !== "string" || clanId.length === 0) {
        throw new HttpsError("failed-precondition", "Player is not in a clan.");
      }
      if (payloadClanId && payloadClanId !== clanId) {
        throw new HttpsError("invalid-argument", "clanId mismatch.");
      }

      const clanDocRef = clanRef(clanId);
      const memberRef = clanMembersCollection(clanId).doc(uid);
      const chatCollection = clanChatCollection(clanId);
      const messageRef = chatCollection.doc();

      const [clanSnap, memberSnap, rateSnap] = await Promise.all([
        transaction.get(clanDocRef),
        transaction.get(memberRef),
        transaction.get(rateRef),
      ]);
      if (!clanSnap.exists) {
        throw new HttpsError("not-found", "Clan not found.");
      }
      if (!memberSnap.exists) {
        throw new HttpsError("permission-denied", "Not a clan member.");
      }

      const clanData = clanSnap.data() ?? {};
      const slowModeSeconds = Number(clanData.chatSlowModeSeconds ?? 2);
      const rateKey = `clan:${clanId}`;
      const lastSentAt = Number(rateSnap.data()?.rooms?.[rateKey]?.lastSentAt ?? 0);
      const nowMs = Date.now();
      if (slowModeSeconds > 0 && nowMs - lastSentAt < slowModeSeconds * 1000) {
        throw new HttpsError("resource-exhausted", "Slow mode in effect. Please wait.");
      }

      transaction.set(messageRef, {
        clanId,
        authorUid: uid,
        authorDisplayName: profile.displayName,
        authorAvatarId: profile.avatarId,
        authorTrophies: profile.trophies ?? 0,
        authorClanName: clanData.name ?? null,
        authorClanBadge: clanData.badge ?? null,
        type: "text",
        text,
        clientCreatedAt: typeof payload.clientCreatedAt === "string" ? payload.clientCreatedAt : null,
        createdAt: now,
        deleted: false,
        deletedReason: null,
      });
      transaction.set(
        rateRef,
        {
          updatedAt: now,
          rooms: { [rateKey]: { lastSentAt: nowMs } },
        },
        { merge: true },
      );
      transaction.set(
        playerClanStateRef(uid),
        { lastVisitedClanChatAt: now },
        { merge: true },
      );

      return { clanId, messageId: messageRef.id };
    },
  );

  await trimMessages(clanChatCollection(result.clanId), CLAN_CHAT_HISTORY_LIMIT);
  return { clanId: result.clanId, messageId: result.messageId };
});

interface GetGlobalChatMessagesRequest {
  roomId: string;
  limit?: number;
}

export const getGlobalChatMessages = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as GetGlobalChatMessagesRequest;
  const roomId = requireRoomId(payload.roomId);
  const limit = clampFetchLimit(payload.limit);

  const roomRef = roomsCollection().doc(roomId);
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) {
    throw new HttpsError("not-found", "Room not found.");
  }

  const messagesSnap = await roomRef
    .collection("Messages")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  await playerClanStateRef(uid).set(
    { lastVisitedGlobalChatAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  return {
    roomId,
    messages: messagesSnap.docs.map(serializeChatMessage).reverse(),
  };
});

interface GetClanChatMessagesRequest {
  limit?: number;
}

export const getClanChatMessages = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as GetClanChatMessagesRequest;
  const limit = clampFetchLimit(payload.limit);

  const stateSnap = await playerClanStateRef(uid).get();
  const clanId = stateSnap.data()?.clanId;
  if (typeof clanId !== "string" || clanId.length === 0) {
    throw new HttpsError("failed-precondition", "Player is not in a clan.");
  }

  const chatSnap = await clanChatCollection(clanId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  await playerClanStateRef(uid).set(
    { lastVisitedClanChatAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  return {
    clanId,
    messages: chatSnap.docs.map(serializeChatMessage).reverse(),
  };
});
