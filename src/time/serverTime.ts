import { onCall } from "firebase-functions/v2/https";

import { REGION } from "../shared/region.js";

export const getServerTime = onCall({ region: REGION }, async () => {
  const nowMs = Date.now();
  return {
    serverNowMs: nowMs,
    serverIso: new Date(nowMs).toISOString(),
  };
});

