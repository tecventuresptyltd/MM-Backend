import { admin } from "./setup";
import { wipeFirestore } from "./helpers/cleanup";
import { seedGameDataCatalogs } from "../seeds/seedGameData";

describe("GameData catalog seeding", () => {
  beforeEach(async () => {
    await wipeFirestore();
  });

  it("writes singleton catalog documents with expected structure", async () => {
    await seedGameDataCatalogs();

    const db = admin.firestore();
    const requiredCatalogIds = [
      "CarsCatalog",
      "SpellsCatalog",
      "ItemsCatalog",
      "ItemSkusCatalog",
      "CratesCatalog",
      "OffersCatalog",
      "RanksCatalog",
    ] as const;

    for (const catalogId of requiredCatalogIds) {
      const snap = await db.doc(`GameData/v1/catalogs/${catalogId}`).get();
      expect(snap.exists).toBe(true);
      const data = snap.data();
      expect(data).toBeDefined();
      expect(typeof data?.updatedAt).toBe("number");
    }

    const xpSnap = await db.doc("GameData/v1/catalogs/XpCurve").get();
    if (xpSnap.exists) {
      const xpData = xpSnap.data();
      expect(xpData).toBeDefined();
      expect(typeof xpData?.updatedAt).toBe("number");
    }

    const subcollections = await db.collection("GameData").doc("v1").listCollections();
    const subcollectionIds = subcollections.map((col) => col.id).sort();
    expect(subcollectionIds).toEqual(["catalogs", "config"]);

    const carsDoc = await db.doc("GameData/v1/catalogs/CarsCatalog").get();
    expect(carsDoc.data()?.cars).toBeDefined();
    expect(typeof carsDoc.data()?.cars).toBe("object");
  });
});
