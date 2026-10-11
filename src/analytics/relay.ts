import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { ledgerId, LedgerEntry } from "./ledger.js";

export function relayEvents(receiptId: string, occurredAt: number, entries: LedgerEntry[], commitKey?: string) {
    return entries.map((entry, index) => {
        const parameters: Record<string, string | number> = { source: "server_ledger", occurred_at_ms: occurredAt };
        if (commitKey) parameters.commit_key = commitKey;
        if (entry.currency) parameters.currency = entry.currency;
        if (entry.delta !== undefined) { parameters.amount = Math.abs(entry.delta); parameters.direction = entry.delta >= 0 ? "earned" : "spent"; }
        if (entry.status) parameters.status = entry.status;
        if (entry.target) parameters.target = entry.target;
        if (entry.level !== undefined) parameters.level = entry.level;
        return { eventId: receiptId + ":" + index, name: entry.kind, parameters };
    });
}

export async function syncLedger(uid: string, ackIds: unknown) {
    if (!Array.isArray(ackIds) || ackIds.length > 50 || ackIds.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))) throw new HttpsError("invalid-argument", "ackIds must contain at most 50 receipt IDs");
    const db = admin.firestore(), actor = ledgerId(uid);
    if (ackIds.length) await db.runTransaction(async transaction => {
        const docs = await transaction.getAll(...[...new Set(ackIds)].map(id => db.collection("AnalyticsLedger").doc(id)));
        for (const doc of docs) {
            if (!doc.exists) continue;
            if (doc.get("actor") !== actor) throw new HttpsError("permission-denied", "Receipt does not belong to this player");
        }
        for (const doc of docs) if (doc.exists) transaction.update(doc.ref, { relayAcknowledged: true, relayAcknowledgedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    const snapshot = await db.collection("AnalyticsLedger").where("actor", "==", actor).where("relayAcknowledged", "==", false).limit(50).get();
    return { receipts: snapshot.docs.map(doc => ({ receiptId: doc.id, events: relayEvents(doc.id, doc.get("occurredAt").toMillis(), doc.get("entries"), doc.get("commitKey")) })) };
}

export const syncAnalyticsLedger = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async request => {
    if (!request.auth?.uid) throw new HttpsError("unauthenticated", "Authentication required");
    return syncLedger(request.auth.uid, request.data?.ackIds ?? []);
});
