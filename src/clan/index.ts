import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

const isString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export const createClan = onCall({ region: "us-central1" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "User is not authenticated.");

  // Accept both { name, tag } (preferred) and { clanName, clanTag } (legacy)
  const raw = (request.data ?? {}) as {
    name?: string;
    clanName?: string;
    tag?: string;
    clanTag?: string;
    type?: "open" | "closed" | "invite-only";
    minimumTrophies?: number;
  };
  const name = isString(raw.name) ? raw.name : raw.clanName;
  const tag  = isString(raw.tag)  ? raw.tag  : raw.clanTag;
  const type = (raw.type ?? "open") as "open" | "closed" | "invite-only";
  const minimumTrophies = Number.isFinite(raw.minimumTrophies) ? Number(raw.minimumTrophies) : 0;

  if (!isString(name) || !isString(tag)) {
    throw new HttpsError("invalid-argument", "clanName/name and clanTag/tag must be non-empty strings.");
  }
  if (!/^[A-Z0-9]{2,5}$/.test(String(tag).toUpperCase())) {
    throw new HttpsError("invalid-argument", "Clan tag must be 2–5 alphanumerics.");
  }

  const db = admin.firestore();
  const now = admin.firestore.FieldValue.serverTimestamp();

  return await db.runTransaction(async (tx) => {
    const clanRef = db.collection("Clans").doc(); // id generated
    const clanId = clanRef.id;

    tx.set(clanRef, {
      clanId,
      name,
      tag: String(tag).toUpperCase(),
      type,
      minimumTrophies,
      stats: { trophies: 0, members: 1 },
      createdAt: now,
      updatedAt: now,
    });

    // Create member record for creator
    tx.set(clanRef.collection("Members").doc(uid), {
      role: "leader",
      trophies: 0,
      joinedAt: now,
    });

    // Attach clan to player profile
    const playerProfileRef = db.doc(`Players/${uid}/Profile/Profile`);
    tx.set(playerProfileRef, { clanId }, { merge: true });

    // Optional: first system message
    tx.set(clanRef.collection("Chat").doc(), {
      authorUid: uid,
      type: "member_joined",
      payload: { uid },
      text: `${name} created`,
      createdAt: now,
    });

    return { clanId: clanRef.id };
  });
});

export const joinClan = onCall({ region: "us-central1" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "User is not authenticated.");

  const raw = (request.data ?? {}) as { clanId?: string, id?: string };
  const clanId = isString(raw.clanId) ? raw.clanId : raw.id; // accept { clanId } or { id }
  if (!isString(clanId)) throw new HttpsError("invalid-argument", "clanId must be a string.");

  const db = admin.firestore();
  const clanRef = db.collection("Clans").doc(clanId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  return await db.runTransaction(async (tx) => {
    const clanSnap = await tx.get(clanRef);
    if (!clanSnap.exists) throw new HttpsError("not-found", "Clan not found.");

    // Add/merge membership
    tx.set(clanRef.collection("Members").doc(uid), {
      role: "member",
      trophies: 0,
      joinedAt: now,
    }, { merge: true });

    // Increment member count
    tx.update(clanRef, {
      "stats.members": admin.firestore.FieldValue.increment(1),
      updatedAt: now,
    });

    // Attach clan to player
    tx.set(db.doc(`Players/${uid}/Profile/Profile`), { clanId }, { merge: true });

    // System message
    tx.set(clanRef.collection("Chat").doc(), {
      authorUid: uid,
      type: "member_joined",
      payload: { uid },
      createdAt: now,
    });

    return { clanId };
  });
});

export const requestToJoinClan = onCall({ region: "us-central1" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "User is not authenticated.");

  const raw = (request.data ?? {}) as { clanId?: string, id?: string, message?: string };
  const clanId = isString(raw.clanId) ? raw.clanId : raw.id;
  const message = isString(raw.message) ? raw.message : "";

  if (!isString(clanId)) throw new HttpsError("invalid-argument", "clanId must be a string.");

  const db = admin.firestore();
  const clanRef = db.collection("Clans").doc(clanId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  const profileSnap = await db.doc(`Players/${uid}/Profile/Profile`).get();
  const profileData = profileSnap.data();
  const displayName = (profileData?.displayName ?? "Player") as string;
  const trophies = Number(profileData?.trophies ?? 0);

  await clanRef.collection("Requests").doc(uid).set({
    uid,
    displayName,
    trophies,
    message,
    requestedAt: now,
  });

  return { clanId };
});
export const leaveClan = onCall({ region: "us-central1" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "User is not authenticated.");

  const db = admin.firestore();
  const now = admin.firestore.FieldValue.serverTimestamp();

  return await db.runTransaction(async (tx) => {
    const playerProfileRef = db.doc(`Players/${uid}/Profile/Profile`);
    const playerProfileSnap = await tx.get(playerProfileRef);
    const clanId = playerProfileSnap.data()?.clanId;

    if (!isString(clanId)) throw new HttpsError("failed-precondition", "Player is not in a clan.");

    const clanRef = db.collection("Clans").doc(clanId);

    // Remove member
    tx.delete(clanRef.collection("Members").doc(uid));

    // Decrement member count
    tx.update(clanRef, {
      "stats.members": admin.firestore.FieldValue.increment(-1),
      updatedAt: now,
    });

    // Detach clan from player
    tx.update(playerProfileRef, { clanId: admin.firestore.FieldValue.delete() });

    // System message
    tx.set(clanRef.collection("Chat").doc(), {
      authorUid: uid,
      type: "member_left",
      payload: { uid },
      createdAt: now,
    });

    return { clanId };
  });
});

export const inviteToClan = onCall({ region: "us-central1" }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "User is not authenticated.");
    return { success: true };
});

export const acceptJoinRequest = onCall({ region: "us-central1" }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "User is not authenticated.");
    return { success: true };
});

export const declineJoinRequest = onCall({ region: "us-central1" }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "User is not authenticated.");
    return { success: true };
});

export const promoteClanMember = onCall({ region: "us-central1" }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "User is not authenticated.");
    return { success: true };
});

export const demoteClanMember = onCall({ region: "us-central1" }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "User is not authenticated.");
    return { success: true };
});

export const kickClanMember = onCall({ region: "us-central1" }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "User is not authenticated.");
    return { success: true };
});

export const updateClanSettings = onCall({ region: "us-central1" }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "User is not authenticated.");
    return { success: true };
});