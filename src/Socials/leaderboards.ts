import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region";

const db = admin.firestore();

interface GetGlobalLeaderboardRequest {
  type: 1 | 2 | 3; // 1 = trophy, 2 = coin, 3 = race
  limit: number;
}

interface LeaderboardPlayer {
  uid: string;
  displayName: string;
  avatarId: number;
  level: number;
  trophies: number;
  rank: number;
  value: number; // The value being ranked by (trophies, careerCoins, or totalWins)
}

export const getGlobalLeaderboard = onCall({ region: REGION }, async (request) => {
  const { type, limit } = request.data as GetGlobalLeaderboardRequest;
  const callerUid = request.auth?.uid;

  // Validate input parameters
  if (typeof type !== "number" || ![1, 2, 3].includes(type)) {
    throw new HttpsError("invalid-argument", "Type must be 1 (trophy), 2 (coin), or 3 (race).");
  }

  if (typeof limit !== "number" || limit <= 0 || limit > 200) {
    throw new HttpsError("invalid-argument", "Limit must be a number between 1 and 200.");
  }

  try {
    // Determine which field to order by based on type
    let orderByField: string;
    let fieldName: string;

    switch (type) {
      case 1: // Trophy leaderboard
        orderByField = "trophies";
        fieldName = "trophies";
        break;
      case 2: // Coin leaderboard  
        orderByField = "careerCoins";
        fieldName = "careerCoins";
        break;
      case 3: // Race wins leaderboard
        orderByField = "totalWins";
        fieldName = "totalWins";
        break;
      default:
        throw new HttpsError("invalid-argument", "Invalid leaderboard type.");
    }

    // Get all players first, then sort in memory
    const playersCollection = await db.collection("Players").get();
    const playerProfiles: any[] = [];
    let callerProfile: any = null;

    // Fetch profile data for each player
    for (const playerDoc of playersCollection.docs) {
      try {
        const profileDoc = await db.doc(`Players/${playerDoc.id}/Profile/Profile`).get();
        if (profileDoc.exists) {
          const profileData = profileDoc.data();
          if (profileData && typeof profileData[fieldName] === "number") {
            const fullProfile = {
              uid: playerDoc.id,
              ...profileData,
            };
            playerProfiles.push(fullProfile);
            if (callerUid && playerDoc.id === callerUid) {
              callerProfile = fullProfile;
            }
          }
        }
      } catch (error) {
        // Skip this player if there's an error reading their profile
        console.warn(`Skipping player ${playerDoc.id}:`, error);
      }
    }

    // Sort by the specified field and take the top results
    playerProfiles.sort((a, b) => (b[fieldName] || 0) - (a[fieldName] || 0));
    const topPlayers = playerProfiles.slice(0, limit);

    const players: Array<{ uid: string; displayName: string; avatarId: number; level: number; rank: number; stat: number }> = [];
    let rank = 1;
    let callerRank: number | null = null;

    for (const profileData of topPlayers) {
      // Ensure we have all required fields
      if (
        typeof profileData.displayName === "string" &&
        typeof profileData.avatarId === "number" &&
        typeof profileData.level === "number" &&
        typeof profileData[fieldName] === "number"
      ) {
        players.push({
          uid: profileData.uid,
          displayName: profileData.displayName,
          avatarId: profileData.avatarId,
          level: profileData.level,
          rank,
          stat: profileData[fieldName],
        });
        if (callerUid && profileData.uid === callerUid) {
          callerRank = rank;
        }
        rank++;
      }
    }

    // If caller is not in topPlayers, find their rank in the full sorted list
    if (callerUid && callerRank == null && callerProfile) {
      for (let i = 0; i < playerProfiles.length; i++) {
        if (playerProfiles[i].uid === callerUid) {
          callerRank = i + 1;
          break;
        }
      }
    }

    return {
      success: true,
      leaderboardType: type,
      totalPlayers: players.length,
      players,
      callerRank: callerRank ?? null,
    };

  } catch (error) {
    console.error("Error fetching global leaderboard:", error);
    throw new HttpsError("internal", "Failed to fetch leaderboard data.");
  }
});