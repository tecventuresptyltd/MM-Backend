import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";

const db = admin.firestore();

/**
 * Gets a player's ELO and profile details from Firestore.
 */
async function getPlayerProfile(uid: string) {
  const profileRef = db.collection("Players").doc(uid).collection("Profile").doc("Profile");
  const profileDoc = await profileRef.get();
  
  if (!profileDoc.exists) {
    return {
      username: "Player_" + uid.substring(0, 5),
      elo: 1000,
      spells: ["fireball", "icelock", "shield", "boost"],
      carSkin: "default"
    };
  }

  const data = profileDoc.data() || {};
  return {
    username: data.displayName || data.username || "Speedster_" + uid.substring(0, 5),
    elo: typeof data.trophies === "number" ? data.trophies : (typeof data.elo === "number" ? data.elo : 1000),
    spells: Array.isArray(data.activeSpellDeck) ? data.activeSpellDeck : ["fireball", "icelock", "shield", "boost"],
    carSkin: data.equippedCarSkin || data.carSkin || "default"
  };
}

/**
 * Creates a new matchmaking lobby in Realtime Database.
 */
export const createLobby = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async (request) => {
  const auth = request.auth;
  if (!auth) {
    throw new HttpsError("unauthenticated", "User must be logged in to create a lobby.");
  }

  const uid = auth.uid;
  const profile = await getPlayerProfile(uid);
  const rankBucket = Math.floor(profile.elo / 200);

  const rtdb = admin.database();
  const lobbyId = "lobby_" + Math.random().toString(36).substring(2, 15);
  const lobbyRef = rtdb.ref(`lobbies/${lobbyId}`);

  const lobbyData = {
    lobbyId: lobbyId,
    hostUid: uid,
    creatorUid: uid,
    status: "waiting",
    createdAt: admin.database.ServerValue.TIMESTAMP,
    members: {
      [uid]: {
        username: profile.username,
        elo: profile.elo,
        spells: profile.spells,
        carSkin: profile.carSkin,
        joinedAt: admin.database.ServerValue.TIMESTAMP,
        status: "menu"
      }
    }
  };

  // 1. Create the lobby node
  await lobbyRef.set(lobbyData);

  // 2. Register in the queryable matchmaking index by rank bucket
  const matchmakingRef = rtdb.ref(`matchmaking/bucket_${rankBucket}/${lobbyId}`);
  await matchmakingRef.set({
    hostUid: uid,
    rosterSize: 1,
    createdAt: admin.database.ServerValue.TIMESTAMP
  });

  logger.info(`[LobbyService] User ${uid} created lobby ${lobbyId} in Rank Bucket ${rankBucket}`);
  return { success: true, lobbyId: lobbyId };
});

/**
 * Joins an existing lobby.
 */
