// functions/test/auth.init.test.ts
import { wrapCallable } from "./helpers/callable";
import { admin } from "./setup";
import { initUser } from "../src/auth";
import {
  wipeAuth,
  wipeFirestore,
  ensureCatalogsSeeded,
} from "./helpers/cleanup";
import { loadStarterRewards } from "../src/shared/starterRewards";
import { loadStarterSpellIds } from "../src/shared/catalogHelpers";

describe("User Initialization", () => {
  let uid: string;
  const authFor = (uid: string) => ({ auth: { uid, token: { firebase: { sign_in_provider: "anonymous" } } } });

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    await ensureCatalogsSeeded();
    uid = `test-uid-${Date.now()}`;

    // Create auth user in emulator
    await admin.auth().createUser({ uid });
  });

  describe("initUser", () => {
    it("creates all required player documents with starter data", async () => {
      const wrapped = wrapCallable(initUser);
      const result = await wrapped({
        data: { opId: "op_init_user" },
        ...authFor(uid),
      });

      expect(result).toEqual({ ok: true });

      const db = admin.firestore();

      // 1. Root player document
      const playerDoc = await db.doc(`Players/${uid}`).get();
      expect(playerDoc.exists).toBe(true);
      expect(playerDoc.data()?.uid).toBe(uid);
      expect(playerDoc.data()?.isGuest).toBe(true);

      // 2. Profile/Profile
      const profileDoc = await db.doc(`Players/${uid}/Profile/Profile`).get();
      expect(profileDoc.exists).toBe(true);
      expect(profileDoc.data()?.displayName).toBe("Guest");
      expect(profileDoc.data()?.avatarId).toBe(1);
      expect(profileDoc.data()?.level).toBe(1);
      expect(profileDoc.data()?.trophies).toBe(0);

      // 3. Economy/Stats
      const economyDoc = await db.doc(`Players/${uid}/Economy/Stats`).get();
      expect(economyDoc.exists).toBe(true);
      expect(economyDoc.data()?.coins).toBe(1000);
      expect(economyDoc.data()?.gems).toBe(0);
      expect(economyDoc.data()?.trophies).toBeUndefined();
      expect(economyDoc.data()?.level).toBeUndefined();

      // 4. Garage with default car stored in singleton
      const garageDoc = await db.doc(`Players/${uid}/Garage/Cars`).get();
      expect(garageDoc.exists).toBe(true);
      expect(garageDoc.data()?.cars?.car_h4ayzwf31g?.upgradeLevel).toBe(0);

      // 5. Loadouts/Active with correct car
      const loadoutDoc = await db.doc(`Players/${uid}/Loadouts/Active`).get();
      expect(loadoutDoc.exists).toBe(true);
      expect(loadoutDoc.data()?.carId).toBe("car_h4ayzwf31g");
      expect(loadoutDoc.data()?.activeSpellDeck).toBe(1);

      // 6. SpellDecks stored as singleton map
      const starterSpellIds = await loadStarterSpellIds();
      const decksDoc = await db.doc(`Players/${uid}/SpellDecks/Decks`).get();
      expect(decksDoc.exists).toBe(true);
      expect(decksDoc.data()?.decks?.["1"]?.spells?.[0]).toEqual(starterSpellIds[0]);

      // 7. Spells singleton contains starter spell
      const spellsDoc = await db.doc(`Players/${uid}/Spells/Levels`).get();
      expect(spellsDoc.exists).toBe(true);
      expect(spellsDoc.data()?.levels?.[starterSpellIds[0]]).toBe(1);

      // 8. Inventory welcome crate uses quantity field
      const starterRewards = await loadStarterRewards();
      const crateDoc = await db
        .doc(`Players/${uid}/Inventory/${starterRewards.crateSkuId}`)
        .get();
      expect(crateDoc.exists).toBe(true);
      expect(crateDoc.data()?.quantity ?? crateDoc.data()?.qty).toBe(1);

      const keyDoc = await db
        .doc(`Players/${uid}/Inventory/${starterRewards.keySkuId}`)
        .get();
      expect(keyDoc.exists).toBe(true);
      expect(keyDoc.data()?.quantity ?? keyDoc.data()?.qty).toBe(1);
    });

    it("is idempotent - calling twice does not duplicate data", async () => {
      const wrapped = wrapCallable(initUser);

      // First call
      await wrapped({ data: { opId: "op_init_1" }, ...authFor(uid) });

      // Second call with different opId
      await wrapped({ data: { opId: "op_init_2" }, ...authFor(uid) });

      const db = admin.firestore();

      const garageSnapshot = await db.collection(`Players/${uid}/Garage`).get();
      expect(garageSnapshot.size).toBe(1);
      expect(garageSnapshot.docs[0].id).toBe("Cars");

      const decksSnapshot = await db.collection(`Players/${uid}/SpellDecks`).get();
      expect(decksSnapshot.size).toBe(1);
      expect(decksSnapshot.docs[0].id).toBe("Decks");

      const spellsSnapshot = await db.collection(`Players/${uid}/Spells`).get();
      expect(spellsSnapshot.size).toBe(1);
      expect(spellsSnapshot.docs[0].id).toBe("Levels");

      const economyDoc = await db.doc(`Players/${uid}/Economy/Stats`).get();
      expect(economyDoc.data()?.coins).toBe(1000);
      expect(economyDoc.data()?.gems).toBe(0);
    });

    it("handles existing player gracefully", async () => {
      const db = admin.firestore();

      await db.doc(`Players/${uid}`).set({
        uid,
        email: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastLogin: admin.firestore.FieldValue.serverTimestamp(),
        isGuest: true,
        birthYear: null,
        isOver13: null,
      });

      const wrapped = wrapCallable(initUser);
      const result = await wrapped({
        data: { opId: "op_init_existing" },
        ...authFor(uid),
      });

      expect(result).toEqual({ ok: true });

      const playerDoc = await db.doc(`Players/${uid}`).get();
      expect(playerDoc.exists).toBe(true);
    });

    it("requires authentication", async () => {
      const wrapped = wrapCallable(initUser);

      await expect(
        wrapped({ data: { opId: "op_no_auth" }, auth: undefined })
      ).rejects.toThrow();
    });

    it("requires valid opId", async () => {
      const wrapped = wrapCallable(initUser);

      await expect(
        wrapped({ data: { opId: 123 }, ...authFor(uid) })
      ).rejects.toThrow();

      await expect(
        wrapped({ data: {}, ...authFor(uid) })
      ).rejects.toThrow();
    });
  });

  describe("Starter Configuration Validation", () => {
    it("provides a playable starter configuration", async () => {
      const wrapped = wrapCallable(initUser);
      await wrapped({ data: { opId: "op_balance_check" }, ...authFor(uid) });

      const db = admin.firestore();

      const economyDoc = await db.doc(`Players/${uid}/Economy/Stats`).get();
      expect(economyDoc.data()?.coins).toBeGreaterThan(0);

      const loadoutDoc = await db.doc(`Players/${uid}/Loadouts/Active`).get();
      expect(loadoutDoc.data()?.carId).toBeTruthy();
      expect(loadoutDoc.data()?.activeSpellDeck).toBe(1);

      const decksDoc = await db.doc(`Players/${uid}/SpellDecks/Decks`).get();
      const activeDeckId = decksDoc.data()?.active?.toString() ?? "1";
      const activeDeck = decksDoc.data()?.decks?.[activeDeckId];
      expect(activeDeck.spells.length).toBe(5);

      const spellsDoc = await db.doc(`Players/${uid}/Spells/Levels`).get();
      for (const spellId of activeDeck.spells.filter(Boolean)) {
        expect(spellsDoc.data()?.levels?.[spellId]).toBeGreaterThanOrEqual(1);
      }
    });
  });
});
