import * as admin from "firebase-admin";
import { getLevelInfo } from "../../src/shared/xp.js";

export type XpBackfillOptions = {
  dryRun: boolean;
  batchSize: number;
  limit: number;
  verbose: boolean;
  fixLevels: boolean;
};

type Counters = {
  scanned: number;
  updated: number;
  skipped: number;
  errors: number;
};

const DEFAULT_BATCH = 200;

export async function runXpBackfill(db: FirebaseFirestore.Firestore, options: XpBackfillOptions) {
  const batchSize = Math.max(1, options.batchSize || DEFAULT_BATCH);
  const limit = Math.max(0, options.limit || 0);
  const counters: Counters = { scanned: 0, updated: 0, skipped: 0, errors: 0 };

  const writer = options.dryRun
    ? null
    : db.bulkWriter({
        throttling: { maxOpsPerSecond: 500 },
      });

  let cursor: FirebaseFirestore.DocumentSnapshot | undefined;

  try {
    while (true) {
      let query = db.collectionGroup("Profile").orderBy("__name__").limit(batchSize);
      if (cursor) {
        query = query.startAfter(cursor);
      }
      const snap = await query.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        if (doc.id !== "Profile") {
          counters.skipped += 1;
          continue;
        }

        counters.scanned += 1;
        const data = doc.data() ?? {};
        const exp = Number(data.exp ?? 0);
        const info = getLevelInfo(exp);
        const expToNextLevel = info.expInLevel + info.expToNext;
        const progressDisplay = `${info.expInLevel} / ${expToNextLevel}`;

        const updates: Record<string, unknown> = {};
        if (data.expProgress !== info.expInLevel) updates.expProgress = info.expInLevel;
        if (data.expToNextLevel !== expToNextLevel) updates.expToNextLevel = expToNextLevel;
        if (data.expProgressDisplay !== progressDisplay) updates.expProgressDisplay = progressDisplay;
        if (options.fixLevels && data.level !== info.level) updates.level = info.level;

        if (Object.keys(updates).length === 0) {
          if (options.verbose) console.log(`[skip] ${doc.ref.path} already consistent`);
          counters.skipped += 1;
        } else if (options.dryRun) {
          console.log(`[dry-run] ${doc.ref.path}`, updates);
          counters.updated += 1;
        } else {
          updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
          writer!.set(doc.ref, updates, { merge: true });
          counters.updated += 1;
        }

        if (limit > 0 && counters.updated >= limit) {
          console.log(`Limit reached (${limit}); stopping early.`);
          cursor = undefined;
          break;
        }
      }

      if (snap.docs.length > 0) {
        cursor = snap.docs[snap.docs.length - 1];
      }

      if (!cursor) break;
    }
  } catch (error) {
    counters.errors += 1;
    console.error("[xp-backfill] failed:", error);
    throw error;
  } finally {
    if (writer) await writer.close();
    console.log(
      `[xp-backfill] scanned=${counters.scanned}, updated=${counters.updated}, skipped=${counters.skipped}, errors=${counters.errors}, dryRun=${options.dryRun}`,
    );
  }
}
