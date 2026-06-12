import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { getSpellsCatalog } from "../core/config.js";
import { generateBotLoadoutResponse } from "../game-systems/botLoadoutHelper.js";

/**
 * ═══════════════════════════════════════════════════════════════
 * Dedicated Server Provisioning
 * ═══════════════════════════════════════════════════════════════
 *
 * requestDedicatedServer:
 *   Called by the lobby host's Unity client to provision a dedicated
 *   game server for the race. The function validates the caller is the
 *   lobby host, reads lobby metadata (track, roster), and writes
 *   serverInfo to RTDB so all clients can auto-connect.
 *
 *   For LOCAL TESTING:
 *     The server must already be running on the developer's machine.
 *     The function writes 127.0.0.1:7777 to RTDB.
 *     Set MM_SERVER_MODE=local in environment (default).
 *
 *   For PRODUCTION:
 *     Set MM_SERVER_MODE=gcp and implement Cloud Run / GCE provisioning
 *     in the GCP section below.
 *
 * serverHeartbeat:
 *   Called by the dedicated server process periodically to confirm
 *   it is alive. Updates the serverInfo node with a timestamp.
 *   Uses a service account token (no App Check).
 *
 * serverRecordRaceResult:
 *   Called by the dedicated server process to record the authoritative
 *   race result. Proxies the data to the existing recordRaceResult
 *   logic for each player in the race, ensuring trophy/coin/xp
 *   settlement is identical to the current host-client flow.
 *   Uses a service account token (no App Check).
 */

const rtdb = () => admin.database();

// ═══════════════════════════════════════════════════════════════
// Shared-secret authentication for server-to-server callables
// ═══════════════════════════════════════════════════════════════
//
// The App-Check-EXEMPT server* functions are invoked by the dedicated
// game-server process (a trusted backend), not by Unity clients. Without
// App Check enforcement, any signed-in user could otherwise spoof them.
// We gate every exempt function behind a shared secret carried in the
// payload as `serverSecret`. The secret is provisioned to the dedicated
// server via the MM_SERVER_SECRET environment variable (same value on
// both sides).

/**
 * Throws failed-precondition if the server secret is not configured in the
 * environment, or permission-denied if the caller did not supply the
 * matching secret. Callers must invoke this before trusting any payload.
 */
const assertServerSecret = (data: unknown): void => {
  const expected = process.env.MM_SERVER_SECRET;
  if (typeof expected !== "string" || expected.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      "Server secret is not configured (MM_SERVER_SECRET unset).",
    );
  }
  const provided =
    data && typeof data === "object"
      ? (data as Record<string, unknown>).serverSecret
      : undefined;
  if (typeof provided !== "string") {
    throw new HttpsError(
      "permission-denied",
      "Invalid or missing server secret.",
    );
  }
  // Constant-time comparison to avoid leaking the secret via timing.
  // timingSafeEqual requires equal-length buffers, so a length mismatch is
  // treated as a (constant-time) failure rather than passed to the comparator.
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (
    expectedBuf.length !== providedBuf.length ||
    !timingSafeEqual(expectedBuf, providedBuf)
  ) {
    throw new HttpsError(
      "permission-denied",
      "Invalid or missing server secret.",
    );
  }
};

// NOTE: None of the server* functions below log the raw request payload —
// they only log explicitly-named, non-secret fields (lobbyId, raceId, etc.).
// `serverSecret` is therefore never written to logs. If a future change logs
// the whole payload, strip `serverSecret` first.