export const joinLobby = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async (request) => {
  const auth = request.auth;
  if (!auth) {
    throw new HttpsError("unauthenticated", "User must be logged in to join a lobby.");
  }

  const lobbyId = request.data?.lobbyId;
  if (typeof lobbyId !== "string" || lobbyId.trim().length === 0) {
    throw new HttpsError("invalid-argument", "A valid lobbyId is required to join a lobby.");
  }

  const uid = auth.uid;
  // Fetch the joiner's profile up-front: RTDB transaction handlers run
  // synchronously (and may re-run), so they cannot await Firestore reads.
  const profile = await getPlayerProfile(uid);

  const rtdb = admin.database();
  const lobbyRef = rtdb.ref(`lobbies/${lobbyId}`);

  // Sentinels so we can surface the same HttpsErrors as before AFTER the
  // transaction resolves (throwing inside the handler would be swallowed).
  let notFound = false;
  let wasKicked = false;
  let wasFull = false;
  let hostUid: string | null = null;
  let newRosterSize = 0;

  // Add the member + enforce the 8-player cap atomically so concurrent joins
  // cannot race past the cap. Operating on the whole lobby node guarantees the
  // members map we inspect is the same one we mutate.
  const result = await lobbyRef.transaction((lobby) => {
    if (lobby === null) {
      // Lobby does not exist (or was concurrently disbanded). Abort.
      notFound = true;
      return undefined; // abort transaction without writing
    }

    // Reset per-attempt flags (the handler can run multiple times).
    notFound = false;
    wasKicked = false;
    wasFull = false;

    if (lobby.kickedPlayers && lobby.kickedPlayers[uid]) {
      wasKicked = true;
      return undefined; // abort
    }

    const roster = lobby.members || {};
    // Idempotent re-join: if already a member, treat as success without
    // double-counting the roster.
    const alreadyMember = Object.prototype.hasOwnProperty.call(roster, uid);
    const currentSize = Object.keys(roster).length;

    if (!alreadyMember && currentSize >= 8) {
      wasFull = true;
      return undefined; // abort
    }

    roster[uid] = {
      username: profile.username,
      elo: profile.elo,
      spells: profile.spells,
      carSkin: profile.carSkin,
      joinedAt: admin.database.ServerValue.TIMESTAMP,
      status: "menu"
    };
    lobby.members = roster;

    hostUid = lobby.hostUid ?? null;
    newRosterSize = Object.keys(roster).length;
    return lobby;
  });

  if (notFound) {
    throw new HttpsError("not-found", "The specified lobby does not exist.");
  }
  if (wasKicked) {
    throw new HttpsError("permission-denied", "You have been kicked from this lobby and cannot rejoin.");
  }
  if (wasFull) {
    throw new HttpsError("resource-exhausted", "This lobby is already full.");
  }
  if (!result.committed) {
    // Transaction aborted for a reason not captured above (e.g. excessive
    // contention). Surface a retryable error rather than silently succeeding.
    throw new HttpsError("aborted", "Could not join the lobby due to contention; please retry.");
  }

  // Update size in the matchmaking index (separate subtree → outside the
  // lobby transaction). Uses the committed roster size and the host's bucket.
  if (hostUid) {
    const hostProfile = await getPlayerProfile(hostUid);
    const hostBucket = Math.floor(hostProfile.elo / 200);
    await rtdb.ref(`matchmaking/bucket_${hostBucket}/${lobbyId}/rosterSize`).set(newRosterSize);
  }

  logger.info(`[LobbyService] User ${uid} joined lobby ${lobbyId}`);
  return { success: true };
});

/**
 * Leaves a lobby, electing a new host if needed or purging the lobby.
 */
