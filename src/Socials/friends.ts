import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { checkIdempotency } from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import { maskProfanity } from "../shared/profanity.js";
import { generateRequestId } from "./id.js";
import { playerProfileRef } from "./refs.js";
import {
  readFriendsDoc,
  readSocialSnapshot,
  writeFriendsDoc,
  writeRequestsDoc,
  updateSocialProfile,
} from "./socialStore.js";
import { buildPlayerSummary, fetchClanSummary } from "./summary.js";
import type { FriendEntry, PlayerSummary } from "./types.js";

const db = admin.firestore();

const FRIENDS_SOFT_LIMIT = 400;
const REQUESTS_SOFT_LIMIT = 100;
const MESSAGE_MAX = 140;
const REMOVE_FRIENDS_BATCH_LIMIT = 20;

const sanitizeUid = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpsError("invalid-argument", "targetUid must be a non-empty string.");
  }
  return value.trim();
};

const sanitizeOpId = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpsError("invalid-argument", "opId must be a non-empty string.");
  }
  return value.trim();
};

const sanitizeMessage = (value: unknown): string | undefined => {
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
  const clipped = trimmed.slice(0, MESSAGE_MAX);
  return maskProfanity(clipped);
};

const sanitizeFriendTargets = (raw: unknown): string[] => {
  if (raw === undefined || raw === null) {
    throw new HttpsError("invalid-argument", "friendUids is required.");
  }
  let entries: string[];
  if (Array.isArray(raw)) {
    entries = raw.map((value) => sanitizeUid(value));
  } else if (typeof raw === "string") {
    entries = [sanitizeUid(raw)];
  } else {
    throw new HttpsError("invalid-argument", "friendUids must be a string or array of strings.");
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!seen.has(entry)) {
      seen.add(entry);
      unique.push(entry);
    }
  }
  if (unique.length === 0) {
    throw new HttpsError("invalid-argument", "friendUids cannot be empty.");
  }
  if (unique.length > REMOVE_FRIENDS_BATCH_LIMIT) {
    throw new HttpsError(
      "invalid-argument",
      `friendUids cannot exceed ${REMOVE_FRIENDS_BATCH_LIMIT}.`,
    );
  }
  return unique;
};

const ensureFriendCapacity = (friends: Record<string, unknown>) => {
  if (Object.keys(friends).length >= FRIENDS_SOFT_LIMIT) {
    throw new HttpsError(
      "resource-exhausted",
      "friend-list-full",
    );
  }
};

const ensureNotBlocked = (
  callerBlocks: Record<string, boolean>,
  targetBlocks: Record<string, boolean>,
  callerUid: string,
  targetUid: string,
) => {
  if (callerBlocks[targetUid]) {
    throw new HttpsError("failed-precondition", "target-blocked");
  }
  if (targetBlocks[callerUid]) {
    throw new HttpsError("failed-precondition", "caller-blocked");
  }
};

const ensureNotFriends = (
  callerFriends: Record<string, unknown>,
  targetFriends: Record<string, unknown>,
  targetUid: string,
  callerUid: string,
) => {
  if (callerFriends[targetUid] || targetFriends[callerUid]) {
    throw new HttpsError("failed-precondition", "already-friends");
  }
};

const ensureNoPending = (
  callerOutgoing: { toUid: string }[],
  callerIncoming: { fromUid: string }[],
  targetUid: string,
) => {
  if (callerOutgoing.some((req) => req.toUid === targetUid)) {
    throw new HttpsError("failed-precondition", "request-already-pending");
  }
  if (callerIncoming.some((req) => req.fromUid === targetUid)) {
    throw new HttpsError("failed-precondition", "incoming-request-exists");
  }
};

const clampRequests = <T>(requests: T[]): T[] => {
  if (requests.length <= REQUESTS_SOFT_LIMIT) {
    return requests;
  }
  return requests.slice(0, REQUESTS_SOFT_LIMIT);
};

const fallbackSummary = (uid: string): PlayerSummary => ({
  uid,
  displayName: "RACER",
  avatarId: 1,
  level: 1,
  trophies: 0,
  clan: null,
});