// ═══════════════════════════════════════════════════════════════
// requestDedicatedServer — Called by Unity lobby host
// ═══════════════════════════════════════════════════════════════
//
// ⚠️ DEPLOYMENT DEPENDENCY — DYNAMIC CONNECTION KEY ⚠️
// As of this change, the LiteNetLib connection key is generated fresh per
// provision (no longer the static "MysticMotors_v1"). The .NET dedicated
// server reads its key from the MM_CONNECTION_KEY environment variable
// (Server/MysticMotors.Server/Config/ServerConfig.cs → ConnectionKey) and
// rejects any peer whose key does not match (GameServer.cs → AcceptIfKey).
//
// Therefore the per-provision `connectionKey` written to serverInfo below MUST
// be passed to the server process as MM_CONNECTION_KEY at launch, or guests
// will be refused at the handshake. Wiring that into the actual process launch
// is OUT OF SCOPE here (the GCP/Cloud Run launch path is a TODO below, and the
// local/lan server is started manually). Until that wiring exists:
//   • GCP mode: pass connectionKey into the job's MM_CONNECTION_KEY env.
//   • local/lan mode: the manually-started server must be launched with the
//     SAME MM_CONNECTION_KEY this function generated, OR (interim) override
//     MM_CONNECTION_KEY on the server to a fixed value AND change this function
//     to emit that fixed key. Reported to the orchestrator as a hard dependency.

export const requestDedicatedServer = onCall(
  callableOptions({ cpu: 1, concurrency: 80 }),
  async (request) => {
    const auth = request.auth;
    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    const uid = auth.uid;
    const { lobbyId, sceneName } = request.data ?? {};

    if (typeof lobbyId !== "string" || lobbyId.trim().length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "A valid lobbyId is required."
      );
    }

    // Validate caller is the lobby host
    const lobbyRef = rtdb().ref(`lobbies/${lobbyId}`);
    const lobbySnap = await lobbyRef.get();

    if (!lobbySnap.exists()) {
      throw new HttpsError("not-found", "Lobby not found.");
    }

    const lobbyData = lobbySnap.val();
    if (lobbyData.hostUid !== uid) {
      throw new HttpsError(
        "permission-denied",
        "Only the lobby host can request a dedicated server."
      );
    }

    // Gather lobby context for the server
    const trackId =
      typeof sceneName === "string" && sceneName.length > 0
        ? sceneName
        : lobbyData.launchSceneName ?? "";
    const gameMode = lobbyData.gameMode ?? "Ranked";
    const members = lobbyData.members ?? {};
    const playerCount = Object.keys(members).length;

    logger.info("[DedicatedServer] Provisioning server", {
      lobbyId,
      trackId,
      gameMode,
      playerCount,
      requestedBy: uid,
    });

    // ── Server Provisioning ──
    const serverMode = process.env.MM_SERVER_MODE ?? "local";
    let serverIp: string;
    let serverPort: number;

    // Connection key handed to clients for the LiteNetLib handshake.
    // - gcp mode: cryptographically random per provision (the provisioning step
    //   launches the server process and must pass it via MM_CONNECTION_KEY —
    //   see the dependency note at the bottom of this file).
    // - local/lan modes: the server process is started MANUALLY before this
    //   function runs, so a random key here would never match what the server
    //   was launched with and every client would be refused at the handshake.
    //   Use MM_SHARED_CONNECTION_KEY (set the same value on the server process)
    //   or fall back to the server's built-in default.
    const connectionKey =
      serverMode === "gcp"
        ? `MM_${randomBytes(24).toString("hex")}`
        : (process.env.MM_SHARED_CONNECTION_KEY || "MysticMotors_v1");

    // A fresh session token on EVERY provision call guarantees the serverInfo
    // node's value changes even when ip/port (and connectionKey, in fixed-host
    // local/lan modes) are reused for back-to-back races. The Unity client's
    // serverInfo ValueChanged listener (OnServerInfoReceived) therefore re-fires
    // and reconnects for the second race instead of seeing an unchanged node.
    const sessionToken = randomUUID();

    switch (serverMode) {
      case "local":
        // Server is already running on the developer's machine
        if (process.env.MM_SERVER_ADDRESS) {
          const parts = process.env.MM_SERVER_ADDRESS.split(":");
          serverIp = parts[0];
          serverPort = parts.length > 1 ? parseInt(parts[1], 10) : 7777;
          logger.info(`[DedicatedServer] LOCAL mode (Tunnelling) — using ${serverIp}:${serverPort}`);
        } else {
          serverIp = "127.0.0.1";
          serverPort = 7777;
          logger.info("[DedicatedServer] LOCAL mode — assuming server at 127.0.0.1:7777");
        }
        break;

      case "lan":
        // For LAN testing across devices
        serverIp = process.env.MM_LAN_SERVER_IP ?? "192.168.1.100";
        serverPort = parseInt(process.env.MM_LAN_SERVER_PORT ?? "7777", 10);
        logger.info(`[DedicatedServer] LAN mode — ${serverIp}:${serverPort}`);
        break;

      case "gcp": {
        // ── PRODUCTION: Start a GCP Cloud Run Job or GCE Instance ──
        // TODO: Implement Cloud Run / GCE provisioning
        //
        // Example with Cloud Run Jobs API:
        //   const { JobsClient } = require("@google-cloud/run").v2;
        //   const client = new JobsClient();
        //   await client.runJob({
        //     name: `projects/PROJECT_ID/locations/us-central1/jobs/mystic-motors-server`,
        //     overrides: {
        //       containerOverrides: [{
        //         env: [
        //           { name: "MM_LOBBY_ID", value: lobbyId },
        //           { name: "MM_TRACK_ID", value: trackId },
        //         ]
        //       }]
        //     }
        //   });
        //
        // The server process itself writes its public IP to RTDB on startup.
        // For now, write a placeholder — the server overwrites on boot.
        serverIp = "PENDING_GCP_ALLOCATION";
        serverPort = 7777;
        logger.info("[DedicatedServer] GCP mode — server will self-register IP");
        break;
      }

      default:
        logger.error(`[DedicatedServer] Unknown server mode: ${serverMode}`);
        throw new HttpsError(
          "internal",
          `Unknown server mode: ${serverMode}`
        );
    }

    // Write server connection info to RTDB
    // All clients listen on lobbies/{lobbyId}/serverInfo and auto-connect
    await lobbyRef.child("serverInfo").set({
      ip: serverIp,
      port: serverPort,
      connectionKey,
      sessionToken,
      sceneName: trackId,
      gameMode,
      playerCount,
      provisionedAt: admin.database.ServerValue.TIMESTAMP,
    });

    // Update matchmaking status
    await lobbyRef.child("matchmakingStatus").set("server_ready");

    logger.info("[DedicatedServer] Server info written", {
      lobbyId,
      ip: serverIp,
      port: serverPort,
    });

    return {
      success: true,
      serverIp,
      serverPort,
      connectionKey,
      sessionToken,
    };
  }
);

