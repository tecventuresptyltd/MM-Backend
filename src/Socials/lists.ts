import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { socialFriendsRef, socialRequestsRef } from "./refs.js";
import { getPlayerSummaries } from "./summary.js";
import type { FriendEntry, FriendRequestIncoming, FriendRequestOutgoing, PlayerSummary } from "./types.js";

const fallbackSummary = (uid: string): PlayerSummary => ({
  uid,
  displayName: "Racer",
  avatarId: 1,
  level: 1,
  trophies: 0,
  clan: null,
});

const needsSummaryRefresh = (summary?: PlayerSummary | null): boolean =>
  !!summary?.clan && summary.clan.badge === undefined;

const mergeFriendEntry = (
  uid: string,
  entry: FriendEntry | undefined,
  summary: PlayerSummary | undefined,
): FriendEntry & { player: PlayerSummary } => ({
  since: entry?.since ?? 0,
  lastInteractedAt: entry?.lastInteractedAt ?? null,
  player: summary ?? entry?.player ?? fallbackSummary(uid),
});

const mergeRequestEntry = <
  T extends FriendRequestIncoming | FriendRequestOutgoing,
>(
  entry: T,
  summary: PlayerSummary | undefined,
  fallbackUid: string,
): T & { player: PlayerSummary } => ({
  ...entry,
  player: summary ?? entry.player ?? fallbackSummary(fallbackUid),
});

export const getFriends = onCall(
  callableOptions({}, true),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const snapshot = await socialFriendsRef(uid).get();
    const friendsData = snapshot.exists
      ? ((snapshot.data() ?? {}) as { friends?: Record<string, FriendEntry> }).friends ?? {}
      : {};
    const entries = Object.entries(friendsData);
    const missingSummaries = entries
      .filter(([, entry]) => !entry?.player || needsSummaryRefresh(entry.player))
      .map(([friendUid]) => friendUid);
    const liveSummaries =
      missingSummaries.length > 0
        ? await getPlayerSummaries(missingSummaries)
        : new Map();

    const friends = entries.map(([friendUid, entry]) =>
      mergeFriendEntry(friendUid, entry, liveSummaries.get(friendUid)),
    );

    return {
      ok: true,
      data: {
        friends,
      },
    };
  },
);

export const getFriendRequests = onCall(
  callableOptions({}, true),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const snapshot = await socialRequestsRef(uid).get();
    const data = snapshot.exists
      ? ((snapshot.data() ?? {}) as {
        incoming?: FriendRequestIncoming[];
        outgoing?: FriendRequestOutgoing[];
      })
      : {};
    const incoming = Array.isArray(data.incoming) ? data.incoming : [];
    const outgoing = Array.isArray(data.outgoing) ? data.outgoing : [];
    const missingIncoming = incoming
      .filter((entry) => !entry.player || needsSummaryRefresh(entry.player))
      .map((entry) => entry.fromUid);
    const missingOutgoing = outgoing
      .filter((entry) => !entry.player || needsSummaryRefresh(entry.player))
      .map((entry) => entry.toUid);
    const lookupUids = Array.from(new Set([...missingIncoming, ...missingOutgoing]));
    const summaries =
      lookupUids.length > 0 ? await getPlayerSummaries(lookupUids) : new Map<string, PlayerSummary>();

    return {
      ok: true,
      data: {
        incoming: incoming.map((entry) =>
          mergeRequestEntry(
            entry,
            summaries.get(entry.fromUid) ?? entry.player ?? undefined,
            entry.fromUid,
          ),
        ),
      },
    };
  },
);
