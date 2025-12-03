import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import {
  checkIdempotency,
  createInProgressReceipt,
} from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import { hashOperationInputs } from "../core/hash.js";
import { resolveInventoryContext } from "../shared/inventory.js";
import {
  createTxInventorySummaryState,
  createTxSkuDocState,
  TxInventorySummaryState,
  TxSkuDocState,
} from "../inventory/index.js";
import { getReferralConfig } from "../core/config.js";
import {
  REFERRAL_CODE_REGISTRY_COLLECTION,
  REFERRAL_PROGRESS_DOC,
} from "./constants.js";
import { normaliseReferralCode } from "./codes.js";
import { awardReferralRewards, AwardInventoryContext } from "./awards.js";
import { ReferralSkuReward } from "./types.js";

const DEVICE_ANCHOR_COLLECTION = "AccountsDeviceAnchors";
const REFEREE_GEM_REWARD = 200;

const INVITER_TIER_REWARDS: Record<number, ReferralSkuReward[]> = {
  1: [
    { skuId: "sku_zz3twgp0wx", qty: 1 },
    { skuId: "sku_rjwe5tdtc4", qty: 1 },
  ],
  2: [
    { skuId: "sku_72wnqwtfmx", qty: 1 },
    { skuId: "sku_p3yxnyhkpx", qty: 1 },
  ],
  3: [
    { skuId: "sku_e8e7jeba7v", qty: 1 },
    { skuId: "sku_zqqmqz7mwb", qty: 1 },
  ],
  4: [
    { skuId: "sku_n9hsc0wxxk", qty: 1 },
    { skuId: "sku_acxbr542j1", qty: 1 },
  ],
  5: [
    { skuId: "sku_kgkjadrd79", qty: 1 },
    { skuId: "sku_hq5ywspmr5", qty: 1 },
  ],
};

const sanitizeString = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
};

const claimAnchorForUser = (
  transaction: FirebaseFirestore.Transaction,
  anchorRef: FirebaseFirestore.DocumentReference,
  anchorSnap: FirebaseFirestore.DocumentSnapshot,
  uid: string,
  timestamp: admin.firestore.FieldValue,
): void => {
  const data = anchorSnap.data() ?? {};
  const owner = typeof data.uid === "string" ? data.uid : "";

  if (data.hasRedeemedReferral === true) {
    throw new HttpsError("permission-denied", "referral-already-redeemed");
  }

  // Anchor missing or not tied to this uid: claim it for the caller so the referral
  // flow can proceed while still tracking reuse on this device.
  if (!anchorSnap.exists) {
    transaction.set(
      anchorRef,
      { uid, createdAt: timestamp, lastSeenAt: timestamp },
      { merge: true },
    );
    return;
  }

  if (!owner || owner !== uid) {
    transaction.set(
      anchorRef,
      { uid, lastSeenAt: timestamp, reclaimedFrom: owner || null },
      { merge: true },
    );
  } else {
    transaction.set(anchorRef, { lastSeenAt: timestamp }, { merge: true });
  }
};

const parseAwardedThresholds = (raw: unknown): number[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const deduped = new Set<number>();
  raw.forEach((value) => {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      deduped.add(Math.floor(num));
    }
  });
  return Array.from(deduped).sort((a, b) => a - b);
};

const buildRewardSkuStates = async (
  transaction: FirebaseFirestore.Transaction,
  uid: string,
  rewards: ReferralSkuReward[],
): Promise<{
  context: AwardInventoryContext | null;
  summaryState?: TxInventorySummaryState;
}> => {
  if (!rewards.length) {
    return { context: null };
  }

  const uniqueSkuIds = Array.from(new Set(rewards.map((reward) => reward.skuId)));
  const inventoryCtx = resolveInventoryContext(uid);
  const summarySnap = await transaction.get(inventoryCtx.summaryRef);
  const summaryState = createTxInventorySummaryState(inventoryCtx.summaryRef, summarySnap);

  const skuRefs = uniqueSkuIds.map((skuId) => inventoryCtx.inventoryCollection.doc(skuId));
  const skuSnaps = skuRefs.length ? await transaction.getAll(...skuRefs) : [];
  const skuStates = new Map<string, TxSkuDocState>();
  uniqueSkuIds.forEach((skuId, index) => {
    skuStates.set(skuId, createTxSkuDocState(db, uid, skuId, skuSnaps[index]));
  });

  return {
    context: { skuStates, summaryState },
    summaryState,
  };
};

