import { wrapCallable } from "../helpers/callable";
import { admin } from "../setup";
import { ensureCatalogsSeeded, wipeFirestore, seedMinimalPlayer } from "../helpers/cleanup";
import { recordRaceResult } from "../../src/race";

const authContext = (uid: string) => ({
  auth: {
    uid,
    token: { firebase: { sign_in_provider: "password" } },
  },
});

describe("Offers stacking integration", () => {
  const db = admin.firestore();

  beforeAll(async () => {
    await ensureCatalogsSeeded();
  });

  beforeEach(async () => {
    await wipeFirestore();
    await ensureCatalogsSeeded();
  });

  it("stacks level-up and missing-key flash specials after a perfect storm race win", async () => {
    const uid = `offers-stack-${Date.now()}`;
    await seedMinimalPlayer(uid);

    const playerProfileRef = db.doc(`Players/${uid}/Profile/Profile`);
    await playerProfileRef.set(
      {
        level: 4,
        exp: 400,
        expProgress: 0.99,
        expToNextLevel: 1,
        trophies: 1000,
        highestTrophies: 1000,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    await db.doc(`Players/${uid}/Offers/Active`).set(
      {
        daily: {
          offerId: "offer_bwebp6s4",
          tier: 1,
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
          isPurchased: false,
          generatedAt: Date.now(),
        },
        special: [],
        updatedAt: Date.now(),
      },
      { merge: true },
    );

    await db.doc(`Players/${uid}/Inventory/sku_kgkjadrd79`).set(
      {
        skuId: "sku_kgkjadrd79",
        quantity: 1,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    const raceCallable = wrapCallable(recordRaceResult);
    const raceResult = await raceCallable({
      data: {
        raceId: `race-${Date.now()}`,
        finishOrder: [uid],
        botNames: [],
      },
      ...authContext(uid),
    });

    expect(raceResult.success).toBe(true);

    const offersDoc = await db.doc(`Players/${uid}/Offers/Active`).get();
    expect(offersDoc.exists).toBe(true);
    const offersData = offersDoc.data()!;

    expect(offersData.daily).toBeDefined();
    expect(offersData.daily.offerId).toBe("offer_bwebp6s4");
    expect(offersData.special).toBeDefined();
    expect(Array.isArray(offersData.special)).toBe(true);
    expect(offersData.special.length).toBe(2);

    const specialOfferIds = offersData.special.map((offer: { offerId: string }) => offer.offerId);
    expect(specialOfferIds).toContain("offer_3vv3me0e");
    expect(specialOfferIds).toContain("offer_zqcpwsbz");
  });
});
