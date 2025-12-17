import * as admin from "firebase-admin";
import { HttpsError } from "firebase-functions/v2/https";

import { db } from "../shared/firestore.js";
import { grantInventoryRewards } from "../shared/inventoryAwards.js";

export const BINDING_REWARD_FIELD = "bindingRewardClaimed";

const BINDING_REWARD_GRANTS = [
  { skuId: "sku_n9hsc0wxxk", quantity: 1 }, // Legendary Crate
  { skuId: "sku_acxbr542j1", quantity: 1 }, // Legendary Key
];

type BindingRewardOptions = {
  playerSnap?: FirebaseFirestore.DocumentSnapshot;
  profileSnap?: FirebaseFirestore.DocumentSnapshot;
  timestamp?: admin.firestore.FieldValue;
};

/**
 * Grants the one-time binding reward (Legendary crate + key) to guest accounts.
 * Expects all necessary reads (player/profile) to be loaded before writes begin.
 */
export const maybeGrantBindingReward = async (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  options: BindingRewardOptions = {},
): Promise<{ granted: boolean }> => {
  const playerRef = db.doc(`Players/${uid}`);
  const profileRef = playerRef.collection("Profile").doc("Profile");

  const [playerSnap, profileSnap] = await Promise.all([
    options.playerSnap ?? transaction.get(playerRef),
    options.profileSnap ?? transaction.get(profileRef),
  ]);

  if (!playerSnap.exists) {
    throw new HttpsError("failed-precondition", "Player doc missing.");
  }
  if (!profileSnap.exists) {
    throw new HttpsError("failed-precondition", "Player profile missing.");
  }

  const playerData = playerSnap.data() ?? {};
  const profileData = profileSnap.data() ?? {};
  const isGuest = playerData.isGuest === true;
  const alreadyClaimed = profileData[BINDING_REWARD_FIELD] === true;

  if (!isGuest || alreadyClaimed) {
    return { granted: false };
  }

  const timestamp = options.timestamp ?? admin.firestore.FieldValue.serverTimestamp();

  await grantInventoryRewards(transaction, uid, BINDING_REWARD_GRANTS, { timestamp });

  transaction.set(
    profileRef,
    {
      [BINDING_REWARD_FIELD]: true,
      bindingRewardGrantedAt: timestamp,
    },
    { merge: true },
  );

  return { granted: true };
};