export const referralClaimReferralCode = onCall({ region: REGION }, async (rawRequest) => {
  const uid = rawRequest.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const opId = sanitizeString(rawRequest.data?.opId);
  if (!opId) {
    throw new HttpsError("invalid-argument", "opId is required.");
  }

  const referralCodeInput = sanitizeString(rawRequest.data?.referralCode);
  const deviceAnchor = sanitizeString(rawRequest.data?.deviceAnchor);
  if (!referralCodeInput || !deviceAnchor) {
    throw new HttpsError("invalid-argument", "referralCode and deviceAnchor are required.");
  }

  const config = await getReferralConfig();
  const normalizedCode = normaliseReferralCode(referralCodeInput, config.alphabet);
  if (!normalizedCode) {
    throw new HttpsError("invalid-argument", "Invalid referral code supplied.");
  }

  const inputsHash = hashOperationInputs({ referralCode: normalizedCode, deviceAnchor });
  const existing = await checkIdempotency(uid, opId);
  if (existing) {
    return existing;
  }

  await createInProgressReceipt(uid, opId, "referral.claim.v2", {
    kind: "referral-claim",
    inputsHash,
  });

  const result = await runTransactionWithReceipt(
    uid,
    opId,
    "referral.claim.v2",
    async (transaction) => {
      const timestamp = admin.firestore.FieldValue.serverTimestamp();

      const claimantProfileRef = db.doc(`Players/${uid}/Profile/Profile`);
      const claimantStatsRef = db.doc(`Players/${uid}/Economy/Stats`);
      const anchorRef = db.doc(`${DEVICE_ANCHOR_COLLECTION}/${deviceAnchor}`);
      const codeRef = db.collection(REFERRAL_CODE_REGISTRY_COLLECTION).doc(normalizedCode);

      const [profileSnap, statsSnap, anchorSnap, codeSnap] = await Promise.all([
        transaction.get(claimantProfileRef),
        transaction.get(claimantStatsRef),
        transaction.get(anchorRef),
        transaction.get(codeRef),
      ]);

      if (!profileSnap.exists) {
        throw new HttpsError("failed-precondition", "player-profile-missing");
      }
      if (!statsSnap.exists) {
        throw new HttpsError("failed-precondition", "player-economy-missing");
      }

      const profileData = profileSnap.data() ?? {};
      if (typeof profileData.referredBy === "string" && profileData.referredBy.trim().length > 0) {
        throw new HttpsError("failed-precondition", "already-claimed");
      }

      if (!codeSnap.exists) {
        throw new HttpsError("not-found", "referral-code-not-found");
      }
      const inviterUidRaw = codeSnap.data()?.uid;
      const inviterUid =
        typeof inviterUidRaw === "string" && inviterUidRaw.trim().length > 0
          ? inviterUidRaw.trim()
          : "";
      if (!inviterUid) {
        throw new HttpsError("failed-precondition", "referral-code-invalid");
      }
      if (inviterUid === uid) {
        throw new HttpsError("failed-precondition", "self-referral");
      }

      const inviterProfileRef = db.doc(`Players/${inviterUid}/Profile/Profile`);
      const inviterProgressRef = db.doc(`Players/${inviterUid}/${REFERRAL_PROGRESS_DOC}`);

      const [inviterProfileSnap, inviterProgressSnap] = await Promise.all([
        transaction.get(inviterProfileRef),
        transaction.get(inviterProgressRef),
      ]);

      if (!inviterProfileSnap.exists) {
        throw new HttpsError("failed-precondition", "inviter-profile-missing");
      }
      const inviterProfile = inviterProfileSnap.data() ?? {};
      const knownAnchors = Array.isArray(inviterProfile.knownDeviceAnchors)
        ? inviterProfile.knownDeviceAnchors.map((anchor: unknown) => String(anchor))
        : [];
      if (knownAnchors.includes(deviceAnchor)) {
        throw new HttpsError("permission-denied", "device-anchor-linked-to-inviter");
      }

      const awardedThresholds = parseAwardedThresholds(inviterProgressSnap.data()?.awardedThresholds);
      const awardedSet = new Set(awardedThresholds);
      const rewardThresholds = Object.keys(INVITER_TIER_REWARDS)
        .map((key) => Number(key))
        .filter((value) => Number.isFinite(value) && value > 0);

      const currentSentTotal = Number(inviterProgressSnap.data()?.sentTotal) || 0;
      const newSentTotal = currentSentTotal + 1;
      const cappedReward = INVITER_TIER_REWARDS[newSentTotal] ?? [];

      const reachableThresholds = rewardThresholds.filter(
        (threshold) => threshold <= newSentTotal && (INVITER_TIER_REWARDS[threshold]?.length ?? 0) > 0,
      );
      const newThresholdsAwarded = reachableThresholds.filter((threshold) => !awardedSet.has(threshold));
      const shouldGrantCurrent = newThresholdsAwarded.includes(newSentTotal);
      const updatedAwarded = Array.from(new Set([...awardedThresholds, ...reachableThresholds])).sort(
        (a, b) => a - b,
      );

      const inviterRewardPrep = await buildRewardSkuStates(transaction, inviterUid, cappedReward);

      // All reads are complete above; writes begin below.
      claimAnchorForUser(transaction, anchorRef, anchorSnap, uid, timestamp);

      transaction.update(claimantStatsRef, {
        gems: admin.firestore.FieldValue.increment(REFEREE_GEM_REWARD),
        updatedAt: timestamp,
      });

      transaction.set(
        claimantProfileRef,
        {
          referredBy: inviterUid,
          referredAt: timestamp,
        },
        { merge: true },
      );

      transaction.set(
        anchorRef,
        {
          hasRedeemedReferral: true,
          redeemedBy: uid,
          redeemedAt: timestamp,
          lastSeenAt: timestamp,
        },
        { merge: true },
      );

      transaction.set(
        inviterProgressRef,
        {
          sentTotal: newSentTotal,
          awardedThresholds: updatedAwarded,
          updatedAt: timestamp,
        },
        { merge: true },
      );

      let inviterAwardSummary: Array<{ skuId: string; qty: number }> = [];
      if (shouldGrantCurrent && cappedReward.length && inviterRewardPrep.context) {
        const awards = await awardReferralRewards(
          transaction,
          inviterUid,
          cappedReward,
          timestamp,
          inviterRewardPrep.context,
        );
        inviterAwardSummary = awards.map((award) => ({
          skuId: award.skuId,
          qty: award.qty,
        }));
      }

      return {
        status: "ok",
        inviterUid,
        sentTotal: newSentTotal,
        awardedThresholds: updatedAwarded,
        inviterRewardsGranted: inviterAwardSummary,
        refereeGemsGranted: REFEREE_GEM_REWARD,
      };
    },
    {
      kind: "referral-claim",
      inputsHash,
    },
  );

  return result;
});
