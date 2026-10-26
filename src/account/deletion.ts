import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { createHash } from "crypto";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { callableOptions } from "../shared/callableOptions.js";
import { db } from "../shared/firestore.js";
import { REGION } from "../shared/region.js";
import { playerClanStateRef } from "../clan/helpers.js";
import { leaveClanForUid } from "../clan/members.js";
import { leaderboardDocRef, socialFriendsRef, socialProfileRef } from "../Socials/refs.js";
import type { LeaderboardMetric } from "../Socials/types.js";

const REQUESTS_COLLECTION = "AccountDeletionRequests";
const LOG_COLLECTION = "AccountDeletionLog";
const GRACE_PERIOD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const JOB_BATCH_LIMIT = 200;
const FRIEND_BATCH_SIZE = 200;
const LEADERBOARD_METRICS: LeaderboardMetric[] = [
  "trophies",
  "careerCoins",
  "totalWins",
  "eliminationTrophies",
  "policeTrophies",
  "infectedTrophies",
];
const UID_LOOKUP_COLLECTIONS = ["Usernames", "AccountsEmails", "AccountsAppleSubs", "AccountsDeviceAnchors"];

const deletionRequestRef = (uid: string) => db.collection(REQUESTS_COLLECTION).doc(uid);

const hashUid = (uid: string): string => createHash("sha256").update(uid).digest("hex");

export const requestAccountDeletion = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const requestRef = deletionRequestRef(uid);
  const existing = await requestRef.get();
  const existingDeleteAfter = existing.data()?.deleteAfter as admin.firestore.Timestamp | undefined;
  if (existingDeleteAfter) {
    return { status: "ok", deleteAfter: existingDeleteAfter.toMillis(), graceDays: GRACE_PERIOD_DAYS };
  }

  const now = Date.now();
  const deleteAfter = now + GRACE_PERIOD_DAYS * DAY_MS;
  await requestRef.set({
    uid,
    source: "app",
    requestedAt: admin.firestore.Timestamp.fromMillis(now),
    deleteAfter: admin.firestore.Timestamp.fromMillis(deleteAfter),
  });

  logger.info("[accountDeletion] requested", { uidHash: hashUid(uid), deleteAfter });
  return { status: "ok", deleteAfter, graceDays: GRACE_PERIOD_DAYS };
});

export const cancelPendingAccountDeletion = async (uid: string): Promise<boolean> => {
  const requestRef = deletionRequestRef(uid);
  const snapshot = await requestRef.get();
  if (!snapshot.exists) {
    return false;
  }
  await requestRef.delete();
  logger.info("[accountDeletion] cancelled by sign-in", { uidHash: hashUid(uid) });
  return true;
};

export const accountDeletionJob = onSchedule(
  {
    region: REGION,
    schedule: "every day 03:00",
    timeZone: "Etc/UTC",
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async () => {
    const due = await db
      .collection(REQUESTS_COLLECTION)
      .where("deleteAfter", "<=", admin.firestore.Timestamp.now())
      .orderBy("deleteAfter")
      .limit(JOB_BATCH_LIMIT)
      .get();

    let deleted = 0;
    let failed = 0;
    for (const requestDoc of due.docs) {
      const uid = requestDoc.id;
      try {
        await deletePlayerAccount(uid);
        await db.collection(LOG_COLLECTION).add({
          uidHash: hashUid(uid),
          source: requestDoc.data().source ?? "app",
          requestedAt: requestDoc.data().requestedAt ?? null,
          deletedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        await requestDoc.ref.delete();
        deleted++;
      } catch (error) {
        failed++;
        logger.error("[accountDeletion] failed, will retry next run", { uidHash: hashUid(uid), error });
      }
    }

    logger.info("[accountDeletion] run complete", { due: due.size, deleted, failed });
  },
);

const deletePlayerAccount = async (uid: string): Promise<void> => {
  await removeFromClan(uid);
  await removeFromFriends(uid);
  await removeFromLeaderboards(uid);
  await deleteUidLookups(uid);
  await db.collection("AccountsProviders").doc(uid).delete();
  await deleteByField("Feedbacks", "userId", uid);
  await admin.database().ref(`presence/online/${uid.replace(/[.#$\[\]]/g, "_")}`).remove();
  await db.recursiveDelete(db.collection("Players").doc(uid));
  await deleteAuthUser(uid);
};

const removeFromClan = async (uid: string): Promise<void> => {
  const clanState = await playerClanStateRef(uid).get();
  const clanId = clanState.data()?.clanId;
  if (typeof clanId !== "string" || clanId.length === 0) {
    return;
  }
  try {
    await leaveClanForUid(uid, `account-deletion-${Date.now()}`);
  } catch (error) {
    logger.warn("[accountDeletion] leave clan failed, removing membership directly", { uidHash: hashUid(uid), error });
    await db.collection("Clans").doc(clanId).collection("Members").doc(uid).delete();
  }
};

const removeFromFriends = async (uid: string): Promise<void> => {
  const friendsSnap = await socialFriendsRef(uid).get();
  const friendUids = Object.keys((friendsSnap.data()?.friends ?? {}) as Record<string, unknown>);

  for (let i = 0; i < friendUids.length; i += FRIEND_BATCH_SIZE) {
    const batch = db.batch();
    friendUids.slice(i, i + FRIEND_BATCH_SIZE).forEach((friendUid) => {
      batch.set(
        socialFriendsRef(friendUid),
        { friends: { [uid]: admin.firestore.FieldValue.delete() }, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true },
      );
      batch.set(
        socialProfileRef(friendUid),
        { friendsCount: admin.firestore.FieldValue.increment(-1), updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true },
      );
    });
    await batch.commit();
  }
};

const removeFromLeaderboards = async (uid: string): Promise<void> => {
  await Promise.all(
    LEADERBOARD_METRICS.map((metric) =>
      db.runTransaction(async (transaction) => {
        const leaderboardRef = leaderboardDocRef(metric);
        const snapshot = await transaction.get(leaderboardRef);
        const entries = snapshot.data()?.top100;
        if (!Array.isArray(entries) || !entries.some((entry) => entry?.uid === uid)) {
          return;
        }
        const remaining = entries
          .filter((entry) => entry?.uid !== uid)
          .map((entry, index) => ({ ...entry, rank: index + 1 }));
        transaction.set(leaderboardRef, { top100: remaining, updatedAt: Date.now() }, { merge: true });
      }),
    ),
  );
};

const deleteUidLookups = async (uid: string): Promise<void> => {
  await Promise.all(UID_LOOKUP_COLLECTIONS.map((collection) => deleteByField(collection, "uid", uid)));
};

const deleteByField = async (collection: string, field: string, value: string): Promise<void> => {
  const snapshot = await db.collection(collection).where(field, "==", value).get();
  if (snapshot.empty) {
    return;
  }
  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
};

const deleteAuthUser = async (uid: string): Promise<void> => {
  try {
    await admin.auth().deleteUser(uid);
  } catch (error) {
    if ((error as { code?: string })?.code !== "auth/user-not-found") {
      throw error;
    }
  }
};
