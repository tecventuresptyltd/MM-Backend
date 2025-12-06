// functions/src/auth/signupEmailPassword.ts
import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { REGION } from "../shared/region";
import { normalizeEmail } from "../shared/normalize";
import { initializeUserIfNeeded } from "../shared/initializeUser";
import { assertSupportedAppVersion } from "../shared/appVersion";
import { sendVerificationEmailAndRecord, VerificationSendResult } from "../shared/emailVerification";

export const signupEmailPassword = onCall({ region: REGION }, async (request) => {
  const { opId, email, password, deviceAnchor, platform, appVersion } = request.data || {};
  if (!email || !password || !opId) throw new HttpsError('invalid-argument', 'Missing required fields.');
  if (!appVersion) throw new HttpsError("invalid-argument", "Missing appVersion.");

  assertSupportedAppVersion(appVersion);

  const auth = admin.auth();
  const db = admin.firestore();
  const norm = normalizeEmail(email);
  const emailDocRef = db.doc(`AccountsEmails/${norm}`);
  // Device anchors are reference-only for full accounts; we do not claim them.
  const anchorRef = deviceAnchor ? db.doc(`AccountsDeviceAnchors/${deviceAnchor}`) : null;

  // Check if user already exists (idempotency)
  let user;
  let createdNewUser = false;
  try {
    user = await auth.getUserByEmail(email);
  } catch (error: any) {
    if (error.code === 'auth/user-not-found') {
      // User doesn't exist, create them
      user = await auth.createUser({ email, password });
      createdNewUser = true;
    } else {
      throw error;
    }
  }

  const [emailSnap, anchorSnap] = await Promise.all([
    emailDocRef.get(),
    anchorRef ? anchorRef.get() : Promise.resolve<admin.firestore.DocumentSnapshot | null>(null),
  ]);

  if (emailSnap.exists) {
    const existingUid = emailSnap.data()?.uid;
    if (existingUid !== user.uid) {
      throw new HttpsError('already-exists', 'Email is already taken.');
    }

    await initializeUserIfNeeded(user.uid, ['password'], { isGuest: false, email, authUser: user, opId });
    let verification: VerificationSendResult | null = null;
    if (!user.emailVerified) {
      verification = await sendVerificationEmailAndRecord({ uid: user.uid, email });
    }
    // Reference device anchor on the player if provided
    if (deviceAnchor) {
      await db.doc(`Players/${user.uid}`).set({
        knownDeviceAnchors: admin.firestore.FieldValue.arrayUnion(deviceAnchor),
      }, { merge: true });
    }
    const customToken = await auth.createCustomToken(user.uid);
    return {
      status: 'ok',
      uid: user.uid,
      customToken,
      idempotent: true,
      verificationEmailSent: !!verification,
      verificationSentAt: verification?.sentAt.toDate().toISOString() ?? null,
    };
  }

  try {
    await db.runTransaction(async (tx) => {
      const emailDoc = await tx.get(emailDocRef);
      if (emailDoc.exists) {
        throw new HttpsError('already-exists', 'Email is already taken.');
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      tx.create(emailDocRef, { uid: user.uid, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      // If deviceAnchor was provided, store it as a reference on the Player doc only.
      if (deviceAnchor) {
        tx.set(
          db.doc(`Players/${user.uid}`),
          { knownDeviceAnchors: admin.firestore.FieldValue.arrayUnion(deviceAnchor) },
          { merge: true },
        );
      }
    });

    await initializeUserIfNeeded(user.uid, ['password'], { isGuest: false, email, authUser: user, opId });

    let verification: VerificationSendResult | null = null;
    if (!user.emailVerified) {
      verification = await sendVerificationEmailAndRecord({ uid: user.uid, email });
    }

    // Return a custom token so client can sign in immediately
    const customToken = await auth.createCustomToken(user.uid);
    return {
      status: 'ok',
      uid: user.uid,
      customToken,
      verificationEmailSent: !!verification,
      verificationSentAt: verification?.sentAt.toDate().toISOString() ?? null,
    };
  } catch (e) {
    // Clean up auth user if Firestore reservation failed
    if (createdNewUser) {
      try { await auth.deleteUser(user.uid); } catch {}
    }
    throw e;
  }
});
