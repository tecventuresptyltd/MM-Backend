import * as admin from "firebase-admin";
import { createHash } from "crypto";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { UpgradeType } from "../shared/typesV2.js";
import { updateUpgradeCompletionTime } from "../upgrades/upgradeScheduler.js";
import { AD_REWARD_VERIFICATIONS_COLLECTION, adRewardVerificationId, isAdmobSsvEnforced } from "../ads/admobSsv.js";
import { AD_WATCH_MAX_PER_24H, AD_WATCH_MAX_PER_SESSION, AdWatchEntry, AdWatchLogData } from "../race/index.js";

const db = admin.firestore();

export const AD_SPEEDUP_SECONDS = 30 * 60;

const MAX_TARGET_ID_LENGTH = 128;
const DAY_MS = 24 * 60 * 60 * 1000;

type AdSpeedupQueueType = "pitCrew" | "library" | "crateSlot";

interface SpeedupWithAdRequest {
    queueType: AdSpeedupQueueType;
    targetId: string;
    opId: string;
    sessionId?: string;
    crateId?: string;
    expectedStartedAt?: number;
}

interface SpeedupWithAdResponse {
    success: boolean;
    opId: string;
    queueType: AdSpeedupQueueType;
    targetId: string;
    secondsRemoved: number;
    newCompletesAt: number;
    isNowComplete: boolean;
    newRemainingSeconds: number;
    adLimits: {
        dailyRemaining: number;
        sessionRemaining: number;
    };
}

interface QueueSlotTarget {
    ref: admin.firestore.DocumentReference;
    slots: Array<Record<string, unknown>>;
    slotIndex: number;
}

