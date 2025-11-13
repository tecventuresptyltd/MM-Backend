import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { checkIdempotency } from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import { generateRequestId } from "./id.js";
import { playerProfileRef } from "./refs.js";
import { readSocialSnapshot, writeFriendsDoc, writeRequestsDoc, updateSocialProfile } from "./socialStore.js";
import { buildPlayerSummary } from "./summary.js";
import type { PlayerSummary } from "./types.js";

const FRIENDS_SOFT_LIMIT = 400;
const REQUESTS_SOFT_LIMIT = 100;
const MESSAGE_MAX = 140;

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
  return trimmed.slice(0, MESSAGE_MAX);
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

const resolveSummary = (
  uid: string,
  profileData: FirebaseFirestore.DocumentData | undefined,
): PlayerSummary => buildPlayerSummary(uid, profileData, null) ?? fallbackSummary(uid);

export const sendFriendRequest = onCall(
  callableOptions(),
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
        const [callerProfileSnap, targetProfileSnap] = await Promise.all([
          tx.get(playerProfileRef(uid)),
          tx.get(playerProfileRef(targetUid)),
        ]);
        if (!targetProfileSnap.exists) {
          throw new HttpsError("not-found", "Target player not found.");
        }
        if (!callerProfileSnap.exists) {
          throw new HttpsError("failed-precondition", "Caller profile missing.");
        }

        const callerProfile = callerProfileSnap.data() ?? {};
        const targetProfile = targetProfileSnap.data() ?? {};
        const callerSummary = resolveSummary(uid, callerProfile);
        const targetSummary = resolveSummary(targetUid, targetProfile);

        const callerSocial = await readSocialSnapshot(uid, tx);
        const targetSocial = await readSocialSnapshot(targetUid, tx);

        ensureNotBlocked(callerSocial.blocks, targetSocial.blocks, uid, targetUid);
        ensureNotFriends(callerSocial.friends, targetSocial.friends, targetUid, uid);
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
            fromUid: uid,
            sentAt: now,
            message,
            player: callerSummary,
          },
          ...targetSocial.requests.incoming,
        ]);

        writeRequestsDoc(tx, uid, callerSocial.requests.incoming, outgoing);
        writeRequestsDoc(tx, targetUid, incoming, targetSocial.requests.outgoing);
        updateSocialProfile(tx, targetUid, { hasFriendRequests: true });

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

export const acceptFriendRequest = onCall(
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
        const requesterSummary = resolveSummary(requesterUid, requesterProfileSnap.data() ?? {});
        const callerSummary = resolveSummary(uid, callerProfileSnap.data() ?? {});
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

        return { ok: true };
      },
      { kind: "friend-cancel" },
    );

    return result;
  },
);
