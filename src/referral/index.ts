import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import { getReferralConfig } from "../core/config.js";
import { ensureReferralCode, normaliseReferralCode } from "./codes.js";
import { REFERRAL_CODE_REGISTRY_COLLECTION } from "./constants.js";

export { referralClaimReferralCode } from "./claim.js";
export { acknowledgeReferralRewards } from "./acknowledge.js";


type AuthedRequest = {
  auth: {
    uid: string;
    token?: Record<string, unknown>;
  };
  rawRequest?: { get?(header: string): string | undefined };
  data?: Record<string, unknown>;
};

type MaybeAuthedRequest = {
  auth?: AuthedRequest["auth"];
  rawRequest?: AuthedRequest["rawRequest"];
  data?: Record<string, unknown>;
};

const getAdminFlag = (request: AuthedRequest): boolean => {
  const claims = request.auth.token ?? {};
  if (claims.admin === true || claims.isAdmin === true) {
    return true;
  }
  const roles = Array.isArray(claims.roles) ? claims.roles : [];
  if (roles.includes("admin") || roles.includes("superuser")) {
    return true;
  }
  const headerChecker = typeof request.rawRequest?.get === "function"
    ? request.rawRequest.get("x-admin") ?? request.rawRequest.get("X-Admin")
    : null;
  if (headerChecker && ["1", "true", "yes"].includes(String(headerChecker).toLowerCase())) {
    return true;
  }
  return false;
};

const ensureValidReferralCode = (code: string, alphabet: string): string => {
  const normalized = normaliseReferralCode(code, alphabet);
  if (normalized.length < 6 || normalized.length > 10) {
    throw new HttpsError("invalid-argument", "Invalid referral code supplied.");
  }
  return normalized;
};

export const referralGetMyReferralCode = onCall({ region: REGION }, async (rawRequest) => {
  const request = rawRequest as MaybeAuthedRequest;
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  const authed = request as AuthedRequest;
  const uid = authed.auth.uid;
  const config = await getReferralConfig();
  const referralCode = await ensureReferralCode(uid, config);
  return { referralCode };
});

export const referralDebugLookup = onCall({ region: REGION }, async (rawRequest) => {
  const request = rawRequest as MaybeAuthedRequest;
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  const authed = request as AuthedRequest;
  if (!getAdminFlag(authed)) {
    throw new HttpsError("permission-denied", "Admin privileges required.");
  }

  const rawCode = typeof request.data?.referralCode === "string"
    ? request.data.referralCode
    : "";
  const config = await getReferralConfig();
  const normalizedCode = ensureValidReferralCode(rawCode, config.alphabet);
  const docRef = db.collection(REFERRAL_CODE_REGISTRY_COLLECTION).doc(normalizedCode);
  const snapshot = await docRef.get();
  if (!snapshot.exists) {
    throw new HttpsError("not-found", "Referral code not registered.");
  }
  const data = snapshot.data() ?? {};
  const createdAt = data.createdAt;
  const millis = createdAt instanceof admin.firestore.Timestamp
    ? createdAt.toMillis()
    : typeof createdAt === "number"
      ? createdAt
      : null;
  return {
    referralCode: normalizedCode,
    uid: data.uid ?? null,
    createdAt: millis,
    checksum: data.checksum ?? null,
  };
});
