import * as admin from "firebase-admin";
import { createHash } from "node:crypto";
import { onDocumentWritten } from "firebase-functions/v2/firestore";

export interface LedgerEntry { kind: string; currency?: string; delta?: number; status?: string; target?: string; level?: number; }
export const ledgerId = (value: string) => createHash("sha256").update(value).digest("hex");

export function economyEntries(before: Record<string, unknown>, after: Record<string, unknown>): LedgerEntry[] {
    return ["coins", "gems", "spellTokens", "spellShards"].flatMap(currency => {
        const prior = Number(before[currency] ?? 0), next = Number(after[currency] ?? 0);
        return Number.isFinite(prior) && Number.isFinite(next) && prior !== next ? [{ kind: "server_currency_change", currency, delta: next - prior }] : [];
    });
}

export const ledgerCommitKey = (uid: string, stamp: { seconds: number; nanoseconds: number } | string) => ledgerId(uid + ":" + (typeof stamp === "string" ? stamp : stamp.seconds + ":" + stamp.nanoseconds));

export async function persistLedgerEvent(eventId: string, uid: string, timestamp: string, entries: LedgerEntry[], commitTime?: admin.firestore.Timestamp): Promise<void> {
    if (!entries.length) return;
    const db = admin.firestore();
    const eventRef = db.collection("AnalyticsLedger").doc(ledgerId(eventId));
    const day = timestamp.slice(0, 10);
    await db.runTransaction(async transaction => {
        if ((await transaction.get(eventRef)).exists) return;
        transaction.create(eventRef, { actor: ledgerId(uid), commitKey: ledgerCommitKey(uid, commitTime ?? timestamp), occurredAt: admin.firestore.Timestamp.fromDate(new Date(timestamp)), entries, source: "server", externalDelivery: "client_relay_on_next_login", relayAcknowledged: false });
        const totals = new Map<string, { kind: string; currency: string; status: string; target: string; count: number; earned: number; spent: number }>();
        for (const entry of entries) {
            const key = [entry.kind, entry.currency || "none", entry.status || "none"].join("_") + (entry.target ? "_" + entry.target : "");
            const total = totals.get(key) ?? { kind: entry.kind, currency: entry.currency || "none", status: entry.status || "none", target: entry.target || "none", count: 0, earned: 0, spent: 0 };
            total.count++;
            total.earned += Math.max(0, entry.delta || 0);
            total.spent += Math.max(0, -(entry.delta || 0));
            totals.set(key, total);
        }
        for (const [key, total] of totals) {
            transaction.set(db.collection("AnalyticsDaily").doc(day + "_" + ledgerId(key)), {
                day, kind: total.kind, currency: total.currency, status: total.status, target: total.target,
                count: admin.firestore.FieldValue.increment(total.count),
                earned: admin.firestore.FieldValue.increment(total.earned),
                spent: admin.firestore.FieldValue.increment(total.spent),
            }, { merge: true });
        }
    });
}

export const recordAnalyticsEconomy = onDocumentWritten({ document: "Players/{uid}/Economy/Stats", retry: true }, async event => {
    if (!event.data?.after.exists) return;
    await persistLedgerEvent(event.id, event.params.uid, event.time, economyEntries(event.data.before.data() ?? {}, event.data.after.data() ?? {}), event.data.after.updateTime);
});

export const recordAnalyticsReceipt = onDocumentWritten({ document: "Players/{uid}/Receipts/{opId}", retry: true }, async event => {
    const after = event.data?.after.data(), before = event.data?.before.data();
    if (!after || after.status === before?.status || !["completed", "failed"].includes(after.status)) return;
    await persistLedgerEvent(event.id, event.params.uid, event.time, [{ kind: "server_operation_result", status: after.status, target: String(after.reason || "unknown").slice(0, 80) }], event.data!.after.updateTime);
});

export function progressionEntries(before: Record<string, any>, after: Record<string, any>, field: "cars" | "spells"): LedgerEntry[] {
    return Object.entries(after[field] ?? {}).flatMap(([id, raw]) => {
        const value = raw as Record<string, unknown>;
        const prior = before[field]?.[id];
        const level = Number(field === "cars" ? value.starLevel ?? value.carLevel ?? 0 : value.level ?? 0);
        const previousLevel = Number(field === "cars" ? prior?.starLevel ?? prior?.carLevel ?? 0 : prior?.level ?? 0);
        return level > previousLevel ? [{ kind: field === "cars" ? "server_car_progression" : "server_spell_progression", target: id, level }] : [];
    });
}

export const recordAnalyticsGarage = onDocumentWritten({ document: "Players/{uid}/Garage/Cars", retry: true }, async event => {
    if (!event.data?.after.exists) return;
    await persistLedgerEvent(event.id, event.params.uid, event.time, progressionEntries(event.data.before.data() ?? {}, event.data.after.data() ?? {}, "cars"), event.data.after.updateTime);
});

export const recordAnalyticsSpells = onDocumentWritten({ document: "Players/{uid}/Spells/Levels", retry: true }, async event => {
    if (!event.data?.after.exists) return;
    await persistLedgerEvent(event.id, event.params.uid, event.time, progressionEntries(event.data.before.data() ?? {}, event.data.after.data() ?? {}, "spells"), event.data.after.updateTime);
});

export const recordAnalyticsIap = onDocumentWritten({ document: "IapTransactions/{transactionId}", retry: true }, async event => {
    const after = event.data?.after.data();
    if (!after?.uid || after.grantApplied === false || event.data?.before.exists) return;
    await persistLedgerEvent(event.id, after.uid, event.time, [{ kind: "server_iap_granted", target: String(after.productId || "unknown"), status: after.verified ? "verified" : "unverified" }], event.data!.after.updateTime);
});

export const recordAnalyticsRace = onDocumentWritten({ document: "Races/{raceId}/Participants/{uid}", retry: true }, async event => {
    const after = event.data?.after.data(), before = event.data?.before.data();
    if (!after?.cachedResult || before?.cachedResult) return;
    await persistLedgerEvent(event.id, event.params.uid, event.time, [{ kind: "server_race_settled", status: "completed", target: String(after.cachedResult.gamemode || "unknown") }], event.data!.after.updateTime);
});
