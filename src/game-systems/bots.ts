import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region.js";
import { buildBotLoadout } from "./botLoadoutHelper.js";
import { callableOptions } from "../shared/callableOptions.js";

export const generateBotLoadout = onCall(callableOptions(), async (request) => {
  const { trophyCount } = request.data ?? {};
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (typeof trophyCount !== "number" || trophyCount < 0) {
    throw new HttpsError("invalid-argument", "trophyCount must be a non-negative number.");
  }

  try {
    const botLoadout = await buildBotLoadout(trophyCount);
    return {
      success: true,
      botLoadout,
    };
  } catch (error) {
    const e = error as Error;
    throw new HttpsError("internal", e.message, e);
  }
});
