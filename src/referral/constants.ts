import { PlayerReferralStats } from "./types.js";

export const createDefaultReferralStats = (): PlayerReferralStats => ({
  sent: 0,
  receivedCredit: false,
  rewards: {
    sentCount: 0,
    receivedCount: 0,
  },
});

export const REFERRAL_CODE_REGISTRY_COLLECTION = "ReferralRegistryCodeToUid";
export const REFERRAL_UID_REGISTRY_COLLECTION = "ReferralRegistryUidToCode";
export const REFERRAL_EVENTS_SUBCOLLECTION = "ReferralsEvents";
export const REFERRAL_PROGRESS_DOC = "Referrals/Progress";
