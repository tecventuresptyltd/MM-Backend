import * as admin from "firebase-admin";
import type { CallableRequest } from "firebase-functions/v2/https";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import {
  ClanRole,
  canInviteMembers,
  canManageMembers,
  clanChatCollection,
  clanMembersCollection,
  clanRef,
  clanRequestsCollection,
  clearPlayerClanProfile,
  clearPlayerClanState,
  getPlayerProfile,
  playerClanInvitesRef,
  playerClanStateRef,
  rolePriority,
  setPlayerClanState,
  updatePlayerClanProfile,
} from "./helpers.js";

const { FieldValue } = admin.firestore;

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

const sanitizeRequestMessage = (value?: unknown): string | undefined => {
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

const queueSystemMessage = (
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

const requireTargetUid = (value?: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpsError("invalid-argument", "targetUid is required.");
  }
  return value.trim();
};

const ROLE_SEQUENCE: ClanRole[] = ["member", "elder", "coLeader", "leader"];

const nextRole = (role: ClanRole): ClanRole | null => {
  const idx = ROLE_SEQUENCE.indexOf(role);
  if (idx < 0 || idx >= ROLE_SEQUENCE.length - 1) {
    return null;
  }
  return ROLE_SEQUENCE[idx + 1];
};

const previousRole = (role: ClanRole): ClanRole | null => {
  const idx = ROLE_SEQUENCE.indexOf(role);
  if (idx <= 0) {
    return null;
  }
  return ROLE_SEQUENCE[idx - 1];
};

const ensureActorOutranksTarget = (actorRole: ClanRole, targetRole: ClanRole) => {
  if (rolePriority(actorRole) <= rolePriority(targetRole)) {
    throw new HttpsError("permission-denied", "Cannot manage a member of equal or higher rank.");
  }
};

const promoteNextLeader = async (
  transaction: FirebaseFirestore.Transaction,
  clanId: string,
  exitingUid: string,
  timestamp: FirebaseFirestore.FieldValue,
): Promise<{ uid: string; displayName: string } | null> => {
  const snapshot = await transaction.get(
    clanMembersCollection(clanId)
      .orderBy("rolePriority", "desc")
      .orderBy("joinedAt", "asc")
      .limit(5),
  );
  for (const doc of snapshot.docs) {
    if (doc.id === exitingUid) {
      continue;
    }
    const data = doc.data() ?? {};
    const role = (data.role ?? "member") as ClanRole;
    if (role === "leader") {
      continue;
    }
    transaction.update(doc.ref, {
      role: "leader",
      rolePriority: rolePriority("leader"),
      lastPromotedAt: timestamp,
    });
    transaction.update(clanRef(clanId), { leaderUid: doc.id });
    return { uid: doc.id, displayName: data.displayName ?? "Racer" };
  }
  return null;
};

const resolvePromotionRole = (currentRole: ClanRole, requested?: ClanRole): ClanRole => {
  if (requested) {
    if (requested === "leader") {
      throw new HttpsError("invalid-argument", "Use transferClanLeadership to assign leaders.");
    }
    if (rolePriority(requested) <= rolePriority(currentRole)) {
      throw new HttpsError("invalid-argument", "Promotion target must be a higher rank.");
    }
    return requested;
  }
  const upgraded = nextRole(currentRole);
  if (!upgraded || upgraded === "leader") {
    throw new HttpsError("failed-precondition", "Member is already at the highest promotable rank.");
  }
  return upgraded;
};

const resolveDemotionRole = (currentRole: ClanRole, requested?: ClanRole): ClanRole => {
  if (currentRole === "member") {
    throw new HttpsError("failed-precondition", "Member is already at the lowest rank.");
  }
  if (requested) {
    if (rolePriority(requested) >= rolePriority(currentRole)) {
      throw new HttpsError("invalid-argument", "Demotion role must be lower than the current rank.");
    }
    return requested;
  }
  const downgraded = previousRole(currentRole);
  if (!downgraded) {
    throw new HttpsError("failed-precondition", "Cannot demote further.");
  }
  return downgraded;
};

interface ClanMutationResponse {
  clanId: string;
}

interface JoinClanRequest {
  opId: string;
  clanId: string;
}

export const joinClan = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as JoinClanRequest;
  const opId = requireOpId(payload.opId);
  const clanId = requireClanId(payload.clanId);

  const profile = await getPlayerProfile(uid);
  if (!profile) {
    throw new HttpsError("failed-precondition", "Player profile not initialised.");
  }

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ClanMutationResponse;
  }
  await createInProgressReceipt(uid, opId, "joinClan");
  const now = FieldValue.serverTimestamp();
  const clanDocRef = clanRef(clanId);
  const memberRef = clanMembersCollection(clanId).doc(uid);
  const stateRef = playerClanStateRef(uid);
  const requestRef = clanRequestsCollection(clanId).doc(uid);
  const invitesRef = playerClanInvitesRef(uid);

  const result = await runTransactionWithReceipt<ClanMutationResponse>(
    uid,
    opId,
    "joinClan",
    async (transaction) => {
      const [clanSnap, stateSnap] = await Promise.all([
        transaction.get(clanDocRef),
        transaction.get(stateRef),
      ]);
      if (!clanSnap.exists) {
        throw new HttpsError("not-found", "Clan not found.");
      }
      if (stateSnap.exists && typeof stateSnap.data()?.clanId === "string") {
        throw new HttpsError("failed-precondition", "Player already belongs to a clan.");
      }
      const clanData = clanSnap.data() ?? {};
      if (clanData.type !== "open") {
        throw new HttpsError("failed-precondition", "Clan does not allow instant joins.");
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
      transaction.delete(requestRef);
      transaction.set(
        invitesRef,
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

      queueSystemMessage(
        transaction,
        clanId,
        `${profile.displayName} joined the clan`,
        { kind: "member_joined", uid },
        now,
      );

      return { clanId };
    },
  );

  return result;
});

