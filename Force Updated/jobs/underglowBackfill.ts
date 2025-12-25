import * as admin from "firebase-admin";

export type UnderglowBackfillOptions = {
  dryRun: boolean;
  batchSize: number;
  limit: number;
  verbose: boolean;
};

type Counters = {
  scanned: number;
  updatedPlayers: number;
  inventoryUpdated: number;
  loadoutsUpdated: number;
  skipped: number;
  errors: number;
};

const DEFAULT_SKU = "sku_z9tnvvdsrn";
const DEFAULT_ITEM = "item_ar2mnq593a";
const DEFAULT_CATEGORY = "cosmetic";
const DEFAULT_RARITY = "Default";
const DEFAULT_SUBTYPE = "underglow";

const normalizeQuantity = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
};

const hasValue = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const applyDelta = (map: Record<string, number>, key: string | null | undefined, delta: number) => {
  if (!key || delta === 0) return;
  const next = (map[key] ?? 0) + delta;
  if (next <= 0) {
    delete map[key];
  } else {
    map[key] = next;
  }
};

const ensureSummary = (
  data: FirebaseFirestore.DocumentData | undefined,
): { totalsByCategory: Record<string, number>; totalsByRarity: Record<string, number>; totalsBySubType: Record<string, number> } => ({
  totalsByCategory: { ...(data?.totalsByCategory ?? {}) },
  totalsByRarity: { ...(data?.totalsByRarity ?? {}) },
  totalsBySubType: { ...(data?.totalsBySubType ?? {}) },
});

const processPlayer = async (
  db: FirebaseFirestore.Firestore,
  uid: string,
  options: UnderglowBackfillOptions,
): Promise<{ inventoryUpdated: boolean; loadoutsUpdated: number }> => {
  const playerRef = db.collection("Players").doc(uid);
  const inventoryRef = playerRef.collection("Inventory").doc(DEFAULT_SKU);
  const summaryRef = playerRef.collection("Inventory").doc("_summary");
  const loadoutsRef = playerRef.collection("Loadouts");

  const timestamp = admin.firestore.FieldValue.serverTimestamp();

  if (options.dryRun) {
    const [invSnap, summarySnap, loadoutsSnap] = await Promise.all([
      inventoryRef.get(),
      summaryRef.get(),
      loadoutsRef.get(),
    ]);

    const invData = invSnap.data() ?? {};
    const qty = normalizeQuantity(invData.quantity ?? invData.qty);
    const needsInventory = qty < 1;

    let loadoutsUpdated = 0;
    loadoutsSnap.forEach((doc) => {
      const cosmetics = (doc.data()?.cosmetics ?? {}) as Record<string, unknown>;
      const hasUnderglow =
        hasValue(cosmetics.underglowSkuId) ||
        hasValue(cosmetics.underglow) ||
        hasValue(cosmetics.underglowItemId);
      if (!hasUnderglow) {
        loadoutsUpdated += 1;
        if (options.verbose) {
          console.log(`[dry-run] would set underglow on ${doc.ref.path}`);
        }
      }
    });

    if (needsInventory && options.verbose) {
      console.log(`[dry-run] would grant ${DEFAULT_SKU} to Players/${uid}/Inventory/${DEFAULT_SKU}`);
    }

    return { inventoryUpdated: needsInventory, loadoutsUpdated };
  }

  return await db.runTransaction(async (tx) => {
    const [invSnap, summarySnap, loadoutsSnap] = await Promise.all([
      tx.get(inventoryRef),
      tx.get(summaryRef),
      tx.get(loadoutsRef),
    ]);

    const invData = invSnap.data() ?? {};
    const qty = normalizeQuantity(invData.quantity ?? invData.qty);
    const needsInventory = qty < 1;

    let inventoryUpdated = false;
    if (needsInventory) {
      const payload: Record<string, unknown> = {
        skuId: DEFAULT_SKU,
        quantity: 1,
        qty: 1,
        type: DEFAULT_CATEGORY,
        updatedAt: timestamp,
      };
      if (invSnap.exists && invData.createdAt !== undefined) {
        payload.createdAt = invData.createdAt;
      } else {
        payload.createdAt = invData.createdAt ?? timestamp;
      }
      tx.set(inventoryRef, payload, { merge: true });
      inventoryUpdated = true;

      const summary = ensureSummary(summarySnap.data());
      applyDelta(summary.totalsByCategory, DEFAULT_CATEGORY, 1);
      applyDelta(summary.totalsByRarity, DEFAULT_RARITY, 1);
      applyDelta(summary.totalsBySubType, DEFAULT_SUBTYPE, 1);
      tx.set(summaryRef, summary, { merge: true });
      tx.set(summaryRef, { updatedAt: timestamp }, { merge: true });
    }

    let loadoutsUpdated = 0;
    loadoutsSnap.forEach((doc) => {
      const cosmetics = (doc.data()?.cosmetics ?? {}) as Record<string, unknown>;
      const hasUnderglow =
        hasValue(cosmetics.underglowSkuId) ||
        hasValue(cosmetics.underglow) ||
        hasValue(cosmetics.underglowItemId);
      if (hasUnderglow) {
        return;
      }
      const updatedCosmetics = {
        ...cosmetics,
        underglowSkuId: DEFAULT_SKU,
        underglowItemId: DEFAULT_ITEM,
        underglow: DEFAULT_SKU,
      };
      tx.set(
        doc.ref,
        {
          cosmetics: updatedCosmetics,
          updatedAt: timestamp,
        },
        { merge: true },
      );
      loadoutsUpdated += 1;
    });

    return { inventoryUpdated, loadoutsUpdated };
  });
};

