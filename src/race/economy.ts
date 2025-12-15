/* eslint-disable @typescript-eslint/no-loss-of-precision */
import { Timestamp } from "firebase-admin/firestore";

export type RankThreshold = { min: number; label: string };

export const RANK_THRESHOLDS: RankThreshold[] = [
  { min: 0, label: "Unranked" },
  { min: 250, label: "Bronze I" },
  { min: 500, label: "Bronze II" },
  { min: 750, label: "Bronze III" },
  { min: 1000, label: "Silver I" },
  { min: 1250, label: "Silver II" },
  { min: 1500, label: "Silver III" },
  { min: 1750, label: "Gold I" },
  { min: 2000, label: "Gold II" },
  { min: 2250, label: "Gold III" },
  { min: 2500, label: "Platinum I" },
  { min: 2750, label: "Platinum II" },
  { min: 3000, label: "Platinum III" },
  { min: 3250, label: "Diamond I" },
  { min: 3500, label: "Diamond II" },
  { min: 3750, label: "Diamond III" },
  { min: 4000, label: "Master I" },
  { min: 4250, label: "Master II" },
  { min: 4500, label: "Master III" },
  { min: 4750, label: "Champion I" },
  { min: 5000, label: "Champion II" },
  { min: 5250, label: "Champion III" },
  { min: 5500, label: "Ascendant I" },
  { min: 5750, label: "Ascendant II" },
  { min: 6000, label: "Ascendant III" },
  { min: 6250, label: "Hypersonic I" },
  { min: 6500, label: "Hypersonic II" },
  { min: 7000, label: "Hypersonic III" },
];

export const RANK_LABELS = RANK_THRESHOLDS.map((entry) => entry.label);

export function getRankForTrophies(trophies: number): string {
  const sanitized = Number.isFinite(trophies) ? trophies : 0;
  for (let i = RANK_THRESHOLDS.length - 1; i >= 0; i -= 1) {
    if (sanitized >= RANK_THRESHOLDS[i].min) {
      return RANK_THRESHOLDS[i].label;
    }
  }
  return "Unranked";
}

export interface TrophyConfig {
  D: number;
  TAU: number;
  W_MIN: number;
  PER_PAIR_CLIP: number;
  CLAMP_MIN: number;
  CLAMP_MAX: number;
  baseKBreakpoints: Array<[number, number]>;
  softCeilingStart: number;
  softCeilingLambda: number;
}

export interface CoinConfig {
  rankMaxByPlace: Record<string, number[]>;
  difficultyFloor: number;
  difficultyCeiling: number;
  roundTo: number;
  boosterMultiplier: number;
}

export interface ExpConfig {
  baseMin: number;
  baseMax: number;
  posMinMult: number;
  posMaxMult: number;
  boosterMultiplier: number;
  rankPlaceCaps?: Record<string, number[]>;
}

export const DEFAULT_TROPHY_CONFIG: TrophyConfig = {
  D: 700,
  TAU: 600,
  W_MIN: 0.2,
  PER_PAIR_CLIP: 8,
  CLAMP_MIN: -40,
  CLAMP_MAX: 40,
  baseKBreakpoints: [
    [2000, 48],
    [4000, 40],
    [6000, 32],
    [7000, 24],
    [8000, 12],
    [9000, 10],
    [10000, 8],
    [Number.POSITIVE_INFINITY, 6],
  ],
  softCeilingStart: 7000,
  softCeilingLambda: 1 / 2000,
};

