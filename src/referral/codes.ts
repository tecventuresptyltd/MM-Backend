import * as admin from "firebase-admin";
import { createHash, randomBytes } from "crypto";
import { ReferralConfig } from "./types.js";
import {
  REFERRAL_CODE_REGISTRY_COLLECTION,
  REFERRAL_UID_REGISTRY_COLLECTION,
} from "./constants.js";
import {
  normaliseReferralStats,
  shouldUpdateReferralStats,
} from "./stats.js";

const db = admin.firestore();
const codeRegistry = db.collection(REFERRAL_CODE_REGISTRY_COLLECTION);
const uidRegistry = db.collection(REFERRAL_UID_REGISTRY_COLLECTION);

const MAX_GENERATION_ATTEMPTS = 12;

export const normaliseReferralCode = (value: string, alphabet: string): string => {
  if (typeof value !== "string") {
    return "";
  }
  const upper = value.toUpperCase();
  const filtered: string[] = [];
  for (const char of upper) {
    if (alphabet.includes(char)) {
      filtered.push(char);
    }
  }
  return filtered.join("");
};

const generateCandidateCode = (alphabet: string, length: number): string => {
  if (alphabet.length === 0) {
    throw new Error("Referral alphabet is empty.");
  }
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    const index = bytes[i] % alphabet.length;
    result += alphabet.charAt(index);
  }
  return result;
};

const computeChecksum = (uid: string, code: string): string =>
  createHash("sha256").update(`${uid}:${code}`).digest("hex").slice(0, 16);

interface EnsureReferralCodeParams {
  transaction: FirebaseFirestore.Transaction;
  uid: string;
  profileRef: FirebaseFirestore.DocumentReference;
  profileSnap: FirebaseFirestore.DocumentSnapshot;
  config: ReferralConfig;
  timestamp: FirebaseFirestore.FieldValue;
}

const prepareProfileUpdates = (
  profileData: Record<string, unknown>,
  code: string,
): Record<string, unknown> | null => {
  const stats = normaliseReferralStats(profileData.referralStats);
  const updates: Record<string, unknown> = { referralCode: code };

  if (!Object.prototype.hasOwnProperty.call(profileData, "referredBy")) {
    updates.referredBy = null;
  }

  if (shouldUpdateReferralStats(profileData.referralStats, stats)) {
    updates.referralStats = stats;
  }

  if (Object.keys(updates).length === 0) {
    return null;
  }

  return updates;
};

interface ReferralCodePlanWrite {
  ref: FirebaseFirestore.DocumentReference;
  data: FirebaseFirestore.DocumentData;
  options: FirebaseFirestore.SetOptions;
}

export interface ReferralCodeTransactionPlan {
  code: string;
  writes: ReferralCodePlanWrite[];
}

const pushProfileUpdate = (
  writes: ReferralCodePlanWrite[],
  profileRef: FirebaseFirestore.DocumentReference,
  profileData: Record<string, unknown>,
  code: string,
) => {
  const updates = prepareProfileUpdates(profileData, code);
  if (!updates) {
    return;
  }
  writes.push({
    ref: profileRef,
    data: updates,
    options: { merge: true },
  });
};

