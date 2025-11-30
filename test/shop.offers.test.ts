import { wrapCallable } from "./helpers/callable";
import { admin } from "./setup";
import { wipeFirestore, ensureCatalogsSeeded, seedMinimalPlayer } from "./helpers/cleanup";
import { getDailyOffers } from "../src/shop/offers";

const authContext = (uid: string) => ({
  auth: {
    uid,
    token: { firebase: { sign_in_provider: "password" } },
  },
});

describe("shop/getDailyOffers", () => {
  const db = admin.firestore();

  beforeEach(async () => {
    await wipeFirestore();
    await ensureCatalogsSeeded();
  });

  it("initializes starter and tier 0 daily offer", async () => {
    const uid = `daily-init-${Date.now()}`;
    await seedMinimalPlayer(uid);
    const callable = wrapCallable(getDailyOffers);

    const result = await callable({
      data: {},
      ...authContext(uid),
    });

    expect(result.starter?.offerId).toBe("offer_3jaky2p2");
    expect(result.daily).toBeDefined();
    expect(result.daily.tier).toBe(0);
    expect(typeof result.daily.expiresAt).toBe("number");
    expect(result.daily.generatedAt).toBeGreaterThan(0);
  });

  it("steps up the ladder when the previous offer was purchased", async () => {
    const uid = `daily-step-${Date.now()}`;
    await seedMinimalPlayer(uid);
    const callable = wrapCallable(getDailyOffers);

    const initial = await callable({
      data: {},
      ...authContext(uid),
    });

    const offersRef = db.doc(`Players/${uid}/Offers/Active`);
    await offersRef.set(
      {
        daily: {
          ...initial.daily,
          isPurchased: true,
          expiresAt: Date.now() - 1000,
        },
      },
      { merge: true },
    );

    const next = await callable({
      data: {},
      ...authContext(uid),
    });

    expect(next.daily.tier).toBe(1);
    expect(next.daily.offerId).toBeDefined();
    // Tier 1 (gold surge) should map to offerType 5 / offer_bwebp6s4
    expect(next.daily.offerId).toBe("offer_bwebp6s4");
    expect(next.daily.isPurchased).toBe(false);
  });
});
