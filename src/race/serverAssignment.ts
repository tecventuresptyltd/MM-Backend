import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";

/**
 * Assigns a dedicated game server to a lobby.
 * Called by the lobby host when all players are ready to start a race.
 *
 * Flow:
 * 1. Validates the caller is the lobby host
 * 2. Reads lobby members to build the player list
 * 3. Selects/provisions a server instance (currently: single pre-running server)
 * 4. Writes serverAddress and sessionId to the lobby in RTDB
 * 5. Returns the server address to the calling client
 *
 * TODO: Integrate with actual server orchestration (GCE, GKE, or Agones)
 * when the server infrastructure is provisioned.
 */
export const assignServer = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async (request) => {
  const auth = request.auth;
  if (!auth) {
    throw new HttpsError("unauthenticated", "User must be logged in to request a server.");
  }

  const lobbyId = request.data?.lobbyId;
  if (typeof lobbyId !== "string" || lobbyId.trim().length === 0) {
    throw new HttpsError("invalid-argument", "A valid lobbyId is required.");
  }

  const uid = auth.uid;
  const rtdb = admin.database();
  const lobbyRef = rtdb.ref(`lobbies/${lobbyId}`);

  // Validate lobby exists and caller is the host
  const snapshot = await lobbyRef.get();
  if (!snapshot.exists()) {
    throw new HttpsError("not-found", "Lobby not found.");
  }

  const lobby = snapshot.val();
  if (lobby.hostUid !== uid) {
    throw new HttpsError("permission-denied", "Only the lobby host can request a server assignment.");
  }

  // Build player list from lobby members
  const members = lobby.members || {};
  const playerUids = Object.keys(members);
  if (playerUids.length === 0) {
    throw new HttpsError("failed-precondition", "Cannot assign a server to an empty lobby.");
  }

  // Generate a unique session ID for this race
  const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

  // ──────────────────────────────────────────────────────────
  // SERVER PROVISIONING
  // TODO: Replace this placeholder with actual server orchestration.
  //
  // Options:
  // A) Single pre-running GCE VM: Use a fixed IP + port
  // B) GKE / Agones: Call the Agones allocator API to get a GameServer
  // C) Cloud Run: Spin up a container and get its URL
  //
  // For now, use a placeholder address that the Unity server will listen on.
  // The server should be pre-deployed and listening on the configured port.
  // ──────────────────────────────────────────────────────────

  const SERVER_IP = process.env.GAME_SERVER_IP || "0.0.0.0";
  const SERVER_PORT = process.env.GAME_SERVER_PORT || "7777";
  const serverAddress = `${SERVER_IP}:${SERVER_PORT}`;

  // Write server assignment to the lobby so all clients can discover it
  await lobbyRef.update({
    serverAddress: serverAddress,
    sessionId: sessionId,
    matchmakingStatus: "server_assigned",
  });

  logger.info(
    `[ServerAssignment] Assigned server ${serverAddress} (session: ${sessionId}) ` +
    `to lobby ${lobbyId} with ${playerUids.length} players. Requested by host ${uid}.`
  );

  return {
    success: true,
    serverAddress: serverAddress,
    sessionId: sessionId,
  };
});
