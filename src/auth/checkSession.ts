import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region";
import { assertSupportedAppVersion } from "../shared/appVersion";

const PRESENCE_ROOT = "presence/online";
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

type PresenceNode = {
  lastSeen?: unknown;
  roomId?: unknown;
  clanId?: unknown;
};

const isFresh = (value: unknown, now: number): boolean => {
  const ts = Number(value);
  if (!Number.isFinite(ts)) return false;
  return ts > 0 && now - ts <= SESSION_TTL_MS;
};

// TEMPORARY: Disabled App Check until Firebase Authentication service sends tokens
// TODO: Re-enable once Authentication shows >90% verified requests
export const checkSession = onCall({ enforceAppCheck: false, region: REGION }, async (request) => {
  const { deviceAnchor, appVersion } = request.data ?? {};

  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  assertSupportedAppVersion(appVersion);

  const uid = request.auth.uid;
  const now = Date.now();
  const rootRef = admin.database().ref(`${PRESENCE_ROOT}/${uid}`);
  const connectionsRef = rootRef.child("connections");

  const [rootSnap, connectionsSnap] = await Promise.all([rootRef.get(), connectionsRef.get()]);

  let alreadyLoggedIn = false;
  let latestLastSeen: number | null = null;
  const seenAnchors: string[] = [];

  if (connectionsSnap.exists()) {
    const connections = connectionsSnap.val() as Record<string, PresenceNode>;
    for (const [anchor, data] of Object.entries(connections ?? {})) {
      seenAnchors.push(anchor);
      const { lastSeen } = data ?? {};
      if (isFresh(lastSeen, now) && (!deviceAnchor || anchor !== deviceAnchor)) {
        alreadyLoggedIn = true;
      }
      const ts = Number(lastSeen);
      if (Number.isFinite(ts)) {
        latestLastSeen = latestLastSeen !== null ? Math.max(latestLastSeen, ts) : ts;
      }
    }
  }

  if (!alreadyLoggedIn && rootSnap.exists()) {
    const rootData = (rootSnap.val() ?? {}) as PresenceNode;
    const rootLastSeen = Number(rootData.lastSeen);
    if (isFresh(rootLastSeen, now) && (!deviceAnchor || !seenAnchors.includes(deviceAnchor))) {
      alreadyLoggedIn = true;
    }
    if (Number.isFinite(rootLastSeen)) {
      latestLastSeen = latestLastSeen !== null ? Math.max(latestLastSeen, rootLastSeen) : rootLastSeen;
    }
  }

  return {
    status: "ok",
    alreadyLoggedIn,
    lastSeen: latestLastSeen,
    anchors: seenAnchors,
  };
});
