import * as admin from "firebase-admin";
import { economyEntries, ledgerId, ledgerCommitKey, persistLedgerEvent, progressionEntries } from "../src/analytics/ledger";
import { syncLedger } from "../src/analytics/relay";
import { insightQuery, mapPreferenceRows } from "../src/analytics/insights";

describe("authoritative analytics ledger", () => {
    const uid = "analytics-ledger-owner", eventId = "analytics-ledger-idempotency-test";
    const day = "2099-01-01";
    const dailyId = day + "_" + ledgerId("server_currency_change_coins_none");
    beforeEach(async () => {
        await admin.firestore().collection("AnalyticsLedger").doc(ledgerId(eventId)).delete();
        await admin.firestore().collection("AnalyticsDaily").doc(dailyId).delete();
    });
    afterAll(async () => {
        await admin.firestore().collection("AnalyticsLedger").doc(ledgerId(eventId)).delete();
        await admin.firestore().collection("AnalyticsDaily").doc(dailyId).delete();
    });
    test("concurrent redelivery records one authoritative delta and one aggregate", async () => {
        const entries = economyEntries({ coins: 100 }, { coins: 125 });
        await Promise.all(Array.from({ length: 4 }, () => persistLedgerEvent(eventId, uid, day + "T10:00:00Z", entries)));
        const snapshot = await admin.firestore().collection("AnalyticsDaily").doc(dailyId).get();
        expect(snapshot.get("count")).toBe(1);
        expect(snapshot.get("earned")).toBe(25);
        expect(snapshot.get("spent")).toBe(0);
    });
    test("analytics persistence failure leaves the committed player balance unchanged", async () => {
        const db = admin.firestore();
        const economy = db.doc(`Players/${uid}/Economy/Stats`);
        const original = await economy.get();
        await economy.set({ coins: 125 });
        const transaction = jest.spyOn(db, "runTransaction").mockRejectedValueOnce(new Error("analytics unavailable"));
        try {
            await expect(persistLedgerEvent(eventId, uid, day + "T10:00:00Z", economyEntries({ coins: 100 }, { coins: 125 })))
                .rejects.toThrow("analytics unavailable");
            expect((await economy.get()).get("coins")).toBe(125);
            expect((await db.collection("AnalyticsLedger").doc(ledgerId(eventId)).get()).exists).toBe(false);
            // The trigger retry can catch up without touching player state.
            await persistLedgerEvent(eventId, uid, day + "T10:00:00Z", economyEntries({ coins: 100 }, { coins: 125 }));
            expect((await economy.get()).get("coins")).toBe(125);
            expect((await db.collection("AnalyticsDaily").doc(dailyId).get()).get("earned")).toBe(25);
        } finally {
            transaction.mockRestore();
            if (original.exists) await economy.set(original.data()!); else await economy.delete();
        }
    });
    test("private drain is repeatable until ack and rejects cross-player acknowledgement", async () => {
        await persistLedgerEvent(eventId, uid, day + "T10:00:00Z", [{ kind: "server_currency_change", currency: "coins", delta: -10 }]);
        const first = await syncLedger(uid, []);
        expect(first.receipts).toHaveLength(1);
        expect(await syncLedger(uid, [])).toEqual(first);
        expect(first.receipts[0].events[0]).toMatchObject({ name: "server_currency_change", parameters: { amount: 10, direction: "spent", source: "server_ledger" } });
        expect((await syncLedger("analytics-ledger-other", [])).receipts).toHaveLength(0);
        await expect(syncLedger("analytics-ledger-other", [first.receipts[0].receiptId])).rejects.toMatchObject({ code: "permission-denied" });
        expect((await syncLedger(uid, [first.receipts[0].receiptId])).receipts).toHaveLength(0);
        expect((await syncLedger(uid, [first.receipts[0].receiptId])).receipts).toHaveLength(0);
    });
    test("commit correlations use the exact player and snapshot commit timestamp", () => {
        const stamp = { seconds: 1000, nanoseconds: 123456789 };
        expect(ledgerCommitKey(uid, stamp)).toBe(ledgerCommitKey(uid, { ...stamp }));
        expect(ledgerCommitKey(uid, stamp)).not.toBe(ledgerCommitKey("other", stamp));
        expect(ledgerCommitKey(uid, stamp)).not.toBe(ledgerCommitKey(uid, { ...stamp, nanoseconds: 123456790 }));
    });
    test("all currency changes and background progression are represented without snapshot double counting", () => {
        expect(economyEntries({ coins: 100, gems: 20 }, { coins: 80, gems: 30 })).toEqual([{ kind: "server_currency_change", currency: "coins", delta: -20 }, { kind: "server_currency_change", currency: "gems", delta: 10 }]);
        expect(economyEntries({ coins: 100 }, { coins: 100 })).toEqual([]);
        expect(progressionEntries({ cars: { c1: { starLevel: 1 } } }, { cars: { c1: { starLevel: 2 } } }, "cars")).toEqual([{ kind: "server_car_progression", target: "c1", level: 2 }]);
    });
    test("preference measures final votes per exposure, excluding changes and abstention", () => {
        const row = (eventName: string, eventCount: number, reason = "") => ({ eventName, eventCount, "customEvent:map_id": "map1", "customEvent:mode": "race", "customEvent:reason": reason });
        const result = mapPreferenceRows([row("map_choice_exposed", 10), row("map_vote_changed", 20), row("map_choice_outcome", 3, "chosen_map_assigned"), row("map_choice_outcome", 2, "abstained"), row("map_assigned", 6)]);
        expect(result[0]).toMatchObject({ exposures: 10, finalVotes: 3, assignments: 6, finalVotesPerExposurePercent: 30 });
        expect(insightQuery("properties/test", "ads", 7, "Android").metrics?.map(metric => metric.name)).toEqual(["totalAdRevenue", "publisherAdClicks", "publisherAdImpressions"]);
    });
});