export const COIN_CAPS_BY_RANK: Record<string, number[]> = {
  "Unranked": [2000, 1500, 1200, 900, 900, 900, 900, 900],
  "Bronze I": [2200, 1650, 1300, 1000, 1000, 1000, 1000, 1000],
  "Bronze II": [2500, 1900, 1500, 1100, 1100, 1100, 1100, 1100],
  "Bronze III": [2800, 2100, 1700, 1300, 1300, 1300, 1300, 1300],
  "Silver I": [3100, 2300, 1900, 1400, 1400, 1400, 1400, 1400],
  "Silver II": [3500, 2600, 2100, 1600, 1600, 1600, 1600, 1600],
  "Silver III": [3900, 2900, 2300, 1800, 1800, 1800, 1800, 1800],
  "Gold I": [4300, 3200, 2600, 1900, 1900, 1900, 1900, 1900],
  "Gold II": [4800, 3600, 2900, 2200, 2200, 2200, 2200, 2200],
  "Gold III": [5400, 4100, 3200, 2400, 2400, 2400, 2400, 2400],
  "Platinum I": [6000, 4500, 3600, 2700, 2700, 2700, 2700, 2700],
  "Platinum II": [6700, 5000, 4000, 3000, 3000, 3000, 3000, 3000],
  "Platinum III": [7500, 5600, 4500, 3400, 3400, 3400, 3400, 3400],
  "Diamond I": [8400, 6300, 5000, 3800, 3800, 3800, 3800, 3800],
  "Diamond II": [9400, 7100, 5600, 4200, 4200, 4200, 4200, 4200],
  "Diamond III": [10500, 7900, 6300, 4700, 4700, 4700, 4700, 4700],
  "Master I": [11800, 8900, 7100, 5300, 5300, 5300, 5300, 5300],
  "Master II": [13200, 9900, 7900, 5900, 5900, 5900, 5900, 5900],
  "Master III": [14800, 11100, 8900, 6600, 6600, 6600, 6600, 6600],
  "Champion I": [16600, 12400, 10000, 7500, 7500, 7500, 7500, 7500],
  "Champion II": [18600, 14000, 11200, 8400, 8400, 8400, 8400, 8400],
  "Champion III": [20900, 15700, 12500, 9400, 9400, 9400, 9400, 9400],
  "Ascendant I": [23400, 17600, 14000, 10500, 10500, 10500, 10500, 10500],
  "Ascendant II": [26200, 19700, 15700, 11800, 11800, 11800, 11800, 11800],
  "Ascendant III": [29400, 22100, 17600, 13200, 13200, 13200, 13200, 13200],
  "Hypersonic I": [32900, 24700, 19700, 14800, 14800, 14800, 14800, 14800],
  "Hypersonic II": [36900, 27700, 22100, 16600, 16600, 16600, 16600, 16600],
  "Hypersonic III": [41300, 31000, 24800, 18600, 18600, 18600, 18600, 18600],
};

const EXP_PLACE_MULTS = [1.2, 1.142857, 1.085714, 1.028571, 0.971429, 0.914286, 0.857143, 0.8];

const expBaseForRank = (rankLabel: string, baseMin: number, baseMax: number): number => {
  const idx = Math.max(0, RANK_LABELS.indexOf(rankLabel));
  const steps = Math.max(1, RANK_LABELS.length - 1);
  return baseMin + (baseMax - baseMin) * (idx / steps);
};

export const EXP_CAPS_BY_RANK: Record<string, number[]> = Object.fromEntries(
  RANK_LABELS.map((label) => [
    label,
    EXP_PLACE_MULTS.map((mult) => Math.round(expBaseForRank(label, 100, 208) * mult)),
  ]),
);

export const DEFAULT_COIN_CONFIG: CoinConfig = {
  rankMaxByPlace: COIN_CAPS_BY_RANK,
  difficultyFloor: 0.85,
  difficultyCeiling: 1.15,
  roundTo: 100,
  boosterMultiplier: 1,
};

export const DEFAULT_EXP_CONFIG: ExpConfig = {
  baseMin: 100,
  baseMax: 208,
  posMinMult: 0.8,
  posMaxMult: 1.2,
  boosterMultiplier: 1,
  rankPlaceCaps: EXP_CAPS_BY_RANK,
};

interface PrecomputedPlayerState {
  K: number;
  H: number;
  w: number[];
  E: number[];
}

const baseK = (rating: number, cfg: TrophyConfig): number => {
  for (const [bound, value] of cfg.baseKBreakpoints) {
    if (rating < bound) {
      return value;
    }
  }
  return cfg.baseKBreakpoints[cfg.baseKBreakpoints.length - 1][1];
};

const highRankDamping = (rating: number, cfg: TrophyConfig): number => {
  const over = Math.max(0, rating - cfg.softCeilingStart);
  return Math.exp(-cfg.softCeilingLambda * over);
};

const expectedScore = (ra: number, rb: number, cfg: TrophyConfig): number =>
  1 / (1 + Math.pow(10, (rb - ra) / cfg.D));

const precomputeForPlayer = (index: number, ratings: number[], cfg: TrophyConfig): PrecomputedPlayerState => {
  const ri = ratings[index];
  const rawWeights = new Array(ratings.length).fill(0);
  let totalWeight = 0;
  for (let j = 0; j < ratings.length; j += 1) {
    if (j === index) {
      continue;
    }
    const dist = Math.abs(ratings[j] - ri);
    const weight = Math.max(cfg.W_MIN, Math.exp(-dist / cfg.TAU));
    rawWeights[j] = weight;
    totalWeight += weight;
  }

  let normalizedWeights: number[];
  if (totalWeight > 0) {
    normalizedWeights = rawWeights.map((w, j) => (j === index ? 0 : w / totalWeight));
  } else {
    const share = ratings.length > 1 ? 1 / (ratings.length - 1) : 0;
    normalizedWeights = rawWeights.map((_, j) => (j === index ? 0 : share));
  }

  const expectations = ratings.map((_, j) => (j === index ? 0 : expectedScore(ri, ratings[j], cfg)));
  return {
    K: baseK(ri, cfg),
    H: highRankDamping(ri, cfg),
    w: normalizedWeights,
    E: expectations,
  };
};

