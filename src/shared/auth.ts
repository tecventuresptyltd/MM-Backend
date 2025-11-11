import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

const auth = admin.auth();

export async function linkEmailPassword(uid: string, email: string, password: string): Promise<void> {
  try {
    // This will fail if the email is already in use by another user.
    await auth.updateUser(uid, { email, password });
  } catch (error: unknown) {
    if ((error as { code: string }).code === "auth/email-already-exists") {
      throw new HttpsError("already-exists", "The email address is already in use by another account.");
    }
    throw new HttpsError("internal", "Failed to link email and password.", error);
  }
}

export async function verifyGoogleIdToken(idToken: string): Promise<admin.auth.DecodedIdToken> {
  try {
    return await auth.verifyIdToken(idToken);
  } catch (error: unknown) {
    if ((error as { code: string }).code === "auth/id-token-expired" || (error as { code: string }).code === "auth/id-token-revoked") {
      throw new HttpsError("unauthenticated", "The provided Google ID token is invalid or has expired.");
    }
    throw new HttpsError("internal", "Failed to verify Google ID token.", error);
  }
}

export async function mintCustomToken(targetUid: string): Promise<string> {
  try {
    return await auth.createCustomToken(targetUid);
  } catch (error: unknown) {
    throw new HttpsError("internal", "Failed to mint custom token.", error);
  }
}