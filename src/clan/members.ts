import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency";
import { runTransactionWithReceipt } from "../core/transactions";

const db = admin.firestore();

// --- Join Clan ---

interface JoinClanRequest {
  opId: string;
  clanId: string;
}

interface JoinClanResponse {
  success: boolean;
  opId: string;
}

export const joinClan = onCall({ region: "us-central1" }, async (request) => {
  const { opId, clanId } = request.data as JoinClanRequest;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (!opId || !clanId) {
    throw new HttpsError("invalid-argument", "Missing required parameters.");
  }

  try {
    const idempotencyResult = await checkIdempotency(uid, opId);
    if (idempotencyResult) {
      return idempotencyResult;
    }

    await createInProgressReceipt(uid, opId, "joinClan");

    return await runTransactionWithReceipt<JoinClanResponse>(
      uid,
      opId,
      "joinClan",
      async (transaction) => {
        const playerPrivateStatusRef = db.doc(`/Players/${uid}/Private/Status`);
        const clanRef = db.doc(`/Clans/${clanId}`);
        const clanMemberRef = db.doc(`/Clans/${clanId}/Members/${uid}`);

        const playerStatusDoc = await transaction.get(playerPrivateStatusRef);
        if (playerStatusDoc.exists && playerStatusDoc.data()!.clanId) {
          throw new HttpsError("failed-precondition", "Player is already in a clan.");
        }

        transaction.set(clanMemberRef, {
          role: "member",
          joinedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        transaction.update(clanRef, {
          "stats.members": admin.firestore.FieldValue.increment(1),
        });

        transaction.set(playerPrivateStatusRef, {
          clanId,
        }, { merge: true });

        return {
          success: true,
          opId,
        };
      }
    );
  } catch (error) {
    const e = error as Error;
    throw new HttpsError("internal", e.message, e);
  }
});

// --- Leave Clan ---

interface LeaveClanRequest {
  opId: string;
}

interface LeaveClanResponse {
  success: boolean;
  opId: string;
}

export const leaveClan = onCall({ region: "us-central1" }, async (request) => {
  const { opId } = request.data as LeaveClanRequest;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (!opId) {
    throw new HttpsError("invalid-argument", "Missing required parameters.");
  }

  try {
    const idempotencyResult = await checkIdempotency(uid, opId);
    if (idempotencyResult) {
      return idempotencyResult;
    }

    await createInProgressReceipt(uid, opId, "leaveClan");

    return await runTransactionWithReceipt<LeaveClanResponse>(
      uid,
      opId,
      "leaveClan",
      async (transaction) => {
        const playerPrivateStatusRef = db.doc(`/Players/${uid}/Private/Status`);
        const playerStatusDoc = await transaction.get(playerPrivateStatusRef);
        const clanId = playerStatusDoc.data()?.clanId;

        if (!clanId) {
          throw new HttpsError("failed-precondition", "Player is not in a clan.");
        }

        const clanRef = db.doc(`/Clans/${clanId}`);
        const clanMemberRef = db.doc(`/Clans/${clanId}/Members/${uid}`);

        transaction.delete(clanMemberRef);
        transaction.update(clanRef, {
          "stats.members": admin.firestore.FieldValue.increment(-1),
        });
        transaction.update(playerPrivateStatusRef, {
          clanId: admin.firestore.FieldValue.delete(),
        });

        return {
          success: true,
          opId,
        };
      }
    );
  } catch (error) {
    const e = error as Error;
    throw new HttpsError("internal", e.message, e);
  }
});

// --- Update Member Trophies ---

interface UpdateMemberTrophiesRequest {
  opId: string;
  trophyDelta: number;
}

interface UpdateMemberTrophiesResponse {
  success: boolean;
  opId: string;
}

export const updateMemberTrophies = onCall({ region: "us-central1" }, async (request) => {
  const { opId, trophyDelta } = request.data as UpdateMemberTrophiesRequest;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (!opId || typeof trophyDelta !== "number") {
    throw new HttpsError("invalid-argument", "Missing or invalid parameters.");
  }

  try {
    const idempotencyResult = await checkIdempotency(uid, opId);
    if (idempotencyResult) {
      return idempotencyResult;
    }

    await createInProgressReceipt(uid, opId, "updateMemberTrophies");

    return await runTransactionWithReceipt<UpdateMemberTrophiesResponse>(
      uid,
      opId,
      "updateMemberTrophies",
      async (transaction) => {
        const playerPrivateStatusRef = db.doc(`/Players/${uid}/Private/Status`);
        const playerStatusDoc = await transaction.get(playerPrivateStatusRef);
        const clanId = playerStatusDoc.data()?.clanId;

        if (!clanId) {
          // Not an error, just nothing to do
          return { success: true, opId };
        }

        const clanRef = db.doc(`/Clans/${clanId}`);
        const clanMemberRef = db.doc(`/Clans/${clanId}/Members/${uid}`);

        transaction.update(clanRef, {
          "stats.trophies": admin.firestore.FieldValue.increment(trophyDelta),
        });
        transaction.update(clanMemberRef, {
          trophies: admin.firestore.FieldValue.increment(trophyDelta),
        });

        return {
          success: true,
          opId,
        };
      }
    );
  } catch (error) {
    const e = error as Error;
    throw new HttpsError("internal", e.message, e);
  }
});