import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { db } from "../shared/firestore.js";
import { getPlayerSummary, getPlayerSummaries } from "./summary.js";

const normalizeName = (value: string | undefined): string => {
  if (!value || typeof value !== "string") {
    return "";
  }
  return value.trim();
};

export const searchPlayer = onCall(
  callableOptions({ cpu: 1, concurrency: 80 }),
  async (request) => {
    const rawName =
      (typeof request.data?.query === "string" ? request.data.query : null) ??
      (typeof request.data?.name === "string" ? request.data.name : null);

    const name = normalizeName(rawName);
    if (!name) {
      throw new HttpsError("invalid-argument", "Name must be a non-empty string.");
    }

    const nameLower = name.toLowerCase();

    if (name.length <= 2) {
      const usernamesQuery = db
        .collection("Usernames")
        .where(admin.firestore.FieldPath.documentId(), ">=", nameLower)
        .where(admin.firestore.FieldPath.documentId(), "<", `${nameLower}~`)
        .limit(10);
      const usernamesSnap = await usernamesQuery.get();
      const uids: string[] = [];

      for (const doc of usernamesSnap.docs) {
        const usernameData = doc.data() ?? {};
        const uid = typeof usernameData.uid === "string" ? usernameData.uid : null;
        if (!uid) {
          continue;
        }
        uids.push(uid);
      }

      if (uids.length === 0) {
        return { success: true, results: [] };
      }

      const summaries = await getPlayerSummaries(uids);
      const results = uids
        .map((uid) => summaries.get(uid))
        .filter((summary): summary is NonNullable<typeof summary> => !!summary)
        .map((summary) => ({
          uid: summary.uid,
          displayName: summary.displayName,
          avatarId: summary.avatarId,
          level: summary.level,
          trophies: summary.trophies,
          clan: summary.clan ?? null,
        }));

      return { success: true, results };
    }

    const usernameDoc = await db.collection("Usernames").doc(nameLower).get();
    if (!usernameDoc.exists) {
      return { success: false, message: "user not found" };
    }
    const usernameData = usernameDoc.data() ?? {};
    const uid = typeof usernameData.uid === "string" ? usernameData.uid : null;
    if (!uid) {
      return { success: false, message: "user not found" };
    }
    const summary = await getPlayerSummary(uid);
    if (!summary) {
      return { success: false, message: "user not found" };
    }

    return {
      success: true,
      player: {
        uid: summary.uid,
        displayName: summary.displayName,
        avatarId: summary.avatarId,
        level: summary.level,
        trophies: summary.trophies,
        clan: summary.clan ?? null,
      },
    };
  },
);

export const searchPlayers = searchPlayer;
