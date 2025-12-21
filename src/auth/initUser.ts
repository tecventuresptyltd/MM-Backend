import { HttpsError, onCall } from "firebase-functions/v2/https";
import { ensureOp } from "../shared/idempotency";
import { initializeUserIfNeeded, waitForUserBootstrap } from "../shared/initializeUser";
import { REGION } from "../shared/region";
import * as admin from "firebase-admin";
import { refreshPlayerLeaderboardSnapshots } from "../Socials/liveLeaderboard.js";

export const initUser = onCall({ enforceAppCheck: false, region: REGION }, async (request) => {
  const { opId } = request.data;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }
  if (typeof opId !== "string") {
    throw new HttpsError("invalid-argument", "Invalid opId provided.");
  }

  await ensureOp(uid, opId, { function: "initUser" });

  const user = await admin.auth().getUser(uid);
  const isGuest = user.providerData.length === 0;
  await initializeUserIfNeeded(
    uid,
    user.providerData.map((p: any) => p.providerId),
    { isGuest, email: user.email ?? null, authUser: user, opId },
  );
  const remaining = await waitForUserBootstrap(uid);
  if (remaining.size > 0) {
    throw new HttpsError(
      "internal",
      `User bootstrap incomplete. Missing documents: ${Array.from(remaining).join(", ")}`,
    );
  }

  try {
    await refreshPlayerLeaderboardSnapshots(uid);
  } catch (error) {
    console.warn("[initUser] failed to refresh leaderboards", { uid, error });
  }

  return { ok: true };
});
