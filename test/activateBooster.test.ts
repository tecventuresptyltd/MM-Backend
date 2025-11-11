import { admin } from "./setup";
import { wipeAuth, wipeFirestore, seedMinimalPlayer, ensureCatalogsSeeded } from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { activateBooster } from "../src/shop";
import { loadBoosterSkuMap } from "./helpers/catalog";

describe("activateBooster", () => {
  let uid: string;
  let coinBoosterSkuId: string;
  let expBoosterSkuId: string;
  const authFor = (userId: string) => ({
    auth: { uid: userId, token: { firebase: { sign_in_provider: "anonymous" } } },
  });

  const activate = wrapCallable(activateBooster);

  const grantBooster = async (boosterSkuId: string, quantity = 1) => {
    await admin.firestore().doc(`Players/${uid}/Inventory/${boosterSkuId}`).set(
      {
        skuId: boosterSkuId,
        quantity,
        qty: quantity,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  };

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();

    uid = `uid-${Date.now()}`;
    await seedMinimalPlayer(uid);
    await ensureCatalogsSeeded();

    const boosterMap = await loadBoosterSkuMap();
    coinBoosterSkuId = boosterMap.coin ?? "";
    expBoosterSkuId = boosterMap.exp ?? "";
    if (!coinBoosterSkuId || !expBoosterSkuId) {
      throw new Error("Missing booster SKUs in catalog.");
    }
  });

  it("activates a booster, decrements inventory, and updates timers", async () => {
    await grantBooster(coinBoosterSkuId);

    const result = await activate({
      data: { opId: "op_activate_coin", boosterId: coinBoosterSkuId },
      ...authFor(uid),
    });

    expect(result.success).toBe(true);
    expect(result.subType).toBe("coin");
    expect(result.activeUntil).toBeGreaterThan(Date.now());

    const consumablesDoc = await admin.firestore()
      .doc(`Players/${uid}/Inventory/${coinBoosterSkuId}`)
      .get();
    expect(consumablesDoc.data()?.quantity ?? consumablesDoc.data()?.qty).toBe(result.remaining);

    const profileDoc = await admin.firestore()
      .doc(`Players/${uid}/Profile/Profile`)
      .get();
    expect(profileDoc.data()?.boosters?.coin?.activeUntil).toBe(result.activeUntil);
    expect(profileDoc.data()?.boosters?.coin?.stackedCount).toBe(1);

    const receiptDoc = await admin.firestore()
      .doc(`Players/${uid}/Receipts/op_activate_coin`)
      .get();
    expect(receiptDoc.exists).toBe(true);
    expect(receiptDoc.data()?.status).toBe("completed");
  });

  it("extends the active timer when re-activating the same booster type", async () => {
    await grantBooster(coinBoosterSkuId, 2);

    const first = await activate({
      data: { opId: "op_activate_coin_first", boosterId: coinBoosterSkuId },
      ...authFor(uid),
    });
    const second = await activate({
      data: { opId: "op_activate_coin_second", boosterId: coinBoosterSkuId },
      ...authFor(uid),
    });

    expect(second.activeUntil).toBe(first.activeUntil + 86400 * 1000);

    const profileDoc = await admin.firestore()
      .doc(`Players/${uid}/Profile/Profile`)
      .get();
    expect(profileDoc.data()?.boosters?.coin?.stackedCount).toBe(2);
  });

  it("maintains independent timers for coin and xp boosters", async () => {
    await grantBooster(coinBoosterSkuId);
    await grantBooster(expBoosterSkuId);

    const coinActivation = await activate({
      data: { opId: "op_activate_coin", boosterId: coinBoosterSkuId },
      ...authFor(uid),
    });

    const xpActivation = await activate({
      data: { opId: "op_activate_xp", boosterId: expBoosterSkuId },
      ...authFor(uid),
    });

    const profileDoc = await admin.firestore()
      .doc(`Players/${uid}/Profile/Profile`)
      .get();
    expect(profileDoc.data()?.boosters?.coin?.activeUntil).toBe(coinActivation.activeUntil);
    expect(profileDoc.data()?.boosters?.exp?.activeUntil).toBe(xpActivation.activeUntil);
  });

  it("rejects activation when the inventory does not contain the booster", async () => {
    await expect(
      activate({
        data: { opId: "op_activate_missing", boosterId: coinBoosterSkuId },
        ...authFor(uid),
      }),
    ).rejects.toHaveProperty("code", "failed-precondition");
  });

  it("is idempotent across retries", async () => {
    await grantBooster(coinBoosterSkuId);

    const first = await activate({
      data: { opId: "op_activate_retry", boosterId: coinBoosterSkuId },
      ...authFor(uid),
    });
    const second = await activate({
      data: { opId: "op_activate_retry", boosterId: coinBoosterSkuId },
      ...authFor(uid),
    });

    expect(second).toEqual(first);

    const boosterDoc = await admin.firestore()
      .doc(`Players/${uid}/Inventory/${coinBoosterSkuId}`)
      .get();
    expect((boosterDoc.data()?.quantity ?? boosterDoc.data()?.qty) ?? 0).toBe(0);
  });
});
