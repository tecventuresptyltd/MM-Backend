import { admin } from "./setup";
import {
  wipeAuth,
  wipeFirestore,
  seedMinimalPlayer,
  ensureCatalogsSeeded,
} from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { setUsername, setAgeYears, claimStarterOffer } from "../src/profile";
import { loadStarterRewards } from "../src/shared/starterRewards";

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
});