export const leaveLobby = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async (request) => {
  const auth = request.auth;
  if (!auth) {
    throw new HttpsError("unauthenticated", "User must be logged in to leave a lobby.");
  }

  const lobbyId = request.data?.lobbyId;
  if (typeof lobbyId !== "string" || lobbyId.trim().length === 0) {
    throw new HttpsError("invalid-argument", "A valid lobbyId is required to leave a lobby.");
  }

  const uid = auth.uid;
  const rtdb = admin.database();
  const lobbyRef = rtdb.ref(`lobbies/${lobbyId}`);

  // Snapshot the original host so we can locate the OLD matchmaking bucket
  // after the transaction commits. We only need the host's bucket; the actual
  // member-remove / host-migration / disband decision is made atomically inside
  // the transaction below (RTDB handlers run synchronously and may re-run, so
  // they cannot await the Firestore profile reads).
  const preSnap = await lobbyRef.get();
  if (!preSnap.exists()) {
    return { success: true, message: "Lobby already deleted." };
  }
  const originalHostUid: string | undefined =
    preSnap.val().hostUid ?? preSnap.val().creatorUid;
  const oldHostProfile = await getPlayerProfile(
    typeof originalHostUid === "string" ? originalHostUid : uid
  );
  const oldHostBucket = Math.floor(oldHostProfile.elo / 200);

  // Outcome captured from the (possibly re-run) transaction handler.
  let disbanded = false;
  let migratedToHost: string | null = null;
  let remainingSize = 0;
  let lobbyCreatedAt: unknown = null;
  let alreadyGone = false;

  // Remove the member + migrate host / disband atomically so concurrent leaves
  // cannot leave a ghost lobby or double-pick a new host.
  const result = await lobbyRef.transaction((lobby) => {
    if (lobby === null) {
      // Lobby was concurrently removed — nothing to do.
      alreadyGone = true;
      return undefined; // abort without writing
    }

    // Reset per-attempt flags (handler may run multiple times).
    disbanded = false;
    migratedToHost = null;
    alreadyGone = false;

    const creatorUid = lobby.creatorUid || lobby.hostUid;
    const roster = lobby.members || {};
    lobbyCreatedAt = lobby.createdAt ?? null;

    // The original creator leaving disbands the whole lobby.
    if (uid === creatorUid) {
      disbanded = true;
      return null; // delete the lobby node
    }

    // Remove the leaving player.
    if (Object.prototype.hasOwnProperty.call(roster, uid)) {
      delete roster[uid];
    }
    lobby.members = roster;

    const remainingKeys = Object.keys(roster);
    remainingSize = remainingKeys.length;

    if (remainingKeys.length === 0) {
      // No one left — purge the lobby entirely (no ghost lobby).
      disbanded = true;
      return null; // delete the lobby node
    }

    // If the leaving player was the host, migrate host to the next member.
    if (lobby.hostUid === uid) {
      const newHostUid = remainingKeys[0];
      lobby.hostUid = newHostUid;
      migratedToHost = newHostUid;
    }

    return lobby;
  });

  if (alreadyGone) {
    return { success: true, message: "Lobby already deleted." };
  }
  if (!result.committed) {
    throw new HttpsError("aborted", "Could not leave the lobby due to contention; please retry.");
  }

  // ── Reconcile the matchmaking index (separate subtree) post-commit ──
  if (disbanded) {
    await rtdb.ref(`matchmaking/bucket_${oldHostBucket}/${lobbyId}`).remove();
    logger.info(`[LobbyService] Lobby ${lobbyId} disbanded/purged after ${uid} left.`);
    return { success: true, disbanded: true };
  }

  if (migratedToHost) {
    // Move the matchmaking entry to the new host's rank bucket.
    const newHostProfile = await getPlayerProfile(migratedToHost);
    const newHostBucket = Math.floor(newHostProfile.elo / 200);

    await rtdb.ref(`matchmaking/bucket_${oldHostBucket}/${lobbyId}`).remove();
    await rtdb.ref(`matchmaking/bucket_${newHostBucket}/${lobbyId}`).set({
      hostUid: migratedToHost,
      rosterSize: remainingSize,
      createdAt: lobbyCreatedAt
    });

    logger.info(`[LobbyService] Host migrated from ${uid} to ${migratedToHost} in lobby ${lobbyId}`);
  } else {
    // No migration — just update the roster size in the existing bucket entry.
    await rtdb.ref(`matchmaking/bucket_${oldHostBucket}/${lobbyId}/rosterSize`).set(remainingSize);
  }

  return { success: true };
});

/**
 * Kicks a player from the lobby (Host Authoritative).
 */
export const kickPlayer = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async (request) => {
  const auth = request.auth;
  if (!auth) {
    throw new HttpsError("unauthenticated", "User must be logged in to kick players.");
  }

  const lobbyId = request.data?.lobbyId;
  const playerUidToKick = request.data?.playerUidToKick;

  if (typeof lobbyId !== "string" || typeof playerUidToKick !== "string") {
    throw new HttpsError("invalid-argument", "Missing lobbyId or playerUidToKick parameter.");
  }

  const rtdb = admin.database();
  const lobbyRef = rtdb.ref(`lobbies/${lobbyId}`);

  const snapshot = await lobbyRef.get();
  if (!snapshot.exists()) {
    throw new HttpsError("not-found", "Lobby not found.");
  }

  const lobby = snapshot.val();
  if (lobby.hostUid !== auth.uid) {
    throw new HttpsError("permission-denied", "Only the host can kick players from this lobby.");
  }

  // Remove player from roster and flag as kicked
  await lobbyRef.child(`members/${playerUidToKick}`).remove();
  await lobbyRef.child(`kickedPlayers/${playerUidToKick}`).set(true);

  // Update size
  const remainingKeys = Object.keys(lobby.members || {}).filter(key => key !== playerUidToKick);
  const hostProfile = await getPlayerProfile(lobby.hostUid);
  const hostBucket = Math.floor(hostProfile.elo / 200);
  await rtdb.ref(`matchmaking/bucket_${hostBucket}/${lobbyId}/rosterSize`).set(remainingKeys.length);

  logger.info(`[LobbyService] Host ${auth.uid} kicked player ${playerUidToKick} from lobby ${lobbyId}`);
  return { success: true };
});

/**
 * Toggles or sets the ready state of a member in the lobby.
 */
