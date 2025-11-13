import { admin } from "./setup";
import { wrapCallable } from "./helpers/callable";
import {
  getGlobalLeaderboard,
  searchPlayer,
  sendFriendRequest,
  acceptFriendRequest,
  rejectFriendRequest,
  cancelFriendRequest,
  viewPlayerProfile,
  getFriends,
  getFriendRequests,
  refreshLeaderboards,
} from "../src/Socials";
import { wipeFirestore, wipeAuth, seedMinimalPlayer } from "./helpers/cleanup";

const authFor = (uid: string) => ({
  auth: { uid, token: { firebase: { sign_in_provider: "anonymous" } } },
});

const seedProfile = async (
  uid: string,
  profile: Record<string, unknown>,
) => {
  await admin
    .firestore()
    .doc(`Players/${uid}/Profile/Profile`)
    .set(profile, { merge: true });
};

const seedSearchIndex = async (uid: string, displayName: string, trophies = 0) => {
  const shard = displayName[0]?.toLowerCase() ?? "#";
  await admin
    .firestore()
    .collection("SearchIndex")
    .doc("Players")
    .collection(/[a-z]/.test(shard) ? shard : "#")
    .doc(uid)
    .set({
      uid,
      displayNameLower: displayName.toLowerCase(),
      trophies,
      level: 10,
      clanSummary: null,
    });
  await admin.firestore().collection("Usernames").doc(displayName.toLowerCase()).set({
    uid,
  });
};