interface PromoteClanMemberRequest {
  opId: string;
  clanId: string;
  targetUid: string;
  role?: ClanRole;
}

export const promoteClanMember = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as PromoteClanMemberRequest;
  const opId = requireOpId(payload.opId);
  const clanId = requireClanId(payload.clanId);
  const targetUid = requireTargetUid(payload.targetUid);

  if (targetUid === uid) {
    throw new HttpsError("invalid-argument", "Cannot promote yourself.");
  }

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ClanMutationResponse;
  }
  await createInProgressReceipt(uid, opId, "promoteClanMember");
  const now = FieldValue.serverTimestamp();

  const clanDocRef = clanRef(clanId);
  const actorMemberRef = clanMembersCollection(clanId).doc(uid);
  const targetMemberRef = clanMembersCollection(clanId).doc(targetUid);

  const result = await runTransactionWithReceipt<ClanMutationResponse>(
    uid,
    opId,
    "promoteClanMember",
    async (transaction) => {
      const [clanSnap, actorSnap, targetSnap] = await Promise.all([
        transaction.get(clanDocRef),
        transaction.get(actorMemberRef),
        transaction.get(targetMemberRef),
      ]);
      if (!clanSnap.exists) {
        throw new HttpsError("not-found", "Clan not found.");
      }
      if (!actorSnap.exists || !targetSnap.exists) {
        throw new HttpsError("not-found", "Member not found.");
      }
      const actorRole = (actorSnap.data()?.role ?? "member") as ClanRole;
      const targetRole = (targetSnap.data()?.role ?? "member") as ClanRole;
      if (!canManageMembers(actorRole)) {
        throw new HttpsError("permission-denied", "Insufficient rank to promote members.");
      }
      ensureActorOutranksTarget(actorRole, targetRole);
      const desiredRole = resolvePromotionRole(targetRole, payload.role as ClanRole | undefined);
      if (rolePriority(desiredRole) >= rolePriority(actorRole) && actorRole !== "leader") {
        throw new HttpsError("permission-denied", "Cannot promote to a rank equal to yours.");
      }

      transaction.update(targetMemberRef, {
        role: desiredRole,
        rolePriority: rolePriority(desiredRole),
        lastPromotedAt: now,
      });

      queueSystemMessage(
        transaction,
        clanId,
        `${targetSnap.data()?.displayName ?? "Member"} was promoted to ${desiredRole}`,
        { kind: "member_promoted", uid: targetUid, role: desiredRole, by: uid },
        now,
      );

      return { clanId };
    },
  );

  return result;
});