export const prepareReferralCodePlan = async (
  params: EnsureReferralCodeParams,
): Promise<ReferralCodeTransactionPlan> => {
  const { transaction, uid, profileRef, profileSnap, config, timestamp } = params;
  const profileData = (profileSnap.exists ? profileSnap.data() ?? {} : {}) as Record<
    string,
    unknown
  >;
  const uidRegistryRef = uidRegistry.doc(uid);
  const uidRegistrySnap = await transaction.get(uidRegistryRef);
  const uidRegistryData = uidRegistrySnap.exists ? uidRegistrySnap.data() ?? {} : {};

  const rawExisting =
    typeof profileData.referralCode === "string"
      ? String(profileData.referralCode)
      : "";
  const existingCode = normaliseReferralCode(rawExisting, config.alphabet);
  const writes: ReferralCodePlanWrite[] = [];

  if (existingCode.length >= 6) {
    const codeRegistryRef = codeRegistry.doc(existingCode);
    const codeSnap = await transaction.get(codeRegistryRef);

    if (!codeSnap.exists) {
      writes.push({
        ref: codeRegistryRef,
        data: {
          uid,
          createdAt: timestamp,
          checksum: computeChecksum(uid, existingCode),
        },
        options: { merge: false },
      });
    } else {
      const registryData = codeSnap.data() ?? {};
      const owner = registryData.uid;
      if (typeof owner === "string" && owner !== uid) {
        throw new Error(
          `Referral code ${existingCode} already assigned to another uid (${owner}).`,
        );
      }
    }
    const uidRegistryData = uidRegistrySnap.exists ? uidRegistrySnap.data() ?? {} : {};
    const storedCode =
      typeof uidRegistryData.code === "string"
        ? normaliseReferralCode(uidRegistryData.code, config.alphabet)
        : "";
    if (storedCode && storedCode !== existingCode) {
      throw new Error(
        `Referral registry mismatch: uid=${uid} already mapped to ${storedCode}, cannot set ${existingCode}.`,
      );
    }

    if (!uidRegistrySnap.exists || !storedCode) {
      writes.push({
        ref: uidRegistryRef,
        data: {
          code: existingCode,
          createdAt: uidRegistryData.createdAt ?? timestamp,
        },
        options: { merge: true },
      });
    }

    pushProfileUpdate(writes, profileRef, profileData, existingCode);
    return { code: existingCode, writes };
  }

  if (uidRegistrySnap.exists) {
    const registryData = uidRegistryData;
    const mappedCode =
      typeof registryData.code === "string"
        ? normaliseReferralCode(registryData.code, config.alphabet)
        : "";
    if (mappedCode.length >= 6) {
      pushProfileUpdate(writes, profileRef, profileData, mappedCode);
      return { code: mappedCode, writes };
    }
  }

  for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt++) {
    const candidate = generateCandidateCode(config.alphabet, config.codeLength);
    const codeRef = codeRegistry.doc(candidate);
    const codeDoc = await transaction.get(codeRef);
    if (codeDoc.exists) {
      continue;
    }

    writes.push({
      ref: codeRef,
      data: {
        uid,
        createdAt: timestamp,
        checksum: computeChecksum(uid, candidate),
      },
      options: { merge: false },
    });
    writes.push({
      ref: uidRegistryRef,
      data: {
        code: candidate,
        createdAt: timestamp,
      },
      options: { merge: false },
    });
    pushProfileUpdate(writes, profileRef, profileData, candidate);
    return { code: candidate, writes };
  }

  throw new Error("Unable to allocate unique referral code after several attempts.");
};

export const applyReferralCodePlan = (
  transaction: FirebaseFirestore.Transaction,
  plan: ReferralCodeTransactionPlan,
): void => {
  for (const write of plan.writes) {
    transaction.set(write.ref, write.data, write.options);
  }
};

export const ensureReferralCodeInTransaction = async (
  params: EnsureReferralCodeParams,
): Promise<string> => {
  const plan = await prepareReferralCodePlan(params);
  applyReferralCodePlan(params.transaction, plan);
  return plan.code;
};

export async function ensureReferralCode(uid: string, config: ReferralConfig): Promise<string> {
  const profileRef = db.doc(`Players/${uid}/Profile/Profile`);
  const timestamp = admin.firestore.FieldValue.serverTimestamp();
  return await db.runTransaction(async (transaction) => {
    const profileSnap = await transaction.get(profileRef);
    return ensureReferralCodeInTransaction({
      transaction,
      uid,
      profileRef,
      profileSnap,
      config,
      timestamp,
    });
  });
}