// ═══════════════════════════════════════════════════════════════
// serverHeartbeat — Called by the dedicated server process
// ═══════════════════════════════════════════════════════════════

export const serverHeartbeat = onCall(
  callableOptions({ cpu: 1, concurrency: 80, enforceAppCheck: false }),
  async (request) => {
    // App Check is exempt for server-to-server calls; authenticate via shared secret.
    assertServerSecret(request.data);
    const { lobbyId, connectedPlayers, raceState } = request.data ?? {};

    if (typeof lobbyId !== "string" || lobbyId.trim().length === 0) {
      throw new HttpsError("invalid-argument", "lobbyId is required.");
    }

    const heartbeatData: Record<string, unknown> = {
      lastHeartbeat: admin.database.ServerValue.TIMESTAMP,
    };

    if (typeof connectedPlayers === "number") {
      heartbeatData.connectedPlayers = connectedPlayers;
    }
    if (typeof raceState === "string") {
      heartbeatData.raceState = raceState;
    }

    await rtdb()
      .ref(`lobbies/${lobbyId}/serverInfo`)
      .update(heartbeatData);

    return { success: true };
  }
);

// ═══════════════════════════════════════════════════════════════
// serverRecordRaceResult — Called by the dedicated server
// ═══════════════════════════════════════════════════════════════