interface DemoteClanMemberRequest {
  opId: string;
  clanId: string;
  targetUid: string;
  role?: ClanRole;
}

export const demoteClanMember = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as DemoteClanMemberRequest;
  const opId = requireOpId(payload.opId);
  const clanId = requireClanId(payload.clanId);
  const targetUid = requireTargetUid(payload.targetUid);

  if (targetUid === uid) {
    throw new HttpsError("invalid-argument", "Cannot demote yourself.");
  }

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ClanMutationResponse;
  }
  await createInProgressReceipt(uid, opId, "demoteClanMember");
  const now = FieldValue.serverTimestamp();

  const clanDocRef = clanRef(clanId);
  const actorMemberRef = clanMembersCollection(clanId).doc(uid);
  const targetMemberRef = clanMembersCollection(clanId).doc(targetUid);

  const result = await runTransactionWithReceipt<ClanMutationResponse>(
    uid,
    opId,
    "demoteClanMember",
    async (transaction) => {
      const [clanSnap, actorSnap, targetSnap] = await Promise.all([
        transaction.get(clanDocRef),
        transaction.get(actorMemberRef),
        transaction.get(targetMemberRef),
      ]);
      if (!clanSnap.exists) {
        throw new HttpsError("not-found", "Clan not found.");
      }
      if (!actorSnap.exists || !targetSnap.exists) {
        throw new HttpsError("not-found", "Member not found.");
      }
      const actorRole = (actorSnap.data()?.role ?? "member") as ClanRole;
      const targetRole = (targetSnap.data()?.role ?? "member") as ClanRole;
      if (targetRole === "leader") {
        throw new HttpsError("failed-precondition", "Use transferClanLeadership for leaders.");
      }
      if (!canManageMembers(actorRole)) {
        throw new HttpsError("permission-denied", "Insufficient rank to demote members.");
      }
      ensureActorOutranksTarget(actorRole, targetRole);
      const desiredRole = resolveDemotionRole(targetRole, payload.role as ClanRole | undefined);

      transaction.update(targetMemberRef, {
        role: desiredRole,
        rolePriority: rolePriority(desiredRole),
        lastPromotedAt: now,
      });

      queueSystemMessage(
        transaction,
        clanId,
        `${targetSnap.data()?.displayName ?? "Member"} was demoted to ${desiredRole}`,
        { kind: "member_demoted", uid: targetUid, role: desiredRole, by: uid },
        now,
      );

      return { clanId };
    },
  );

  return result;
});

interface TransferClanLeadershipRequest {
  opId: string;
  clanId: string;
  targetUid: string;
}

