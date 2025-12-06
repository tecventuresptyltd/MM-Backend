import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";

const db = admin.firestore();

type LogKind = "verification" | "reset";

export const logEmailSend = onCall({ region: "us-central1" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const { kind } = (request.data ?? {}) as { kind?: unknown };
  if (kind !== "verification" && kind !== "reset") {
    throw new HttpsError("invalid-argument", "kind must be 'verification' or 'reset'.");
  }

  const playerRef = db.doc(`Players/${uid}`);
  const stamp = admin.firestore.FieldValue.serverTimestamp();

  const payload: Record<string, unknown> = {};
  if (kind === "verification") {
    payload.emailVerification = { lastSentAt: stamp };
  } else {
    payload.passwordReset = { lastSentAt: stamp };
  }

  await playerRef.set(payload, { merge: true });

  return {
    status: "ok",
    recordedAt: new Date().toISOString(),
  };
});
