import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { db } from "../shared/firestore.js";
import { searchIndexShard } from "./refs.js";
import { getPlayerSummary } from "./summary.js";

const PAGE_MAX = 10;
const PAGE_DEFAULT = 10;

interface SearchCursorPayload {
  shard: string;
  displayNameLower: string;
  uid: string;
}

const normalizeQuery = (raw?: unknown): string => {
  if (typeof raw !== "string") {
    throw new HttpsError("invalid-argument", "query must be a string.");
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length < 2) {
    throw new HttpsError("invalid-argument", "query must be at least 2 characters long.");
  }
  return trimmed.slice(0, 32);
};

const resolvePageSize = (raw?: unknown): number => {
  if (raw === undefined || raw === null) {
    return PAGE_DEFAULT;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || value > PAGE_MAX) {
    throw new HttpsError(
      "invalid-argument",
      `pageSize must be between 1 and ${PAGE_MAX}.`,
    );
  }
  return Math.floor(value);
};

const shardFromQuery = (query: string): string => {
  const first = query.charAt(0);
  if (!first) {
    return "#";
  }
  return /[a-z]/.test(first) ? first : "#";
};

const encodeCursor = (payload: SearchCursorPayload): string =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

const decodeCursor = (token: string): SearchCursorPayload => {
  try {
    const payload = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8"),
    ) as SearchCursorPayload;
    if (
      typeof payload.shard !== "string" ||
      typeof payload.displayNameLower !== "string" ||
      typeof payload.uid !== "string"
    ) {
      throw new Error("invalid cursor");
    }
    return payload;
  } catch {
    throw new HttpsError("invalid-argument", "Invalid pageToken.");
  }
};

const fallbackByUsername = async (query: string) => {
  const usernameDoc = await db.collection("Usernames").doc(query).get();
  if (!usernameDoc.exists) {
    return null;
  }
  const data = usernameDoc.data() ?? {};
  const uid =
    typeof data.uid === "string" && data.uid.trim().length > 0 ? data.uid.trim() : null;
  if (!uid) {
    return null;
  }
  const summary = await getPlayerSummary(uid);
  return summary ? [summary] : null;
};

const baseResponse = (results: unknown[], pageToken: string | null, query: string) => ({
  ok: true,
  data: {
    query,
    results,
    pageToken,
  },
  success: true,
  results,
});

export const searchPlayer = onCall(
  callableOptions(),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const queryInput = request.data?.query ?? request.data?.name;
    const query = normalizeQuery(queryInput);
    const pageSize = resolvePageSize(request.data?.pageSize);
    const shardKey = shardFromQuery(query);
    const shard = searchIndexShard(shardKey);
    const prefixEnd = `${query}\uf8ff`;

    let search = shard
      .orderBy("displayNameLower")
      .orderBy(admin.firestore.FieldPath.documentId())
      .startAt(query)
      .endAt(prefixEnd)
      .limit(pageSize + 1);

    if (typeof request.data?.pageToken === "string") {
      const cursor = decodeCursor(request.data.pageToken);
      if (cursor.shard !== shardKey) {
        throw new HttpsError("invalid-argument", "Cursor does not match query.");
      }
      search = search.startAfter(cursor.displayNameLower, cursor.uid);
    }

    const snapshot = await search.get();
    const docs = snapshot.docs;
    const pageDocs = docs.slice(0, pageSize);
    const nextDoc = docs.length > pageSize ? docs[pageSize] : null;

    const summaries = (
      await Promise.all(
        pageDocs.map(async (doc) => {
          const data = doc.data() ?? {};
          const targetUid =
            typeof data.uid === "string" && data.uid.trim().length > 0
              ? data.uid.trim()
              : doc.id;
          return getPlayerSummary(targetUid);
        }),
      )
    ).filter((summary): summary is NonNullable<typeof summary> => Boolean(summary));

    const nextPageToken =
      nextDoc && nextDoc.exists
        ? encodeCursor({
            shard: shardKey,
            displayNameLower: String(nextDoc.get("displayNameLower") ?? ""),
            uid: nextDoc.get("uid") ?? nextDoc.id,
          })
        : null;

    if (summaries.length === 0) {
      const fallback = await fallbackByUsername(query);
      if (!fallback) {
        return { ok: false, success: false, message: "user not found" };
      }
      return {
        ...baseResponse(fallback, null, query),
        player: fallback[0],
      };
    }

    return baseResponse(summaries, nextPageToken, query);
  },
);

export const searchPlayers = searchPlayer;