export const transferClanLeadership = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as TransferClanLeadershipRequest;
  const opId = requireOpId(payload.opId);
  const clanId = requireClanId(payload.clanId);
  const targetUid = requireTargetUid(payload.targetUid);

  if (targetUid === uid) {
    throw new HttpsError("invalid-argument", "Transfer target must be another member.");
  }

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ClanMutationResponse;
  }
  await createInProgressReceipt(uid, opId, "transferClanLeadership");
  const now = FieldValue.serverTimestamp();

  const clanDocRef = clanRef(clanId);
  const leaderRef = clanMembersCollection(clanId).doc(uid);
  const targetRef = clanMembersCollection(clanId).doc(targetUid);

  const result = await runTransactionWithReceipt<ClanMutationResponse>(
    uid,
    opId,
    "transferClanLeadership",
    async (transaction) => {
      const [clanSnap, leaderSnap, targetSnap] = await Promise.all([
        transaction.get(clanDocRef),
        transaction.get(leaderRef),
        transaction.get(targetRef),
      ]);
      if (!clanSnap.exists) {
        throw new HttpsError("not-found", "Clan not found.");
      }
      if (!leaderSnap.exists || !targetSnap.exists) {
        throw new HttpsError("not-found", "Member not found.");
      }
      if (leaderSnap.data()?.role !== "leader") {
        throw new HttpsError("permission-denied", "Only the leader can transfer leadership.");
      }

      transaction.update(targetRef, {
        role: "leader",
        rolePriority: rolePriority("leader"),
        lastPromotedAt: now,
      });
      transaction.update(leaderRef, {
        role: "coLeader",
        rolePriority: rolePriority("coLeader"),
        lastPromotedAt: now,
      });
      transaction.update(clanDocRef, { leaderUid: targetUid, updatedAt: now });

      queueSystemMessage(
        transaction,
        clanId,
        `${targetSnap.data()?.displayName ?? "Member"} is now the clan leader`,
        { kind: "leadership_transfer", from: uid, to: targetUid },
        now,
      );

      return { clanId };
    },
  );

  return result;
});

interface KickClanMemberRequest {
  opId: string;
  clanId: string;
  targetUid: string;
}

export const kickClanMember = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as KickClanMemberRequest;
  const opId = requireOpId(payload.opId);
  const clanId = requireClanId(payload.clanId);
  const targetUid = requireTargetUid(payload.targetUid);

  if (targetUid === uid) {
    throw new HttpsError("invalid-argument", "Use leaveClan to leave.");
  }

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ClanMutationResponse;
  }
  await createInProgressReceipt(uid, opId, "kickClanMember");
  const now = FieldValue.serverTimestamp();

  const clanDocRef = clanRef(clanId);
  const actorMemberRef = clanMembersCollection(clanId).doc(uid);
  const targetMemberRef = clanMembersCollection(clanId).doc(targetUid);
  const invitesRef = playerClanInvitesRef(targetUid);

  const result = await runTransactionWithReceipt<ClanMutationResponse>(
    uid,
    opId,
    "kickClanMember",
    async (transaction) => {
      const [clanSnap, actorSnap, targetSnap] = await Promise.all([
        transaction.get(clanDocRef),
        transaction.get(actorMemberRef),
        transaction.get(targetMemberRef),
      ]);
      if (!clanSnap.exists) {
        throw new HttpsError("not-found", "Clan not found.");
      }
      if (!actorSnap.exists || !targetSnap.exists) {
        throw new HttpsError("not-found", "Member not found.");
      }
      const actorRole = (actorSnap.data()?.role ?? "member") as ClanRole;
      const targetRole = (targetSnap.data()?.role ?? "member") as ClanRole;
      if (targetRole === "leader") {
        throw new HttpsError("failed-precondition", "Use transferClanLeadership for leaders.");
      }
      if (!canManageMembers(actorRole)) {
        throw new HttpsError("permission-denied", "Insufficient rank to remove members.");
      }
      ensureActorOutranksTarget(actorRole, targetRole);

      const memberTrophies = Number(targetSnap.data()?.trophies ?? 0);
      transaction.delete(targetMemberRef);
      transaction.update(clanDocRef, {
        "stats.members": FieldValue.increment(-1),
        "stats.trophies": FieldValue.increment(-memberTrophies),
        updatedAt: now,
      });
      clearPlayerClanProfile(transaction, targetUid);
      clearPlayerClanState(transaction, targetUid);
      transaction.set(
        invitesRef,
        {
          updatedAt: now,
          invites: { [clanId]: FieldValue.delete() },
        },
        { merge: true },
      );

      queueSystemMessage(
        transaction,
        clanId,
        `${targetSnap.data()?.displayName ?? "Member"} was removed from the clan`,
        { kind: "member_kicked", uid: targetUid, by: uid },
        now,
      );

      return { clanId };
    },
  );

  return result;
});

interface UpdateMemberTrophiesRequest {
  opId: string;
  trophyDelta: number;
}

