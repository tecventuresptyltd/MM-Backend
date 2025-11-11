import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

const db = admin.firestore();

// --- Invite To Clan ---

interface InviteToClanRequest {
  opId: string;
  targetUid: string;
}

export const inviteToClan = onCall({ region: "us-central1" }, async (request) => {
  const { opId, targetUid } = request.data as InviteToClanRequest;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (!opId || !targetUid) {
    throw new HttpsError("invalid-argument", "Missing required parameters.");
  }

  // Simplified logic - in a real scenario, we'd check for leader/co-leader role
  const playerPrivateStatusRef = db.doc(`/Players/${uid}/Private/Status`);
  const playerStatusDoc = await playerPrivateStatusRef.get();
  const clanId = playerStatusDoc.data()?.clanId;

  if (!clanId) {
    throw new HttpsError("failed-precondition", "Player is not in a clan.");
  }

  const clanInviteRef = db.doc(`/Clans/${clanId}/Invites/${targetUid}`);
  await clanInviteRef.set({
    invitedBy: uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, opId };
});

// --- Request to Join Clan ---

interface RequestToJoinClanRequest {
  opId: string;
  clanId: string;
}

export const requestToJoinClan = onCall({ region: "us-central1" }, async (request) => {
  const { opId, clanId } = request.data as RequestToJoinClanRequest;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (!opId || !clanId) {
    throw new HttpsError("invalid-argument", "Missing required parameters.");
  }

  const playerProfileRef = db.doc(`/Players/${uid}/Profile/Profile`);
  const playerProfileDoc = await playerProfileRef.get();
  const { displayName, trophies } = playerProfileDoc.data()!;

  const clanRequestRef = db.doc(`/Clans/${clanId}/Requests/${uid}`);
  await clanRequestRef.set({
    uid,
    displayName,
    trophies,
    requestedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, opId };
});