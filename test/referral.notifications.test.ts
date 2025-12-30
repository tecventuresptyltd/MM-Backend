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
    acknowledgeReferralRewards,
} from "../src/referral";

const authContext = (uid: string) => ({
    auth: {
        uid,
        token: {
            firebase: { sign_in_provider: "anonymous" },
        },
    },
});

const readUnseenRewards = async (uid: string) => {
    const doc = await admin.firestore().doc(`Players/${uid}/Referrals/UnseenRewards`).get();
    return doc.exists ? doc.data() : null;
};

describe("Referral Notifications", () => {
    beforeAll(async () => {
        await ensureCatalogsSeeded();
    });

    beforeEach(async () => {
        await wipeFirestore();
        await wipeAuth();
        await ensureCatalogsSeeded();
    });

    it("creates unseen reward entry when inviter receives tier 1 rewards", async () => {
        const inviterUid = `inviter-${Date.now()}`;
        const inviteeUid = `invitee-${Date.now()}`;
        await seedMinimalPlayer(inviterUid);
        await seedMinimalPlayer(inviteeUid);

        const wrappedGetCode = wrapCallable(referralGetMyReferralCode);
        const inviterCodeResp = await wrappedGetCode({ data: {}, ...authContext(inviterUid) });
        const inviterCode = inviterCodeResp.referralCode;

        const wrappedClaim = wrapCallable(referralClaimReferralCode);
        await wrappedClaim({
            data: { opId: "op-notif-1", referralCode: inviterCode },
            ...authContext(inviteeUid),
        });

        const unseenRewards = await readUnseenRewards(inviterUid);
        expect(unseenRewards).toBeTruthy();
        expect(unseenRewards!.totalUnseenRewards).toBe(1);
        expect(unseenRewards!.unseenRewards).toHaveLength(1);
        expect(unseenRewards!.unseenRewards[0].inviteeUid).toBe(inviteeUid);
        expect(unseenRewards!.unseenRewards[0].tier).toBe(1);
        expect(unseenRewards!.unseenRewards[0].rewards.length).toBeGreaterThan(0);
    });

    it("aggregates multiple referrals into unseenRewards array", async () => {
        const inviterUid = `inviter-multi-${Date.now()}`;
        const invitee1Uid = `invitee1-${Date.now()}`;
        const invitee2Uid = `invitee2-${Date.now()}`;

        await seedMinimalPlayer(inviterUid);
        await seedMinimalPlayer(invitee1Uid);
        await seedMinimalPlayer(invitee2Uid);

        const wrappedGetCode = wrapCallable(referralGetMyReferralCode);
        const inviterCodeResp = await wrappedGetCode({ data: {}, ...authContext(inviterUid) });
        const inviterCode = inviterCodeResp.referralCode;

        const wrappedClaim = wrapCallable(referralClaimReferralCode);

        // First referral (tier 1)
        await wrappedClaim({
            data: { opId: "op-multi-1", referralCode: inviterCode },
            ...authContext(invitee1Uid),
        });

        // Second referral (tier 2)
        await wrappedClaim({
            data: { opId: "op-multi-2", referralCode: inviterCode },
            ...authContext(invitee2Uid),
        });

        const unseenRewards = await readUnseenRewards(inviterUid);
        expect(unseenRewards).toBeTruthy();
        expect(unseenRewards!.totalUnseenRewards).toBe(2);
        expect(unseenRewards!.unseenRewards).toHaveLength(2);

        // Verify both tiers are tracked
        const tiers = unseenRewards!.unseenRewards.map((r: any) => r.tier);
        expect(tiers).toEqual(expect.arrayContaining([1, 2]));
    });

    it("acknowledges all unseen rewards when eventIds is empty", async () => {
        const inviterUid = `inviter-ack-${Date.now()}`;
        const inviteeUid = `invitee-ack-${Date.now()}`;

        await seedMinimalPlayer(inviterUid);
        await seedMinimalPlayer(inviteeUid);

        const wrappedGetCode = wrapCallable(referralGetMyReferralCode);
        const inviterCodeResp = await wrappedGetCode({ data: {}, ...authContext(inviterUid) });
        const inviterCode = inviterCodeResp.referralCode;

        const wrappedClaim = wrapCallable(referralClaimReferralCode);
        await wrappedClaim({
            data: { opId: "op-ack-1", referralCode: inviterCode },
            ...authContext(inviteeUid),
        });

        // Verify unseen reward exists
        let unseenRewards = await readUnseenRewards(inviterUid);
        expect(unseenRewards!.totalUnseenRewards).toBe(1);

        // Acknowledge all rewards (empty eventIds)
        const wrappedAck = wrapCallable(acknowledgeReferralRewards);
        const ackResult = await wrappedAck({
            data: { eventIds: [] },
            ...authContext(inviterUid),
        });

        expect(ackResult.acknowledged).toBe(1);
        expect(ackResult.remaining).toBe(0);

        // Verify unseen rewards are cleared
        unseenRewards = await readUnseenRewards(inviterUid);
        expect(unseenRewards!.totalUnseenRewards).toBe(0);
        expect(unseenRewards!.unseenRewards).toHaveLength(0);
    });

    it("acknowledges specific rewards when eventIds provided", async () => {
        const inviterUid = `inviter-specific-${Date.now()}`;
        const invitee1Uid = `invitee1-spec-${Date.now()}`;
        const invitee2Uid = `invitee2-spec-${Date.now()}`;

        await seedMinimalPlayer(inviterUid);
        await seedMinimalPlayer(invitee1Uid);
        await seedMinimalPlayer(invitee2Uid);

        const wrappedGetCode = wrapCallable(referralGetMyReferralCode);
        const inviterCodeResp = await wrappedGetCode({ data: {}, ...authContext(inviterUid) });
        const inviterCode = inviterCodeResp.referralCode;

        const wrappedClaim = wrapCallable(referralClaimReferralCode);

        await wrappedClaim({
            data: { opId: "op-spec-1", referralCode: inviterCode },
            ...authContext(invitee1Uid),
        });

        await wrappedClaim({
            data: { opId: "op-spec-2", referralCode: inviterCode },
            ...authContext(invitee2Uid),
        });

        let unseenRewards = await readUnseenRewards(inviterUid);
        expect(unseenRewards!.totalUnseenRewards).toBe(2);

        // Acknowledge only the first reward
        const firstEventId = unseenRewards!.unseenRewards[0].eventId;

        const wrappedAck = wrapCallable(acknowledgeReferralRewards);
        const ackResult = await wrappedAck({
            data: { eventIds: [firstEventId] },
            ...authContext(inviterUid),
        });

        expect(ackResult.acknowledged).toBe(1);
        expect(ackResult.remaining).toBe(1);

        // Verify one reward remains
        unseenRewards = await readUnseenRewards(inviterUid);
        expect(unseenRewards!.totalUnseenRewards).toBe(1);
        expect(unseenRewards!.unseenRewards).toHaveLength(1);
    });

    it("handles acknowledgment when no unseen rewards exist", async () => {
        const inviterUid = `inviter-empty-${Date.now()}`;
        await seedMinimalPlayer(inviterUid);

        const wrappedAck = wrapCallable(acknowledgeReferralRewards);
        const ackResult = await wrappedAck({
            data: { eventIds: [] },
            ...authContext(inviterUid),
        });

        expect(ackResult.acknowledged).toBe(0);
        expect(ackResult.remaining).toBe(0);
    });
});
