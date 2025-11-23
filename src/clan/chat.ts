import * as admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { REGION } from "../shared/region.js";
import { clansCollection } from "./helpers.js";

const rtdb = () => admin.database();

export const CLAN_CHAT_HISTORY_FETCH = 200;
const CLAN_CHAT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CLAN_CHAT_PRUNE_BATCH = 200;

export const clanChatMessagesRef = (clanId: string) => rtdb().ref(`chat_messages/${clanId}`);

export interface ClanChatRTDBMessage {
  u: string | null;
  n: string;
  type: "text" | "system";
  m?: string;
  payload?: Record<string, unknown> | null;
  c?: string | null;
  av?: number | null;
  tr?: number | null;
  cl?: string | null;
  clientCreatedAt?: string | null;
  op?: string | null;
  ts?: number | object;
}

export const pushClanChatMessage = async (
  clanId: string,
  message: ClanChatRTDBMessage,
): Promise<string | null> => {
  const ref = clanChatMessagesRef(clanId).push();
  const payload = {
    ...message,
    ts: message.ts ?? admin.database.ServerValue.TIMESTAMP,
  };
  await ref.set(payload);
  return ref.key;
};

export const pushClanSystemMessage = async (
  clanId: string,
  text: string,
  payload?: Record<string, unknown>,
): Promise<string | null> =>
  pushClanChatMessage(clanId, {
    u: null,
    n: "System",
    type: "system",
    m: text,
    payload: payload ?? null,
  });

export interface PendingClanSystemMessage {
  clanId: string;
  text: string;
  payload?: Record<string, unknown>;
}

export const publishClanSystemMessages = async (messages: PendingClanSystemMessage[]) => {
  if (!messages || messages.length === 0) {
    return;
  }
  await Promise.all(messages.map((msg) => pushClanSystemMessage(msg.clanId, msg.text, msg.payload)));
};

const pruneClanHistory = async (clanId: string, cutoffMs: number): Promise<number> => {
  let pruned = 0;
  const ref = clanChatMessagesRef(clanId);
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
        updates[`chat_messages/${clanId}/${key}`] = null;
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

export const cleanupClanChatHistory = onSchedule(
  {
    region: REGION,
    schedule: "every 24 hours",
    timeZone: "Etc/UTC",
  },
  async () => {
    const cutoff = Date.now() - CLAN_CHAT_RETENTION_MS;
    const snapshot = await clansCollection().select("clanId").get();
    let totalPruned = 0;
    for (const doc of snapshot.docs) {
      const clanId = (doc.data()?.clanId as string) || doc.id;
      totalPruned += await pruneClanHistory(clanId, cutoff);
    }
    console.log(`[cleanupClanChatHistory] pruned ${totalPruned} messages`);
  },
);