const extractClanId = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const resolveSummary = async (
  uid: string,
  profileData: FirebaseFirestore.DocumentData | undefined,
  transaction?: FirebaseFirestore.Transaction,
): Promise<PlayerSummary> => {
  const clanId = extractClanId(profileData?.clanId);
  const clanSummary = clanId ? await fetchClanSummary(clanId, transaction) : null;
  return buildPlayerSummary(uid, profileData, clanSummary) ?? fallbackSummary(uid);
};

interface SendFriendRequestResult {
  requestId: string;
  targetSummary: PlayerSummary;
}

const performSendFriendRequest = async (
  transaction: FirebaseFirestore.Transaction,
  callerUid: string,
  targetUid: string,
  message?: string,
): Promise<SendFriendRequestResult> => {
  const [callerProfileSnap, targetProfileSnap] = await Promise.all([
    transaction.get(playerProfileRef(callerUid)),
    transaction.get(playerProfileRef(targetUid)),
  ]);
  if (!targetProfileSnap.exists) {
    throw new HttpsError("not-found", "Target player not found.");
  }
  if (!callerProfileSnap.exists) {
    throw new HttpsError("failed-precondition", "Caller profile missing.");
  }

  const callerProfile = callerProfileSnap.data() ?? {};
  const targetProfile = targetProfileSnap.data() ?? {};
  const callerSummary = await resolveSummary(callerUid, callerProfile, transaction);
  const targetSummary = await resolveSummary(targetUid, targetProfile, transaction);

  const callerSocial = await readSocialSnapshot(callerUid, transaction);
  const targetSocial = await readSocialSnapshot(targetUid, transaction);

  ensureNotBlocked(callerSocial.blocks, targetSocial.blocks, callerUid, targetUid);
  ensureNotFriends(callerSocial.friends, targetSocial.friends, targetUid, callerUid);
  ensureNoPending(
    callerSocial.requests.outgoing,
    callerSocial.requests.incoming,
    targetUid,
  );

  const requestId = generateRequestId();
  const now = Date.now();
  const outgoing = clampRequests([
    {
      requestId,
      toUid: targetUid,
      sentAt: now,
      message,
    },
    ...callerSocial.requests.outgoing,
  ]);
  const incoming = clampRequests([
    {
      requestId,
      fromUid: callerUid,
      sentAt: now,
      message,
      player: callerSummary,
    },
    ...targetSocial.requests.incoming,
  ]);

  writeRequestsDoc(transaction, callerUid, callerSocial.requests.incoming, outgoing);
  writeRequestsDoc(transaction, targetUid, incoming, targetSocial.requests.outgoing);
  updateSocialProfile(transaction, targetUid, { hasFriendRequests: true });

  return { requestId, targetSummary };
};

export const sendFriendRequest = onCall(
  callableOptions({}, true),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const opId = sanitizeOpId(request.data?.opId);
    const targetUid = sanitizeUid(request.data?.targetUid);
    if (uid === targetUid) {
      throw new HttpsError("invalid-argument", "Cannot send a friend request to yourself.");
    }
    const message = sanitizeMessage(request.data?.message);

    const cached = await checkIdempotency(uid, opId);
    if (cached) {
      return cached;
    }

    const result = await runTransactionWithReceipt(
      uid,
      opId,
      "send-friend-request",
      async (tx) => {
        const { requestId, targetSummary } = await performSendFriendRequest(
          tx,
          uid,
          targetUid,
          message,
        );
        return {
          ok: true,
          data: { requestId, status: "pending", player: targetSummary },
        };
      },
      { kind: "friend-request" },
    );

    return result;
  },
);

