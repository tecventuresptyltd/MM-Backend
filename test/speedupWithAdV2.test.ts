import { randomUUID } from "crypto";
import { admin } from "./setup";
import { wrapCallable } from "./helpers/callable";
import { speedupWithAdV2, AD_SPEEDUP_SECONDS } from "../src/speedups/speedupWithAdV2";
import { updateUpgradeCompletionTime } from "../src/upgrades/upgradeScheduler";
import { AD_REWARD_VERIFICATIONS_COLLECTION, adRewardVerificationId } from "../src/ads/admobSsv";

jest.setTimeout(120_000);

jest.mock("../src/upgrades/upgradeScheduler", () => ({
    updateUpgradeCompletionTime: jest.fn().mockResolvedValue(undefined),
}));

const queueTypes = ["pitCrew", "library", "crateSlot"] as const;
const wrapped = wrapCallable(speedupWithAdV2);
const db = admin.firestore();

describe.each(queueTypes)("speedupWithAdV2 %s", (queueType) => {
    let uid: string;
    let targetId: string;
    let queueRef: admin.firestore.DocumentReference;
    let receiptRef: admin.firestore.DocumentReference;
    let proofRef: admin.firestore.DocumentReference;
    let watchLogRef: admin.firestore.DocumentReference;
    let request: {
        data: {
            queueType: typeof queueType;
            targetId: string;
            opId: string;
            sessionId: string;
            crateId?: string;
            expectedStartedAt?: number;
        };
        auth: { uid: string };
    };
    let initialCompletesAt: number;
    let slot: Record<string, unknown>;
    let previousSsvSetting: string | undefined;

    beforeEach(async () => {
        previousSsvSetting = process.env.ADMOB_SSV_ENFORCED;
        process.env.ADMOB_SSV_ENFORCED = "true";
        jest.clearAllMocks();
        uid = `ad-test-${randomUUID()}`;
        targetId = queueType === "crateSlot" ? "0" : "target-a";
        const opId = "ad-speedup-test";
        const startedAt = Date.now() - 60000;
        initialCompletesAt = Date.now() + 4 * AD_SPEEDUP_SECONDS * 1000;
        queueRef = db.doc(`Players/${uid}/${queueType === "crateSlot" ? "Crates/Slots" : queueType === "pitCrew" ? "Queues/PitCrew" : "Queues/Library"}`);
        receiptRef = db.doc(`Players/${uid}/Receipts/${opId}`);
        proofRef = db.doc(`${AD_REWARD_VERIFICATIONS_COLLECTION}/${adRewardVerificationId(uid, opId)}`);
        watchLogRef = db.doc(`Players/${uid}/Ads/WatchLog`);
        slot = {
            startedAt: admin.firestore.Timestamp.fromMillis(startedAt),
            completesAt: admin.firestore.Timestamp.fromMillis(initialCompletesAt),
            ...(queueType === "crateSlot"
                ? { crateId: "crate-a", isUnlocking: true }
                : { [queueType === "pitCrew" ? "carId" : "spellId"]: targetId }),
        };
        request = {
            data: {
                queueType, targetId, opId, sessionId: "session-a", expectedStartedAt: startedAt,
                ...(queueType === "crateSlot" ? { crateId: "crate-a" } : {}),
            },
            auth: { uid },
        };
        await Promise.all([
            queueRef.set({ slots: [slot] }),
            proofRef.set({ uid, raceId: opId }),
        ]);
    });

    afterEach(async () => {
        if (previousSsvSetting === undefined) {
            delete process.env.ADMOB_SSV_ENFORCED;
        } else {
            process.env.ADMOB_SSV_ENFORCED = previousSsvSetting;
        }
        await Promise.all([
            db.recursiveDelete(db.doc(`Players/${uid}`)),
            proofRef.delete(),
        ]);
    });

    it("applies simultaneous requests with one operation ID exactly once", async () => {
        const results = await Promise.all([wrapped(request), wrapped(request), wrapped(request)]);
        expect(results[1]).toEqual(results[0]);
        expect(results[2]).toEqual(results[0]);
        expect(results[0]).toMatchObject({ success: true, secondsRemoved: AD_SPEEDUP_SECONDS });
        const updatedSlot = (await queueRef.get()).data()?.slots[0];
        expect(updatedSlot.completesAt.toMillis()).toBe(initialCompletesAt - AD_SPEEDUP_SECONDS * 1000);
        const log = (await watchLogRef.get()).data();
        expect(log?.watches).toHaveLength(1);
        expect(log?.sessionCount).toBe(1);
        expect((await receiptRef.get()).data()).toMatchObject({
            status: "completed", kind: "speedupWithAdV2", result: results[0],
        });
        expect(updateUpgradeCompletionTime).toHaveBeenCalledTimes(queueType === "crateSlot" ? 0 : 1);
    });

    it("replays success after the timer and proof have gone without scheduling it again", async () => {
        const first = await wrapped(request);
        await Promise.all([queueRef.delete(), proofRef.delete()]);
        expect(await wrapped(request)).toEqual(first);
        expect((await watchLogRef.get()).data()?.watches).toHaveLength(1);
        expect(updateUpgradeCompletionTime).toHaveBeenCalledTimes(queueType === "crateSlot" ? 0 : 1);
    });

    it("rejects reusing a successful operation for another target and preserves its receipt", async () => {
        const first = await wrapped(request);
        const originalReceipt = (await receiptRef.get()).data();
        await expect(wrapped({
            ...request,
            data: { ...request.data, targetId: "different-target" },
        })).rejects.toHaveProperty("code", "failed-precondition");
        expect((await receiptRef.get()).data()).toEqual(originalReceipt);
        expect(await wrapped(request)).toEqual(first);
    });

    it("binds the operation to its queue, crate, and timer identity", async () => {
        await wrapped(request);
        const changes = [
            { queueType: queueType === "pitCrew" ? "library" : "pitCrew" },
            { expectedStartedAt: request.data.expectedStartedAt! + 1000 },
            ...(queueType === "crateSlot" ? [{ crateId: "crate-b" }] : []),
        ];
        for (const change of changes) {
            await expect(wrapped({ ...request, data: { ...request.data, ...change } }))
                .rejects.toHaveProperty("code", "failed-precondition");
        }
        expect((await watchLogRef.get()).data()?.watches).toHaveLength(1);
    });

    it("rejects an operation ID already used by another callable", async () => {
        const otherReceipt = { status: "completed", reason: "purchaseShopSku", result: { success: true } };
        await receiptRef.set(otherReceipt);
        await expect(wrapped(request)).rejects.toHaveProperty("code", "failed-precondition");
        expect((await receiptRef.get()).data()).toEqual(otherReceipt);
        expect((await watchLogRef.get()).exists).toBe(false);
    });

    it("rejects a replaced timer without consuming the completed ad", async () => {
        await queueRef.set({
            slots: [{ ...slot, startedAt: admin.firestore.Timestamp.fromMillis(request.data.expectedStartedAt! + 1000) }],
        });
        await expect(wrapped(request)).rejects.toMatchObject({
            code: "failed-precondition", details: { reason: "ad-target-changed" },
        });
        expect((await receiptRef.get()).exists).toBe(false);
        expect((await watchLogRef.get()).exists).toBe(false);
        expect((await queueRef.get()).data()?.slots[0].completesAt.toMillis()).toBe(initialCompletesAt);
    });

    it("can claim the same operation after ad verification arrives late", async () => {
        await proofRef.delete();
        await expect(wrapped(request)).rejects.toMatchObject({
            code: "failed-precondition", message: "Ad reward not verified yet. Please try again.",
        });
        expect((await receiptRef.get()).exists).toBe(false);
        await proofRef.set({ uid, raceId: request.data.opId });
        expect(await wrapped(request)).toMatchObject({ success: true, secondsRemoved: AD_SPEEDUP_SECONDS });
        expect((await watchLogRef.get()).data()?.watches).toHaveLength(1);
    });

    it("accepts callers without the optional timer identity", async () => {
        delete request.data.expectedStartedAt;
        expect(await wrapped(request)).toMatchObject({ success: true });
    });

    it("returns old successful receipts before checking a removed queue", async () => {
        const result = await wrapped(request);
        await receiptRef.set({ opId: request.data.opId, status: "completed", reason: "speedupWithAdV2", result });
        await queueRef.delete();
        expect(await wrapped(request)).toEqual(result);
    });
});