const deltaAtFinish = (
  index: number,
  finishOrder: number[],
  precomputed: PrecomputedPlayerState,
  cfg: TrophyConfig,
  placeIndexOverride?: number,
): number => {
  const { K, H, w, E } = precomputed;
  let placeIndex = finishOrder.indexOf(index);
  if (placeIndex === -1) {
    if (typeof placeIndexOverride === "number") {
      placeIndex = placeIndexOverride;
    } else {
      throw new Error("finishOrder missing player index");
    }
  }
  const finishedBefore = new Set(finishOrder.slice(0, placeIndex));
  let total = 0;
  for (let j = 0; j < w.length; j += 1) {
    if (j === index) continue;
    const sij = finishedBefore.has(j) ? 0 : 1;
    let delta = K * H * w[j] * (sij - E[j]);
    if (delta > cfg.PER_PAIR_CLIP) delta = cfg.PER_PAIR_CLIP;
    if (delta < -cfg.PER_PAIR_CLIP) delta = -cfg.PER_PAIR_CLIP;
    total += delta;
  }
  let rounded = Math.round(total);
  if (rounded < cfg.CLAMP_MIN) rounded = cfg.CLAMP_MIN;
  if (rounded > cfg.CLAMP_MAX) rounded = cfg.CLAMP_MAX;
  return rounded;
};

export const calculateTrophies = (
  playerIndex: number,
  finishOrder: number[],
  ratings: number[],
  cfg: TrophyConfig,
  placeIndexOverride?: number,
): number => {
  const pre = precomputeForPlayer(playerIndex, ratings, cfg);
  return deltaAtFinish(playerIndex, finishOrder, pre, cfg, placeIndexOverride);
};

const avgExpectedVsLobby = (playerIndex: number, ratings: number[], cfg: TrophyConfig): number => {
  const pre = precomputeForPlayer(playerIndex, ratings, cfg);
  return pre.w.reduce((sum, weight, idx) => (idx === playerIndex ? sum : sum + weight * pre.E[idx]), 0);
};

const difficultyMultiplier = (avgE: number, floor: number, ceiling: number): number => {
  const clamped = Math.max(0, Math.min(1, avgE));
  const normalized = Math.max(-0.5, Math.min(0.5, 0.5 - clamped)) / 0.5;
  if (normalized >= 0) {
    return 1 + normalized * (ceiling - 1);
  }
  return 1 + normalized * (1 - floor);
};

export const calculateCoins = (
  rankLabel: string,
  place: number,
  lobbyRatings: number[],
  playerIndex: number,
  coinCfg: CoinConfig,
  trophyCfg: TrophyConfig,
): number => {
  const caps = coinCfg.rankMaxByPlace[rankLabel];
  if (!caps || place < 1 || place > caps.length) {
    throw new Error(`Missing coin caps for rank ${rankLabel}`);
  }
  const maxForPlace = caps[place - 1];
  const avgE = avgExpectedVsLobby(playerIndex, lobbyRatings, trophyCfg);
  const mult = difficultyMultiplier(avgE, coinCfg.difficultyFloor, coinCfg.difficultyCeiling);
  const raw = maxForPlace * mult * coinCfg.boosterMultiplier;
  const rounded = Math.round(raw / coinCfg.roundTo) * coinCfg.roundTo;
  return Math.max(0, rounded);
};

export const calculateExp = (
  trophies: number,
  place: number,
  totalPositions: number,
  cfg: ExpConfig,
  rankLabel?: string,
): number => {
  if (cfg.rankPlaceCaps && rankLabel) {
    const caps = cfg.rankPlaceCaps[rankLabel];
    if (!caps || place < 1 || place > caps.length) {
      throw new Error(`Missing EXP caps for rank ${rankLabel}`);
    }
    return Math.max(0, Math.round(caps[place - 1] * cfg.boosterMultiplier));
  }

  const t = Math.max(0, Math.min(1, trophies / 7000));
  const base = cfg.baseMin + (cfg.baseMax - cfg.baseMin) * t;
  let posMult = 1;
  if (totalPositions > 1) {
    const frac = (place - 1) / (totalPositions - 1);
    posMult = cfg.posMaxMult + (cfg.posMinMult - cfg.posMaxMult) * frac;
  }
  return Math.max(0, Math.round(base * posMult * cfg.boosterMultiplier));
};

const syntheticLastPlaceFinishOrder = (count: number, playerIndex: number): number[] => {
  const order: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (i !== playerIndex) order.push(i);
  }
  order.push(playerIndex);
  return order;
};

