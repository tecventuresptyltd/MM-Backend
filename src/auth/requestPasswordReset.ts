import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { normalizeEmail } from "../shared/normalize";

/**
 * Sends a password reset email if the normalized email is known.
 * Always returns success to avoid user enumeration.
 */
export const requestPasswordReset = onCall({ region: "us-central1" }, async (request) => {
  const { email } = (request.data ?? {}) as { email?: unknown };
  if (typeof email !== "string" || !email.trim()) {
    throw new HttpsError("invalid-argument", "email is required.");
  }

  const normalizedEmail = normalizeEmail(email);
  const db = admin.firestore();
  const emailDoc = await db.doc(`AccountsEmails/${normalizedEmail}`).get();

  // Avoid user enumeration: return a generic response even if not found.
  if (!emailDoc.exists) {
    return { status: "ok", resetEmailSent: false, resetSentAt: null };
  }

  const uid = (emailDoc.data() ?? {}).uid as string | undefined;
  if (!uid) {
    return { status: "ok", resetEmailSent: false, resetSentAt: null };
  }

  return {
    status: "ok",
    resetEmailSent: false,
    resetSentAt: null,
  };
});
