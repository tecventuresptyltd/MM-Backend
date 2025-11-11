// functions/test/initializeUser.test.ts
import * as admin from "firebase-admin";
import { initializeUserIfNeeded } from "../src/shared/initializeUser";
import {
  wipeFirestore,
  wipeAuth,
  ensureCatalogsSeeded,
} from "./helpers/cleanup";
import { loadStarterRewards } from "../src/shared/starterRewards";
import { loadStarterSpellIds } from "../src/shared/catalogHelpers";

describe("initializeUserIfNeeded", () => {
  let uid: string;
  let starterRewards: Awaited<ReturnType<typeof loadStarterRewards>>;
  let starterSpellIds: string[];

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    await ensureCatalogsSeeded();

    uid = `test-uid-${Date.now()}`;
    starterRewards = await loadStarterRewards();
    starterSpellIds = await loadStarterSpellIds();

    await admin.auth().createUser({ uid });
  });

  it("creates all required documents for a new user", async () => {
    await initializeUserIfNeeded(uid, [], { isGuest: false, email: "test@example.com" });

    const db = admin.firestore();

    const playerDoc = await db.doc(`Players/${uid}`).get();
    expect(playerDoc.exists).toBe(true);
    expect(playerDoc.data()?.uid).toEqual(uid);
    expect(playerDoc.data()?.email).toEqual("test@example.com");

    const profileDoc = await db.doc(`Players/${uid}/Profile/Profile`).get();
    expect(profileDoc.exists).toBe(true);
    expect(profileDoc.data()?.displayName).toEqual("New Racer");
    expect(profileDoc.data()?.level).toEqual(1);
    expect(profileDoc.data()?.trophies).toEqual(0);

    const economyDoc = await db.doc(`Players/${uid}/Economy/Stats`).get();
    expect(economyDoc.exists).toBe(true);
    expect(economyDoc.data()?.coins).toEqual(1000);
    expect(economyDoc.data()?.trophies).toBeUndefined();
    expect(economyDoc.data()?.level).toBeUndefined();

    const garageDoc = await db.doc(`Players/${uid}/Garage/Cars`).get();
    expect(garageDoc.exists).toBe(true);
    expect(garageDoc.data()?.cars?.car_h4ayzwf31g?.upgradeLevel).toEqual(0);

    const loadoutDoc = await db.doc(`Players/${uid}/Loadouts/Active`).get();
    expect(loadoutDoc.exists).toBe(true);
    expect(loadoutDoc.data()?.carId).toEqual("car_h4ayzwf31g");
    expect(loadoutDoc.data()?.activeSpellDeck).toEqual(1);

    const spellDeckDoc = await db.doc(`Players/${uid}/SpellDecks/Decks`).get();
    expect(spellDeckDoc.exists).toBe(true);
    expect(spellDeckDoc.data()?.decks?.["1"]?.spells?.[0]).toEqual(starterSpellIds[0]);

    const spellsDoc = await db.doc(`Players/${uid}/Spells/Levels`).get();
    expect(spellsDoc.exists).toBe(true);
    expect(spellsDoc.data()?.levels?.[starterSpellIds[0]]).toEqual(1);

    const dailyDoc = await db.doc(`Players/${uid}/Daily/Status`).get();
    expect(dailyDoc.exists).toBe(true);

    const progressDoc = await db.doc(`Players/${uid}/Progress/Initial`).get();
    expect(progressDoc.exists).toBe(true);

    const socialDoc = await db.doc(`Players/${uid}/Social/Profile`).get();
    expect(socialDoc.exists).toBe(true);

    const crateDoc = await db
      .doc(`Players/${uid}/Inventory/${starterRewards.crateSkuId}`)
      .get();
    expect(crateDoc.exists).toBe(true);
    expect(crateDoc.data()?.quantity ?? crateDoc.data()?.qty).toEqual(1);

    const keyDoc = await db
      .doc(`Players/${uid}/Inventory/${starterRewards.keySkuId}`)
      .get();
    expect(keyDoc.exists).toBe(true);
    expect(keyDoc.data()?.quantity ?? keyDoc.data()?.qty).toEqual(1);

    const summaryDoc = await db.doc(`Players/${uid}/Inventory/_summary`).get();
    expect(summaryDoc.exists).toBe(true);
    const totals = summaryDoc.data()?.totalsByCategory ?? {};
    expect(Number(totals.crate ?? 0)).toBeGreaterThanOrEqual(1);
    expect(Number(totals.key ?? 0)).toBeGreaterThanOrEqual(1);

    const receiptDoc = await db
      .doc(`Players/${uid}/Receipts/initializeUser.starterRewards`)
      .get();
    expect(receiptDoc.exists).toBe(true);
    expect(receiptDoc.data()?.status).toBe("completed");
  });

  it("does not double-grant starter rewards on subsequent runs", async () => {
    await initializeUserIfNeeded(uid, [], { isGuest: true, email: null });
    await initializeUserIfNeeded(uid, [], { isGuest: true, email: null });

    const db = admin.firestore();
    const crateDoc = await db
      .doc(`Players/${uid}/Inventory/${starterRewards.crateSkuId}`)
      .get();
    expect(crateDoc.data()?.quantity ?? crateDoc.data()?.qty).toEqual(1);

    const keyDoc = await db
      .doc(`Players/${uid}/Inventory/${starterRewards.keySkuId}`)
      .get();
    expect(keyDoc.data()?.quantity ?? keyDoc.data()?.qty).toEqual(1);
  });
});
