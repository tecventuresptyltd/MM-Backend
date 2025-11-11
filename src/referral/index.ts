import * as admin from "firebase-admin";
import { PubSub } from "@google-cloud/pubsub";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import { resolveInventoryContext } from "../shared/inventory.js";
import {
  checkIdempotency,
  createInProgressReceipt,
  applyReceiptMetadata,
} from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import { hashOperationInputs } from "../core/hash.js";
import { getReferralConfig } from "../core/config.js";
import {
  ensureReferralCode,
  ensureReferralCodeInTransaction,
  normaliseReferralCode,
} from "./codes.js";
import {
  awardReferralRewards,
  AwardInventoryContext,
} from "./awards.js";
import { incrementReferralProgress } from "./progress.js";
import {
  normaliseReferralStats,
  cloneReferralStats,
  applyInviteeRewardCredit,
  applyInviterRewardCredit,
} from "./stats.js";
import {
  REFERRAL_CODE_REGISTRY_COLLECTION,
  REFERRAL_EVENTS_SUBCOLLECTION,
  REFERRAL_PROGRESS_DOC,
} from "./constants.js";
import {
  createTxInventorySummaryState,
  createTxSkuDocState,
  TxInventorySummaryState,
  TxSkuDocState,
} from "../inventory/index.js";
import { ReferralConfig, ReferralSkuReward } from "./types.js";

const REFERRAL_METRICS_TOPIC = process.env.REFERRAL_METRICS_TOPIC ?? null;
const pubsub = REFERRAL_METRICS_TOPIC ? new PubSub() : null;

const publishReferralMetric = async (payload: Record<string, unknown>): Promise<void> => {
  if (!pubsub || !REFERRAL_METRICS_TOPIC) {
    return;
  }
  try {
    await pubsub
      .topic(REFERRAL_METRICS_TOPIC)
      .publishMessage({ data: Buffer.from(JSON.stringify(payload)) });
  } catch (error) {
    console.error("[ReferralMetrics] Failed to publish referral-claimed event", error);
  }
};

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

const sanitizeOpId = (value: unknown): string => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
};

const ensureValidReferralCode = (code: string, config: ReferralConfig): string => {
  const normalized = normaliseReferralCode(code, config.alphabet);
  if (normalized.length < 6 || normalized.length > 10) {
    throw new HttpsError("invalid-argument", "Invalid referral code supplied.");
  }
  return normalized;
};

const toRewardSummary = (rewards: ReferralSkuReward[]) =>
  rewards.map((reward) => ({ skuId: reward.skuId, qty: reward.qty }));

