import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency";
import { runTransactionWithReceipt } from "../core/transactions";

const db = admin.firestore();

// --- Create Clan ---

interface CreateClanRequest {
  opId: string;
  name: string;
  type: "open" | "closed" | "invite-only";
  minimumTrophies: number;
}

interface CreateClanResponse {
  success: boolean;
  opId: string;
  clanId: string;
}

export const createClan = onCall({ region: "us-central1" }, async (request) => {
  const { opId, name, type, minimumTrophies } = request.data as CreateClanRequest;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (!opId || !name || !type || minimumTrophies === undefined) {
    throw new HttpsError("invalid-argument", "Missing required parameters.");
  }

  try {
    const idempotencyResult = await checkIdempotency(uid, opId);
    if (idempotencyResult) {
      return idempotencyResult;
    }

    await createInProgressReceipt(uid, opId, "createClan");

    const clanId = `clan_${Math.random().toString(36).substring(2, 12)}`;

    return await runTransactionWithReceipt<CreateClanResponse>(
      uid,
      opId,
      "createClan",
      async (transaction) => {
        const playerPrivateStatusRef = db.doc(`/Players/${uid}/Private/Status`);
        const clanRef = db.doc(`/Clans/${clanId}`);
        const clanMemberRef = db.doc(`/Clans/${clanId}/Members/${uid}`);

        const playerStatusDoc = await transaction.get(playerPrivateStatusRef);
        if (playerStatusDoc.exists && playerStatusDoc.data()!.clanId) {
          throw new HttpsError("failed-precondition", "Player is already in a clan.");
        }

        transaction.set(clanRef, {
          clanId,
          name,
          type,
          minimumTrophies,
          stats: {
            members: 1,
            trophies: 0, // Will be updated by updateMemberTrophies
          },
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        transaction.set(clanMemberRef, {
          trophies: 0, // Will be updated by updateMemberTrophies
          role: "leader",
          joinedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        transaction.set(playerPrivateStatusRef, {
          clanId,
        }, { merge: true });

        return {
          success: true,
          opId,
          clanId,
        };
      }
    );
  } catch (error) {
    const e = error as Error;
    throw new HttpsError("internal", e.message, e);
  }
});

// --- Update Clan Settings ---

interface UpdateClanSettingsRequest {
  opId: string;
  clanId: string;
  description?: string;
  badge?: string;
}

interface UpdateClanSettingsResponse {
  success: boolean;
  opId: string;
}

export const updateClanSettings = onCall({ region: "us-central1" }, async (request) => {
  const { opId, clanId, description, badge } = request.data as UpdateClanSettingsRequest;
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

    await createInProgressReceipt(uid, opId, "updateClanSettings");

    return await runTransactionWithReceipt<UpdateClanSettingsResponse>(
      uid,
      opId,
      "updateClanSettings",
      async (transaction) => {
        const clanRef = db.doc(`/Clans/${clanId}`);
        const clanMemberRef = db.doc(`/Clans/${clanId}/Members/${uid}`);

        const clanMemberDoc = await transaction.get(clanMemberRef);
        if (!clanMemberDoc.exists || clanMemberDoc.data()!.role !== "leader") {
          throw new HttpsError("permission-denied", "Only the clan leader can update settings.");
        }

        const updateData: { [key: string]: string | admin.firestore.FieldValue } = {
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (description) {
          updateData.description = description;
        }
        if (badge) {
          updateData.badge = badge;
        }

        transaction.update(clanRef, updateData);

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