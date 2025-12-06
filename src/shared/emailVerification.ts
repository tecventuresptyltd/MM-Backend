import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

const auth = admin.auth();
const db = admin.firestore();

const DEFAULT_VERIFICATION_REDIRECT =
  process.env.EMAIL_VERIFICATION_REDIRECT ??
  process.env.APP_URL ??
  "https://mysticmotors.app/verify";

export interface VerificationSendResult {
  link: string;
  sentAt: admin.firestore.Timestamp;
}

/**
 * Generates an email verification link and records when it was sent.
 * The calling function is responsible for actually emailing the link.
 */
export async function sendVerificationEmailAndRecord(opts: {
  uid: string;
  email: string;
}): Promise<VerificationSendResult> {
  const { uid, email } = opts;
  if (!email || typeof email !== "string") {
    throw new HttpsError("invalid-argument", "Missing email for verification.");
  }

  const actionCodeSettings = {
    url: DEFAULT_VERIFICATION_REDIRECT,
    handleCodeInApp: false,
  };

  const link = await auth.generateEmailVerificationLink(email, actionCodeSettings);
  const sentAt = admin.firestore.Timestamp.now();

  await db.doc(`Players/${uid}`).set(
    {
      emailVerification: {
        lastSentAt: sentAt,
      },
    },
    { merge: true },
  );

  return { link, sentAt };
}
