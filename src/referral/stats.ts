import { PlayerReferralStats } from "./types.js";
import { createDefaultReferralStats } from "./constants.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toNonNegativeInt = (value: unknown, fallback: number): number => {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) {
    return fallback;
  }
  return Math.floor(num);
};

export const normaliseReferralStats = (
  value: unknown,
): PlayerReferralStats => {
  const base = createDefaultReferralStats();
  if (!isRecord(value)) {
    return base;
  }
  const stats: PlayerReferralStats = {
    sent: toNonNegativeInt(value.sent, base.sent),
    receivedCredit:
      typeof value.receivedCredit === "boolean"
        ? value.receivedCredit
        : base.receivedCredit,
    rewards: {
      sentCount: base.rewards.sentCount,
      receivedCount: base.rewards.receivedCount,
    },
  };

  const rewards = isRecord(value.rewards) ? value.rewards : {};
  stats.rewards.sentCount = toNonNegativeInt(
    rewards.sentCount,
    base.rewards.sentCount,
  );
  stats.rewards.receivedCount = toNonNegativeInt(
    rewards.receivedCount,
    base.rewards.receivedCount,
  );

  return stats;
};

export const cloneReferralStats = (
  stats: PlayerReferralStats,
): PlayerReferralStats => ({
  sent: stats.sent,
  receivedCredit: stats.receivedCredit,
  rewards: {
    sentCount: stats.rewards.sentCount,
    receivedCount: stats.rewards.receivedCount,
  },
});

export const shouldUpdateReferralStats = (
  current: unknown,
  desired: PlayerReferralStats,
): boolean => {
  if (!isRecord(current)) {
    return true;
  }
  const currentSent = toNonNegativeInt(current.sent, -1);
  const currentReceived = current.receivedCredit === true;
  const rewards = isRecord(current.rewards) ? current.rewards : {};
  const currentSentCount = toNonNegativeInt(rewards.sentCount, -1);
  const currentReceivedCount = toNonNegativeInt(rewards.receivedCount, -1);

  return (
    currentSent !== desired.sent ||
    currentReceived !== desired.receivedCredit ||
    currentSentCount !== desired.rewards.sentCount ||
    currentReceivedCount !== desired.rewards.receivedCount
  );
};

export const applyInviteeRewardCredit = (
  stats: PlayerReferralStats,
  receivedIncrement = 1,
): PlayerReferralStats => ({
  sent: stats.sent,
  receivedCredit: true,
  rewards: {
    sentCount: stats.rewards.sentCount,
    receivedCount: stats.rewards.receivedCount + receivedIncrement,
  },
});

export const applyInviterRewardCredit = (
  stats: PlayerReferralStats,
  sentIncrement: number,
  rewardIncrements: number,
): PlayerReferralStats => ({
  sent: stats.sent + sentIncrement,
  receivedCredit: stats.receivedCredit,
  rewards: {
    sentCount: stats.rewards.sentCount + rewardIncrements,
    receivedCount: stats.rewards.receivedCount,
  },
});

export const __testOnly = {
  toNonNegativeInt,
};