export const toggleReadyState = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async (request) => {
  const auth = request.auth;
  if (!auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const lobbyId = request.data?.lobbyId;
  const isReady = request.data?.isReady;

  if (typeof lobbyId !== "string" || typeof isReady !== "boolean") {
    throw new HttpsError("invalid-argument", "Missing lobbyId or isReady boolean parameter.");
  }

  const uid = auth.uid;
  const rtdb = admin.database();
  const memberRef = rtdb.ref(`lobbies/${lobbyId}/members/${uid}`);

  const snapshot = await memberRef.get();
  if (!snapshot.exists()) {
    throw new HttpsError("not-found", "User is not a member of this lobby.");
  }

  await memberRef.child("isReady").set(isReady);
  logger.info(`[LobbyService] User ${uid} set ready state to ${isReady} in lobby ${lobbyId}`);
  return { success: true };
});

/**
 * Promotes another player in the lobby to Host (Host Authoritative).
 */
export const promoteToHost = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async (request) => {
  const auth = request.auth;
  if (!auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const lobbyId = request.data?.lobbyId;
  const newHostUid = request.data?.newHostUid;

  if (typeof lobbyId !== "string" || typeof newHostUid !== "string") {
    throw new HttpsError("invalid-argument", "Missing lobbyId or newHostUid parameter.");
  }

  const rtdb = admin.database();
  const lobbyRef = rtdb.ref(`lobbies/${lobbyId}`);

  const snapshot = await lobbyRef.get();
  if (!snapshot.exists()) {
    throw new HttpsError("not-found", "Lobby not found.");
  }

  const lobby = snapshot.val();
  if (lobby.hostUid !== auth.uid) {
    throw new HttpsError("permission-denied", "Only the host can promote another player to host.");
  }

  const roster = lobby.members || {};
  if (!roster[newHostUid]) {
    throw new HttpsError("invalid-argument", "The specified player is not a member of this lobby.");
  }

  // Update hostUid
  await lobbyRef.child("hostUid").set(newHostUid);

  // Move matchmaking entry to new host's rank bucket
  const oldHostProfile = await getPlayerProfile(auth.uid);
  const oldHostBucket = Math.floor(oldHostProfile.elo / 200);

  const newHostProfile = await getPlayerProfile(newHostUid);
  const newHostBucket = Math.floor(newHostProfile.elo / 200);

  const rosterSize = Object.keys(roster).length;

  await rtdb.ref(`matchmaking/bucket_${oldHostBucket}/${lobbyId}`).remove();
  await rtdb.ref(`matchmaking/bucket_${newHostBucket}/${lobbyId}`).set({
    hostUid: newHostUid,
    rosterSize: rosterSize,
    createdAt: lobby.createdAt
  });

  logger.info(`[LobbyService] Host promoted from ${auth.uid} to ${newHostUid} in lobby ${lobbyId}`);
  return { success: true };
});

/**
 * Sends a chat message to the lobby chat.
 */
export const sendLobbyChatMessage = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async (request) => {
  const auth = request.auth;
  if (!auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const lobbyId = request.data?.lobbyId;
  const message = request.data?.message;

  if (typeof lobbyId !== "string" || typeof message !== "string" || message.trim().length === 0) {
    throw new HttpsError("invalid-argument", "Missing lobbyId or message parameter.");
  }

  const uid = auth.uid;
  const rtdb = admin.database();
  const lobbyRef = rtdb.ref(`lobbies/${lobbyId}`);

  const snapshot = await lobbyRef.get();
  if (!snapshot.exists()) {
    throw new HttpsError("not-found", "Lobby not found.");
  }

  const lobby = snapshot.val();
  const roster = lobby.members || {};
  if (!roster[uid]) {
    throw new HttpsError("permission-denied", "You are not a member of this lobby.");
  }

  const senderProfile = roster[uid];
  const username = senderProfile.username || "Racer";

  const chatMessage = {
    senderUid: uid,
    username: username,
    message: message.trim(),
    timestamp: admin.database.ServerValue.TIMESTAMP
  };

  const messageRef = lobbyRef.child("chat").push();
  await messageRef.set(chatMessage);

  logger.info(`[LobbyService] User ${uid} (${username}) sent message in lobby ${lobbyId}`);
  return { success: true };
});

