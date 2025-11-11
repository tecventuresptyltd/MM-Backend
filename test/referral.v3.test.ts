import { admin } from "./setup";
import {
  ensureCatalogsSeeded,
  wipeFirestore,
  wipeAuth,
  seedMinimalPlayer,
} from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import {
  referralGetMyReferralCode,
  referralClaimReferralCode,
  referralDebugLookup,
} from "../src/referral";
import { initializeUserIfNeeded } from "../src/shared/initializeUser";

const authContext = (uid: string, extraClaims: Record<string, unknown> = {}) => ({
  auth: {
    uid,
    token: {
      firebase: { sign_in_provider: "anonymous" },
      ...extraClaims,
    },
  },
});

const readProfile = async (uid: string) =>
  (await admin.firestore().doc(`Players/${uid}/Profile/Profile`).get()).data() ?? {};

const readInventoryQty = async (uid: string, skuId: string): Promise<number> => {
  const doc = await admin.firestore().doc(`Players/${uid}/Inventory/${skuId}`).get();
  if (!doc.exists) {
    return 0;
  }
  const data = doc.data() ?? {};
  return Number(data.qty ?? data.quantity ?? 0);
};

const readProgressDoc = async (uid: string) =>
  (await admin.firestore().doc(`Players/${uid}/Referrals/Progress`).get()).data() ?? {};

const listEvents = async (uid: string) => {
  const snapshot = await admin
    .firestore()
    .collection(`Players/${uid}/ReferralsEvents`)
    .orderBy("createdAt")
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() ?? {}) }));
};

const inviteeSkuId = "sku_rjwe5tdtc4";
const inviterSkuThreshold1 = "sku_2xw1r4bah7";

