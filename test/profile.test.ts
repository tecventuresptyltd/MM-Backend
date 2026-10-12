import { admin } from "./setup";
import {
  wipeAuth,
  wipeFirestore,
  seedMinimalPlayer,
  ensureCatalogsSeeded,
} from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { setUsername, setAgeYears, claimStarterOffer, markTutorialComplete } from "../src/profile";
import { loadStarterRewards } from "../src/shared/starterRewards";
import { getMasteryConfig, getMasteryRank, getMasteryProgress, getXpCapForCar, getSpellEvolutionV2Catalog } from "../src/core/configV2";

describe("Profile Functions", () => {
  let uid: string;
  let starterRewards: Awaited<ReturnType<typeof loadStarterRewards>>;
  const authFor = (uid: string) => ({
    auth: { uid, token: { firebase: { sign_in_provider: "anonymous" } } },
  });
  const readSummaryCount = (
    totals: Record<string, unknown> | undefined,
    key: string,
  ): number =>
    Number(
      totals?.[key] ??
        (totals as Record<string, unknown> | undefined)?.[`${key}s`] ??
        0,
    );

  beforeAll(async () => {
    await ensureCatalogsSeeded();
    starterRewards = await loadStarterRewards();
  });

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    uid = `test-uid-${Date.now()}`;
    await seedMinimalPlayer(uid);
  });

  describe("setUsername", () => {
    it("reserves the username and updates the player profile", async () => {
      const wrapped = wrapCallable(setUsername);
      await wrapped({ data: { username: "Speedster" }, ...authFor(uid) });

      const profileDoc = await admin.firestore().doc(`Players/${uid}/Profile/Profile`).get();
      expect(profileDoc.data()?.displayName).toBe("Speedster");

      const usernameDoc = await admin.firestore().doc(`Usernames/speedster`).get();
      expect(usernameDoc.exists).toBe(true);
      expect(usernameDoc.data()?.uid).toBe(uid);
    });

    it("rejects usernames that are already taken", async () => {
      await admin.firestore().doc("Usernames/speedster").set({ uid: "other-user" });

      const wrapped = wrapCallable(setUsername);
      await expect(wrapped({ data: { username: "Speedster" }, ...authFor(uid) })).rejects.toHaveProperty(
        "code",
        "already-exists"
      );
    });
  });

  describe("setAgeYears", () => {
    it("stores derived birth year and over-13 flag", async () => {
      const wrapped = wrapCallable(setAgeYears);
      const response = await wrapped({ data: { ageYears: 20 }, ...authFor(uid) });

      const currentYear = new Date().getFullYear();
      expect(response.birthYear).toBe(currentYear - 20);
      expect(response.isOver13).toBe(true);

      const playerDoc = await admin.firestore().doc(`Players/${uid}`).get();
      expect(playerDoc.data()?.birthYear).toBe(currentYear - 20);
      expect(playerDoc.data()?.isOver13).toBe(true);
    });
  });

  describe("claimStarterOffer", () => {
    it("grants the starter crate once and records the flag", async () => {
      const wrapped = wrapCallable(claimStarterOffer);
      const crateRef = admin.firestore().doc(
        `Players/${uid}/Inventory/${starterRewards.crateSkuId}`,
      );
      const keyRef = starterRewards.keySkuId
        ? admin
            .firestore()
            .doc(`Players/${uid}/Inventory/${starterRewards.keySkuId}`)
        : null;
      const summaryRef = admin
        .firestore()
        .doc(`Players/${uid}/Inventory/_summary`);

      const [crateBeforeSnap, keyBeforeSnap, summaryBeforeSnap] = await Promise.all([
        crateRef.get(),
        keyRef ? keyRef.get() : Promise.resolve(null),
        summaryRef.get(),
      ]);
      const baseCrateQty = Number(
        crateBeforeSnap.data()?.quantity ?? crateBeforeSnap.data()?.qty ?? 0,
      );
      const baseKeyQty = keyBeforeSnap
        ? Number(keyBeforeSnap.data()?.quantity ?? keyBeforeSnap.data()?.qty ?? 0)
        : 0;
      const baseTotals = summaryBeforeSnap.data()?.totalsByCategory ?? {};

      const opId = "op_claim_starter";
      await wrapped({ data: { opId }, ...authFor(uid) });

      const flagsDoc = await admin
        .firestore()
        .doc(`Players/${uid}/Progress/Flags`)
        .get();
      expect(flagsDoc.data()?.starterOfferClaimed).toBe(true);

      const crateAfterSnap = await crateRef.get();
      const crateQuantity =
        crateAfterSnap.data()?.quantity ?? crateAfterSnap.data()?.qty;
      expect(Number(crateQuantity ?? 0)).toBe(baseCrateQty + 1);

      if (keyRef) {
        const keyAfterSnap = await keyRef.get();
        const keyQuantity =
          keyAfterSnap.data()?.quantity ?? keyAfterSnap.data()?.qty;
        expect(Number(keyQuantity ?? 0)).toBe(baseKeyQty + 1);
      }

      const receiptDoc = await admin
        .firestore()
        .doc(`Players/${uid}/Receipts/${opId}`)
        .get();
      expect(receiptDoc.exists).toBe(true);
      expect(receiptDoc.data()?.status).toBe("completed");

      const summaryAfter = await summaryRef.get();
      const totalsAfter = summaryAfter.data()?.totalsByCategory ?? {};
      expect(readSummaryCount(totalsAfter, "crate")).toBe(
        readSummaryCount(baseTotals, "crate") + 1,
      );
      if (starterRewards.keySkuId) {
        expect(readSummaryCount(totalsAfter, "key")).toBe(
          readSummaryCount(baseTotals, "key") + 1,
        );
      }

      const profileDoc = await admin
        .firestore()
        .doc(`Players/${uid}/Profile/Profile`)
        .get();
      const boosters = profileDoc.data()?.boosters;
      expect(boosters && typeof boosters === "object").toBe(true);

      await expect(wrapped({ data: { opId: "op_claim_starter_retry" }, ...authFor(uid) })).rejects.toHaveProperty(
        "code",
        "already-exists"
      );

      const crateAfterRetry = await crateRef.get();
      const quantityAfter =
        crateAfterRetry.data()?.quantity ?? crateAfterRetry.data()?.qty;
      expect(Number(quantityAfter ?? 0)).toBe(baseCrateQty + 1);
    });
  });

  describe("markTutorialComplete", () => {
    it("grants car and unique equipped spell XP once under concurrent completion", async () => {
      const db = admin.firestore();
      const carId = "car_h4ayzwf31g";
      const spellIds = ["spell_2382r2jk", "spell_test_second", "spell_test_third"];
      await db.doc(`Players/${uid}/Loadouts/Active`).set({ carId, activeSpellDeck: 1 });
      await db.doc(`Players/${uid}/Garage/Cars`).set({ cars: { [carId]: { starLevel: 2, carLevel: 2, xp: 0 } } });
      await db.doc(`Players/${uid}/SpellDecks/Decks`).set({ decks: { "1": { spells: [...spellIds, spellIds[0], ""] } } });
      await db.doc(`Players/${uid}/Spells/Levels`).set({ spells: Object.fromEntries(
        [...spellIds, "spell_unequipped"].map(id => [id, { level: 2, xp: 0, isXpCapped: false }]),
      ) });
      const wrapped = wrapCallable(markTutorialComplete);
      await Promise.all([
        wrapped({ data: { grantRewards: true }, ...authFor(uid) }),
        wrapped({ data: { grantRewards: true }, ...authFor(uid) }),
      ]);
      const car = (await db.doc(`Players/${uid}/Garage/Cars`).get()).data()?.cars[carId];
      const spells = (await db.doc(`Players/${uid}/Spells/Levels`).get()).data()?.spells;
      expect(car.xp).toBe(125);
      expect(car.carLevel).toBe(2);
      for (const id of spellIds) expect(spells[id]).toEqual({ level: 2, xp: 25, isXpCapped: false });
      expect(spells.spell_unequipped.xp).toBe(0);
    });

    it("respects XP caps and preserves max-level spell progress", async () => {
      const db = admin.firestore();
      const carId = "car_h4ayzwf31g";
      const cap = await getXpCapForCar(carId, 2);
      const catalog = await getSpellEvolutionV2Catalog();
      const spellCap = catalog.spellXpConfig.xpCapPerLevel["2"];
      await db.doc(`Players/${uid}/Loadouts/Active`).set({ carId, activeSpellDeck: 1 });
      await db.doc(`Players/${uid}/Garage/Cars`).set({ cars: { [carId]: { starLevel: 2, xp: cap - 10 } } });
      await db.doc(`Players/${uid}/SpellDecks/Decks`).set({ decks: { "1": { spells: ["spell_2382r2jk", "spell_max"] } } });
      await db.doc(`Players/${uid}/Spells/Levels`).set({ spells: {
        spell_2382r2jk: { level: 2, xp: spellCap - 5, isXpCapped: false },
        spell_max: { level: catalog.maxSpellLevel, xp: 777, isXpCapped: true },
      } });
      const result = await wrapCallable(markTutorialComplete)({ data: { grantRewards: true }, ...authFor(uid) });
      expect(result.carXpGranted).toBe(10);
      expect(result.spellXpGranted.spell_2382r2jk).toBe(5);
      const car = (await db.doc(`Players/${uid}/Garage/Cars`).get()).data()?.cars[carId];
      const spells = (await db.doc(`Players/${uid}/Spells/Levels`).get()).data()?.spells;
      expect(car.xp).toBe(cap);
      expect(car.isXpCapped).toBe(true);
      expect(spells.spell_2382r2jk).toEqual({ level: 2, xp: spellCap, isXpCapped: true });
      expect(spells.spell_max.xp).toBe(777);
    });

    it("does not grant car or spell XP when rewards are disabled or already claimed", async () => {
      const db = admin.firestore();
      const garageRef = db.doc(`Players/${uid}/Garage/Cars`);
      const spellsRef = db.doc(`Players/${uid}/Spells/Levels`);
      const garageBefore = (await garageRef.get()).data();
      const spellsBefore = (await spellsRef.get()).data();
      const wrapped = wrapCallable(markTutorialComplete);
      await wrapped({ data: { grantRewards: false }, ...authFor(uid) });
      await wrapped({ data: { grantRewards: true }, ...authFor(uid) });
      expect((await garageRef.get()).data()).toEqual(garageBefore);
      expect((await spellsRef.get()).data()).toEqual(spellsBefore);
    });

    it("adds tutorial XP to mastery without replacing legacy XP fields", async () => {
      const profileRef = admin.firestore().doc(`Players/${uid}/Profile/Profile`);
      const economyRef = admin.firestore().doc(`Players/${uid}/Economy/Stats`);
      const spellsRef = admin.firestore().doc(`Players/${uid}/Spells/Levels`);
      await profileRef.set({ masteryXp: 500, masteryRank: 0, level: 0, exp: 80 }, { merge: true });
      await spellsRef.set({ spells: { spell_2382r2jk: { level: 4, xp: 321, isXpCapped: true } } }, { merge: true });
      const coinsBefore = Number((await economyRef.get()).data()?.coins ?? 0);
      const config = await getMasteryConfig();
      const wrapped = wrapCallable(markTutorialComplete);
      await wrapped({ data: { grantRewards: true }, ...authFor(uid) });
      await wrapped({ data: { grantRewards: true }, ...authFor(uid) });
      const profile = (await profileRef.get()).data();
      const expectedProgress = getMasteryProgress(600, config);
      const economy = (await economyRef.get()).data();
      const spells = (await spellsRef.get()).data();
      expect(profile?.masteryXp).toBe(600);
      expect(profile?.masteryRank).toBe(getMasteryRank(600, config));
      expect(profile?.level).toBe(profile?.masteryRank);
      expect(profile?.expProgress).toBe(expectedProgress.expProgress);
      expect(profile?.expToNextLevel).toBe(expectedProgress.expToNextLevel);
      expect(profile?.exp).toBe(80);
      expect(Number(economy?.coins)).toBe(coinsBefore + 1000);
      expect(spells?.spells?.spell_2382r2jk).toEqual({ level: 4, xp: 321, isXpCapped: true });
    });
  });
});
