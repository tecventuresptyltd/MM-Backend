import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { REGION } from "../shared/region.js";

const PRESENCE_ONLINE_ROOT = "presence/online";
const STALE_AFTER_MS = 30 * 60 * 1000;

type PresenceRecord = {
  lastSeen?: unknown;
  connections?: Record<string, { lastSeen?: unknown } | null> | null;
};

const toMillis = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const newestLastSeen = (record: PresenceRecord | null): number => {
  if (!record || typeof record !== "object") return 0;

  let newest = toMillis(record.lastSeen);
  if (record.connections && typeof record.connections === "object") {
    for (const connection of Object.values(record.connections)) {
      newest = Math.max(newest, toMillis(connection?.lastSeen));
    }
  }
  return newest;
};

export const presenceReaper = onSchedule(
  {
    region: REGION,
    schedule: "every 5 minutes",
    timeZone: "Etc/UTC",
    timeoutSeconds: 120,
    memory: "256MiB",
  },
  async () => {
    const rootRef = admin.database().ref(PRESENCE_ONLINE_ROOT);
    const snapshot = await rootRef.get();
    if (!snapshot.exists()) return;

    const records = (snapshot.val() ?? {}) as Record<string, PresenceRecord | null>;
    const cutoff = Date.now() - STALE_AFTER_MS;
    const updates: Record<string, null> = {};

    for (const [uid, record] of Object.entries(records)) {
      if (newestLastSeen(record) < cutoff) {
        updates[uid] = null;
      }
    }

    const removed = Object.keys(updates).length;
    if (removed === 0) return;

    await rootRef.update(updates);
    logger.info("[PresenceReaper] Removed stale presence entries", { removed });
  }
);
