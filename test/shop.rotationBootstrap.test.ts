import { admin } from "./setup";
import { ensureCatalogsSeeded, wipeFirestore } from "./helpers/cleanup";
import { initializeUserIfNeeded } from "../src/shared/initializeUser";
import { getCuratedOffers, getRotationConfig, resetRotationConfigCache, rotationStateRef } from "../src/shop/curatedRotation";
import rotationSeed from "../seeds/gamedata/config/ShopRotationConfig.json";

jest.setTimeout(60000);
const db = admin.firestore();
const uid = "rotation-bootstrap-player";

beforeEach(async () => {
  await wipeFirestore();
  await ensureCatalogsSeeded();
  await db.doc("GameData/v1/config/ShopRotationConfig").set({ ...rotationSeed, enabled: true, selectionMode: "manual" });
  resetRotationConfigCache();
});

afterAll(async () => {
  await db.recursiveDelete(db.doc(`Players/${uid}`));
  await db.doc("GameData/v1/config/ShopRotationConfig").set(rotationSeed);
  resetRotationConfigCache();
});

test("new-player bootstrap creates a complete curated trio and subsequent bootstrap preserves the selected range and state", async () => {
  await initializeUserIfNeeded(uid, ["anonymous"], { isGuest: true });
  const rotation = await rotationStateRef(uid).get();
  const activeRef = db.doc(`Players/${uid}/Offers/Active`);
  const initial = (await activeRef.get()).data()!;
  expect(rotation.exists).toBe(true);
  expect(initial.rotating).toHaveLength(3);
  expect(initial.rotating.map((offer: { offerId: string }) => offer.offerId)).toEqual(rotationSeed.ranges[0].sets[0].offerIds);
  expect(initial.special).toEqual([]);
  expect(initial.rotation.setId).toBe("A1");

  const configuration = await getRotationConfig();
  expect(configuration).not.toBeNull();
  await getCuratedOffers(uid, configuration!, { rangeId: "standard" });
  const stateBefore = (await rotationStateRef(uid).get()).data();
  await initializeUserIfNeeded(uid, ["anonymous"], { isGuest: true });
  expect((await rotationStateRef(uid).get()).data()).toEqual(stateBefore);
  const active = (await activeRef.get()).data()!;
  expect(active.rotation.setId).toBe("B1");
  expect(active.rotating).toHaveLength(3);
});
