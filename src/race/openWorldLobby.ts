import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { REGION } from "../shared/region.js";
import { callableOptions } from "../shared/callableOptions.js";

/**
 * ═══════════════════════════════════════════════════════════════
 * Open World Lobby — shard registry
 * ═══════════════════════════════════════════════════════════════
 *
 * A shared free-roam world holding up to N players. Multiple shards can exist;
 * this module decides which one a joining player lands in.
 *
 * DESIGN NOTE — servers register, clients only pick:
 *   Shards are created by free-roam GAME SERVERS calling freeRoamServerRegister()
 *   on boot. Clients never create a shard. If clients could create them, they would
 *   mint shard entries with no game server behind them and joiners would sit at a
 *   connection screen forever.
 *
 *   joinOpenWorldLobby() therefore only ever picks from shards that are registered
 *   AND recently heartbeating. If every shard is full it returns a clean
 *   `resource-exhausted` the client can show as "world is full, try again".
 *
 * DESIGN NOTE — why the reservation counter is transactional:
 *   Two players reading playerCount: 9 at the same instant would both join and the
 *   shard would end up at 11. The increment therefore runs inside an RTDB
 *   transaction that re-checks the cap and aborts if the shard filled up in between.
 *
 * DESIGN NOTE — why the count self-heals:
 *   A crashed client leaves a stale reservation behind. The game server knows exactly
 *   who is really connected, so freeRoamServerHeartbeat() prunes reservations the
 *   server can't see (after a grace period, so a player who reserved but hasn't
 *   finished connecting yet is never kicked) and rewrites playerCount from the
 *   surviving members. Drift fixes itself within one heartbeat instead of needing
 *   the scheduled reaper to catch it.
 *
 * RTDB shape:
 *   /openWorldLobbies/{lobbyId}
 *     ip, port, connectionKey     — how to reach the game server
 *     maxPlayers                  — shard cap
 *     playerCount                 — live occupancy (transactional)
 *     registeredAt, lastHeartbeat — liveness
 *     members/{uid}: { joinedAt }
 */

// #region Constants

/** A shard whose server hasn't heartbeat within this window is treated as dead. */
const SERVER_STALE_MS = 90 * 1000;

/**
 * Grace period between a client reserving a slot and the game server being expected
 * to see them connected. Below this age a reservation is never pruned — the player
 * is still loading the scene and opening their UDP socket.
 */
const RESERVATION_GRACE_MS = 45 * 1000;

/** Hard ceiling on shards inspected per join, so a leaked registry can't slow joins down. */
const MAX_SHARDS_SCANNED = 50;

const DEFAULT_MAX_PLAYERS = 10;

// #endregion

// #region Types

interface ShardRecord {
  ip?: string;
  port?: number;
  connectionKey?: string;
  maxPlayers?: number;
  playerCount?: number;
  registeredAt?: number;
  lastHeartbeat?: number;
  members?: Record<string, { joinedAt?: number }>;
}

interface ShardCandidate {
  lobbyId: string;
  shard: ShardRecord;
  occupancy: number;
  capacity: number;
}

// #endregion

// #region Helpers

const rtdb = () => admin.database();

const shardsRef = () => rtdb().ref("openWorldLobbies");

const shardRef = (lobbyId: string) => rtdb().ref(`openWorldLobbies/${lobbyId}`);

const requireLobbyId = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpsError("invalid-argument", "A valid lobbyId is required.");
  }
  return value.trim();
};

/** A shard is joinable only if a live server is behind it and it has a usable address. */
const isShardAlive = (shard: ShardRecord, now: number): boolean => {
  if (!shard || typeof shard.ip !== "string" || shard.ip.length === 0) return false;
  if (typeof shard.port !== "number" || shard.port <= 0) return false;
  const beat = typeof shard.lastHeartbeat === "number" ? shard.lastHeartbeat : shard.registeredAt;
  if (typeof beat !== "number") return false;
  return now - beat < SERVER_STALE_MS;
};

const memberCount = (shard: ShardRecord): number =>
  shard.members ? Object.keys(shard.members).length : 0;

/**
 * Occupancy used for cap decisions: the higher of the reservation counter and the
 * actual member list, so neither a drifted counter nor a missed decrement can let
 * a shard overfill.
 */
const effectiveOccupancy = (shard: ShardRecord): number =>
  Math.max(
    typeof shard.playerCount === "number" && shard.playerCount > 0 ? shard.playerCount : 0,
    memberCount(shard)
  );

const shardConnectionPayload = (lobbyId: string, shard: ShardRecord) => ({
  lobbyId,
  ip: shard.ip,
  port: shard.port,
  connectionKey: shard.connectionKey ?? "MysticMotors_v1",
  maxPlayers: shard.maxPlayers ?? DEFAULT_MAX_PLAYERS,
});

// #endregion

// #region joinOpenWorldLobby — called by the Unity client

/**
 * Picks a live, non-full shard and reserves a slot in it.
 *
 * Packing behaviour: candidates are tried fullest-first so players actually meet
 * each other, instead of being scattered one per shard.
 */
