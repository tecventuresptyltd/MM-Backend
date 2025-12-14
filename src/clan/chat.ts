import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onValueDeleted } from "firebase-functions/v2/database";
import { REGION } from "../shared/region.js";
import { clansCollection, playerProfileRef } from "./helpers.js";
import { roomsCollection, roomRef } from "../chat/rooms.js";

const rtdb = () => admin.database();
const { FieldValue } = admin.firestore;

const CLAN_CHAT_ROOT = "chat_messages/clans";
const GLOBAL_CHAT_ROOT = "chat_messages/global";

export const CLAN_CHAT_HISTORY_FETCH = 200;
const CLAN_CHAT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CLAN_CHAT_PRUNE_BATCH = 200;
export const GLOBAL_CHAT_HISTORY_FETCH = 100;
const GLOBAL_CHAT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

export const clanChatMessagesRef = (clanId: string) => rtdb().ref(`${CLAN_CHAT_ROOT}/${clanId}`);
export const globalChatMessagesRef = (roomId: string) => rtdb().ref(`${GLOBAL_CHAT_ROOT}/${roomId}`);

export interface ChatRTDBMessage {
  u: string | null;
  n: string;
  type: "text" | "system";
  m?: string;
  payload?: Record<string, unknown> | null;
  c?: string | null;
  cid?: string | null;
  av?: number | null;
  tr?: number | null;
  cl?: string | null;
  clientCreatedAt?: string | null;
  role?: string | null;
  op?: string | null;
  ts?: number | object;
}

const pushMessageToRef = async (
  ref: admin.database.Reference,
  message: ChatRTDBMessage,
): Promise<string | null> => {
  const pushRef = ref.push();
  const payload = {
    ...message,
    ts: message.ts ?? admin.database.ServerValue.TIMESTAMP,
  };
  await pushRef.set(payload);
  return pushRef.key;
};

export const pushClanChatMessage = async (
  clanId: string,
  message: ChatRTDBMessage,
): Promise<string | null> => pushMessageToRef(clanChatMessagesRef(clanId), message);

export const pushGlobalChatMessage = async (
  roomId: string,
  message: ChatRTDBMessage,
): Promise<string | null> => pushMessageToRef(globalChatMessagesRef(roomId), message);

export const pushSystemGlobalMessage = async (roomId: string, text: string) =>
  pushGlobalChatMessage(roomId, {
    u: null,
    n: "System",
    type: "system",
    m: text,
  });

export interface SystemMessageAuthorSnapshot {
  uid: string | null;
  displayName: string;
  avatarId: number | null;
  trophies: number | null;
  role?: string | null;
}

export const pushClanSystemMessage = async (
  clanId: string,
  text: string,
  payload?: Record<string, unknown>,
  author?: SystemMessageAuthorSnapshot | null,
): Promise<string | null> =>
  pushClanChatMessage(clanId, {
    u: author?.uid ?? null,
    n: author?.displayName ?? "System",
    av: author?.avatarId ?? null,
    tr: author?.trophies ?? null,
    role: author?.role ?? null,
    type: "system",
    m: text,
    payload: payload ?? null,
  });

export interface PendingClanSystemMessage {
  clanId: string;
  text: string;
  payload?: Record<string, unknown>;
  author?: SystemMessageAuthorSnapshot | null;
}

export const publishClanSystemMessages = async (messages: PendingClanSystemMessage[]) => {
  if (!messages || messages.length === 0) {
    return;
  }
  await Promise.all(
    messages.map((msg) => pushClanSystemMessage(msg.clanId, msg.text, msg.payload, msg.author)),
  );
};

const pruneChatHistory = async (path: string, cutoffMs: number): Promise<number> => {
  let pruned = 0;
  const ref = rtdb().ref(path);
  while (true) {
    const snapshot = await ref.orderByChild("ts").endAt(cutoffMs).limitToFirst(CLAN_CHAT_PRUNE_BATCH).get();
    if (!snapshot.exists()) {
      break;
    }
    const updates: Record<string, null> = {};
    let batchCount = 0;
    snapshot.forEach((child) => {
      const key = child.key;
      if (key) {
        updates[`${path}/${key}`] = null;
        batchCount += 1;
      }
    });
    if (batchCount === 0) {
      break;
    }
    await rtdb().ref().update(updates);
    pruned += batchCount;
    if (batchCount < CLAN_CHAT_PRUNE_BATCH) {
      break;
    }
  }
  return pruned;
};

export const cleanupChatHistory = onSchedule(
  {
    region: REGION,
    schedule: "every 24 hours",
    timeZone: "Etc/UTC",
  },
  async () => {
    const now = Date.now();
    const clanCutoff = now - CLAN_CHAT_RETENTION_MS;
    const globalCutoff = now - GLOBAL_CHAT_RETENTION_MS;

    const clanSnapshot = await clansCollection().select("clanId").get();
    let totalClanPruned = 0;
    for (const doc of clanSnapshot.docs) {
      const clanId = (doc.data()?.clanId as string) || doc.id;
      totalClanPruned += await pruneChatHistory(`${CLAN_CHAT_ROOT}/${clanId}`, clanCutoff);
    }

    const roomsSnapshot = await roomsCollection()
      .where("type", "==", "global")
      .select("roomId")
      .get();
    let totalGlobalPruned = 0;
    for (const doc of roomsSnapshot.docs) {
      const roomId = (doc.data()?.roomId as string) || doc.id;
      totalGlobalPruned += await pruneChatHistory(`${GLOBAL_CHAT_ROOT}/${roomId}`, globalCutoff);
    }

    console.log(
      `[cleanupChatHistory] pruned ${totalClanPruned} clan messages and ${totalGlobalPruned} global messages`,
    );
  },
);

export const onPresenceOffline = onValueDeleted(
  {
    region: REGION,
    ref: "presence/online/{uid}",
  },
  async (event) => {
    const uid = event.params.uid;
    if (!uid) {
      return;
    }
    try {
      // Get roomId from the presence data that was just deleted
      const presenceData = event.data.val();
      const roomId = typeof presenceData?.roomId === "string" ? presenceData.roomId : null;
      if (!roomId || roomId.length === 0) {
        return;
      }
      await admin.firestore().runTransaction(async (transaction) => {
        const ref = roomRef(roomId);
        const snap = await transaction.get(ref);
        if (!snap.exists) {
          return;
        }
        const current = Number(snap.data()?.connectedCount ?? 0);
        const next = Math.max(0, current - 1);
        transaction.update(ref, {
          connectedCount: next,
          updatedAt: FieldValue.serverTimestamp(),
          lastActivityAt: FieldValue.serverTimestamp(),
        });
      });
    } catch (error) {
      console.error("[chat.onPresenceOffline] failed to decrement room count", error);
    }
  },
);
