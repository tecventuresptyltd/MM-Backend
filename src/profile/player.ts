import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { checkUsername } from "./validators";
import { REGION } from "../shared/region";
import {
  checkIdempotency,
  createInProgressReceipt,
} from "../core/idempotency.js";
import {
  runTransactionWithReceipt,
  runReadThenWriteWithReceipt,
} from "../core/transactions.js";
import { loadStarterRewards } from "../shared/starterRewards.js";
import {
  createTxInventorySummaryState,
  createTxSkuDocState,
  txIncSkuQty,
  txUpdateInventorySummary,
} from "../inventory/index.js";
import { updateClanMemberSnapshot } from "../clan/helpers.js";
import { refreshFriendSnapshots } from "../Socials/updateSnapshots.js";

const db = admin.firestore();
const SUBSCRIPTION_REWARD_GEMS = 25;

export const checkUsernameAvailable = onCall({ region: REGION }, async (request) => {
  const { username } = request.data;
  const isAvailable = await checkUsername(username);
  return { available: isAvailable };
});

export const setUsername = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const { username } = request.data;
  const { uid } = request.auth;

  const isAvailable = await checkUsername(username);
  if (!isAvailable) {
    throw new HttpsError("already-exists", "Username is not available.");
  }

  const usernameLower = username.toLowerCase();
  const usernameRef = db.collection("Usernames").doc(usernameLower);
  const profileRef = db.collection("Players").doc(uid).collection("Profile").doc("Profile");
  const userUsernameQuery = db.collection("Usernames").where("uid", "==", uid);

  await db.runTransaction(async (transaction) => {
    const [profileSnap, existingUsernameSnap, usernameDocSnap] = await Promise.all([
      transaction.get(profileRef),
      transaction.get(userUsernameQuery),
      transaction.get(usernameRef),
    ]);

    if (!profileSnap.exists) {
      throw new HttpsError("failed-precondition", "Player profile not found.");
    }

    if (usernameDocSnap.exists) {
      const existingUid = (usernameDocSnap.data() ?? {}).uid;
      if (typeof existingUid === "string" && existingUid !== uid) {
        throw new HttpsError("already-exists", "Username is not available.");
      }
    }

    // Remove stale username documents that still map to this uid so searches do not return duplicates.
    for (const doc of existingUsernameSnap.docs) {
      if (doc.id !== usernameLower) {
        transaction.delete(doc.ref);
      }
    }

    transaction.set(usernameRef, {
      uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    transaction.update(profileRef, { displayName: username });
  });

  await Promise.all([
    updateClanMemberSnapshot(uid, { displayName: username }),
    refreshFriendSnapshots(uid),
  ]);

  return { status: "ok" };
});

export const setAgeYears = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const { ageYears } = request.data;
  const { uid } = request.auth;

  if (typeof ageYears !== "number" || ageYears < 0 || ageYears > 120) {
    throw new HttpsError("invalid-argument", "Invalid age provided.");
  }

  const currentYear = new Date().getFullYear();
  const birthYear = currentYear - ageYears;
  const isOver13 = ageYears >= 13;


  // Store birthYear and isOver13 on the root Player document
  const playerRef = db.doc(`/Players/${uid}`);
  await playerRef.set({ birthYear, isOver13 }, { merge: true });

  return { status: "ok", birthYear, isOver13 };
});

