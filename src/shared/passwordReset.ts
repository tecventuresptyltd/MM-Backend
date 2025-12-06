import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

const auth = admin.auth();
const db = admin.firestore();

const DEFAULT_RESET_REDIRECT =
  process.env.PASSWORD_RESET_REDIRECT ??
  process.env.APP_URL ??
  "https://mysticmotors.app/reset-password";

export interface PasswordResetSendResult {
  link: string;
  sentAt: admin.firestore.Timestamp;
}

/**
 * Generates a password reset link and records when it was sent.
 * The caller is responsible for delivering the link to the user.
 */
export async function sendPasswordResetEmailAndRecord(opts: {
  uid: string;
  email: string;
}): Promise<PasswordResetSendResult> {
  const { uid, email } = opts;
  if (!email || typeof email !== "string") {
    throw new HttpsError("invalid-argument", "Missing email for password reset.");
  }

  const link = await auth.generatePasswordResetLink(email, {
    url: DEFAULT_RESET_REDIRECT,
    handleCodeInApp: false,
  });
  const sentAt = admin.firestore.Timestamp.now();

  await db.doc(`Players/${uid}`).set(
    {
      passwordReset: {
        lastSentAt: sentAt,
      },
    },
    { merge: true },
  );

  return { link, sentAt };
}