interface UpdateMemberTrophiesResponse {
  opId: string;
  updated: boolean;
}

export const updateMemberTrophies = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as UpdateMemberTrophiesRequest;
  const opId = requireOpId(payload.opId);
  const trophyDelta = Number(payload.trophyDelta);
  if (!Number.isFinite(trophyDelta)) {
    throw new HttpsError("invalid-argument", "trophyDelta must be a finite number.");
  }

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as UpdateMemberTrophiesResponse;
  }
  await createInProgressReceipt(uid, opId, "updateMemberTrophies");
  const stateRef = playerClanStateRef(uid);

  const result = await runTransactionWithReceipt<UpdateMemberTrophiesResponse>(
    uid,
    opId,
    "updateMemberTrophies",
    async (transaction) => {
      const stateSnap = await transaction.get(stateRef);
      const clanId = stateSnap.data()?.clanId;
      if (typeof clanId !== "string" || clanId.length === 0) {
        return { opId, updated: false };
      }
      const clanDocRef = clanRef(clanId);
      const memberRef = clanMembersCollection(clanId).doc(uid);
      const memberSnap = await transaction.get(memberRef);
      if (!memberSnap.exists) {
        return { opId, updated: false };
      }

      transaction.update(clanDocRef, {
        "stats.trophies": FieldValue.increment(trophyDelta),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.update(memberRef, {
        trophies: FieldValue.increment(trophyDelta),
      });

      return { opId, updated: true };
    },
  );

  return result;
});

interface RequestToJoinClanRequest {
  opId: string;
  clanId: string;
  message?: string;
}

export const requestToJoinClan = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as RequestToJoinClanRequest;
  const opId = requireOpId(payload.opId);
  const clanId = requireClanId(payload.clanId);
  const message = sanitizeRequestMessage(payload.message);

  const profile = await getPlayerProfile(uid);
  if (!profile) {
    throw new HttpsError("failed-precondition", "Player profile not initialised.");
  }

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ClanMutationResponse;
  }
  await createInProgressReceipt(uid, opId, "requestToJoinClan");
  const now = FieldValue.serverTimestamp();
  const clanDocRef = clanRef(clanId);
  const requestRef = clanRequestsCollection(clanId).doc(uid);
  const stateRef = playerClanStateRef(uid);

  const result = await runTransactionWithReceipt<ClanMutationResponse>(
    uid,
    opId,
    "requestToJoinClan",
    async (transaction) => {
      const [clanSnap, stateSnap] = await Promise.all([
        transaction.get(clanDocRef),
        transaction.get(stateRef),
      ]);
      if (!clanSnap.exists) {
        throw new HttpsError("not-found", "Clan not found.");
      }
      if (stateSnap.exists && typeof stateSnap.data()?.clanId === "string") {
        throw new HttpsError("failed-precondition", "Player already belongs to a clan.");
      }
      const clanData = clanSnap.data() ?? {};
      if (clanData.type === "closed") {
        throw new HttpsError("failed-precondition", "Clan is closed to new members.");
      }
      if (clanData.type === "open") {
        throw new HttpsError("failed-precondition", "Clan is open. Use joinClan instead.");
      }
      const minTrophies = Number(clanData.minimumTrophies ?? 0);
      if ((profile.trophies ?? 0) < minTrophies) {
        throw new HttpsError("failed-precondition", "Not enough trophies to request this clan.");
      }

      transaction.set(requestRef, {
        uid,
        displayName: profile.displayName,
        trophies: profile.trophies ?? 0,
        message,
        requestedAt: now,
      });

      return { clanId };
    },
  );

  return result;
});

interface CancelJoinRequest {
  opId: string;
  clanId: string;
}

export const cancelJoinRequest = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as CancelJoinRequest;
  const opId = requireOpId(payload.opId);
  const clanId = requireClanId(payload.clanId);

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ClanMutationResponse;
  }
  await createInProgressReceipt(uid, opId, "cancelJoinRequest");
  const result = await runTransactionWithReceipt<ClanMutationResponse>(
    uid,
    opId,
    "cancelJoinRequest",
    async (transaction) => {
      transaction.delete(clanRequestsCollection(clanId).doc(uid));
      return { clanId };
    },
  );
  return result;
});

