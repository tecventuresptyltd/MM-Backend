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
    status: "waiting",
    createdAt: admin.database.ServerValue.TIMESTAMP,
    sharedRandomSeed: "seed_" + Math.random().toString(36).substring(2, 15),
    members: {
      [uid]: {
        username: profile.username,
        elo: profile.elo,
        spells: profile.spells,
        carSkin: profile.carSkin,
        joinedAt: admin.database.ServerValue.TIMESTAMP
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
  const profile = await getPlayerProfile(uid);

  const rtdb = admin.database();
  const lobbyRef = rtdb.ref(`lobbies/${lobbyId}`);

  // Fetch active lobby transactionally
  const snapshot = await lobbyRef.get();
  if (!snapshot.exists()) {
    throw new HttpsError("not-found", "The specified lobby does not exist.");
  }

  const lobby = snapshot.val();

  // Check if player was kicked
  if (lobby.kickedPlayers && lobby.kickedPlayers[uid]) {
    throw new HttpsError("permission-denied", "You have been kicked from this lobby and cannot rejoin.");
  }

  const roster = lobby.members || {};
  const currentSize = Object.keys(roster).length;

  if (currentSize >= 8) {
    throw new HttpsError("resource-exhausted", "This lobby is already full.");
  }

  // Add user to members list
  await lobbyRef.child(`members/${uid}`).set({
    username: profile.username,
    elo: profile.elo,
    spells: profile.spells,
    carSkin: profile.carSkin,
    joinedAt: admin.database.ServerValue.TIMESTAMP
  });

  // Update size in the matchmaking index
  const hostProfile = await getPlayerProfile(lobby.hostUid);
  const hostBucket = Math.floor(hostProfile.elo / 200);
  await rtdb.ref(`matchmaking/bucket_${hostBucket}/${lobbyId}/rosterSize`).set(currentSize + 1);

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

  const snapshot = await lobbyRef.get();
  if (!snapshot.exists()) {
    return { success: true, message: "Lobby already deleted." };
  }

  const lobby = snapshot.val();
  const roster = lobby.members || {};

  // Remove player
  await lobbyRef.child(`members/${uid}`).remove();

  const remainingKeys = Object.keys(roster).filter(key => key !== uid);
  const hostProfile = await getPlayerProfile(lobby.hostUid);
  const hostBucket = Math.floor(hostProfile.elo / 200);

  if (remainingKeys.length === 0) {
    // Delete the lobby completely
    await lobbyRef.remove();
    await rtdb.ref(`matchmaking/bucket_${hostBucket}/${lobbyId}`).remove();
    logger.info(`[LobbyService] Empty lobby ${lobbyId} purged.`);
  } else {
    // Update matchmaking size
    await rtdb.ref(`matchmaking/bucket_${hostBucket}/${lobbyId}/rosterSize`).set(remainingKeys.length);

    // If the leaving player was the Host, perform Host Migration
    if (lobby.hostUid === uid) {
      const newHostUid = remainingKeys[0];
      await lobbyRef.child("hostUid").set(newHostUid);
      
      // Move matchmaking entry to new host's rank bucket
      const newHostProfile = await getPlayerProfile(newHostUid);
      const newHostBucket = Math.floor(newHostProfile.elo / 200);

      await rtdb.ref(`matchmaking/bucket_${hostBucket}/${lobbyId}`).remove();
      await rtdb.ref(`matchmaking/bucket_${newHostBucket}/${lobbyId}`).set({
        hostUid: newHostUid,
        rosterSize: remainingKeys.length,
        createdAt: lobby.createdAt
      });

      logger.info(`[LobbyService] Host migrated from ${uid} to ${newHostUid} in lobby ${lobbyId}`);
    }
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
 * Submits the Unity Relay Join Code (Host Authoritative).
 */
export const submitRelayJoinCode = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async (request) => {
  const auth = request.auth;
  if (!auth) {
    throw new HttpsError("unauthenticated", "User must be logged in.");
  }

  const lobbyId = request.data?.lobbyId;
  const relayJoinCode = request.data?.relayJoinCode;

  if (typeof lobbyId !== "string" || typeof relayJoinCode !== "string") {
    throw new HttpsError("invalid-argument", "Missing lobbyId or relayJoinCode parameter.");
  }

  const rtdb = admin.database();
  const lobbyRef = rtdb.ref(`lobbies/${lobbyId}`);

  const snapshot = await lobbyRef.get();
  if (!snapshot.exists()) {
    throw new HttpsError("not-found", "Lobby not found.");
  }

  const lobby = snapshot.val();
  if (lobby.hostUid !== auth.uid) {
    throw new HttpsError("permission-denied", "Only the host can register the Unity Relay Join Code.");
  }

  await lobbyRef.child("relayJoinCode").set(relayJoinCode);
  logger.info(`[LobbyService] Host registered Relay Code: ${relayJoinCode} for lobby ${lobbyId}`);
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

