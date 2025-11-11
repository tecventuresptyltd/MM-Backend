import * as admin from "firebase-admin";
import { ReferralConfig } from "./types.js";
import { REFERRAL_PROGRESS_DOC } from "./constants.js";

const db = admin.firestore();

const normaliseThresholdArray = (value: unknown): number[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const thresholds = value
    .map((entry) => Number(entry))
    .filter((entry) => Number.isFinite(entry) && entry > 0)
    .map((entry) => Math.floor(entry));
  return Array.from(new Set(thresholds)).sort((a, b) => a - b);
};

interface ProgressUpdateResult {
  newTotal: number;
  thresholdsAwarded: number[];
  awardedThresholds: number[];
}

export const incrementReferralProgress = async (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  incrementBy: number,
  timestamp: FirebaseFirestore.FieldValue,
  config: ReferralConfig,
  options?: { snapshot?: FirebaseFirestore.DocumentSnapshot },
): Promise<ProgressUpdateResult> => {
  if (!Number.isFinite(incrementBy) || incrementBy <= 0) {
    throw new Error("incrementReferralProgress requires a positive increment.");
  }

  const progressRef = db.doc(`Players/${uid}/${REFERRAL_PROGRESS_DOC}`);
  const progressSnap =
    options?.snapshot ?? (await transaction.get(progressRef));
  const rawData = progressSnap.exists ? progressSnap.data() ?? {} : {};
  const currentTotal = Number(rawData.sentTotal) || 0;
  const awardedThresholds = normaliseThresholdArray(rawData.awardedThresholds);
  const awardedSet = new Set(awardedThresholds);

  const newTotal = currentTotal + Math.floor(incrementBy);
  const thresholdsAwarded: number[] = [];

  for (const reward of config.inviterRewards) {
    const threshold = Math.floor(reward.threshold);
    if (threshold <= 0 || awardedSet.has(threshold)) {
      continue;
    }
    if (currentTotal < threshold && newTotal >= threshold) {
      thresholdsAwarded.push(threshold);
      awardedSet.add(threshold);
    }
  }

  const updatedAwarded = Array.from(awardedSet).sort((a, b) => a - b);

  transaction.set(
    progressRef,
    {
      sentTotal: newTotal,
      awardedThresholds: updatedAwarded,
      lastUpdatedAt: timestamp,
    },
    { merge: true },
  );

  return {
    newTotal,
    thresholdsAwarded,
    awardedThresholds: updatedAwarded,
  };
};
