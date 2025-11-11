import { admin } from "./setup";
import { wipeFirestore } from "./helpers/cleanup";
import { seedTestPlayer } from "../seeds/seedTestPlayer";

const TEST_UID = "test_user_001";

describe("Test player seeding", () => {
  beforeEach(async () => {
    await wipeFirestore();
  });

  it("creates canonical singleton documents for the test player", async () => {
    await seedTestPlayer(TEST_UID);

    const db = admin.firestore();

    const profileSnap = await db.doc(`Players/${TEST_UID}/Profile/Profile`).get();
    expect(profileSnap.exists).toBe(true);
    const profileData = profileSnap.data();
    expect(profileData).toMatchObject({
      displayName: expect.any(String),
      avatarId: expect.any(Number),
      exp: expect.any(Number),
      level: expect.any(Number),
      trophies: expect.any(Number),
      highestTrophies: expect.any(Number),
    });

    const economySnap = await db.doc(`Players/${TEST_UID}/Economy/Stats`).get();
    expect(economySnap.exists).toBe(true);
    const economyData = economySnap.data();
    expect(economyData).toMatchObject({ coins: expect.any(Number), gems: expect.any(Number) });
    expect(economyData).not.toHaveProperty("level");
    expect(economyData).not.toHaveProperty("trophies");

    const loadoutSnap = await db.doc(`Players/${TEST_UID}/Loadouts/Active`).get();
    expect(loadoutSnap.exists).toBe(true);
    const spellsSnap = await db.doc(`Players/${TEST_UID}/Spells/Levels`).get();
    expect(spellsSnap.exists).toBe(true);

    const crateDoc = await db.doc(`Players/${TEST_UID}/Inventory/sku_2xw1r4bah7`).get();
    expect(crateDoc.exists).toBe(true);
    expect(crateDoc.data()).toMatchObject({ qty: expect.any(Number), quantity: expect.any(Number) });

    const keyDoc = await db.doc(`Players/${TEST_UID}/Inventory/sku_rjwe5tdtc4`).get();
    expect(keyDoc.exists).toBe(true);
    expect(keyDoc.data()).toMatchObject({ qty: expect.any(Number), quantity: expect.any(Number) });
  });
});
