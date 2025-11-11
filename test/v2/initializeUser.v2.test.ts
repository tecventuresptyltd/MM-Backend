import { admin } from "../setup";
import { initializeUserIfNeeded } from "../../src/shared/initializeUser";
import { __resetCachedFlagsForTests } from "../../src/core/flags";
import {
  wipeFirestore,
  wipeAuth,
  ensureCatalogsSeeded,
} from "../helpers/cleanup.js";
import { loadStarterRewards } from "../../src/shared/starterRewards";

describe("initializeUserIfNeeded (itemId mode)", () => {
  const originalFlag = process.env.USE_ITEMID_V2;
  const originalUnifiedFlag = process.env.USE_UNIFIED_SKUS;
  let uid: string;
  let starterRewards: Awaited<ReturnType<typeof loadStarterRewards>>;

  beforeAll(() => {
    process.env.USE_UNIFIED_SKUS = "false";
    process.env.USE_ITEMID_V2 = "true";
    __resetCachedFlagsForTests();
  });

  afterAll(() => {
    if (originalUnifiedFlag === undefined) {
      delete process.env.USE_UNIFIED_SKUS;
    } else {
      process.env.USE_UNIFIED_SKUS = originalUnifiedFlag;
    }
    if (originalFlag === undefined) {
      delete process.env.USE_ITEMID_V2;
    } else {
      process.env.USE_ITEMID_V2 = originalFlag;
    }
    __resetCachedFlagsForTests();
  });

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    await ensureCatalogsSeeded();

    uid = `v2-${Date.now()}`;
    starterRewards = await loadStarterRewards();
    await admin.auth().createUser({ uid });
  });

  it("creates consolidated inventory documents with starter rewards", async () => {
    await initializeUserIfNeeded(uid, [], { isGuest: false, email: "v2@example.com" });

    const db = admin.firestore();
    const itemsDoc = await db.doc(`Players/${uid}/Inventory/Items`).get();
    expect(itemsDoc.exists).toBe(true);
    const counts = (itemsDoc.data()?.counts ?? {}) as Record<string, unknown>;
    const crateCount =
      counts[starterRewards.crateItemId] ?? counts[starterRewards.crateSkuId];
    const keyCount =
      counts[starterRewards.keyItemId] ?? counts[starterRewards.keySkuId];
    expect(Number(crateCount ?? 0)).toEqual(1);
    expect(Number(keyCount ?? 0)).toEqual(1);

    const summaryDoc = await db.doc(`Players/${uid}/Inventory/_summary`).get();
    expect(summaryDoc.exists).toBe(true);
    const totalsByCategory = summaryDoc.data()?.totalsByCategory ?? {};
    expect(Number(totalsByCategory.crate ?? 0)).toEqual(1);
    expect(Number(totalsByCategory.key ?? 0)).toEqual(1);

    const legacyConsumables = await db.doc(`Players/${uid}/Inventory/Consumables`).get();
    expect(legacyConsumables.exists).toBe(false);

    const receiptDoc = await db
      .doc(`Players/${uid}/Receipts/initializeUser.starterRewards`)
      .get();
    expect(receiptDoc.exists).toBe(true);
    expect(receiptDoc.data()?.status).toBe("completed");
  });
});
