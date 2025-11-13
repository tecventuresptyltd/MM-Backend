import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { playerProfileRef, socialProfileRef, playerEconomyRef } from "./refs.js";
import { getPlayerSummary } from "./summary.js";

const sanitizeUid = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpsError("invalid-argument", "uid must be provided.");
  }
  return value.trim();
};

export const viewPlayerProfile = onCall(
  callableOptions(),
  async (request) => {
    const callerUid = request.auth?.uid;
    if (!callerUid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const targetUid = sanitizeUid(request.data?.uid ?? request.data?.targetUid ?? callerUid);
    const [profileSnap, socialSnap, economySnap] = await Promise.all([
      playerProfileRef(targetUid).get(),
      socialProfileRef(targetUid).get(),
      playerEconomyRef(targetUid).get(),
    ]);

    if (!profileSnap.exists) {
      throw new HttpsError("not-found", "Player profile not found.");
    }

    const summary = await getPlayerSummary(targetUid);
    if (!summary) {
      throw new HttpsError("not-found", "Player summary not available.");
    }

    const socialData = socialSnap.exists ? socialSnap.data() ?? {} : {};
    const profileData = profileSnap.data() ?? {};
    const economyData = economySnap.exists ? economySnap.data() ?? {} : {};

    return {
      ok: true,
      success: true,
      data: {
        player: summary,
        stats: {
          level: profileData.level ?? 1,
          trophies: profileData.trophies ?? 0,
          highestTrophies: profileData.highestTrophies ?? 0,
          careerCoins: profileData.careerCoins ?? economyData.careerCoins ?? 0,
          totalWins: profileData.totalWins ?? 0,
          totalRaces: profileData.totalRaces ?? 0,
        },
        social: {
          friendsCount: socialData.friendsCount ?? 0,
          hasFriendRequests: socialData.hasFriendRequests ?? false,
          referralCode: socialData.referralCode ?? profileData.referralCode ?? null,
          lastActiveAt: socialData.lastActiveAt ?? null,
        },
      },
    };
  },
);
