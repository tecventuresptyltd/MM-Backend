import type * as admin from "firebase-admin";

export type LeaderboardMetric = "trophies" | "careerCoins" | "totalWins";

export const LEADERBOARD_METRICS: Record<
  LeaderboardMetric,
  { field: keyof PlayerProfileSeed; legacyType: number }
> = {
  trophies: { field: "trophies", legacyType: 1 },
  careerCoins: { field: "careerCoins", legacyType: 2 },
  totalWins: { field: "totalWins", legacyType: 3 },
};

export interface PlayerClanSummary {
  clanId: string;
  name: string;
  badge?: string | null;
}

export interface PlayerSummary {
  uid: string;
  displayName: string;
  avatarId: number;
  level: number;
  trophies: number;
  clan?: PlayerClanSummary | null;
}

export interface LeaderboardEntry {
  uid: string;
  value: number;
  rank: number;
  snapshot: PlayerSummary;
}

export interface LeaderboardDocument {
  metric: LeaderboardMetric;
  updatedAt: number;
  top100: LeaderboardEntry[];
  youCache?: Record<
    string,
    {
      rank: number;
      value: number;
    }
  >;
}

export interface PlayerProfileSeed {
  displayName?: string;
  avatarId?: number;
  level?: number;
  trophies?: number;
  highestTrophies?: number;
  careerCoins?: number;
  totalWins?: number;
  totalRaces?: number;
  clanId?: string | null;
}

export interface SocialProfileDoc {
  friendsCount?: number;
  hasFriendRequests?: boolean;
  referralCode?: string | null;
  lastActiveAt?: number | null;
  updatedAt?: admin.firestore.Timestamp | admin.firestore.FieldValue;
}

export interface FriendEntry {
  since: number;
  lastInteractedAt?: number | null;
  player?: PlayerSummary | null;
}

export interface FriendsDoc {
  friends?: Record<string, FriendEntry>;
  updatedAt?: admin.firestore.Timestamp | admin.firestore.FieldValue;
}

export interface FriendRequestIncoming {
  requestId: string;
  fromUid: string;
  sentAt: number;
  message?: string;
  player?: PlayerSummary | null;
}

export interface FriendRequestOutgoing {
  requestId: string;
  toUid: string;
  sentAt: number;
  message?: string;
  player?: PlayerSummary | null;
}

export interface RequestsDoc {
  incoming?: FriendRequestIncoming[];
  outgoing?: FriendRequestOutgoing[];
  updatedAt?: admin.firestore.Timestamp | admin.firestore.FieldValue;
}

export interface BlocksDoc {
  blocked?: Record<string, boolean>;
  updatedAt?: admin.firestore.Timestamp | admin.firestore.FieldValue;
}