export const getPlayerAge = onCall({ region: REGION }, async (request) => {
  const { uid } = request.data;
  // Read birthYear from the root Player document
  const playerRef = db.doc(`/Players/${uid}`);
  const doc = await playerRef.get();

  if (!doc.exists) {
    throw new HttpsError("not-found", "Player not found.");
  }

  const playerData = doc.data();
  const birthYear = playerData?.birthYear;

  if (typeof birthYear !== "number") {
    throw new HttpsError(
      "failed-precondition",
      "Player age has not been set."
    );
  }

  const currentYear = new Date().getFullYear();
  const age = currentYear - birthYear;
  const isOver13 = age >= 13;

  return { age, isOver13 };
});
export const setAvatar = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const { avatarId } = request.data;
  const { uid } = request.auth;

  if (typeof avatarId !== "number" || avatarId < 1 || avatarId > 10) {
    throw new HttpsError(
      "invalid-argument",
      "Invalid avatarId provided."
    );
  }

  const profileRef = db.collection("Players").doc(uid).collection("Profile").doc("Profile");
  await profileRef.update({ avatarId });

  await Promise.all([
    updateClanMemberSnapshot(uid, { avatarId }),
    refreshFriendSnapshots(uid),
  ]);

  return { status: "ok" };
});
export const setSubscriptionFlag = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const { key, value } = request.data;
  const { uid } = request.auth;

  const validKeys = ["youtube", "instagram", "discord", "tiktok"];
  if (!validKeys.includes(key)) {
    throw new HttpsError("invalid-argument", "Invalid subscription key.");
  }

  if (typeof value !== "boolean") {
    throw new HttpsError("invalid-argument", "Subscription value must be a boolean.");
  }

  const profileRef = db.collection("Players").doc(uid).collection("Profile").doc("Profile");
  const economyRef = db.doc(`Players/${uid}/Economy/Stats`);

  let gemsGranted = 0;
  await db.runTransaction(async (transaction) => {
    const [profileSnap, economySnap] = await Promise.all([
      transaction.get(profileRef),
      transaction.get(economyRef),
    ]);

    if (!economySnap.exists) {
      throw new HttpsError("failed-precondition", "Player economy stats not found.");
    }

    const profileData = profileSnap.exists ? profileSnap.data() ?? {} : {};
    const subscribedPlatforms = (
      profileData.subscribedPlatforms ??
      profileData.subscriptions ??
      {}
    ) as Record<string, boolean>;
    const rewarded = (profileData.subscriptionRewards ?? {}) as Record<string, boolean>;
    const alreadyRewarded = rewarded[key] === true;
    const willSubscribe = value === true;

    if (willSubscribe && !alreadyRewarded) {
      gemsGranted = SUBSCRIPTION_REWARD_GEMS;
      transaction.update(economyRef, {
        gems: admin.firestore.FieldValue.increment(SUBSCRIPTION_REWARD_GEMS),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    const nextSubscribedPlatforms = { ...subscribedPlatforms, [key]: value };
    const nextSubscriptionRewards =
      gemsGranted > 0 ? { ...rewarded, [key]: true } : rewarded;

    const profileUpdate: Record<string, unknown> = {
      subscribedPlatforms: nextSubscribedPlatforms,
      subscriptionRewards: nextSubscriptionRewards,
      // Remove legacy mirror to keep shape clean.
      subscriptions: admin.firestore.FieldValue.delete(),
    };

    transaction.set(profileRef, profileUpdate, { merge: true });
  });

  return { status: "ok", gemsGranted };
});
export const claimStarterOffer = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "The function must be called while authenticated."
    );
  }

  const { opId } = request.data;
  const { uid } = request.auth;

  if (typeof opId !== "string" || !opId.trim()) {
    throw new HttpsError("invalid-argument", "Invalid opId provided.");
  }

  const existing = await checkIdempotency(uid, opId);
  if (existing) {
    return existing;
  }

  await createInProgressReceipt(uid, opId, "claimStarterOffer");

  const starterRewards = await loadStarterRewards();
  const useItemIdInventory = process.env.USE_ITEMID_V2 === "true";
  const legacyItemsRef = useItemIdInventory
    ? db.doc(`Players/${uid}/Inventory/Items`)
    : null;
  const legacyConsumablesRef = useItemIdInventory
    ? db.doc(`Players/${uid}/Inventory/Consumables`)
    : null;

  try {
    return await runReadThenWriteWithReceipt(
      uid,
      opId,
      "claimStarterOffer",
      async (transaction) => {
        const timestamp = admin.firestore.FieldValue.serverTimestamp();
        const flagsRef = db.doc(`/Players/${uid}/Progress/Flags`);
        const crateRef = db.doc(`Players/${uid}/Inventory/${starterRewards.crateSkuId}`);
        const keySkuId = starterRewards.keySkuId ?? null;
        const keyRef = keySkuId
          ? db.doc(`Players/${uid}/Inventory/${keySkuId}`)
          : null;
        const summaryRef = db.doc(`Players/${uid}/Inventory/_summary`);
        const legacyItemsDocPromise = legacyItemsRef
          ? transaction.get(legacyItemsRef)
          : Promise.resolve(null);
        const legacyConsumablesDocPromise = legacyConsumablesRef
          ? transaction.get(legacyConsumablesRef)
          : Promise.resolve(null);

        const snapshots = await Promise.all([
          transaction.get(flagsRef),
          transaction.get(crateRef),
          keyRef ? transaction.get(keyRef) : Promise.resolve(null),
          transaction.get(summaryRef),
          legacyItemsDocPromise,
          legacyConsumablesDocPromise,
        ]);

        const flagsDoc = snapshots[0];
        const crateDoc = snapshots[1];
        const keyDoc = (snapshots[2] ??
          null) as FirebaseFirestore.DocumentSnapshot | null;
        const summaryDoc = snapshots[3];
        const legacyItemsDoc = snapshots[4];
        const legacyConsumablesDoc = snapshots[5];

        if (flagsDoc.exists && flagsDoc.data()?.starterOfferClaimed) {
          throw new HttpsError("already-exists", "Starter offer already claimed.");
        }

        const crateState = createTxSkuDocState(
          db,
          uid,
          starterRewards.crateSkuId,
          crateDoc,
        );
        const keyState = keySkuId
          ? createTxSkuDocState(db, uid, keySkuId, keyDoc ?? undefined)
          : null;
        const summaryState = createTxInventorySummaryState(summaryRef, summaryDoc);

        const legacyInfo =
          useItemIdInventory
            ? {
                itemsRef: legacyItemsRef,
                itemsCounts:
                  (legacyItemsDoc?.exists
                    ? ((legacyItemsDoc.data() ?? {}) as { counts?: Record<string, number> })
                        .counts
                    : undefined) ?? {},
                consumablesRef:
                  legacyConsumablesDoc?.exists === true ? legacyConsumablesRef : null,
                consumableCounts:
                  legacyConsumablesDoc?.exists === true
                    ? ((legacyConsumablesDoc?.data() ?? {}) as {
                        counts?: Record<string, number>;
                      }).counts ?? {}
                    : {},
              }
            : null;

        return {
          timestamp,
          flagsRef,
          crateState,
          keyState,
          summaryState,
          legacy: legacyInfo,
        };
      },
      async (transaction, reads) => {
        const summaryChanges: Record<string, number> = {};

        await txIncSkuQty(transaction, db, uid, starterRewards.crateSkuId, 1, {
          state: reads.crateState,
          timestamp: reads.timestamp,
        });
        summaryChanges[starterRewards.crateSkuId] =
          (summaryChanges[starterRewards.crateSkuId] ?? 0) + 1;

        if (reads.keyState && starterRewards.keySkuId) {
          await txIncSkuQty(
            transaction,
            db,
            uid,
            starterRewards.keySkuId,
            1,
            {
              state: reads.keyState,
              timestamp: reads.timestamp,
            },
          );
          summaryChanges[starterRewards.keySkuId] =
            (summaryChanges[starterRewards.keySkuId] ?? 0) + 1;
        }

        if (Object.keys(summaryChanges).length > 0) {
          await txUpdateInventorySummary(transaction, db, uid, summaryChanges, {
            state: reads.summaryState,
            timestamp: reads.timestamp,
          });
        }

        transaction.set(
          reads.flagsRef,
          { starterOfferClaimed: true, updatedAt: reads.timestamp },
          { merge: true },
        );

        if (reads.legacy) {
          const legacyCrateTotal = reads.crateState.quantity;
          const legacyKeyTotal = reads.keyState?.quantity ?? 0;
          if (reads.legacy.itemsRef) {
            const itemCounts = { ...reads.legacy.itemsCounts };
            itemCounts[starterRewards.crateItemId] = legacyCrateTotal;
            if (starterRewards.keyItemId) {
              itemCounts[starterRewards.keyItemId] = legacyKeyTotal;
            }
            transaction.set(
              reads.legacy.itemsRef,
              {
                counts: itemCounts,
                updatedAt: reads.timestamp,
              },
              { merge: true },
            );
          }
          if (reads.legacy.consumablesRef) {
            const consumableCounts = { ...reads.legacy.consumableCounts };
            consumableCounts[starterRewards.crateSkuId] = legacyCrateTotal;
            if (starterRewards.keySkuId) {
              consumableCounts[starterRewards.keySkuId] = legacyKeyTotal;
            }
            transaction.set(
              reads.legacy.consumablesRef,
              {
                counts: consumableCounts,
                updatedAt: reads.timestamp,
              },
              { merge: true },
            );
          }
        }

        return { status: "ok" };
      },
    );
  } catch (error) {
    if (error instanceof HttpsError) {
      throw error;
    }
    console.error("[claimStarterOffer] Failed to grant starter rewards:", error);
    throw new HttpsError("internal", "Failed to claim starter offer.");
  }
});