const collectRewardSkuIds = (rewards: ReferralSkuReward[]): string[] => {
  const result = new Set<string>();
  for (const reward of rewards) {
    if (!reward || typeof reward.skuId !== "string") {
      continue;
    }
    const trimmed = reward.skuId.trim();
    if (trimmed.length === 0) {
      continue;
    }
    result.add(trimmed);
  }
  return Array.from(result);
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

export const referralClaimReferralCode = onCall({ region: REGION }, async (rawRequest) => {
  const request = rawRequest as MaybeAuthedRequest;
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  const authed = request as AuthedRequest;
  const uid = authed.auth.uid;
  const opId = sanitizeOpId(request.data?.opId);
  if (!opId) {
    throw new HttpsError("invalid-argument", "opId is required.");
  }

  const rawCode = typeof request.data?.referralCode === "string"
    ? request.data.referralCode
    : "";

  const config = await getReferralConfig();
  const normalizedCode = ensureValidReferralCode(rawCode, config);
  const inputsHash = hashOperationInputs({ referralCode: normalizedCode });

  const existing = await checkIdempotency(uid, opId);
  if (existing) {
    return existing;
  }

  await createInProgressReceipt(uid, opId, "referral.claimReferralCode", {
    kind: "referral-claim",
    inputsHash,
  });

  const receiptRef = db.doc(`Players/${uid}/Receipts/${opId}`);
  let result;
  try {
    result = await runTransactionWithReceipt(
      uid,
      opId,
      "referral.claimReferralCode",
      async (transaction) => {
      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      const nowMillis = Date.now();

      const claimantProfileRef = db.doc(`Players/${uid}/Profile/Profile`);
      const claimantClaimRef = db.doc(`ReferralClaims/${uid}`);
      const codeRegistryRef = db
        .collection(REFERRAL_CODE_REGISTRY_COLLECTION)
        .doc(normalizedCode);

      const [claimantProfileSnap, claimantClaimSnap, codeRegistrySnap] = await Promise.all([
        transaction.get(claimantProfileRef),
        transaction.get(claimantClaimRef),
        transaction.get(codeRegistryRef),
      ]);

      if (!claimantProfileSnap.exists) {
        throw new HttpsError("failed-precondition", "invitee-profile-missing");
      }

      const claimantData = claimantProfileSnap.data() ?? {};
      const existingReferredBy =
        typeof claimantData.referredBy === "string" ? claimantData.referredBy : null;
      if (existingReferredBy) {
        throw new HttpsError("failed-precondition", "already-claimed");
      }

      const inviteeStats = normaliseReferralStats(claimantData.referralStats);
      if (inviteeStats.receivedCredit) {
        throw new HttpsError("failed-precondition", "already-claimed");
      }

      const claimMeta = claimantClaimSnap.exists ? claimantClaimSnap.data() ?? {} : {};
      const claimStatus = typeof claimMeta.status === "string" ? claimMeta.status : null;
      const claimOpId = typeof claimMeta.opId === "string" ? claimMeta.opId : null;
      if (claimStatus === "finalized") {
        throw new HttpsError("failed-precondition", "already-claimed");
      }
      if (claimStatus === "in-progress" && claimOpId && claimOpId !== opId) {
        throw new HttpsError("failed-precondition", "already-in-progress");
      }

      if (!codeRegistrySnap.exists) {
        throw new HttpsError("not-found", "referral-code-not-found");
      }
      const inviterUid = codeRegistrySnap.data()?.uid;
      if (typeof inviterUid !== "string" || inviterUid.trim().length === 0) {
        throw new HttpsError("failed-precondition", "referral-code-invalid");
      }

      if (config.blockSelfReferral && inviterUid === uid) {
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

      const inviterData = inviterProfileSnap.data() ?? {};
      const inviterStats = normaliseReferralStats(inviterData.referralStats);

      const inviterReferredByRaw =
        typeof inviterData.referredBy === "string" ? inviterData.referredBy : null;
      const inviterReferredByCode = inviterReferredByRaw
        ? normaliseReferralCode(inviterReferredByRaw, config.alphabet)
        : "";

      if (config.blockCircularReferral && inviterReferredByCode) {
        const inviterReferredRegistryRef = db
          .collection(REFERRAL_CODE_REGISTRY_COLLECTION)
          .doc(inviterReferredByCode);
        const inviterReferredRegistrySnap = await transaction.get(inviterReferredRegistryRef);
        const inviterReferredOwner =
          inviterReferredRegistrySnap.exists && typeof inviterReferredRegistrySnap.data()?.uid === "string"
            ? (inviterReferredRegistrySnap.data()?.uid as string)
            : null;

        if (inviterReferredOwner === uid) {
          throw new HttpsError("failed-precondition", "circular-referral");
        }

        if (inviterReferredOwner) {
          const ancestorProfileRef = db.doc(`Players/${inviterReferredOwner}/Profile/Profile`);
          const ancestorProfileSnap = await transaction.get(ancestorProfileRef);
          if (ancestorProfileSnap.exists) {
            const ancestorReferredRaw =
              typeof ancestorProfileSnap.data()?.referredBy === "string"
                ? (ancestorProfileSnap.data()?.referredBy as string)
                : "";
            const ancestorReferredCode = normaliseReferralCode(
              ancestorReferredRaw,
              config.alphabet,
            );
            if (ancestorReferredCode) {
              const ancestorRegistryRef = db
                .collection(REFERRAL_CODE_REGISTRY_COLLECTION)
                .doc(ancestorReferredCode);
              const ancestorRegistrySnap = await transaction.get(ancestorRegistryRef);
              const ancestorOwner =
                ancestorRegistrySnap.exists && typeof ancestorRegistrySnap.data()?.uid === "string"
                  ? (ancestorRegistrySnap.data()?.uid as string)
                  : null;
              if (ancestorOwner === uid) {
                throw new HttpsError("failed-precondition", "circular-referral");
              }
            }
          }
        }
      }

      const inviteeSkuIds = collectRewardSkuIds(config.inviteeRewards);
      const inviterSkuIds = collectRewardSkuIds(
        config.inviterRewards.flatMap((entry) => entry.rewards ?? []),
      );

      const inviteeInventoryCtx = resolveInventoryContext(uid);
      const inviterInventoryCtx = resolveInventoryContext(inviterUid);

      const [inviteeSummarySnap, inviterSummarySnap] = await Promise.all([
        transaction.get(inviteeInventoryCtx.summaryRef),
        transaction.get(inviterInventoryCtx.summaryRef),
      ]);

      const inviteeSkuRefs = inviteeSkuIds.map((skuId) =>
        db.doc(`Players/${uid}/Inventory/${skuId}`),
      );
      const inviterSkuRefs = inviterSkuIds.map((skuId) =>
        db.doc(`Players/${inviterUid}/Inventory/${skuId}`),
      );

      const inviteeSkuSnaps = inviteeSkuRefs.length
        ? await transaction.getAll(...inviteeSkuRefs)
        : [];
      const inviterSkuSnaps = inviterSkuRefs.length
        ? await transaction.getAll(...inviterSkuRefs)
        : [];

      const inviteeSkuStates = new Map<string, TxSkuDocState>();
      inviteeSkuIds.forEach((skuId, index) => {
        inviteeSkuStates.set(
          skuId,
          createTxSkuDocState(db, uid, skuId, inviteeSkuSnaps[index]),
        );
      });

      const inviterSkuStates = new Map<string, TxSkuDocState>();
      inviterSkuIds.forEach((skuId, index) => {
        inviterSkuStates.set(
          skuId,
          createTxSkuDocState(db, inviterUid, skuId, inviterSkuSnaps[index]),
        );
      });

      const inviteeSummaryState: TxInventorySummaryState = createTxInventorySummaryState(
        inviteeInventoryCtx.summaryRef,
        inviteeSummarySnap,
      );
      const inviterSummaryState: TxInventorySummaryState = createTxInventorySummaryState(
        inviterInventoryCtx.summaryRef,
        inviterSummarySnap,
      );

      await ensureReferralCodeInTransaction({
        transaction,
        uid,
        profileRef: claimantProfileRef,
        profileSnap: claimantProfileSnap,
        config,
        timestamp,
      });

      transaction.set(
        claimantClaimRef,
        {
          status: "in-progress",
          opId,
          referralCode: normalizedCode,
          inviterUid,
          startedAt: timestamp,
          updatedAt: timestamp,
        },
        { merge: true },
      );

      const updatedInviteeStats = applyInviteeRewardCredit(
        cloneReferralStats(inviteeStats),
        Math.max(1, config.inviteeRewards.length),
      );

      transaction.set(
        claimantProfileRef,
        {
          referredBy: normalizedCode,
          referredByUid: inviterUid,
          referredAt: timestamp,
          referralStats: updatedInviteeStats,
          updatedAt: timestamp,
        },
        { merge: true },
      );

      const inviteeAwardContext: AwardInventoryContext = {
        skuStates: inviteeSkuStates,
        summaryState: inviteeSummaryState,
      };
      const inviterAwardContext: AwardInventoryContext = {
        skuStates: inviterSkuStates,
        summaryState: inviterSummaryState,
      };

      const inviteeAwards = await awardReferralRewards(
        transaction,
        uid,
        config.inviteeRewards,
        timestamp,
        inviteeAwardContext,
      );

      const progress = await incrementReferralProgress(
        transaction,
        inviterUid,
        1,
        timestamp,
        config,
        { snapshot: inviterProgressSnap },
      );

      const thresholdsReached = progress.thresholdsAwarded;
      const inviterRewardDefinitions = thresholdsReached.flatMap((threshold) => {
        const rewardEntry = config.inviterRewards.find(
          (reward) => Math.floor(reward.threshold) === threshold,
        );
        return rewardEntry ? rewardEntry.rewards : [];
      });

      const inviterAwards = await awardReferralRewards(
        transaction,
        inviterUid,
        inviterRewardDefinitions,
        timestamp,
        inviterAwardContext,
      );

      const sentIncrement = Math.max(0, progress.newTotal - inviterStats.sent);
      const inviterStatsUpdated = applyInviterRewardCredit(
        cloneReferralStats(inviterStats),
        sentIncrement,
        thresholdsReached.length,
      );

      transaction.set(
        inviterProfileRef,
        {
          referralStats: inviterStatsUpdated,
          updatedAt: timestamp,
        },
        { merge: true },
      );

      const inviteeEventsRef = db.collection(`Players/${uid}/${REFERRAL_EVENTS_SUBCOLLECTION}`);
      const inviterEventsRef = db.collection(
        `Players/${inviterUid}/${REFERRAL_EVENTS_SUBCOLLECTION}`,
      );

      transaction.set(inviteeEventsRef.doc(), {
        type: "claim",
        opId,
        referralCode: normalizedCode,
        referralUid: inviterUid,
        otherUid: inviterUid,
        createdAt: nowMillis,
      });

      transaction.set(inviteeEventsRef.doc(), {
        type: "reward-received",
        opId,
        referralCode: normalizedCode,
        referralUid: inviterUid,
        otherUid: inviterUid,
        awarded: inviteeAwards.map((reward) => ({ skuId: reward.skuId, qty: reward.qty })),
        createdAt: nowMillis,
      });

      if (thresholdsReached.length > 0) {
        transaction.set(inviterEventsRef.doc(), {
          type: "reward-sent",
          opId,
          referralCode: normaliseReferralCode(
            typeof inviterData.referralCode === "string" ? inviterData.referralCode : "",
            config.alphabet,
          ),
          referralUid: uid,
          otherUid: uid,
          awarded: inviterAwards.map((reward) => ({ skuId: reward.skuId, qty: reward.qty })),
          createdAt: nowMillis,
        });

        const inviterReceiptRef = db.doc(
          `Players/${inviterUid}/Receipts/referralReward.${opId}`,
        );
        transaction.set(
          inviterReceiptRef,
          applyReceiptMetadata(
            {
              opId: `referralReward.${opId}`,
              status: "completed",
              reason: "referralReward",
              createdAt: timestamp,
              completedAt: timestamp,
              result: {
                sourceUid: uid,
                thresholds: thresholdsReached,
                rewards: inviterAwards.map((reward) => ({
                  skuId: reward.skuId,
                  qty: reward.qty,
                  previous: reward.previous,
                  next: reward.next,
                })),
              },
            },
            {
              kind: "referral-reward",
              inputsHash: hashOperationInputs({
                referralCode: normalizedCode,
                sourceUid: uid,
                thresholds: thresholdsReached,
              }),
            },
          ),
          { merge: true },
        );
      }

      transaction.set(
        claimantClaimRef,
        {
          status: "finalized",
          opId,
          referralCode: normalizedCode,
          inviterUid,
          claimedAt: timestamp,
          updatedAt: timestamp,
        },
        { merge: true },
      );

      return {
        status: "ok",
        referredBy: normalizedCode,
        inviteeRewards: toRewardSummary(config.inviteeRewards),
        inviter: {
          uid: inviterUid,
          newSentTotal: progress.newTotal,
          thresholdsReached,
        },
      };
    },
    {
      kind: "referral-claim",
      inputsHash,
    },
  );
  } catch (error) {
    await maybeCleanupReceipt(uid, opId, error, receiptRef);
    throw error;
  }

  void publishReferralMetric({
    type: "referral-claimed",
    uid,
    referralCode: result.referredBy,
    inviterUid: result.inviter.uid,
    thresholdsReached: result.inviter.thresholdsReached,
    rewardedSkus: result.inviteeRewards,
    at: Date.now(),
  });

  return result;
});

const RECEIPT_ERROR_MESSAGES = new Set(["already-in-progress", "already-claimed"]);

async function maybeCleanupReceipt(
  uid: string,
  opId: string,
  error: unknown,
  receiptRef: admin.firestore.DocumentReference,
): Promise<void> {
  if (!(error instanceof HttpsError)) {
    return;
  }
  if (error.code !== "failed-precondition") {
    return;
  }
  if (!RECEIPT_ERROR_MESSAGES.has(error.message)) {
    return;
  }
  try {
    await receiptRef.delete();
  } catch {
    // cleanup best effort
  }
}

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
  const normalizedCode = ensureValidReferralCode(rawCode, config);
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
