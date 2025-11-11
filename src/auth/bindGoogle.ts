import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { db } from "../shared/firestore";
import { verifyGoogleIdToken } from "../shared/auth";
import { ensureOp } from "../shared/idempotency";

export const bindGoogle = onCall({ enforceAppCheck: false, region: "us-central1" }, async (request) => {
  const { opId, idToken } = request.data;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }
  if (typeof idToken !== "string") {
    throw new HttpsError("invalid-argument", "Invalid idToken provided.");
  }

  await ensureOp(uid, opId);

  const decodedToken = await verifyGoogleIdToken(idToken);
  const googleEmail = decodedToken.email;

  if (googleEmail) {
    const normEmail = googleEmail.toLowerCase().trim();
    const emailRef = db.doc(`AccountsEmails/${normEmail}`);
    const emailDoc = await emailRef.get();

    if (emailDoc.exists && emailDoc.data()!.uid !== uid) {
      throw new HttpsError("already-exists", "This email is already in use by another account.");
    }
  }

  const batch = db.batch();

  if (googleEmail) {
    const normEmail = googleEmail.toLowerCase().trim();
    const emailRef = db.doc(`AccountsEmails/${normEmail}`);
    batch.set(emailRef, {
      uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  const playerRef = db.doc(`Players/${uid}`);
  batch.update(playerRef, {
    isGuest: false,
  });

  const providersRef = db.doc(`AccountsProviders/${uid}`);
  batch.set(providersRef, {
    google: {
      email: googleEmail,
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await batch.commit();

  // Vacate any device anchors currently pointing to this uid; store references on the player.
  try {
    const anchorsSnap = await db.collection('AccountsDeviceAnchors').where('uid', '==', uid).get();
    if (!anchorsSnap.empty) {
      const cleanupBatch = db.batch();
      const playerRef = db.doc(`Players/${uid}`);
      const anchorIds: string[] = [];
      anchorsSnap.forEach((doc) => anchorIds.push(doc.id));
      if (anchorIds.length) {
        cleanupBatch.set(playerRef, { knownDeviceAnchors: admin.firestore.FieldValue.arrayUnion(...anchorIds) }, { merge: true });
        anchorIds.forEach((id) => cleanupBatch.delete(db.doc(`AccountsDeviceAnchors/${id}`)));
        await cleanupBatch.commit();
      }
    }
  } catch {}

  return { status: "ok" };
});
