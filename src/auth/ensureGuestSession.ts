import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { db, DeviceAnchorDoc } from "../shared/firestore";
import { mintCustomToken } from "../shared/auth";
import { ensureOp } from "../shared/idempotency";
import { initializeUserIfNeeded, waitForUserBootstrap } from "../shared/initializeUser";
import { REGION } from "../shared/region";
import { assertSupportedAppVersion } from "../shared/appVersion";

// TEMPORARY: Disabled App Check until Firebase Authentication service sends tokens
// TODO: Re-enable once Authentication shows >90% verified requests
export const ensureGuestSession = onCall({ enforceAppCheck: false, region: REGION, invoker: "public" }, async (request) => {
  // Defensive guard before destructuring
  const data = request.data ?? {};
  const { opId, deviceAnchor, platform, appVersion } = data;

  // Validate inputs
  if (!opId || !deviceAnchor) {
    throw new HttpsError('invalid-argument', 'Missing required fields: opId, deviceAnchor.');
  }

  assertSupportedAppVersion(appVersion);

  let uid = request.auth?.uid ?? null;

  const deviceRef = db.collection("AccountsDeviceAnchors").doc(deviceAnchor);
  const deviceDoc = await deviceRef.get();

  if (deviceDoc.exists) {
    const deviceData = deviceDoc.data() as DeviceAnchorDoc;
    // Determine if the current anchor owner is a guest or a full account
    const ownerUid = deviceData.uid;
    await ensureOp(ownerUid, opId, { function: "ensureGuestSession" });

    // Fetch owner player to check guest status
    const ownerPlayerSnap = await db.doc(`Players/${ownerUid}`).get();
    const ownerIsGuest = ownerPlayerSnap.exists
      ? !!ownerPlayerSnap.data()?.isGuest
      : true; // default to guest if missing

    if (deviceData.uid === uid) {
      // Anchor is already registered to the current user.
      await deviceRef.update({ lastSeenAt: admin.firestore.FieldValue.serverTimestamp() });
      const customToken = await mintCustomToken(uid);
      return { status: "ok", mode: "current", uid, customToken };
    }

    if (ownerIsGuest) {
      // Anchor points to a guest: recover that guest.
      const customToken = await mintCustomToken(ownerUid);
      return { status: "recover", uid: ownerUid, customToken };
    }

    // Anchor points to a full account: vacate the slot and assign to a guest.
    // Use current uid if provided, otherwise create a new anonymous user.
    let newUid = uid ?? null;
    if (!newUid) {
      const newUser = await admin.auth().createUser({});
      newUid = newUser.uid;
      const initOpts = { isGuest: true, email: null, authUser: null, opId };
      await initializeUserIfNeeded(newUid, ["anonymous"], initOpts);
      const bootstrapCheck = await waitForUserBootstrap(newUid);
      if (bootstrapCheck.size > 0) {
        throw new HttpsError(
          "internal",
          `Guest bootstrap incomplete. Missing documents: ${Array.from(bootstrapCheck).join(", ")}`,
        );
      }
    }

    const now = admin.firestore.FieldValue.serverTimestamp();

    // Re-anchor inside a transaction to avoid races
    await db.runTransaction(async (tx) => {
      const latest = await tx.get(deviceRef);
      const latestData = latest.data() as DeviceAnchorDoc | undefined;
      const latestOwner = latestData?.uid;

      // If someone else reclaimed as guest in the meantime, respect that and return recover
      if (latestData && latestOwner && latestOwner !== ownerUid) {
        return; // noop; we'll handle after txn
      }

      const payload: Record<string, unknown> = {
        uid: newUid,
        lastSeenAt: now,
      };
      if (typeof platform === "string") payload.platform = platform;
      if (typeof appVersion === "string") payload.appVersion = appVersion;
      tx.set(deviceRef, payload, { merge: true });

      // Keep a reference to this device on the full account (former owner)
      if (ownerUid) {
        const ownerPlayerRef = db.doc(`Players/${ownerUid}`);
        tx.set(
          ownerPlayerRef,
          { knownDeviceAnchors: admin.firestore.FieldValue.arrayUnion(deviceRef.id) },
          { merge: true },
        );
      }
    });

    // If someone else grabbed during txn, check again
    const postDoc = await deviceRef.get();
    const currentOwner = (postDoc.data() as DeviceAnchorDoc | undefined)?.uid;
    if (currentOwner && currentOwner !== newUid) {
      // Another guest reclaimed; return recover for that uid
      const customToken = await mintCustomToken(currentOwner);
      return { status: "recover", uid: currentOwner, customToken };
    }

    const customToken = await mintCustomToken(newUid!);
    const mode = uid ? "current" : "new";
    return { status: "ok", mode, uid: newUid, customToken };
  } else {
    // This is a new device anchor. Register it to the current user.
    if (!uid) {
      // This is a new device anchor and a new user. Create a new anonymous user.
      const newUser = await admin.auth().createUser({});
      uid = newUser.uid;
    }
    await ensureOp(uid, opId, { function: "ensureGuestSession" });
    const anchorPayload: Record<string, unknown> = {
      uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (typeof platform === "string") {
      anchorPayload.platform = platform;
    }

    if (typeof appVersion === "string") {
      anchorPayload.appVersion = appVersion;
    }

    await deviceRef.set(anchorPayload);

    const initOpts = { isGuest: true, email: null, authUser: null, opId };
    await initializeUserIfNeeded(uid, ["anonymous"], initOpts);
    const bootstrapCheck = await waitForUserBootstrap(uid);
    if (bootstrapCheck.size > 0) {
      throw new HttpsError(
        "internal",
        `Guest bootstrap incomplete. Missing documents: ${Array.from(bootstrapCheck).join(", ")}`,
      );
    }

    await db.doc(`Players/${uid}`).get();

    const customToken = await mintCustomToken(uid);
    return { status: "ok", mode: "new", uid, customToken };
  }
});
