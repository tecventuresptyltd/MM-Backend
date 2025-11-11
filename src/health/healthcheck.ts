import { onRequest } from "firebase-functions/v2/https";
import { REGION } from "../shared/region";

export const healthcheck = onRequest({ region: REGION }, (req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});