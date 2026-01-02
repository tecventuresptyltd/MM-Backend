// functions/src/auth/signupGoogle.ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { REGION } from "../shared/region";
import { normalizeEmail } from "../shared/normalize";
import { verifyGoogleIdToken } from "../shared/googleVerify";
import { initializeUserIfNeeded } from "../shared/initializeUser";
import { assertSupportedAppVersion } from "../shared/appVersion";
// TEMPORARY: Disabled App Check until Firebase Authentication service sends tokens
// TODO: Re-enable once Authentication shows >90% verified requests
export const signupGoogle = onCall({ enforceAppCheck: false, region: REGION }, async (request) => {
  const { idToken, opId, platform, appVersion, deviceAnchor } = (request.data ?? {}) as {
    idToken?: string; opId?: string; platform?: string; appVersion?: string; deviceAnchor?: string;
  };
  if (!opId) throw new HttpsError("invalid-argument", "Missing opId.");
  if (!idToken) throw new HttpsError("invalid-argument", "Missing idToken.");
  if (!platform) throw new HttpsError("invalid-argument", "Missing platform.");
  if (!appVersion) throw new HttpsError("invalid-argument", "Missing appVersion.");

  assertSupportedAppVersion(appVersion);

  const { email, sub: googleSub } = await verifyGoogleIdToken(idToken).catch(() => {
    throw new HttpsError("invalid-argument", "Invalid Google token.");
  });
  if (!email) throw new HttpsError("invalid-argument", "Google token missing email.");

  const db = admin.firestore();
  const auth = admin.auth();
  const normalizedEmail = normalizeEmail(email);
  const emailDocRef = db.doc(`AccountsEmails/${normalizedEmail}`);

  let user;
  let createdNewUser = false;
  try {
    user = await auth.getUserByEmail(normalizedEmail);
  } catch (error: unknown) {
    if ((error as { code: string }).code === "auth/user-not-found") {
      // User does not exist, so create them.
      user = await auth.createUser({ email });
      createdNewUser = true;
    } else {
      // Some other error occurred.
      throw error;
    }
  }

  // Check if email is already registered to another account
  const existingEmailDoc = await emailDocRef.get();
  let finalUid = user.uid;
  const buildInitOpts = (targetUid: string) => ({
    isGuest: false,
    email: email ?? null,
    authUser: targetUid === user.uid ? user : null,
    opId,
  });

  if (existingEmailDoc.exists) {
    // Email already registered - link to that account instead
    const existingUid = existingEmailDoc.data()?.uid;
    if (existingUid && existingUid !== user.uid) {
      // Delete the newly created user and use the existing one
      try {
        await auth.deleteUser(user.uid);
      } catch { }
      finalUid = existingUid;

      // Add Google as a provider to the existing account
      await initializeUserIfNeeded(finalUid, ['google'], buildInitOpts(finalUid));

      const customToken = await admin.auth().createCustomToken(finalUid, { googleSub });
      return { status: "ok", uid: finalUid, customToken };
    }

    // Existing reservation belongs to same uid -> treat as idempotent success.
    await initializeUserIfNeeded(finalUid, ['google'], buildInitOpts(finalUid));
    const customToken = await admin.auth().createCustomToken(finalUid, { googleSub });
    return { status: "ok", uid: finalUid, customToken, idempotent: true };
  }

  // Email not registered yet or UIDs match - proceed with reservation
  try {
    await db.runTransaction(async (transaction) => {
      const emailDoc = await transaction.get(emailDocRef);
      if (!emailDoc.exists) {
        // Email is not registered, so create the reservation document.
        transaction.create(emailDocRef, {
          uid: user.uid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    });
  } catch (error) {
    // If the transaction fails and we just created the user, we should clean up.
    const isNewUser = createdNewUser || user.metadata.creationTime === user.metadata.lastSignInTime;
    if (isNewUser) {
      await auth.deleteUser(user.uid);
    }
    throw error;
  }

  await initializeUserIfNeeded(finalUid, ['google'], buildInitOpts(finalUid));

  // If deviceAnchor was provided, record it as a reference only.
  if (deviceAnchor) {
    await db.doc(`Players/${finalUid}`).set({
      knownDeviceAnchors: admin.firestore.FieldValue.arrayUnion(deviceAnchor),
    }, { merge: true });
  }

  const customToken = await admin.auth().createCustomToken(finalUid, { googleSub });
  return { status: "ok", uid: finalUid, customToken };
});