export async function runUnderglowBackfill(
  db: FirebaseFirestore.Firestore,
  options: UnderglowBackfillOptions,
) {
  const batchSize = Math.max(1, options.batchSize || 200);
  const limit = Math.max(0, options.limit || 0);
  const counters: Counters = {
    scanned: 0,
    updatedPlayers: 0,
    inventoryUpdated: 0,
    loadoutsUpdated: 0,
    skipped: 0,
    errors: 0,
  };

  let cursor: FirebaseFirestore.DocumentSnapshot | undefined;
  let stop = false;

  while (!stop) {
    let query = db.collection("Players").orderBy(admin.firestore.FieldPath.documentId()).limit(batchSize);
    if (cursor) {
      query = query.startAfter(cursor);
    }

    const snap = await query.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      counters.scanned += 1;
      const uid = doc.id;
      try {
        const result = await processPlayer(db, uid, options);
        if (result.inventoryUpdated || result.loadoutsUpdated > 0) {
          counters.updatedPlayers += 1;
          if (result.inventoryUpdated) counters.inventoryUpdated += 1;
          counters.loadoutsUpdated += result.loadoutsUpdated;
          if (options.verbose) {
            console.log(
              `[updated] uid=${uid} inventory=${result.inventoryUpdated ? "yes" : "no"} loadouts=${result.loadoutsUpdated}`,
            );
          }
        } else {
          counters.skipped += 1;
          if (options.verbose) console.log(`[skip] uid=${uid} already has underglow`);
        }
      } catch (error) {
        counters.errors += 1;
        console.error(`[error] uid=${uid}:`, error);
      }

      if (limit > 0 && counters.updatedPlayers >= limit) {
        stop = true;
        break;
      }
    }

    cursor = snap.docs[snap.docs.length - 1];
  }

  console.log(
    `[underglow-backfill] scanned=${counters.scanned}, updatedPlayers=${counters.updatedPlayers}, inventoryUpdated=${counters.inventoryUpdated}, loadoutsUpdated=${counters.loadoutsUpdated}, skipped=${counters.skipped}, errors=${counters.errors}, dryRun=${options.dryRun}`,
  );
}