export const joinOpenWorldLobby = onCall(
  callableOptions({ cpu: 1, concurrency: 80 }),
  async (request) => {
    const auth = request.auth;
    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be logged in to join the open world.");
    }

    const uid = auth.uid;
    const now = Date.now();

    const snapshot = await shardsRef().get();
    const allShards = (snapshot.val() ?? {}) as Record<string, ShardRecord>;
    const entries = Object.entries(allShards).slice(0, MAX_SHARDS_SCANNED);

    if (entries.length === 0) {
      throw new HttpsError(
        "unavailable",
        "No open world server is currently online. Please try again shortly."
      );
    }

    // Rejoin path: if this player already holds a reservation on a live shard, hand
    // back the same one instead of double-counting them. Covers reconnects and
    // duplicate calls from a retrying client.
    for (const [lobbyId, shard] of entries) {
      if (shard?.members?.[uid] && isShardAlive(shard, now)) {
        logger.info("[OpenWorldLobby] Existing reservation reused", { uid, lobbyId });
        return { success: true, rejoined: true, ...shardConnectionPayload(lobbyId, shard) };
      }
    }

    const candidates: ShardCandidate[] = entries
      .filter(([, shard]) => isShardAlive(shard, now))
      .map(([lobbyId, shard]) => ({
        lobbyId,
        shard,
        occupancy: effectiveOccupancy(shard),
        capacity: shard.maxPlayers ?? DEFAULT_MAX_PLAYERS,
      }))
      .filter((c) => c.occupancy < c.capacity)
      .sort((a, b) => b.occupancy - a.occupancy); // fullest first — keep players together

    if (candidates.length === 0) {
      throw new HttpsError(
        "resource-exhausted",
        "All open world shards are full. Please try again shortly."
      );
    }

    for (const candidate of candidates) {
      const capacity = candidate.capacity;

      // Transactionally claim a slot, re-checking the cap so two players can't both
      // take the last one.
      //
      // MUST NOT abort on null. RTDB invokes this handler speculatively with null
      // before the server value arrives; returning undefined there aborts the whole
      // transaction and the reservation never commits — for anyone. Null is therefore
      // treated as zero. The shard's existence was already confirmed by the read above,
      // and in the rare case it was deleted in between we create a lone playerCount
      // node, which has no `ip` — so isShardAlive() hides it from joiners immediately
      // and the reaper deletes it on the next pass.
      const result = await shardRef(candidate.lobbyId)
        .child("playerCount")
        .transaction((current) => {
          const count = typeof current === "number" && current > 0 ? current : 0;
          if (count >= capacity) return undefined;      // genuinely full — try the next shard
          return count + 1;
        });

      if (!result.committed) continue;

      await shardRef(candidate.lobbyId)
        .child(`members/${uid}`)
        .set({ joinedAt: admin.database.ServerValue.TIMESTAMP });

      logger.info("[OpenWorldLobby] Slot reserved", {
        uid,
        lobbyId: candidate.lobbyId,
        playerCount: result.snapshot.val(),
        capacity,
      });

      return {
        success: true,
        rejoined: false,
        ...shardConnectionPayload(candidate.lobbyId, candidate.shard),
      };
    }

    throw new HttpsError(
      "resource-exhausted",
      "All open world shards filled up while joining. Please try again."
    );
  }
);

// #endregion

// #region leaveOpenWorldLobby — called by the Unity client

/**
 * Releases the caller's reservation. Safe to call twice — a member that is already
 * gone decrements nothing, so the counter can't be driven negative by retries.
 */
export const leaveOpenWorldLobby = onCall(
  callableOptions({ cpu: 1, concurrency: 80 }),
  async (request) => {
    const auth = request.auth;
    if (!auth) {
      throw new HttpsError("unauthenticated", "User must be logged in.");
    }

    const uid = auth.uid;
    const lobbyId = requireLobbyId(request.data?.lobbyId);
    const memberRef = shardRef(lobbyId).child(`members/${uid}`);

    const memberSnap = await memberRef.get();
    if (!memberSnap.exists()) {
      return { success: true, alreadyLeft: true };
    }

    await memberRef.remove();
    // Same null rule as the join path: aborting on null would stop the decrement from
    // ever committing, so the counter would only ever climb.
    await shardRef(lobbyId)
      .child("playerCount")
      .transaction((current) => {
        const count = typeof current === "number" && current > 0 ? current : 0;
        return count > 0 ? count - 1 : 0;
      });

    logger.info("[OpenWorldLobby] Slot released", { uid, lobbyId });
    return { success: true, alreadyLeft: false };
  }
);

// #endregion

// #region freeRoamServerRegister — called by the .NET game server on boot

/**
 * A free-roam game server announces itself. Called with a service account, so
 * App Check is off — same pattern as serverSelfRegister for race servers.
 *
 * Re-registering an existing lobbyId (server restart) resets occupancy to zero,
 * because a restarted process has dropped every socket it was holding.
 */