interface LeaveClanRequest {
  opId: string;
}

export const leaveClan = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as LeaveClanRequest;
  const opId = requireOpId(payload.opId);

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ClanMutationResponse;
  }
  await createInProgressReceipt(uid, opId, "leaveClan");
  const stateRef = playerClanStateRef(uid);
  const now = FieldValue.serverTimestamp();

  const result = await runTransactionWithReceipt<ClanMutationResponse>(
    uid,
    opId,
    "leaveClan",
    async (transaction) => {
      const stateSnap = await transaction.get(stateRef);
      const clanId = stateSnap.data()?.clanId;
      if (typeof clanId !== "string" || clanId.length === 0) {
        throw new HttpsError("failed-precondition", "Player is not in a clan.");
      }

      const clanDocRef = clanRef(clanId);
      const memberRef = clanMembersCollection(clanId).doc(uid);
      const [clanSnap, memberSnap] = await Promise.all([
        transaction.get(clanDocRef),
        transaction.get(memberRef),
      ]);
      if (!clanSnap.exists || !memberSnap.exists) {
        throw new HttpsError("failed-precondition", "Membership is out of sync.");
      }
      const clanData = clanSnap.data() ?? {};
      const memberData = memberSnap.data() ?? {};
      const memberTrophies = Number(memberData.trophies ?? 0);
      const remainingMembers = Number(clanData?.stats?.members ?? 1) - 1;
      if (memberData.role === "leader") {
        if (remainingMembers <= 0) {
          throw new HttpsError("failed-precondition", "Leader must delete the clan instead of leaving.");
        }
        const promoted = await promoteNextLeader(transaction, clanId, uid, now);
        if (!promoted) {
          throw new HttpsError("failed-precondition", "No eligible member to take leadership.");
        }
        queueSystemMessage(
          transaction,
          clanId,
          `${promoted.displayName} is now the clan leader`,
          { kind: "leadership_transfer", to: promoted.uid, from: uid },
          now,
        );
      }

      transaction.delete(memberRef);
      transaction.update(clanDocRef, {
        "stats.members": FieldValue.increment(-1),
        "stats.trophies": FieldValue.increment(-memberTrophies),
        updatedAt: now,
      });
      clearPlayerClanProfile(transaction, uid);
      clearPlayerClanState(transaction, uid);

      queueSystemMessage(
        transaction,
        clanId,
        `${memberData.displayName ?? "Member"} left the clan`,
        { kind: "member_left", uid },
        now,
      );

      return { clanId };
    },
  );

  return result;
});

interface AcceptJoinRequestRequest {
  opId: string;
  clanId: string;
  targetUid: string;
}