describe("social functions", () => {
  let alice: string;
  let bob: string;
  let carol: string;

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    alice = `uid_alice_${Date.now()}`;
    bob = `uid_bob_${Date.now()}`;
    carol = `uid_carol_${Date.now()}`;

    await Promise.all([seedMinimalPlayer(alice), seedMinimalPlayer(bob), seedMinimalPlayer(carol)]);

    await seedProfile(alice, {
      displayName: "Alice",
      trophies: 4200,
      careerCoins: 9000,
      totalWins: 30,
      avatarId: 2,
      level: 15,
    });
    await seedProfile(bob, {
      displayName: "Bob",
      trophies: 3800,
      careerCoins: 6400,
      totalWins: 22,
      avatarId: 3,
      level: 12,
    });
    await seedProfile(carol, {
      displayName: "Carol",
      trophies: 1500,
      careerCoins: 2100,
      totalWins: 8,
      avatarId: 5,
      level: 6,
    });
  });

  describe("leaderboards", () => {
    it("returns paginated results with caller summary", async () => {
      await refreshLeaderboards();
      const wrapped = wrapCallable(getGlobalLeaderboard);
      const firstPage = await wrapped({
        data: { metric: "trophies", pageSize: 2 },
        ...authFor(alice),
      });

      expect(firstPage.ok).toBe(true);
      expect(firstPage.data.entries).toHaveLength(2);
      expect(firstPage.data.you.player.uid).toEqual(alice);
      expect(firstPage.players).toHaveLength(2);

      const token = firstPage.data.pageToken;
      expect(typeof token === "string" || token === null).toBe(true);

      if (token) {
        const secondPage = await wrapped({
          data: { metric: "trophies", pageToken: token, pageSize: 2 },
          ...authFor(alice),
        });
        expect(secondPage.data.entries.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("rejects invalid metric inputs", async () => {
      await refreshLeaderboards();
      const wrapped = wrapCallable(getGlobalLeaderboard);
      await expect(
        wrapped({ data: { metric: "unknown" }, ...authFor(alice) }),
      ).rejects.toBeTruthy();
    });
  });

  describe("search", () => {
    beforeEach(async () => {
      await Promise.all([
        seedSearchIndex(alice, "AliceWonder", 4200),
        seedSearchIndex(bob, "BobBuilder", 3800),
        seedSearchIndex(carol, "CarolRacer", 1500),
      ]);
    });

    it("performs prefix search with pagination", async () => {
      const wrapped = wrapCallable(searchPlayer);
      const response = await wrapped({
        data: { query: "bo", pageSize: 1 },
        ...authFor(alice),
      });
      expect(response.ok).toBe(true);
      expect(response.data.results[0].uid).toEqual(bob);
      if (response.data.pageToken) {
        const next = await wrapped({
          data: { query: "bo", pageToken: response.data.pageToken },
          ...authFor(alice),
        });
        expect(Array.isArray(next.data.results)).toBe(true);
      }
    });

    it("falls back to exact username match when index empty", async () => {
      await admin
        .firestore()
        .collection("SearchIndex")
        .doc("Players")
        .collection("c")
        .doc(carol)
        .delete();

      const wrapped = wrapCallable(searchPlayer);
      const result = await wrapped({
        data: { query: "carolracer" },
        ...authFor(bob),
      });
      expect(result.player.uid).toEqual(carol);
    });

    it("enforces minimum query length", async () => {
      const wrapped = wrapCallable(searchPlayer);
      await expect(
        wrapped({ data: { query: "a" }, ...authFor(alice) }),
      ).rejects.toBeTruthy();
    });
  });

  describe("friend requests", () => {
    it("sends and accepts friend requests idempotently", async () => {
      const sendWrapped = wrapCallable(sendFriendRequest);
      const acceptWrapped = wrapCallable(acceptFriendRequest);

      const first = await sendWrapped({
        data: { opId: "op-send", targetUid: bob, message: "hey" },
        ...authFor(alice),
      });
      expect(first.data.status).toEqual("pending");

       const bobRequestsDoc = await admin.firestore().doc(`Players/${bob}/Social/Requests`).get();
       const bobIncoming = (bobRequestsDoc.data()?.incoming ?? []) as Array<{ player?: any }>;
       expect(bobIncoming[0]?.player?.uid).toEqual(alice);
       expect(bobIncoming[0]?.player?.displayName).toEqual("Alice");

      const replay = await sendWrapped({
        data: { opId: "op-send", targetUid: bob },
        ...authFor(alice),
      });
      expect(replay.data.requestId).toEqual(first.data.requestId);

      const accept = await acceptWrapped({
        data: { opId: "op-accept", requestId: first.data.requestId },
        ...authFor(bob),
      });
      expect(accept.data.friend.uid).toEqual(alice);

      const friendsDoc = await admin.firestore().doc(`Players/${alice}/Social/Friends`).get();
      expect(friendsDoc.data()?.friends?.[bob]?.player?.uid).toEqual(bob);
    });

    it("rejects and cancels requests", async () => {
      const sendWrapped = wrapCallable(sendFriendRequest);
      const rejectWrapped = wrapCallable(rejectFriendRequest);
      const cancelWrapped = wrapCallable(cancelFriendRequest);

      const request = await sendWrapped({
        data: { opId: "op-reject", targetUid: bob },
        ...authFor(alice),
      });
      const targetDoc = await admin.firestore().doc(`Players/${bob}/Social/Requests`).get();
      expect(targetDoc.data()?.incoming?.[0]?.player?.uid).toEqual(alice);
      await rejectWrapped({
        data: { opId: "op-reject-run", requestId: request.data.requestId },
        ...authFor(bob),
      });
      const bobRequests = await admin.firestore().doc(`Players/${bob}/Social/Requests`).get();
      expect((bobRequests.data()?.incoming ?? []).length).toEqual(0);

      const second = await sendWrapped({
        data: { opId: "op-cancel", targetUid: carol },
        ...authFor(alice),
      });
      const carolReqDoc = await admin.firestore().doc(`Players/${carol}/Social/Requests`).get();
      expect(carolReqDoc.data()?.incoming?.[0]?.player?.uid).toEqual(alice);
      await cancelWrapped({
        data: { opId: "op-cancel-run", requestId: second.data.requestId },
        ...authFor(alice),
      });
      const carolRequests = await admin.firestore().doc(`Players/${carol}/Social/Requests`).get();
      expect((carolRequests.data()?.incoming ?? []).length).toEqual(0);
    });
  });

  describe("friends & request listings", () => {
    it("returns live player data for pending requests", async () => {
      const sendWrapped = wrapCallable(sendFriendRequest);
      const requestsWrapped = wrapCallable(getFriendRequests);

      const request = await sendWrapped({
        data: { opId: "op-live-req", targetUid: bob },
        ...authFor(alice),
      });
      expect(request.data.requestId).toBeTruthy();

      await seedProfile(alice, { displayName: "AliceNew", trophies: 9999 });

      const response = await requestsWrapped({
        data: {},
        ...authFor(bob),
      });
      expect(response.ok).toBe(true);
      expect(response.data.incoming[0].player.displayName).toEqual("AliceNew");
      expect(response.data.incoming[0].player.trophies).toEqual(9999);
    });

    it("returns live player data for accepted friends", async () => {
      const sendWrapped = wrapCallable(sendFriendRequest);
      const acceptWrapped = wrapCallable(acceptFriendRequest);
      const friendsWrapped = wrapCallable(getFriends);

      const request = await sendWrapped({
        data: { opId: "op-live-friend", targetUid: bob },
        ...authFor(alice),
      });
      await acceptWrapped({
        data: { opId: "op-live-friend-accept", requestId: request.data.requestId },
        ...authFor(bob),
      });

      await seedProfile(bob, { displayName: "BobNew", trophies: 7777 });

      const response = await friendsWrapped({
        data: {},
        ...authFor(alice),
      });
      expect(response.ok).toBe(true);
      const friend = response.data.friends.find((entry: any) => entry.player.uid === bob);
      expect(friend).toBeTruthy();
      expect(friend.player.displayName).toEqual("BobNew");
      expect(friend.player.trophies).toEqual(7777);
    });
  });

  describe("view profile", () => {
    it("returns public profile fields and social stats", async () => {
      const wrapped = wrapCallable(viewPlayerProfile);
      const response = await wrapped({
        data: { uid: alice },
        ...authFor(bob),
      });
      expect(response.ok).toBe(true);
      expect(response.data.player.uid).toEqual(alice);
      expect(response.data.stats.trophies).toBeGreaterThan(0);
      expect(response.data.social.friendsCount).toBeGreaterThanOrEqual(0);
    });
  });
});
