import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { REGION } from "../shared/region.js";
import { db } from "../shared/firestore.js";
import { socialProfileRef } from "./refs.js";

const PRESENCE_PATH = "presence";
const LAST_SEEN_NODE = "lastSeen";
const MAX_BATCH = 200;

interface LastSeenEntry {
  uid: string;
  lastSeen: number;
}

const parseLastSeenSnapshot = (snapshot: admin.database.DataSnapshot): LastSeenEntry[] => {
  const payload = snapshot.val();
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const entries: LastSeenEntry[] = [];
  for (const [uid, raw] of Object.entries(payload)) {
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    entries.push({ uid, lastSeen: value });
  }
  return entries
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, MAX_BATCH);
};

const shouldUpdate = (current: unknown, next: number): boolean => {
  const currentValue = typeof current === "number" ? current : Number(current);
  if (!Number.isFinite(currentValue)) {
    return true;
  }
  return next > currentValue;
};

export const presence = {
  mirrorLastSeen: onSchedule(
    {
      region: REGION,
      schedule: "every 10 minutes",
      timeZone: "Etc/UTC",
    },
    async () => {
      const rtdb = admin.database();
      const snapshot = await rtdb.ref(`${PRESENCE_PATH}/${LAST_SEEN_NODE}`).get();
      const entries = parseLastSeenSnapshot(snapshot);
      if (entries.length === 0) {
        console.log("[presence.mirrorLastSeen] No entries to mirror.");
        return;
      }

      const refs = entries.map((entry) => socialProfileRef(entry.uid));
      const docs = await db.getAll(...refs);
      const batch = db.batch();
      let updates = 0;

      docs.forEach((doc, idx) => {
        const entry = entries[idx];
        if (!entry) {
          return;
        }
        const data = doc.exists ? doc.data() ?? {} : {};
        if (!shouldUpdate(data.lastActiveAt, entry.lastSeen)) {
          return;
        }
        batch.set(
          refs[idx],
          {
            lastActiveAt: entry.lastSeen,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true },
        );
        updates += 1;
      });

      if (updates === 0) {
        console.log("[presence.mirrorLastSeen] No updates required.");
        return;
      }

      await batch.commit();
      console.log(`[presence.mirrorLastSeen] Updated ${updates} profiles.`);
    },
  ),
};
