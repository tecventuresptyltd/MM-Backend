import { onCall } from "firebase-functions/v2/https";

import { callableOptions } from "../shared/callableOptions.js";

export const getServerTime = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async () => {
  const nowMs = Date.now();
  return {
    serverNowMs: nowMs,
    serverIso: new Date(nowMs).toISOString(),
  };
});

