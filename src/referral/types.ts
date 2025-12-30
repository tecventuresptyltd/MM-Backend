export interface ReferralSkuReward {
  skuId: string;
  qty: number;
}

export interface ReferralThresholdReward {
  threshold: number;
  rewards: ReferralSkuReward[];
}

export interface ReferralConfig {
  codeLength: number;
  alphabet: string;
  maxClaimPerInvitee: number;
  maxClaimsPerInviter: number;
  inviteeRewards: ReferralSkuReward[];
  inviterRewards: ReferralThresholdReward[];
  blockSelfReferral: boolean;
  blockCircularReferral: boolean;
}

export interface PlayerReferralStats {
  sent: number;
  receivedCredit: boolean;
  rewards: {
    sentCount: number;
    receivedCount: number;
  };
}

export type ReferralEventType = "claim" | "reward-sent" | "reward-received";

export interface ReferralEventDoc {
  type: ReferralEventType;
  opId: string;
  referralCode: string;
  otherUid?: string;
  awarded?: ReferralSkuReward[];
  createdAt: number;
  deviceHash?: string | null;
  ipHash?: string | null;
}

export interface UnseenReferralReward {
  eventId: string;           // Reference to event in /Referrals/Events
  inviteeUid: string;        // Who redeemed the code
  tier: number;              // Which tier threshold was reached
  rewards: ReferralSkuReward[];
  timestamp: FirebaseFirestore.FieldValue | number;
}

export interface UnseenRewardsDoc {
  unseenRewards: UnseenReferralReward[];
  totalUnseenRewards: number;
  updatedAt: FirebaseFirestore.FieldValue | number;
}