export const sendFriendRequestByUid = onCall(
  callableOptions({}, true),
  async (request) => {
    if (!request.auth?.uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const fromUid = sanitizeUid(request.data?.fromUid ?? request.data?.from ?? request.data?.sourceUid);
    const toUid = sanitizeUid(request.data?.toUid ?? request.data?.targetUid ?? request.data?.friendUid);
    if (fromUid === toUid) {
      throw new HttpsError("invalid-argument", "fromUid and toUid must be different players.");
    }
    const message = sanitizeMessage(request.data?.message);

    const { requestId, targetSummary } = await db.runTransaction(async (tx) =>
      performSendFriendRequest(tx, fromUid, toUid, message),
    );

    return {
      ok: true,
      data: {
        requestId,
        status: "pending",
        player: targetSummary,
        fromUid,
        toUid,
      },
    };
  },
);

export const acceptFriendRequest = onCall(
  callableOptions({}, true),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }
    const opId = sanitizeOpId(request.data?.opId);
    const requestId = sanitizeUid(request.data?.requestId);

    const cached = await checkIdempotency(uid, opId);
    if (cached) {
      return cached;
    }

    const result = await runTransactionWithReceipt(
      uid,
      opId,
      "accept-friend-request",
      async (tx) => {
        const callerSocial = await readSocialSnapshot(uid, tx);
        const incoming = callerSocial.requests.incoming;
        const pending = incoming.find((req) => req.requestId === requestId);
        if (!pending) {
          throw new HttpsError("not-found", "Request not found.");
        }
        const requesterUid = pending.fromUid;

        const [callerProfileSnap, requesterProfileSnap, requesterSocial] = await Promise.all([
          tx.get(playerProfileRef(uid)),
          tx.get(playerProfileRef(requesterUid)),
          readSocialSnapshot(requesterUid, tx),
        ]);

        if (!requesterProfileSnap.exists) {
          throw new HttpsError("not-found", "Request owner missing.");
        }
        if (!callerProfileSnap.exists) {
          throw new HttpsError("failed-precondition", "Caller profile missing.");
        }

        ensureNotBlocked(callerSocial.blocks, requesterSocial.blocks, uid, requesterUid);
        ensureFriendCapacity(callerSocial.friends);
        ensureFriendCapacity(requesterSocial.friends);

        const now = Date.now();
        const requesterSummary = await resolveSummary(
          requesterUid,
          requesterProfileSnap.data() ?? {},
          tx,
        );
        const callerSummary = await resolveSummary(uid, callerProfileSnap.data() ?? {}, tx);
        const callerFriends = {
          ...callerSocial.friends,
          [requesterUid]: { since: now, player: requesterSummary },
        };
        const requesterFriends = {
          ...requesterSocial.friends,
          [uid]: { since: now, player: callerSummary },
        };

        const nextIncoming = incoming.filter((req) => req.requestId !== requestId);
        const nextTargetIncoming = requesterSocial.requests.incoming;
        const nextTargetOutgoing = requesterSocial.requests.outgoing.filter(
          (req) => req.requestId !== requestId,
        );
        const nextCallerOutgoing = callerSocial.requests.outgoing.filter(
          (req) => req.requestId !== requestId,
        );

        writeFriendsDoc(tx, uid, callerFriends);
        writeFriendsDoc(tx, requesterUid, requesterFriends);
        writeRequestsDoc(tx, uid, nextIncoming, nextCallerOutgoing);
        writeRequestsDoc(tx, requesterUid, nextTargetIncoming, nextTargetOutgoing);

        updateSocialProfile(tx, uid, {
          friendsCount: Object.keys(callerFriends).length,
          hasFriendRequests: nextIncoming.length > 0,
        });
        updateSocialProfile(tx, requesterUid, {
          friendsCount: Object.keys(requesterFriends).length,
        });

        const friendSummary = requesterSummary;
        return {
          ok: true,
          data: {
            friend: friendSummary ?? { uid: requesterUid },
            since: now,
          },
        };
      },
      { kind: "friend-accept" },
    );

    return result;
  },
);

export const rejectFriendRequest = onCall(
  callableOptions({}, true),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }
    const opId = sanitizeOpId(request.data?.opId);
    const requestId = sanitizeUid(request.data?.requestId);

    const cached = await checkIdempotency(uid, opId);
    if (cached) {
      return cached;
    }

    const result = await runTransactionWithReceipt(
      uid,
      opId,
      "reject-friend-request",
      async (tx) => {
        const callerSocial = await readSocialSnapshot(uid, tx);
        const match = callerSocial.requests.incoming.find((req) => req.requestId === requestId);
        if (!match) {
          throw new HttpsError("not-found", "Request not found.");
        }
        const sourceUid = match.fromUid;
        const sourceSocial = await readSocialSnapshot(sourceUid, tx);

        const nextCallerIncoming = callerSocial.requests.incoming.filter(
          (req) => req.requestId !== requestId,
        );
        const nextSourceOutgoing = sourceSocial.requests.outgoing.filter(
          (req) => req.requestId !== requestId,
        );

        writeRequestsDoc(tx, uid, nextCallerIncoming, callerSocial.requests.outgoing);
        writeRequestsDoc(tx, sourceUid, sourceSocial.requests.incoming, nextSourceOutgoing);
        updateSocialProfile(tx, uid, {
          hasFriendRequests: nextCallerIncoming.length > 0,
        });

        return { ok: true };
      },
      { kind: "friend-reject" },
    );

    return result;
  },
);

