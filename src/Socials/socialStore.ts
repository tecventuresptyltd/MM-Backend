import * as admin from "firebase-admin";
import {
  socialProfileRef,
  socialFriendsRef,
  socialRequestsRef,
  socialBlocksRef,
} from "./refs.js";
import type {
  BlocksDoc,
  FriendEntry,
  FriendsDoc,
  FriendRequestIncoming,
  FriendRequestOutgoing,
  RequestsDoc,
  SocialProfileDoc,
} from "./types.js";

export interface SocialSnapshot {
  profile: SocialProfileDoc;
  friends: Record<string, FriendEntry>;
  requests: {
    incoming: FriendRequestIncoming[];
    outgoing: FriendRequestOutgoing[];
  };
  blocks: Record<string, boolean>;
}

const DEFAULT_SOCIAL_SNAPSHOT: SocialSnapshot = {
  profile: {
    friendsCount: 0,
    hasFriendRequests: false,
    referralCode: null,
    lastActiveAt: null,
  },
  friends: {},
  requests: {
    incoming: [],
    outgoing: [],
  },
  blocks: {},
};

const parseFriendsDoc = (doc: FirebaseFirestore.DocumentSnapshot): Record<string, FriendEntry> => {
  if (!doc.exists) {
    return {};
  }
  const data = doc.data() as FriendsDoc;
  return data?.friends && typeof data.friends === "object" ? { ...data.friends } : {};
};

const parseRequestsDoc = (
  doc: FirebaseFirestore.DocumentSnapshot,
): { incoming: FriendRequestIncoming[]; outgoing: FriendRequestOutgoing[] } => {
  if (!doc.exists) {
    return { incoming: [], outgoing: [] };
  }
  const data = doc.data() as RequestsDoc;
  const incoming = Array.isArray(data?.incoming) ? [...data.incoming] : [];
  const outgoing = Array.isArray(data?.outgoing) ? [...data.outgoing] : [];
  return { incoming, outgoing };
};

const parseBlocksDoc = (doc: FirebaseFirestore.DocumentSnapshot): Record<string, boolean> => {
  if (!doc.exists) {
    return {};
  }
  const data = doc.data() as BlocksDoc;
  if (!data?.blocked) {
    return {};
  }
  const result: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(data.blocked)) {
    if (value === true) {
      result[key] = true;
    }
  }
  return result;
};

export const readSocialSnapshot = async (
  uid: string,
  transaction: admin.firestore.Transaction,
): Promise<SocialSnapshot> => {
  const [profileDoc, friendsDoc, requestsDoc, blocksDoc] = await Promise.all([
    transaction.get(socialProfileRef(uid)),
    transaction.get(socialFriendsRef(uid)),
    transaction.get(socialRequestsRef(uid)),
    transaction.get(socialBlocksRef(uid)),
  ]);

  return {
    profile: profileDoc.exists ? ((profileDoc.data() ?? {}) as SocialProfileDoc) : { ...DEFAULT_SOCIAL_SNAPSHOT.profile },
    friends: parseFriendsDoc(friendsDoc),
    requests: parseRequestsDoc(requestsDoc),
    blocks: parseBlocksDoc(blocksDoc),
  };
};

export const readFriendsDoc = async (
  uid: string,
  transaction: admin.firestore.Transaction,
): Promise<Record<string, FriendEntry>> => {
  const snapshot = await transaction.get(socialFriendsRef(uid));
  return parseFriendsDoc(snapshot);
};

export const writeFriendsDoc = (
  transaction: admin.firestore.Transaction,
  uid: string,
  friends: Record<string, FriendEntry>,
): void => {
  transaction.set(
    socialFriendsRef(uid),
    { friends, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true },
  );
};

export const writeRequestsDoc = (
  transaction: admin.firestore.Transaction,
  uid: string,
  incoming: FriendRequestIncoming[],
  outgoing: FriendRequestOutgoing[],
): void => {
  transaction.set(
    socialRequestsRef(uid),
    { incoming, outgoing, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true },
  );
};

export const updateSocialProfile = (
  transaction: admin.firestore.Transaction,
  uid: string,
  patch: Partial<SocialProfileDoc>,
): void => {
  transaction.set(
    socialProfileRef(uid),
    {
      ...patch,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
};