export const speedupWithAdV2 = onCall(
    callableOptions({ minInstances: getMinInstances(false), memory: "256MiB", cpu: 1, concurrency: 80 }, true),
    async (request) => {
        const uid = request.auth?.uid;
        if (!uid) {
            throw new HttpsError("unauthenticated", "User must be authenticated.");
        }

        const { queueType, targetId, opId, sessionId, crateId, expectedStartedAt } = request.data as SpeedupWithAdRequest;
        validateRequest(queueType, targetId, opId);
        if (expectedStartedAt !== undefined && (!Number.isFinite(expectedStartedAt) || expectedStartedAt <= 0)) {
            throw new HttpsError("invalid-argument", "expectedStartedAt must be a positive timestamp.");
        }

        const clientSessionId = typeof sessionId === "string" ? sessionId : "";
        const receiptRef = db.doc(`/Players/${uid}/Receipts/${opId}`);
        const inputsHash = createHash("sha256")
            .update(JSON.stringify({ queueType, targetId, crateId: crateId ?? null, expectedStartedAt: expectedStartedAt ?? null }))
            .digest("hex");

        const outcome = await db.runTransaction(
            async (transaction) => {
                const receipt = (await transaction.get(receiptRef)).data();
                if (receipt) {
                    if (receipt.reason !== "speedupWithAdV2"
                        || (receipt.kind && receipt.kind !== "speedupWithAdV2")
                        || (receipt.inputsHash && receipt.inputsHash !== inputsHash)) {
                        throw new HttpsError("failed-precondition", "This operation ID belongs to a different request.");
                    }
                    if (receipt.status === "completed") {
                        const cached = receipt.result as SpeedupWithAdResponse | undefined;
                        if (!cached?.success || cached.queueType !== queueType || cached.targetId !== targetId) {
                            throw new HttpsError("failed-precondition", "This operation ID belongs to a different request.");
                        }
                        return { result: cached, applied: false };
                    }
                    if (receipt.status === "in_progress" || receipt.status === "reserved") {
                        throw new HttpsError("aborted", "This operation is already in progress. Please try again.");
                    }
                }

                await assertAdVerified(transaction, uid, opId);
                const now = Date.now();
                const adWatchLogRef = db.doc(`/Players/${uid}/Ads/WatchLog`);
                const adWatchLogDoc = await transaction.get(adWatchLogRef);
                const target = await readTarget(transaction, uid, queueType, targetId, crateId);

                const adLogData: AdWatchLogData = adWatchLogDoc.exists
                    ? adWatchLogDoc.data() as AdWatchLogData
                    : { watches: [], sessionId: null, sessionCount: 0, updatedAt: admin.firestore.Timestamp.now() };
                const recentWatches = filterRecentWatches(adLogData.watches ?? [], now);
                const isSameSession = clientSessionId !== "" && clientSessionId === adLogData.sessionId;

                if (recentWatches.length >= AD_WATCH_MAX_PER_24H) {
                    throw new HttpsError("resource-exhausted", "Maximum 10 ad watches per 24 hours reached. Try again later.");
                }

                if (isSameSession && (adLogData.sessionCount ?? 0) >= AD_WATCH_MAX_PER_SESSION) {
                    throw new HttpsError("resource-exhausted", "Maximum 4 ad watches per session reached. Restart the app to watch more ads.");
                }

                const slot = target.slots[target.slotIndex];
                if (expectedStartedAt !== undefined
                    && (slot.startedAt as admin.firestore.Timestamp | null)?.toMillis() !== expectedStartedAt) {
                    throw new HttpsError("failed-precondition", "This timer has changed. Refresh and try again.", { reason: "ad-target-changed" });
                }
                const currentCompletesAtMs = (slot.completesAt as admin.firestore.Timestamp | null)?.toMillis() ?? 0;
                if (currentCompletesAtMs <= now) {
                    throw new HttpsError("failed-precondition", "This timer has already completed. Claim it instead.");
                }

                const newCompletesAtMs = Math.max(now, currentCompletesAtMs - AD_SPEEDUP_SECONDS * 1000);
                const isNowComplete = newCompletesAtMs <= now;
                const updatedSlots = [...target.slots];
                updatedSlots[target.slotIndex] = {
                    ...slot,
                    completesAt: admin.firestore.Timestamp.fromMillis(newCompletesAtMs),
                };

                transaction.update(target.ref, {
                    slots: updatedSlots,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });

                const newSessionCount = isSameSession ? (adLogData.sessionCount ?? 0) + 1 : 1;
                const newWatchEntry: AdWatchEntry = {
                    timestamp: admin.firestore.Timestamp.now(),
                    type: `speedup_${queueType}`,
                    raceId: "",
                };
                const watches = [...recentWatches, newWatchEntry];

                transaction.set(adWatchLogRef, {
                    watches,
                    sessionId: clientSessionId || adLogData.sessionId || null,
                    sessionCount: newSessionCount,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });

                const result: SpeedupWithAdResponse = {
                    success: true,
                    opId,
                    queueType,
                    targetId,
                    secondsRemoved: Math.round((currentCompletesAtMs - newCompletesAtMs) / 1000),
                    newCompletesAt: newCompletesAtMs,
                    isNowComplete,
                    newRemainingSeconds: isNowComplete ? 0 : Math.ceil((newCompletesAtMs - now) / 1000),
                    adLimits: {
                        dailyRemaining: Math.max(0, AD_WATCH_MAX_PER_24H - watches.length),
                        sessionRemaining: Math.max(0, AD_WATCH_MAX_PER_SESSION - newSessionCount),
                    },
                };
                transaction.set(receiptRef, {
                    opId,
                    status: "completed",
                    reason: "speedupWithAdV2",
                    kind: "speedupWithAdV2",
                    inputsHash,
                    result,
                    completedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                return { result, applied: true };
            },
        );

        const { result } = outcome;
        if (outcome.applied && result.success && queueType !== "crateSlot") {
            const upgradeType: UpgradeType = queueType === "pitCrew" ? "carEvolution" : "spellResearch";
            try {
                await updateUpgradeCompletionTime(uid, upgradeType, targetId, result.newCompletesAt);
            } catch (error) {
                console.warn(`[speedupWithAdV2] Failed to update completion queue for ${uid}/${targetId}`, error);
            }
        }

        return result;
    },
);

function validateRequest(queueType: unknown, targetId: unknown, opId: unknown): void {
    if (queueType !== "pitCrew" && queueType !== "library" && queueType !== "crateSlot") {
        throw new HttpsError("invalid-argument", "queueType must be pitCrew, library or crateSlot.");
    }

    if (typeof targetId !== "string" || targetId.length === 0 || targetId.length > MAX_TARGET_ID_LENGTH) {
        throw new HttpsError("invalid-argument", "Valid targetId string is required.");
    }

    if (typeof opId !== "string" || opId.length === 0) {
        throw new HttpsError("invalid-argument", "Valid opId string is required.");
    }
}

async function assertAdVerified(transaction: admin.firestore.Transaction, uid: string, opId: string): Promise<void> {
    if (!isAdmobSsvEnforced()) {
        return;
    }

    const verificationId = adRewardVerificationId(uid, opId);
    const verified = verificationId !== null
        && (await transaction.get(db.doc(`/${AD_REWARD_VERIFICATIONS_COLLECTION}/${verificationId}`))).exists;
    if (!verified) {
        throw new HttpsError("failed-precondition", "Ad reward not verified yet. Please try again.");
    }
}

function filterRecentWatches(watches: AdWatchEntry[], nowMs: number): AdWatchEntry[] {
    const cutoffMs = nowMs - DAY_MS;
    return watches.filter((watch) => watchTimestampMs(watch) > cutoffMs);
}

function watchTimestampMs(watch: AdWatchEntry): number {
    if (watch.timestamp instanceof admin.firestore.Timestamp) {
        return watch.timestamp.toMillis();
    }

    const seconds = (watch.timestamp as unknown as { _seconds?: number })?._seconds;
    return typeof seconds === "number" ? seconds * 1000 : 0;
}

async function readTarget(
    transaction: admin.firestore.Transaction,
    uid: string,
    queueType: AdSpeedupQueueType,
    targetId: string,
    crateId: string | undefined,
): Promise<QueueSlotTarget> {
    if (queueType === "crateSlot") {
        return readCrateSlotTarget(transaction, uid, targetId, crateId);
    }

    const ref = db.doc(queueType === "pitCrew" ? `/Players/${uid}/Queues/PitCrew` : `/Players/${uid}/Queues/Library`);
    const doc = await transaction.get(ref);
    if (!doc.exists) {
        throw new HttpsError("not-found", `No active ${queueType} queue found.`);
    }

    const slots = (doc.data()!.slots ?? []) as Array<Record<string, unknown>>;
    const idField = queueType === "pitCrew" ? "carId" : "spellId";
    const slotIndex = slots.findIndex((slot) => slot[idField] === targetId);
    if (slotIndex === -1) {
        throw new HttpsError("not-found", `No active ${queueType} slot found for target: ${targetId}`);
    }

    return { ref, slots, slotIndex };
}

async function readCrateSlotTarget(
    transaction: admin.firestore.Transaction,
    uid: string,
    targetId: string,
    crateId: string | undefined,
): Promise<QueueSlotTarget> {
    const slotIndex = Number.parseInt(targetId, 10);
    if (!Number.isInteger(slotIndex) || slotIndex < 0) {
        throw new HttpsError("invalid-argument", `Invalid crate slot index: ${targetId}`);
    }

    const ref = db.doc(`/Players/${uid}/Crates/Slots`);
    const doc = await transaction.get(ref);
    if (!doc.exists) {
        throw new HttpsError("not-found", "No crates in slots.");
    }

    const slots = (doc.data()!.slots ?? []) as Array<Record<string, unknown>>;
    const slot = slotIndex < slots.length ? slots[slotIndex] : null;
    if (!slot) {
        throw new HttpsError("not-found", `No crate in slot ${slotIndex}.`);
    }

    if (crateId && slot.crateId !== crateId) {
        throw new HttpsError("failed-precondition", `Crate slot ${slotIndex} no longer holds crate ${crateId}. Refresh and try again.`);
    }

    if (slot.isUnlocking !== true) {
        throw new HttpsError("failed-precondition", "Crate is not unlocking.");
    }

    return { ref, slots, slotIndex };
}
