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
  callableOptions(),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "Authentication required.");
    }

    const snapshot = await socialFriendsRef(uid).get();
    const friendsData = snapshot.exists
      ? ((snapshot.data() ?? {}) as { friends?: Record<string, FriendEntry> }).friends ?? {}
      : {};
    const friendUids = Object.keys(friendsData);
    const liveSummaries = await getPlayerSummaries(friendUids);

    const friends = friendUids.map((friendUid) =>
      mergeFriendEntry(friendUid, friendsData[friendUid], liveSummaries.get(friendUid)),
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
  callableOptions(),
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
    const lookupUids = [
      ...incoming.map((entry) => entry.fromUid),
      ...outgoing.map((entry) => entry.toUid),
    ];
    const summaries = await getPlayerSummaries(lookupUids);

    return {
      ok: true,
      data: {
        incoming: incoming.map((entry) =>
          mergeRequestEntry(entry, summaries.get(entry.fromUid), entry.fromUid),
        ),
        outgoing: outgoing.map((entry) =>
          mergeRequestEntry(entry, summaries.get(entry.toUid), entry.toUid),
        ),
      },
    };
  },
);
