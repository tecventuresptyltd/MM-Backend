import * as crypto from "crypto";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { onRequest } from "firebase-functions/v2/https";
import { REGION } from "../shared/region.js";

const VERIFIER_KEYS_URL = "https://www.gstatic.com/admob/reward/verifier-keys.json";
const KEY_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const AD_REWARD_VERIFICATIONS_COLLECTION = "AdRewardVerifications";

interface VerifierKey {
  keyId: number;
  pem: string;
}

let cachedKeys: Map<string, string> | null = null;
let cachedKeysAt = 0;

export const isAdmobSsvEnforced = (): boolean => process.env.ADMOB_SSV_ENFORCED === "true";

export const adRewardVerificationId = (uid: string, raceId: string): string | null =>
  SAFE_ID_PATTERN.test(uid) && SAFE_ID_PATTERN.test(raceId) ? `${uid}_${raceId}` : null;

const loadVerifierKeys = async (forceRefresh: boolean): Promise<Map<string, string>> => {
  if (!forceRefresh && cachedKeys && Date.now() - cachedKeysAt < KEY_CACHE_TTL_MS) {
    return cachedKeys;
  }
  const response = await fetch(VERIFIER_KEYS_URL);
  if (!response.ok) {
    throw new Error(`verifier_keys_http_${response.status}`);
  }
  const body = (await response.json()) as { keys?: VerifierKey[] };
  const keys = new Map<string, string>();
  for (const key of body.keys ?? []) {
    if (key && typeof key.pem === "string") {
      keys.set(String(key.keyId), key.pem);
    }
  }
  cachedKeys = keys;
  cachedKeysAt = Date.now();
  return keys;
};

const splitSignedQuery = (rawQuery: string): { message: string; signature: string; keyId: string } | null => {
  const signatureIndex = rawQuery.indexOf("&signature=");
  if (signatureIndex <= 0) {
    return null;
  }
  const message = rawQuery.substring(0, signatureIndex);
  const trailing = new URLSearchParams(rawQuery.substring(signatureIndex + 1));
  const signature = trailing.get("signature");
  const keyId = trailing.get("key_id");
  if (!signature || !keyId) {
    return null;
  }
  return { message, signature, keyId };
};

const verifySignature = async (message: string, signature: string, keyId: string): Promise<boolean> => {
  let keys = await loadVerifierKeys(false);
  if (!keys.has(keyId)) {
    keys = await loadVerifierKeys(true);
  }
  const pem = keys.get(keyId);
  if (!pem) {
    return false;
  }
  const signatureBytes = Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return crypto.verify("sha256", Buffer.from(message, "utf8"), { key: pem, dsaEncoding: "der" }, signatureBytes);
};

export const admobSsv = onRequest({ region: REGION, memory: "256MiB", cpu: 1, concurrency: 80 }, async (req, res) => {
  const rawUrl = req.originalUrl ?? req.url ?? "";
  const queryIndex = rawUrl.indexOf("?");
  const rawQuery = queryIndex >= 0 ? rawUrl.substring(queryIndex + 1) : "";
  const signed = splitSignedQuery(rawQuery);
  if (!signed) {
    res.status(400).send("missing_signature");
    return;
  }

  try {
    if (!(await verifySignature(signed.message, signed.signature, signed.keyId))) {
      logger.warn("[admobSsv] Signature rejected", { keyId: signed.keyId });
      res.status(403).send("invalid_signature");
      return;
    }
  } catch (error) {
    logger.error("[admobSsv] Verification failed", { error: String(error) });
    res.status(500).send("verification_error");
    return;
  }

  const params = new URLSearchParams(signed.message);
  const uid = params.get("user_id") ?? "";
  const raceId = params.get("custom_data") ?? "";
  const transactionId = params.get("transaction_id") ?? "";
  const verificationId = adRewardVerificationId(uid, raceId);
  if (!verificationId) {
    res.status(200).send("ok");
    return;
  }

  await admin.firestore().doc(`/${AD_REWARD_VERIFICATIONS_COLLECTION}/${verificationId}`).set({
    uid,
    raceId,
    transactionId,
    adUnit: params.get("ad_unit") ?? "",
    rewardItem: params.get("reward_item") ?? "",
    rewardAmount: Number(params.get("reward_amount") ?? 0),
    adTimestampMs: Number(params.get("timestamp") ?? 0),
    verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  res.status(200).send("ok");
});