/**
 * The dedicated server calls this with the authoritative finish order for
 * the entire race. This is a server-to-server call (App Check exempt,
 * authenticated via the shared MM_SERVER_SECRET).
 *
 * This function does NOT settle rewards itself — settlement (trophies, coins,
 * XP, drops) is owned by recordRaceResult, which runs once per player inside
 * a Firestore transaction. This function simply persists the authoritative
 * finish order onto the Race document so that, when each player's client
 * calls recordRaceResult, the settlement uses the server's ordering instead
 * of trusting the client-submitted order. (See recordRaceResult in
 * ../race/index.ts: when raceData.serverFinishOrder is present it derives the
 * authoritative placement indices from it.)
 *
 * Input (payload):
 *   serverSecret: string — shared secret (stripped before logging)
 *   lobbyId:      string — the lobby this race belongs to
 *   raceId:       string — from startRace/prepareRace
 *   finishOrder:  Array<{
 *                   slot: number,        // server-side slot id
 *                   uid: string,         // player uid ("" for bots)
 *                   botName: string,     // bot display name ("" for players)
 *                   isBot: boolean,
 *                   position: number,    // 1-indexed final placement
 *                   timeSeconds: number, // finish time
 *                 }>
 *
 * Writes to /Races/{raceId}:
 *   serverFinishOrder: the validated finishOrder array (sorted by position)
 *   source: "dedicated_server"
 *   serverSubmittedAt: server timestamp
 *
 * Idempotency: if /Races/{raceId} already has a serverFinishOrder whose
 * content differs from this submission, the call is rejected (logged) rather
 * than overwriting authoritative data. Re-submitting identical content is a
 * no-op success.
 */

type ServerFinishOrderEntry = {
  slot: number;
  uid: string;
  botName: string;
  isBot: boolean;
  position: number;
  timeSeconds: number;
};

const validateServerFinishOrder = (raw: unknown): ServerFinishOrderEntry[] => {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "finishOrder must be a non-empty array.",
    );
  }
  const normalized: ServerFinishOrderEntry[] = raw.map((entry, idx) => {
    if (!entry || typeof entry !== "object") {
      throw new HttpsError(
        "invalid-argument",
        `finishOrder[${idx}] must be an object.`,
      );
    }
    const e = entry as Record<string, unknown>;
    const slot = Number(e.slot);
    const isBot = e.isBot === true;
    const uid = typeof e.uid === "string" ? e.uid : "";
    const botName = typeof e.botName === "string" ? e.botName : "";
    const position = Number(e.position);
    const timeSeconds = Number(e.timeSeconds);

    if (!Number.isFinite(slot)) {
      throw new HttpsError("invalid-argument", `finishOrder[${idx}].slot must be a number.`);
    }
    if (!Number.isInteger(position) || position < 1) {
      throw new HttpsError("invalid-argument", `finishOrder[${idx}].position must be a positive integer.`);
    }
    if (!isBot && uid.trim().length === 0) {
      throw new HttpsError("invalid-argument", `finishOrder[${idx}] is a player but has no uid.`);
    }
    if (isBot && botName.trim().length === 0) {
      throw new HttpsError("invalid-argument", `finishOrder[${idx}] is a bot but has no botName.`);
    }

    return {
      slot,
      uid,
      botName,
      isBot,
      position,
      timeSeconds: Number.isFinite(timeSeconds) ? timeSeconds : 0,
    };
  });

  // Persist in placement order so downstream consumers can rely on it.
  normalized.sort((a, b) => a.position - b.position);
  return normalized;
};

/** Order-insensitive structural equality for an existing serverFinishOrder. */
const serverFinishOrdersMatch = (
  a: unknown,
  b: ServerFinishOrderEntry[],
): boolean => {
  if (!Array.isArray(a) || a.length !== b.length) {
    return false;
  }
  const key = (e: Partial<ServerFinishOrderEntry>): string =>
    `${e.slot}|${e.uid ?? ""}|${e.botName ?? ""}|${e.isBot === true}|${e.position}`;
  const existing = (a as Array<Record<string, unknown>>)
    .map((e) => key({
      slot: Number(e.slot),
      uid: typeof e.uid === "string" ? e.uid : "",
      botName: typeof e.botName === "string" ? e.botName : "",
      isBot: e.isBot === true,
      position: Number(e.position),
    }))
    .sort();
  const incoming = b.map((e) => key(e)).sort();
  return existing.every((val, i) => val === incoming[i]);
};

