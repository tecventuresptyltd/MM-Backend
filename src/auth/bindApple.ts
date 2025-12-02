import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { db } from "../shared/firestore";
import { ensureOp } from "../shared/idempotency";
import { normalizeEmail } from "../shared/normalize";
import { getAppleAudienceFromEnv, verifyAppleIdentityToken } from "../shared/appleVerify";

type BindAppleRequest = {
  opId?: unknown;
  identityToken?: unknown;
  nonce?: unknown;
  deviceAnchor?: unknown;
};

const ensureString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpsError("invalid-argument", `Missing or invalid ${field}.`);
  }
  return value.trim();
};

export const bindApple = onCall({ enforceAppCheck: false, region: "us-central1" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const { opId, identityToken, nonce, deviceAnchor } = (request.data ?? {}) as BindAppleRequest;
  const opIdStr = ensureString(opId, "opId");
  const token = ensureString(identityToken, "identityToken");

  await ensureOp(uid, opIdStr, { function: "bindApple" });

  const audience = getAppleAudienceFromEnv();
  const claims = await verifyAppleIdentityToken(token, {
    audience,
    nonce: typeof nonce === "string" ? nonce : undefined,
  });

  const appleSub = claims.sub;
  const email = claims.email ? normalizeEmail(claims.email) : null;

  const appleSubRef = db.doc(`AccountsAppleSubs/${appleSub}`);
  const subSnap = await appleSubRef.get();
  if (subSnap.exists && (subSnap.data() ?? {}).uid !== uid) {
    throw new HttpsError("already-exists", "Apple account is linked to another user.");
  }

  if (email) {
    const emailRef = db.doc(`AccountsEmails/${email}`);
    const emailSnap = await emailRef.get();
    if (emailSnap.exists && (emailSnap.data() ?? {}).uid !== uid) {
      throw new HttpsError("already-exists", "Email is already linked to another user.");
    }
  }

  const batch = db.batch();

  batch.set(appleSubRef, {
    uid,
    email: email ?? null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  if (email) {
    const emailRef = db.doc(`AccountsEmails/${email}`);
    batch.set(
      emailRef,
      {
        uid,
        provider: "apple",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  }

  const playerRef = db.doc(`Players/${uid}`);
  batch.set(
    playerRef,
    {
      isGuest: false,
    },
    { merge: true },
  );

  const providersRef = db.doc(`AccountsProviders/${uid}`);
  batch.set(
    providersRef,
    {
      providers: admin.firestore.FieldValue.arrayUnion("apple"),
      apple: {
        sub: appleSub,
        email,
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await batch.commit();

  // Vacate any device anchors currently pointing to this uid; store references on the player.
  try {
    const anchorsSnap = await db.collection("AccountsDeviceAnchors").where("uid", "==", uid).get();
    if (!anchorsSnap.empty) {
      const cleanupBatch = db.batch();
      const anchorIds: string[] = [];
      anchorsSnap.forEach((doc) => anchorIds.push(doc.id));
      if (anchorIds.length) {
        cleanupBatch.set(
          playerRef,
          { knownDeviceAnchors: admin.firestore.FieldValue.arrayUnion(...anchorIds) },
          { merge: true },
        );
        anchorIds.forEach((id) => cleanupBatch.delete(db.doc(`AccountsDeviceAnchors/${id}`)));
        await cleanupBatch.commit();
      }
    }
  } catch (error) {
    console.warn("[bindApple] failed to cleanup device anchors", error);
  }

  if (deviceAnchor && typeof deviceAnchor === "string") {
    await playerRef.set(
      {
        knownDeviceAnchors: admin.firestore.FieldValue.arrayUnion(deviceAnchor),
      },
      { merge: true },
    );
  }

  return { status: "ok" };
});
