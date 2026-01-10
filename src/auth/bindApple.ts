import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { db } from "../shared/firestore";
import { ensureOp } from "../shared/idempotency";
import { normalizeEmail } from "../shared/normalize";
import { getAppleAudienceFromEnv, verifyAppleIdentityToken } from "../shared/appleVerify";
import { initializeUserIfNeeded } from "../shared/initializeUser";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";

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

// TEMPORARY: Disabled App Check until Firebase Authentication service sends tokens
// TODO: Re-enable once Authentication shows >90% verified requests
export const bindApple = onCall(
  callableOptions({ enforceAppCheck: false, minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
  async (request) => {
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
    const playerRef = db.doc(`Players/${uid}`);
    const providersRef = db.doc(`AccountsProviders/${uid}`);
    const profileRef = db.doc(`Players/${uid}/Profile/Profile`);
    const emailRef = email ? db.doc(`AccountsEmails/${email}`) : null;

    await db.runTransaction(async (tx) => {
      const [playerSnap, profileSnap, subSnap, emailSnap] = await Promise.all([
        tx.get(playerRef),
        tx.get(profileRef),
        tx.get(appleSubRef),
        emailRef ? tx.get(emailRef) : Promise.resolve(null),
      ]);

      if (!playerSnap.exists) {
        throw new HttpsError("failed-precondition", "Player doc missing.");
      }
      if (!profileSnap.exists) {
        throw new HttpsError("failed-precondition", "Player profile missing.");
      }

      if (subSnap.exists && (subSnap.data() ?? {}).uid !== uid) {
        throw new HttpsError("already-exists", "Apple account is linked to another user.");
      }

      if (emailRef && emailSnap?.exists && (emailSnap.data() ?? {}).uid !== uid) {
        throw new HttpsError("already-exists", "Email is already linked to another user.");
      }

      const timestamp = admin.firestore.FieldValue.serverTimestamp();

      tx.set(
        appleSubRef,
        {
          uid,
          email: email ?? null,
          updatedAt: timestamp,
          createdAt: timestamp,
        },
        { merge: true },
      );

      if (emailRef) {
        tx.set(
          emailRef,
          {
            uid,
            provider: "apple",
            createdAt: timestamp,
          },
          { merge: true },
        );
      }

      tx.set(
        playerRef,
        {
          isGuest: false,
        },
        { merge: true },
      );

      tx.set(
        providersRef,
        {
          providers: admin.firestore.FieldValue.arrayUnion("apple"),
          apple: {
            sub: appleSub,
            email,
          },
          updatedAt: timestamp,
          createdAt: timestamp,
        },
        { merge: true },
      );
    });

    await initializeUserIfNeeded(uid, ["apple"], {
      isGuest: false,
      email,
      opId: opIdStr,
    });

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
