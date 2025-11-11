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
