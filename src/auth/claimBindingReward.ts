import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { db } from "../shared/firestore";
import { BINDING_REWARD_FIELD, maybeGrantBindingReward } from "./bindingRewards.js";

type ProviderName = "password" | "google" | "apple";

const normalizeProvider = (value: unknown): ProviderName | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "password") return "password";
  if (trimmed === "google" || trimmed === "google.com") return "google";
  if (trimmed === "apple" || trimmed === "apple.com") return "apple";
  return null;
};

export const claimBindingReward = onCall({ region: "us-central1" }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const authUser = await admin.auth().getUser(uid);
  const emailVerified = authUser.emailVerified === true;

  const playerRef = db.doc(`Players/${uid}`);
  const profileRef = db.doc(`Players/${uid}/Profile/Profile`);
  const providersRef = db.doc(`AccountsProviders/${uid}`);

  const [playerSnap, profileSnap, accountProvidersSnap] = await Promise.all([
    playerRef.get(),
    profileRef.get(),
    providersRef.get(),
  ]);

  if (!playerSnap.exists) {
    throw new HttpsError("failed-precondition", "Player doc missing.");
  }
  if (!profileSnap.exists) {
    throw new HttpsError("failed-precondition", "Player profile missing.");
  }

  const profileData = profileSnap.data() ?? {};
  const bindingRewardClaimed = profileData[BINDING_REWARD_FIELD] === true;

  const providerSet = new Set<ProviderName>();
  const appendProviders = (values: unknown): void => {
    if (!Array.isArray(values)) {
      return;
    }
    for (const value of values) {
      const normalized = normalizeProvider(value);
      if (normalized) {
        providerSet.add(normalized);
      }
    }
  };

  authUser.providerData.forEach((info) => {
    const normalized = normalizeProvider(info.providerId);
    if (normalized) {
      providerSet.add(normalized);
    }
  });
  appendProviders((playerSnap.data() ?? {}).authProviders);
  appendProviders((accountProvidersSnap.data() ?? {}).providers);

  const linkedProviders = Array.from(providerSet).sort();
  const hasPassword = providerSet.has("password");
  const hasProvider = linkedProviders.length > 0;

  if (bindingRewardClaimed) {
    return {
      status: "already_claimed",
      linkedProviders,
      emailVerified,
      bindingRewardClaimed: true,
    };
  }

  if (!hasProvider) {
    return {
      status: "not_linked",
      linkedProviders,
      emailVerified,
      bindingRewardClaimed: false,
    };
  }

  if (hasPassword && !emailVerified) {
    return {
      status: "email_unverified",
      linkedProviders,
      emailVerified,
      bindingRewardClaimed: false,
    };
  }

  const claimResult = await db.runTransaction(async (tx) => {
    const [playerTx, profileTx] = await Promise.all([tx.get(playerRef), tx.get(profileRef)]);

    if (!playerTx.exists) {
      throw new HttpsError("failed-precondition", "Player doc missing.");
    }
    if (!profileTx.exists) {
      throw new HttpsError("failed-precondition", "Player profile missing.");
    }

    const profileState = profileTx.data() ?? {};
    if (profileState[BINDING_REWARD_FIELD] === true) {
      return { granted: false, alreadyClaimed: true };
    }

    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    const { granted } = await maybeGrantBindingReward(tx, uid, {
      playerSnap: playerTx,
      profileSnap: profileTx,
      timestamp,
    });

    return { granted, alreadyClaimed: false };
  });

  if (claimResult.alreadyClaimed) {
    return {
      status: "already_claimed",
      linkedProviders,
      emailVerified,
      bindingRewardClaimed: true,
    };
  }

  if (!claimResult.granted) {
    return {
      status: "failed",
      linkedProviders,
      emailVerified,
      bindingRewardClaimed: bindingRewardClaimed || false,
    };
  }

  return {
    status: "ok",
    granted: true,
    linkedProviders,
    emailVerified,
    bindingRewardClaimed: true,
  };
});
