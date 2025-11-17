import * as admin from "firebase-admin";
import { socialFriendsRef, socialRequestsRef } from "./refs.js";
import type { FriendsDoc, RequestsDoc, PlayerSummary } from "./types.js";
import { getPlayerSummary } from "./summary.js";

const db = admin.firestore();

const extractFriendIds = (
  snapshot: FirebaseFirestore.DocumentSnapshot,
): string[] => {
  if (!snapshot.exists) {
    return [];
  }
  const data = snapshot.data() as FriendsDoc;
  if (!data?.friends) {
    return [];
  }
  return Object.keys(data.friends);
};

const splitIntoChunks = <T>(items: T[], size: number): T[][] => {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
};

const updateFriendEntries = async (uid: string, summary: PlayerSummary) => {
  const snapshot = await socialFriendsRef(uid).get();
  const friendIds = extractFriendIds(snapshot);
  if (friendIds.length === 0) {
    return;
  }
  const chunks = splitIntoChunks(friendIds, 400);
  await Promise.all(
    chunks.map((chunk) => {
      const batch = db.batch();
      chunk.forEach((friendUid) => {
        batch.set(
          socialFriendsRef(friendUid),
          {
            friends: {
              [uid]: { player: summary },
            },
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      });
      return batch.commit();
    }),
  );
};

const updateRequestEntry = async (
  ownerUid: string,
  field: "incoming" | "outgoing",
  requestId: string,
  summary: PlayerSummary,
) => {
  await db.runTransaction(async (transaction) => {
    const ref = socialRequestsRef(ownerUid);
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) {
      return;
    }
    const data = (snapshot.data() ?? {}) as RequestsDoc;
    const incoming = Array.isArray(data.incoming) ? [...data.incoming] : [];
    const outgoing = Array.isArray(data.outgoing) ? [...data.outgoing] : [];
    let mutated = false;

    if (field === "incoming") {
      for (const request of incoming) {
        if (request.requestId === requestId) {
          request.player = summary;
          mutated = true;
          break;
        }
      }
      if (mutated) {
        transaction.set(
          ref,
          {
            incoming,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
      }
      return;
    }

    for (const request of outgoing) {
      if (request.requestId === requestId) {
        request.player = summary;
        mutated = true;
        break;
      }
    }
    if (mutated) {
      transaction.set(
        ref,
        {
          outgoing,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }
  });
};

const updateRequestEntries = async (
  uid: string,
  summary: PlayerSummary,
) => {
  const snapshot = await socialRequestsRef(uid).get();
  if (!snapshot.exists) {
    return;
  }
  const data = (snapshot.data() ?? {}) as RequestsDoc;
  const incoming = Array.isArray(data.incoming) ? data.incoming : [];
  const outgoing = Array.isArray(data.outgoing) ? data.outgoing : [];

  await Promise.all([
    ...incoming
      .filter((entry) => entry.fromUid && entry.requestId)
      .map((entry) =>
        updateRequestEntry(entry.fromUid, "outgoing", entry.requestId, summary),
      ),
    ...outgoing
      .filter((entry) => entry.toUid && entry.requestId)
      .map((entry) =>
        updateRequestEntry(entry.toUid, "incoming", entry.requestId, summary),
      ),
  ]);
};

export const refreshFriendSnapshots = async (uid: string) => {
  const summary = await getPlayerSummary(uid);
  if (!summary) {
    return;
  }
  await Promise.all([
    updateFriendEntries(uid, summary),
    updateRequestEntries(uid, summary),
  ]);
};