describe("Referral callables (v3)", () => {
  beforeAll(async () => {
    await ensureCatalogsSeeded();
  });

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    await ensureCatalogsSeeded();
  });

  it("assigns an immutable referral code during initialization", async () => {
    const uid = `user-${Date.now()}`;
    await seedMinimalPlayer(uid);

    const profileAfterInit = await readProfile(uid);
    expect(typeof profileAfterInit.referralCode).toBe("string");
    const initialCode = profileAfterInit.referralCode as string;

    const wrappedGetCode = wrapCallable(referralGetMyReferralCode);
    const response = await wrappedGetCode({ data: {}, ...authContext(uid) });
    expect(response.referralCode).toBe(initialCode);

    await initializeUserIfNeeded(uid, ["anonymous"], { isGuest: true });
    const profileAfterReinit = await readProfile(uid);
    expect(profileAfterReinit.referralCode).toBe(initialCode);
  });

  it("allows invitee to claim rewards and increments inviter progress", async () => {
    const inviterUid = `inviter-${Date.now()}`;
    const inviteeUid = `invitee-${Date.now()}`;
    await seedMinimalPlayer(inviterUid);
    await seedMinimalPlayer(inviteeUid);

    const wrappedGetCode = wrapCallable(referralGetMyReferralCode);
    const inviterCodeResp = await wrappedGetCode({ data: {}, ...authContext(inviterUid) });
    const inviterCode = inviterCodeResp.referralCode;

    const wrappedClaim = wrapCallable(referralClaimReferralCode);
    const claimResult = await wrappedClaim({
      data: { opId: "op-claim-1", referralCode: inviterCode },
      ...authContext(inviteeUid),
    });

    expect(claimResult.status).toBe("ok");
    expect(claimResult.referredBy).toBe(inviterCode);
    expect(claimResult.inviter.uid).toBe(inviterUid);
    expect(claimResult.inviteeRewards.some((reward: any) => reward.skuId === inviteeSkuId)).toBe(true);

    const inviteeProfile = await readProfile(inviteeUid);
    expect(inviteeProfile.referredBy).toBe(inviterCode);
    const inviteeBalance = await readInventoryQty(inviteeUid, inviteeSkuId);
    expect(inviteeBalance).toBeGreaterThanOrEqual(1);

    const inviterProgress = await readProgressDoc(inviterUid);
    expect(inviterProgress.sentTotal).toBe(1);

    const inviterInventory = await readInventoryQty(inviterUid, inviterSkuThreshold1);
    expect(inviterInventory).toBeGreaterThanOrEqual(1);

    const inviteeEvents = await listEvents(inviteeUid);
    expect(inviteeEvents.find((event) => event.type === "claim")).toBeDefined();
    expect(inviteeEvents.find((event) => event.type === "reward-received")).toBeDefined();

    const inviterEvents = await listEvents(inviterUid);
    expect(inviterEvents.find((event) => event.type === "reward-sent")).toBeDefined();

    const inviteeReceipt = await admin
      .firestore()
      .doc(`Players/${inviteeUid}/Receipts/op-claim-1`)
      .get();
    expect(inviteeReceipt.exists).toBe(true);
    const inviterReceipt = await admin
      .firestore()
      .doc(`Players/${inviterUid}/Receipts/referralReward.op-claim-1`)
      .get();
    expect(inviterReceipt.exists).toBe(true);
  });

  it("rejects self-referral attempts", async () => {
    const uid = `self-${Date.now()}`;
    await seedMinimalPlayer(uid);

    const { referralCode } = await wrapCallable(referralGetMyReferralCode)({ data: {}, ...authContext(uid) });
    await expect(
      wrapCallable(referralClaimReferralCode)({
        data: { opId: "self-op", referralCode },
        ...authContext(uid),
      }),
    ).rejects.toHaveProperty("code", "failed-precondition");
  });

  it("prevents multiple referral claims by the same invitee", async () => {
    const inviterUid = `dual-${Date.now()}`;
    const inviteeUid = `dual-invitee-${Date.now()}`;
    const otherInviterUid = `other-${Date.now()}`;

    await seedMinimalPlayer(inviterUid);
    await seedMinimalPlayer(inviteeUid);
    await seedMinimalPlayer(otherInviterUid);

    const wrappedGetCode = wrapCallable(referralGetMyReferralCode);
    const inviterCode = (
      await wrappedGetCode({ data: {}, ...authContext(inviterUid) })
    ).referralCode;
    const otherCode = (
      await wrappedGetCode({ data: {}, ...authContext(otherInviterUid) })
    ).referralCode;

    const wrappedClaim = wrapCallable(referralClaimReferralCode);
    const firstClaim = await wrappedClaim({
      data: { opId: "op-double", referralCode: inviterCode },
      ...authContext(inviteeUid),
    });
    expect(firstClaim.status).toBe("ok");

    await expect(
      wrappedClaim({
        data: { opId: "op-double-2", referralCode: otherCode },
        ...authContext(inviteeUid),
      }),
    ).rejects.toHaveProperty("code", "failed-precondition");

    const replay = await wrappedClaim({
      data: { opId: "op-double", referralCode: inviterCode },
      ...authContext(inviteeUid),
    });
    expect(replay.referredBy).toBe(inviterCode);
  });

  it("rejects circular referral loops", async () => {
    const aliceUid = `alice-${Date.now()}`;
    const bobUid = `bob-${Date.now()}`;
    await seedMinimalPlayer(aliceUid);
    await seedMinimalPlayer(bobUid);

    const wrappedGetCode = wrapCallable(referralGetMyReferralCode);
    const aliceCode = (await wrappedGetCode({ data: {}, ...authContext(aliceUid) })).referralCode;
    const bobCode = (await wrappedGetCode({ data: {}, ...authContext(bobUid) })).referralCode;

    const wrappedClaim = wrapCallable(referralClaimReferralCode);
    await wrappedClaim({ data: { opId: "loop-a", referralCode: aliceCode }, ...authContext(bobUid) });

    await expect(
      wrappedClaim({ data: { opId: "loop-b", referralCode: bobCode }, ...authContext(aliceUid) }),
    ).rejects.toHaveProperty("code", "failed-precondition");
  });

  it("processes at most one concurrent referral claim per invitee", async () => {
    const inviterUid = `race-${Date.now()}`;
    const inviteeUid = `race-invitee-${Date.now()}`;
    await seedMinimalPlayer(inviterUid);
    await seedMinimalPlayer(inviteeUid);

    const { referralCode } = await wrapCallable(referralGetMyReferralCode)({
      data: {},
      ...authContext(inviterUid),
    });

    const wrappedClaim = wrapCallable(referralClaimReferralCode);
    const attemptOne = wrappedClaim({
      data: { opId: "concurrency-1", referralCode },
      ...authContext(inviteeUid),
    });
    const attemptTwo = wrappedClaim({
      data: { opId: "concurrency-2", referralCode },
      ...authContext(inviteeUid),
    });

    const settled = await Promise.allSettled([attemptOne, attemptTwo]);
    const successes = settled.filter((result) => result.status === "fulfilled");
    const failures = settled.filter((result) => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    const profile = await readProfile(inviteeUid);
    expect(profile.referredBy).toBe(referralCode);

    const receiptOne = await admin
      .firestore()
      .doc(`Players/${inviteeUid}/Receipts/concurrency-1`)
      .get();
    const receiptTwo = await admin
      .firestore()
      .doc(`Players/${inviteeUid}/Receipts/concurrency-2`)
      .get();
    const receipts = [receiptOne, receiptTwo].filter((doc) => doc.exists);
    expect(receipts).toHaveLength(1);
  });

  it("allows admins to look up referral codes via debug callable", async () => {
    const uid = `debug-${Date.now()}`;
    await seedMinimalPlayer(uid);
    const { referralCode } = await wrapCallable(referralGetMyReferralCode)({ data: {}, ...authContext(uid) });

    const wrappedDebug = wrapCallable(referralDebugLookup);
    await expect(
      wrappedDebug({ data: { referralCode }, ...authContext(uid) }),
    ).rejects.toHaveProperty("code", "permission-denied");

    const debugResult = await wrappedDebug({
      data: { referralCode },
      ...authContext(uid, { admin: true }),
      rawRequest: {
        get(header: string) {
          if (header.toLowerCase() === "x-admin") {
            return "true";
          }
          return undefined;
        },
      },
    });
    expect(debugResult.uid).toBe(uid);
    expect(debugResult.referralCode).toBe(referralCode);
  });
});