export const calculateLastPlaceDelta = (
  playerIndex: number,
  ratings: number[],
  cfg: TrophyConfig,
): number => {
  const order = syntheticLastPlaceFinishOrder(ratings.length, playerIndex);
  return calculateTrophies(playerIndex, order, ratings, cfg);
};

export interface RaceSettlement {
  actualTrophiesDelta: number;
  settlementDelta: number;
}

export const settleTrophiesAfterFinish = (
  playerIndex: number,
  finishOrder: number[],
  ratings: number[],
  cfg: TrophyConfig,
  lastPlaceDeltaApplied: number,
  placeIndexOverride?: number,
): RaceSettlement => {
  const actual = calculateTrophies(playerIndex, finishOrder, ratings, cfg, placeIndexOverride);
  return {
    actualTrophiesDelta: actual,
    settlementDelta: actual - lastPlaceDeltaApplied,
  };
};

export interface RaceInputsWithPrededuction {
  playerIndex: number;
  finishOrder: number[];
  ratings: number[];
  place: number;
  totalPositions: number;
  hasCoinBooster?: boolean;
  hasExpBooster?: boolean;
  lastPlaceDeltaApplied: number;
  placeIndexForI?: number;
}

export interface RaceRewardsWithSettlement {
  trophiesActual: number;
  trophiesSettlement: number;
  coins: number;
  exp: number;
  baseCoins: number;
  boosterCoins: number;
  baseXp: number;
  boosterXp: number;
  oldRank: string;
  newRank: string;
  promoted: boolean;
  demoted: boolean;
  preDeductedLast: number;
}

const rankIndex = (label: string): number => {
  const idx = RANK_LABELS.indexOf(label);
  return idx >= 0 ? idx : 0;
};

export const computeRaceRewardsWithPrededuction = (
  input: RaceInputsWithPrededuction,
  trophyCfg: TrophyConfig,
  coinCfg: CoinConfig,
  expCfg: ExpConfig,
): RaceRewardsWithSettlement => {
  const oldTrophies = input.ratings[input.playerIndex] ?? 0;
  const oldRank = getRankForTrophies(oldTrophies);

  // Calculate base coins (multiplier = 1)
  const coinCfgBase: CoinConfig = {
    ...coinCfg,
    boosterMultiplier: 1,
  };

  const baseCoins = calculateCoins(
    oldRank,
    input.place,
    input.ratings,
    input.playerIndex,
    coinCfgBase,
    trophyCfg,
  );

  // Calculate total coins (with actual multiplier)
  const coinCfgLocal: CoinConfig = {
    ...coinCfg,
    boosterMultiplier: input.hasCoinBooster ? 2 : 1,
  };

  const coins = calculateCoins(
    oldRank,
    input.place,
    input.ratings,
    input.playerIndex,
    coinCfgLocal,
    trophyCfg,
  );

  const boosterCoins = coins - baseCoins;

  // Calculate base XP (multiplier = 1)
  const expCfgBase: ExpConfig = {
    ...expCfg,
    rankPlaceCaps: expCfg.rankPlaceCaps ?? EXP_CAPS_BY_RANK,
    boosterMultiplier: 1,
  };

  const baseXp = calculateExp(
    oldTrophies,
    input.place,
    input.totalPositions,
    expCfgBase,
    oldRank,
  );

  // Calculate total XP (with actual multiplier)
  const expCfgLocal: ExpConfig = {
    ...expCfg,
    rankPlaceCaps: expCfg.rankPlaceCaps ?? EXP_CAPS_BY_RANK,
    boosterMultiplier: input.hasExpBooster ? 2 : 1,
  };

  const exp = calculateExp(
    oldTrophies,
    input.place,
    input.totalPositions,
    expCfgLocal,
    oldRank,
  );

  const boosterXp = exp - baseXp;

  const settlement = settleTrophiesAfterFinish(
    input.playerIndex,
    input.finishOrder,
    input.ratings,
    trophyCfg,
    input.lastPlaceDeltaApplied,
    input.placeIndexForI,
  );

  const newTrophies = oldTrophies + settlement.settlementDelta;
  const newRank = getRankForTrophies(newTrophies);

  return {
    trophiesActual: settlement.actualTrophiesDelta,
    trophiesSettlement: settlement.settlementDelta,
    coins,
    exp,
    baseCoins,
    boosterCoins,
    baseXp,
    boosterXp,
    oldRank,
    newRank,
    promoted: rankIndex(newRank) > rankIndex(oldRank),
    demoted: rankIndex(newRank) < rankIndex(oldRank),
    preDeductedLast: input.lastPlaceDeltaApplied,
  };
};

export const toMillis = (value: unknown): number => {
  if (typeof value === "number") {
    return value;
  }
  if (value instanceof Timestamp) {
    return value.toMillis();
  }
  if (value && typeof (value as { toMillis?: () => number }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
