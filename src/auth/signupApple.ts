import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { REGION } from "../shared/region";
import { assertSupportedAppVersion } from "../shared/appVersion";
import { normalizeEmail } from "../shared/normalize";
import { getAppleAudienceFromEnv, verifyAppleIdentityToken } from "../shared/appleVerify";
import { initializeUserIfNeeded } from "../shared/initializeUser";

type SignupAppleRequest = {
  identityToken?: unknown;
  nonce?: unknown;
  opId?: unknown;
  platform?: unknown;
  appVersion?: unknown;
  deviceAnchor?: unknown;
};

const ensureString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpsError("invalid-argument", `Missing or invalid ${field}.`);
  }
  return value.trim();
};

// TEMPORARY: Disabled App Check until Firebase Authentication service sends tokens
// TODO: Re-enable once Authentication shows >90% verified requests
export const signupApple = onCall({ enforceAppCheck: false, region: REGION }, async (request) => {
  const { identityToken, nonce, opId, platform, appVersion, deviceAnchor } =
    (request.data ?? {}) as SignupAppleRequest;

  const opIdStr = ensureString(opId, "opId");
  const platformStr = ensureString(platform, "platform");
  const appVersionStr = ensureString(appVersion, "appVersion");
  const token = ensureString(identityToken, "identityToken");

  assertSupportedAppVersion(appVersionStr);

  const audience = getAppleAudienceFromEnv();
  const appleClaims = await verifyAppleIdentityToken(token, {
    audience,
    nonce: typeof nonce === "string" ? nonce : undefined,
  });

  const appleSub = appleClaims.sub;
  const email = appleClaims.email ? normalizeEmail(appleClaims.email) : null;
  const db = admin.firestore();
  const auth = admin.auth();
  const appleSubRef = db.doc(`AccountsAppleSubs/${appleSub}`);
  const emailRef = email ? db.doc(`AccountsEmails/${email}`) : null;

  let uid: string | null = null;
  let authUser: admin.auth.UserRecord | null = null;
  let createdNewUser = false;

  const subSnap = await appleSubRef.get();
  if (subSnap.exists) {
    uid = (subSnap.data() ?? {}).uid;
  }

  if (!uid && emailRef) {
    const emailSnap = await emailRef.get();
    if (emailSnap.exists) {
      uid = (emailSnap.data() ?? {}).uid;
    }
  }

  if (uid) {
    try {
      authUser = await auth.getUser(uid);
    } catch (error) {
      console.warn("[signupApple] uid from mapping not found in Auth", uid, error);
      authUser = null;
    }
  }

  if (!uid) {
    const proposedUid = `apple:${appleSub}`;
    try {
      authUser = await auth.getUser(proposedUid);
      uid = authUser.uid;
    } catch (error) {
      const payload: admin.auth.CreateRequest = { uid: proposedUid };
      if (email) {
        payload.email = email;
        payload.emailVerified = appleClaims.emailVerified ?? undefined;
      }
      authUser = await auth.createUser(payload);
      uid = authUser.uid;
      createdNewUser = true;
    }
  }

  if (!uid) {
    throw new HttpsError("internal", "Unable to resolve uid for Apple signup.");
  }

  if (email && emailRef) {
    try {
      await db.runTransaction(async (tx) => {
        const emailSnap = await tx.get(emailRef);
        if (!emailSnap.exists) {
          tx.create(emailRef, {
            uid,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            provider: "apple",
          });
        } else if (emailSnap.data()?.uid !== uid) {
          throw new HttpsError(
            "already-exists",
            "Email is already linked to a different account.",
          );
        }
      });
    } catch (error) {
      if (createdNewUser) {
        try {
          await auth.deleteUser(uid);
        } catch { }
      }
      if (error instanceof HttpsError) {
        throw error;
      }
      throw new HttpsError("internal", "Failed to reserve email for Apple signup.");
    }
  }

  await appleSubRef.set(
    {
      uid,
      email: email ?? null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await initializeUserIfNeeded(uid, ["apple"], {
    isGuest: false,
    email,
    authUser,
    opId: opIdStr,
  });

  if (deviceAnchor && typeof deviceAnchor === "string") {
    await db.doc(`Players/${uid}`).set(
      {
        knownDeviceAnchors: admin.firestore.FieldValue.arrayUnion(deviceAnchor),
      },
      { merge: true },
    );
  }

  const customToken = await auth.createCustomToken(uid, { appleSub });
  return { status: "ok", uid, customToken };
});
