import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { db } from "../shared/firestore";
import { verifyGoogleIdToken } from "../shared/googleVerify";
import { ensureOp } from "../shared/idempotency";
import { initializeUserIfNeeded } from "../shared/initializeUser";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";

// TEMPORARY: Disabled App Check until Firebase Authentication service sends tokens
// TODO: Re-enable once Authentication shows >90% verified requests
export const bindGoogle = onCall(
  callableOptions({ enforceAppCheck: false, minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
  async (request) => {
    const { opId, idToken } = request.data;
    const uid = request.auth?.uid;

    if (!uid) {
      throw new HttpsError("unauthenticated", "User must be authenticated.");
    }
    if (typeof idToken !== "string") {
      throw new HttpsError("invalid-argument", "Invalid idToken provided.");
    }

    await ensureOp(uid, opId);

    const { email: googleEmail } = await verifyGoogleIdToken(idToken).catch(() => {
      throw new HttpsError("invalid-argument", "Invalid Google token.");
    });

    const normEmail = googleEmail ? googleEmail.toLowerCase().trim() : null;
    const playerRef = db.doc(`Players/${uid}`);
    const profileRef = db.doc(`Players/${uid}/Profile/Profile`);
    const providersRef = db.doc(`AccountsProviders/${uid}`);
    const emailRef = normEmail ? db.doc(`AccountsEmails/${normEmail}`) : null;

    await db.runTransaction(async (tx) => {
      const [playerSnap, profileSnap, emailSnap] = await Promise.all([
        tx.get(playerRef),
        tx.get(profileRef),
        emailRef ? tx.get(emailRef) : Promise.resolve(null),
      ]);

      if (!playerSnap.exists) {
        throw new HttpsError("failed-precondition", "Player doc missing.");
      }
      if (!profileSnap.exists) {
        throw new HttpsError("failed-precondition", "Player profile missing.");
      }

      if (emailRef && emailSnap?.exists && emailSnap.data()?.uid !== uid) {
        throw new HttpsError("already-exists", "This email is already in use by another account.");
      }

      const timestamp = admin.firestore.FieldValue.serverTimestamp();

      if (emailRef) {
        tx.set(emailRef, {
          uid,
          createdAt: timestamp,
        }, { merge: true });
      }

      tx.set(playerRef, { isGuest: false }, { merge: true });

      tx.set(
        providersRef,
        {
          google: { email: googleEmail },
          providers: admin.firestore.FieldValue.arrayUnion("google"),
          updatedAt: timestamp,
          createdAt: timestamp,
        },
        { merge: true },
      );
    });

    await initializeUserIfNeeded(uid, ["google"], {
      isGuest: false,
      email: googleEmail ?? null,
      opId,
    });

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
    } catch { }

    return { status: "ok" };
  });