export const acceptJoinRequest = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as AcceptJoinRequestRequest;
  const opId = requireOpId(payload.opId);
  const clanId = requireClanId(payload.clanId);
  const targetUid = requireTargetUid(payload.targetUid);

  const targetProfile = await getPlayerProfile(targetUid);
  if (!targetProfile) {
    throw new HttpsError("not-found", "Target player not found.");
  }

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ClanMutationResponse;
  }
  await createInProgressReceipt(uid, opId, "acceptJoinRequest");
  const now = FieldValue.serverTimestamp();
  const clanDocRef = clanRef(clanId);
  const actorMemberRef = clanMembersCollection(clanId).doc(uid);
  const targetMemberRef = clanMembersCollection(clanId).doc(targetUid);
  const requestRef = clanRequestsCollection(clanId).doc(targetUid);
  const targetStateRef = playerClanStateRef(targetUid);
  const invitesRef = playerClanInvitesRef(targetUid);

  const result = await runTransactionWithReceipt<ClanMutationResponse>(
    uid,
    opId,
    "acceptJoinRequest",
    async (transaction) => {
      const [clanSnap, actorSnap, requestSnap, targetStateSnap] = await Promise.all([
        transaction.get(clanDocRef),
        transaction.get(actorMemberRef),
        transaction.get(requestRef),
        transaction.get(targetStateRef),
      ]);
      if (!clanSnap.exists) {
        throw new HttpsError("not-found", "Clan not found.");
      }
      if (!actorSnap.exists) {
        throw new HttpsError("permission-denied", "Not a clan member.");
      }
      const actorRole = (actorSnap.data()?.role ?? "member") as ClanRole;
      if (!canInviteMembers(actorRole)) {
        throw new HttpsError("permission-denied", "Insufficient rank to accept requests.");
      }
      if (!requestSnap.exists) {
        throw new HttpsError("not-found", "Join request not found.");
      }
      if (targetStateSnap.exists && typeof targetStateSnap.data()?.clanId === "string") {
        throw new HttpsError("failed-precondition", "Player already belongs to another clan.");
      }

      const clanData = clanSnap.data() ?? {};

      const trophies = targetProfile.trophies ?? requestSnap.data()?.trophies ?? 0;
      transaction.set(targetMemberRef, {
        uid: targetUid,
        role: "member",
        rolePriority: rolePriority("member"),
        trophies,
        joinedAt: now,
        displayName: targetProfile.displayName,
        avatarId: targetProfile.avatarId,
        level: targetProfile.level ?? 1,
      });
      transaction.update(clanDocRef, {
        "stats.members": FieldValue.increment(1),
        "stats.trophies": FieldValue.increment(trophies),
        updatedAt: now,
      });
      transaction.delete(requestRef);
      transaction.set(
        invitesRef,
        {
          updatedAt: now,
          invites: { [clanId]: FieldValue.delete() },
        },
        { merge: true },
      );

      updatePlayerClanProfile(transaction, targetUid, {
        clanId,
        clanName: clanData.name ?? "Clan",
        role: "member",
      });
      setPlayerClanState(transaction, targetUid, {
        clanId,
        role: "member",
        joinedAt: now,
      });

      queueSystemMessage(
        transaction,
        clanId,
        `${targetProfile.displayName} joined the clan`,
        { kind: "member_joined", uid: targetUid },
        now,
      );

      return { clanId };
    },
  );

  return result;
});

interface DeclineJoinRequestRequest {
  opId: string;
  clanId: string;
  targetUid: string;
}

export const declineJoinRequest = onCall(callableOptions(), async (request) => {
  const uid = assertAuthenticated(request);
  const payload = (request.data ?? {}) as DeclineJoinRequestRequest;
  const opId = requireOpId(payload.opId);
  const clanId = requireClanId(payload.clanId);
  const targetUid = requireTargetUid(payload.targetUid);

  const cached = await checkIdempotency(uid, opId);
  if (cached) {
    return cached as ClanMutationResponse;
  }
  await createInProgressReceipt(uid, opId, "declineJoinRequest");
  const clanDocRef = clanRef(clanId);
  const actorMemberRef = clanMembersCollection(clanId).doc(uid);
  const requestRef = clanRequestsCollection(clanId).doc(targetUid);

  const result = await runTransactionWithReceipt<ClanMutationResponse>(
    uid,
    opId,
    "declineJoinRequest",
    async (transaction) => {
      const [clanSnap, actorSnap, requestSnap] = await Promise.all([
        transaction.get(clanDocRef),
        transaction.get(actorMemberRef),
        transaction.get(requestRef),
      ]);
      if (!clanSnap.exists) {
        throw new HttpsError("not-found", "Clan not found.");
      }
      if (!actorSnap.exists) {
        throw new HttpsError("permission-denied", "Not a clan member.");
      }
      const actorRole = (actorSnap.data()?.role ?? "member") as ClanRole;
      if (!canInviteMembers(actorRole)) {
        throw new HttpsError("permission-denied", "Insufficient rank to decline requests.");
      }
      if (!requestSnap.exists) {
        return { clanId };
      }
      transaction.delete(requestRef);
      return { clanId };
    },
  );

  return result;
});