export const serverRecordRaceResult = onCall(
  callableOptions({
    cpu: 1,
    concurrency: 80,
    memory: "512MiB",
    enforceAppCheck: false,
  }),
  async (request) => {
    assertServerSecret(request.data);
    const { lobbyId, raceId, finishOrder } = request.data ?? {};

    // Validate required fields
    if (typeof lobbyId !== "string" || lobbyId.trim().length === 0) {
      throw new HttpsError("invalid-argument", "lobbyId is required.");
    }
    if (typeof raceId !== "string" || raceId.trim().length === 0) {
      throw new HttpsError("invalid-argument", "raceId is required.");
    }
    const validatedFinishOrder = validateServerFinishOrder(finishOrder);

    logger.info("[serverRecordRaceResult] Recording authoritative finish order", {
      lobbyId,
      raceId,
      finishOrderLength: validatedFinishOrder.length,
    });

    const db = admin.firestore();
    const raceRef = db.doc(`/Races/${raceId}`);

    // Persist the authoritative finish order with an idempotency guard inside
    // a transaction so concurrent submissions cannot clobber each other.
    await db.runTransaction(async (transaction) => {
      const raceDoc = await transaction.get(raceRef);
      if (!raceDoc.exists) {
        throw new HttpsError("not-found", `Race ${raceId} not found.`);
      }

      const raceData = raceDoc.data() ?? {};
      const existing = raceData.serverFinishOrder;
      if (existing !== undefined && existing !== null) {
        if (serverFinishOrdersMatch(existing, validatedFinishOrder)) {
          // Identical re-submission — idempotent no-op.
          logger.info(
            "[serverRecordRaceResult] Identical finish order already recorded — no-op",
            { raceId, lobbyId },
          );
          return;
        }
        // Different content — reject rather than overwrite authoritative data.
        logger.error(
          "[serverRecordRaceResult] Rejected attempt to overwrite existing serverFinishOrder",
          { raceId, lobbyId, existingLength: Array.isArray(existing) ? existing.length : null, incomingLength: validatedFinishOrder.length },
        );
        throw new HttpsError(
          "already-exists",
          "Race already has a different server finish order; refusing to overwrite.",
        );
      }

      transaction.update(raceRef, {
        serverFinishOrder: validatedFinishOrder,
        source: "dedicated_server",
        serverLobbyId: lobbyId,
        serverSubmittedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    logger.info("[serverRecordRaceResult] Authoritative finish order persisted", {
      raceId,
      lobbyId,
    });

    // Settlement of trophies/coins/XP still happens in recordRaceResult, which
    // each player's client calls and which now honours serverFinishOrder.
    return {
      success: true,
      raceId,
      finishOrderLength: validatedFinishOrder.length,
    };
  }
);

// ═══════════════════════════════════════════════════════════════
// serverUpdateRaceState — Server announces state changes
// ═══════════════════════════════════════════════════════════════

export const serverUpdateRaceState = onCall(
  callableOptions({ cpu: 1, concurrency: 80, enforceAppCheck: false }),
  async (request) => {
    assertServerSecret(request.data);
    const { lobbyId, state } = request.data ?? {};

    if (typeof lobbyId !== "string" || lobbyId.trim().length === 0) {
      throw new HttpsError("invalid-argument", "lobbyId is required.");
    }
    if (typeof state !== "string") {
      throw new HttpsError("invalid-argument", "state is required.");
    }

    const validStates = [
      "waiting_for_players",
      "countdown",
      "racing",
      "finishing",
      "completed",
      "shutting_down",
    ];

    if (!validStates.includes(state)) {
      throw new HttpsError(
        "invalid-argument",
        `Invalid state. Must be one of: ${validStates.join(", ")}`
      );
    }

    await rtdb().ref(`lobbies/${lobbyId}/serverInfo`).update({
      raceState: state,
      lastStateUpdate: admin.database.ServerValue.TIMESTAMP,
    });

    // When race completes, update matchmaking status
    if (state === "completed" || state === "shutting_down") {
      await rtdb()
        .ref(`lobbies/${lobbyId}/matchmakingStatus`)
        .set("race_complete");
    }

    logger.info("[serverUpdateRaceState]", { lobbyId, state });
    return { success: true };
  }
);

// ═══════════════════════════════════════════════════════════════
// serverSelfRegister — Server announces its own IP on boot
// ═══════════════════════════════════════════════════════════════

/**
 * Called by the dedicated server on startup in GCP mode to write
 * its public IP address to the lobby's serverInfo node.
 * This enables the Cloud Function to provision the server without
 * knowing the IP in advance.
 */
export const serverSelfRegister = onCall(
  callableOptions({ cpu: 1, concurrency: 80, enforceAppCheck: false }),
  async (request) => {
    assertServerSecret(request.data);
    const { lobbyId, ip, port, connectionKey } = request.data ?? {};

    if (typeof lobbyId !== "string" || lobbyId.trim().length === 0) {
      throw new HttpsError("invalid-argument", "lobbyId is required.");
    }
    if (typeof ip !== "string" || ip.trim().length === 0) {
      throw new HttpsError("invalid-argument", "ip is required.");
    }
    if (typeof port !== "number" || port < 1 || port > 65535) {
      throw new HttpsError("invalid-argument", "port must be 1-65535.");
    }

    logger.info("[serverSelfRegister] Server booted and registering", {
      lobbyId,
      ip,
      port,
    });

    await rtdb().ref(`lobbies/${lobbyId}/serverInfo`).update({
      ip,
      port,
      connectionKey: connectionKey ?? "MysticMotors_v1",
      registeredAt: admin.database.ServerValue.TIMESTAMP,
    });

    // Signal clients that the server is ready
    await rtdb()
      .ref(`lobbies/${lobbyId}/matchmakingStatus`)
      .set("server_ready");

    return { success: true };
  }
);

// ═══════════════════════════════════════════════════════════════
// serverGetSpellCatalog — Dedicated server reads the spell catalog
// ═══════════════════════════════════════════════════════════════

/**
 * Called by the dedicated server (App Check exempt, shared-secret
 * authenticated) to fetch the spell catalog so it can authoritatively
 * resolve spell definitions during a race. Mirrors the SpellsCatalog doc
 * content at /GameData/v1/catalogs/SpellsCatalog. Returns { spells: <map> }.
 *
 * Reuses getSpellsCatalog() (the same cached/normalised loader the client
 * race flow uses) rather than reading raw Firestore, so the server sees the
 * identical spell data clients do.
 */
export const serverGetSpellCatalog = onCall(
  callableOptions({ cpu: 1, concurrency: 80, memory: "512MiB", enforceAppCheck: false }),
  async (request) => {
    assertServerSecret(request.data);

    const spells = await getSpellsCatalog();

    logger.info("[serverGetSpellCatalog] Served spell catalog", {
      spellCount: Object.keys(spells ?? {}).length,
    });

    return { spells };
  }
);

// ═══════════════════════════════════════════════════════════════
// serverGenerateBotLoadout — Dedicated server generates a bot loadout
// ═══════════════════════════════════════════════════════════════

/**
 * Called by the dedicated server (App Check exempt, shared-secret
 * authenticated) to generate a bot loadout. Delegates to the same shared
 * core (generateBotLoadoutResponse) used by the App-Check-enforced client
 * callable generateBotLoadout, so the logic lives in one place.
 *
 * Payload: { trophies: number, serverSecret: string }
 */
export const serverGenerateBotLoadout = onCall(
  callableOptions({ cpu: 1, concurrency: 80, enforceAppCheck: false }),
  async (request) => {
    assertServerSecret(request.data);
    const { trophies } = request.data ?? {};
    try {
      return await generateBotLoadoutResponse(trophies);
    } catch (e) {
      if (e instanceof Error && e.message === "invalid trophyCount") {
        throw new HttpsError("invalid-argument", "trophies must be a non-negative number.");
      }
      throw e;
    }
  }
);