export const freeRoamServerRegister = onCall(
  callableOptions({ cpu: 1, concurrency: 80, enforceAppCheck: false }),
  async (request) => {
    const { lobbyId: rawLobbyId, ip, port, connectionKey, maxPlayers } = request.data ?? {};
    const lobbyId = requireLobbyId(rawLobbyId);

    if (typeof ip !== "string" || ip.trim().length === 0) {
      throw new HttpsError("invalid-argument", "ip is required.");
    }
    if (typeof port !== "number" || port < 1 || port > 65535) {
      throw new HttpsError("invalid-argument", "port must be 1-65535.");
    }

    const cap =
      typeof maxPlayers === "number" && maxPlayers > 0 && maxPlayers <= 64
        ? Math.floor(maxPlayers)
        : DEFAULT_MAX_PLAYERS;

    await shardRef(lobbyId).set({
      ip: ip.trim(),
      port,
      connectionKey: typeof connectionKey === "string" && connectionKey.length > 0
        ? connectionKey
        : "MysticMotors_v1",
      maxPlayers: cap,
      playerCount: 0,
      members: null,
      registeredAt: admin.database.ServerValue.TIMESTAMP,
      lastHeartbeat: admin.database.ServerValue.TIMESTAMP,
    });

    logger.info("[OpenWorldLobby] Server registered", { lobbyId, ip, port, maxPlayers: cap });
    return { success: true, lobbyId };
  }
);

// #endregion

// #region freeRoamServerHeartbeat — called by the .NET game server every few seconds

/**
 * Liveness plus the authoritative roster. The server sends exactly who it has
 * connected; this prunes reservations it can't see (older than the grace period)
 * and rewrites playerCount from what survives, so the counter self-corrects after
 * a client crash without waiting for the scheduled reaper.
 */
export const freeRoamServerHeartbeat = onCall(
  callableOptions({ cpu: 1, concurrency: 80, enforceAppCheck: false }),
  async (request) => {
    const { lobbyId: rawLobbyId, connectedUids } = request.data ?? {};
    const lobbyId = requireLobbyId(rawLobbyId);

    const connected = new Set<string>(
      Array.isArray(connectedUids)
        ? connectedUids.filter((u): u is string => typeof u === "string" && u.length > 0)
        : []
    );

    const ref = shardRef(lobbyId);
    const snap = await ref.get();
    if (!snap.exists()) {
      // The reaper removed this shard (or it was never registered). Tell the server
      // so it can re-register rather than heartbeating into the void forever.
      return { success: false, reason: "not-registered" };
    }

    const shard = (snap.val() ?? {}) as ShardRecord;
    const members = shard.members ?? {};
    const now = Date.now();

    const updates: Record<string, unknown> = {
      lastHeartbeat: admin.database.ServerValue.TIMESTAMP,
    };

    let surviving = 0;
    for (const [uid, member] of Object.entries(members)) {
      const joinedAt = typeof member?.joinedAt === "number" ? member.joinedAt : now;
      const withinGrace = now - joinedAt < RESERVATION_GRACE_MS;

      if (connected.has(uid) || withinGrace) {
        surviving++;
        continue;
      }
      updates[`members/${uid}`] = null; // stale reservation — player never arrived or dropped
    }

    // Anyone the server sees but who has no reservation row still occupies a slot.
    for (const uid of connected) {
      if (!members[uid]) {
        updates[`members/${uid}`] = { joinedAt: admin.database.ServerValue.TIMESTAMP };
        surviving++;
      }
    }

    updates.playerCount = surviving;
    await ref.update(updates);

    return { success: true, playerCount: surviving };
  }
);

// #endregion

// #region openWorldLobbyReaper — scheduled cleanup

/**
 * Backstop for shards whose server died without deregistering. Without this the
 * registry fills with dead entries and joiners get handed an address that never
 * answers.
 *
 * Also reconciles playerCount against the member list, in case a heartbeat was
 * missed while reservations were being written.
 */
export const openWorldLobbyReaper = onSchedule(
  {
    region: REGION,
    schedule: "every 5 minutes",
    timeZone: "Etc/UTC",
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    const snapshot = await shardsRef().get();
    if (!snapshot.exists()) return;

    const allShards = (snapshot.val() ?? {}) as Record<string, ShardRecord>;
    const now = Date.now();
    const updates: Record<string, unknown> = {};
    let removed = 0;
    let reconciled = 0;

    for (const [lobbyId, shard] of Object.entries(allShards)) {
      if (!isShardAlive(shard, now)) {
        updates[lobbyId] = null;
        removed++;
        continue;
      }

      const actual = memberCount(shard);
      if (shard.playerCount !== actual) {
        updates[`${lobbyId}/playerCount`] = actual;
        reconciled++;
      }
    }

    if (Object.keys(updates).length === 0) return;

    await shardsRef().update(updates);
    logger.info("[OpenWorldLobby] Reaper pass complete", { removed, reconciled });
  }
);

// #endregion
