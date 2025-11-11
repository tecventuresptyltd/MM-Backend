import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region";

const db = admin.firestore();

interface GetLeaderboardRequest {
  leaderboardType: "trophies" | "earnings";
  pageSize: number;
  startAfter?: unknown;
}

export const getLeaderboard = onCall({ region: REGION }, async (request) => {
  const { leaderboardType, pageSize, startAfter } = request.data as GetLeaderboardRequest;

  if (!leaderboardType || !pageSize) {
    throw new HttpsError("invalid-argument", "Missing required parameters.");
  }

  const fieldToOrderBy = leaderboardType === "trophies" ? "trophies" : "earnings";
  let query = db.collectionGroup("Stats")
    .orderBy(fieldToOrderBy, "desc")
    .limit(pageSize);

  if (startAfter) {
    query = query.startAfter(startAfter);
  }

  const snapshot = await query.get();
  const players = snapshot.docs.map(doc => doc.data());

  return {
    players,
    nextPageToken: players.length === pageSize ? snapshot.docs[snapshot.docs.length - 1] : null,
  };
});