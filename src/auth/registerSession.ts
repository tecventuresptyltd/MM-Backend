import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region";
import { assertSupportedAppVersion } from "../shared/appVersion";

type Platform = "ios" | "android" | "windows" | "mac" | "linux";

const PRESENCE_ROOT = "presence/online";
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

const sanitizePlatform = (input: unknown): Platform | null => {
  if (typeof input !== "string") return null;
  const normalized = input.toLowerCase();
  if (normalized === "ios" || normalized === "android" || normalized === "windows" || normalized === "mac" || normalized === "linux") {
    return normalized as Platform;
  }
  return null;
};

export const registerSession = onCall({ region: REGION }, async (request) => {
  const { deviceAnchor, platform, appVersion } = request.data ?? {};

  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  if (typeof deviceAnchor !== "string" || deviceAnchor.trim().length === 0) {
    throw new HttpsError("invalid-argument", "deviceAnchor is required.");
  }

  assertSupportedAppVersion(appVersion);

  const uid = request.auth.uid;
  const platformValue = sanitizePlatform(platform);
  const now = Date.now();
  const connectionsRef = admin.database().ref(`${PRESENCE_ROOT}/${uid}/connections`);

  const snapshot = await connectionsRef.get();
  const connections = snapshot.val() ?? {};
  let alreadyLoggedIn = false;

  if (connections && typeof connections === "object") {
    for (const [key, raw] of Object.entries(connections)) {
      if (key === deviceAnchor) continue;
      const lastSeen = Number((raw as { lastSeen?: unknown })?.lastSeen ?? 0);
      if (Number.isFinite(lastSeen) && lastSeen > 0 && now - lastSeen <= SESSION_TTL_MS) {
        alreadyLoggedIn = true;
        break;
      }
    }
  }

  const sessionPath = `${PRESENCE_ROOT}/${uid}/connections/${deviceAnchor}`;
  const updates: Record<string, unknown> = {
    [sessionPath]: {
      anchor: deviceAnchor,
      platform: platformValue,
      appVersion: typeof appVersion === "string" ? appVersion : null,
      lastSeen: now,
    },
    [`presence/lastSeen/${uid}`]: now,
  };

  await admin.database().ref().update(updates);

  try {
    await admin.database().ref(sessionPath).onDisconnect().remove();
  } catch {
    // If onDisconnect fails (e.g., emulator), fail silently; TTL will age out stale sessions.
  }

  return { status: "ok", alreadyLoggedIn, now };
});