export const cancelFriendRequest = onCall(
  callableOptions(),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }
    const opId = sanitizeOpId(request.data?.opId);
    const requestId = sanitizeUid(request.data?.requestId);

    const cached = await checkIdempotency(uid, opId);
    if (cached) {
      return cached;
    }

    const result = await runTransactionWithReceipt(
      uid,
      opId,
      "cancel-friend-request",
      async (tx) => {
        const callerSocial = await readSocialSnapshot(uid, tx);
        const match = callerSocial.requests.outgoing.find((req) => req.requestId === requestId);
        if (!match) {
          throw new HttpsError("not-found", "Request not found.");
        }
        const targetUid = match.toUid;
        const targetSocial = await readSocialSnapshot(targetUid, tx);

        const nextCallerOutgoing = callerSocial.requests.outgoing.filter(
          (req) => req.requestId !== requestId,
        );
        const nextTargetIncoming = targetSocial.requests.incoming.filter(
          (req) => req.requestId !== requestId,
        );

        writeRequestsDoc(tx, uid, callerSocial.requests.incoming, nextCallerOutgoing);
        writeRequestsDoc(tx, targetUid, nextTargetIncoming, targetSocial.requests.outgoing);
        updateSocialProfile(tx, targetUid, {
          hasFriendRequests: nextTargetIncoming.length > 0,
        });

        return { success: true };
      },
      { kind: "friend-cancel" },
    );

    return result;
  },
);

interface RemoveFriendsResponse {
  success: boolean;
  message: string;
}

export const removeFriends = onCall(
  callableOptions(),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }
    const opId = sanitizeOpId(request.data?.opId);
    const rawTargets =
      request.data?.friendUids ??
      request.data?.targetUids ??
      request.data?.friendUid ??
      request.data?.targetUid;
    const targetUids = sanitizeFriendTargets(rawTargets);
    if (targetUids.includes(uid)) {
      throw new HttpsError("invalid-argument", "Cannot remove yourself from friends.");
    }

    const cached = await checkIdempotency(uid, opId);
    if (cached) {
      return cached;
    }

    const result = await runTransactionWithReceipt<RemoveFriendsResponse>(
      uid,
      opId,
      "remove-friends",
      async (tx) => {
        const callerSocial = await readSocialSnapshot(uid, tx);
        const missing = targetUids.find((targetUid) => !callerSocial.friends[targetUid]);
        if (missing) {
          throw new HttpsError("failed-precondition", "not-friends");
        }

        const nextCallerFriends: Record<string, FriendEntry> = { ...callerSocial.friends };
        targetUids.forEach((targetUid) => {
          delete nextCallerFriends[targetUid];
        });

        const targetSnapshots = await Promise.all(
          targetUids.map(async (targetUid) => ({
            uid: targetUid,
            friends: await readFriendsDoc(targetUid, tx),
          })),
        );
        targetSnapshots.forEach((entry) => {
          delete entry.friends[uid];
        });

        writeFriendsDoc(tx, uid, nextCallerFriends);
        const callerFriendsCount = Object.keys(nextCallerFriends).length;
        updateSocialProfile(tx, uid, {
          friendsCount: callerFriendsCount,
        });

        targetSnapshots.forEach(({ uid: friendUid, friends }) => {
          writeFriendsDoc(tx, friendUid, friends);
          updateSocialProfile(tx, friendUid, {
            friendsCount: Object.keys(friends).length,
          });
        });

        return {
          success: true,
          message: "Friend removed",
        };
      },
      { kind: "friend-remove" },
    );

    return result;
  },
);
