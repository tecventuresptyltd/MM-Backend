import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { normalizeEmail } from "../shared/normalize";
import { initializeUserIfNeeded } from "../shared/initializeUser";

export const bindEmailPassword = onCall({ region: "us-central1" }, async (request) => {
  const data = request.data ?? {};
  const { email, password, opId } = data;

  if (!request.auth?.uid) throw new HttpsError("unauthenticated", "User must be authenticated.");
  if (!email || typeof email !== "string") throw new HttpsError("invalid-argument", "Missing/invalid email.");
  if (!password || password.length < 6) throw new HttpsError("invalid-argument", "Password must be at least 6 characters long.");
  if (!opId) throw new HttpsError("invalid-argument", "Missing opId.");

  const uid = request.auth.uid;
  const norm = normalizeEmail(email);
  const db = admin.firestore();

  const emailDoc = db.doc(`AccountsEmails/${norm}`);
  const playerDoc = db.doc(`Players/${uid}`);
  const providersDoc = db.doc(`AccountsProviders/${uid}`);

  await db.runTransaction(async (tx) => {
    // Ensure player exists
    const playerSnap = await tx.get(playerDoc);
    if (!playerSnap.exists) {
      throw new HttpsError("failed-precondition", "Player doc missing.");
    }

    // Enforce uniqueness: read first, then create or reject
    const emailSnap = await tx.get(emailDoc);
    if (emailSnap.exists) {
      const owner = (emailSnap.data() as { uid: string }).uid;
      if (owner !== uid) {
        throw new HttpsError("already-exists", "EMAIL_TAKEN");
      }
      // else: same owner -> idempotent OK (no-op)
    } else {
      tx.create(emailDoc, {
        uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // Mark provider in our accounts state
    tx.set(
      providersDoc,
      {
        // This field is not defined in the schema, but we are leaving it for now.
        // providers: admin.firestore.FieldValue.arrayUnion('password'),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // Flip player flags
    tx.set(
      playerDoc,
      {
        isGuest: false,
      },
      { merge: true }
    );
  });

  // Only link in Auth **after** the txn succeeded (so taken emails short-circuit above).
  // Guard idempotency: if email is already set to same value, updateUser is harmless.
  await admin.auth().updateUser(uid, { email });
  await admin.auth().updateUser(uid, { password });

  await initializeUserIfNeeded(uid, ["password"], {
    isGuest: false,
    email,
    opId,
  });

  // Vacate any device anchors currently pointing to this uid; store references on the player.
  try {
    const anchorsSnap = await db.collection('AccountsDeviceAnchors').where('uid', '==', uid).get();
    if (!anchorsSnap.empty) {
      const batch = db.batch();
      const playerRef = db.doc(`Players/${uid}`);
      const anchorIds: string[] = [];
      anchorsSnap.forEach((doc) => anchorIds.push(doc.id));
      if (anchorIds.length) {
        batch.set(playerRef, { knownDeviceAnchors: admin.firestore.FieldValue.arrayUnion(...anchorIds) }, { merge: true });
        anchorIds.forEach((id) => {
          batch.delete(db.doc(`AccountsDeviceAnchors/${id}`));
        });
        await batch.commit();
      }
    }
  } catch {}

  return {
    status: "ok",
    verificationEmailSent: false,
    verificationSentAt: null,
  };
});
