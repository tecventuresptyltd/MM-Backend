// functions/test/clan.test.ts
import { admin } from "./setup";
import { createClan, joinClan, leaveClan, requestToJoinClan } from "../src/clan";
import { wipeFirestore, wipeAuth, seedMinimalPlayer } from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";

describe("Clan Functions", () => {
  let uid: string;
  let clanId: string;
  const authFor = (uid: string) => ({ auth: { uid, token: { firebase: { sign_in_provider: "anonymous" } } } });

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    uid = `test-uid-${Date.now()}`;
    await seedMinimalPlayer(uid);
  });

  describe("createClan", () => {
    it("creates a new clan and sets the player as leader", async () => {
      const wrapped = wrapCallable(createClan);
      const response = await wrapped({
        data: {
          name: "Test Clan",
          tag: "TEST",
          type: "open",
          minimumTrophies: 100,
          opId: "op_create_clan",
        },
        ...authFor(uid),
      });
      clanId = response.clanId ?? response.data?.clanId;

      const clanDoc = await admin.firestore().doc(`Clans/${clanId}`).get();
      expect(clanDoc.exists).toBe(true);
      expect(clanDoc.data()?.name).toEqual("Test Clan");
      expect(clanDoc.data()?.stats.members).toEqual(1);

      const memberDoc = await admin.firestore().doc(`Clans/${clanId}/Members/${uid}`).get();
      expect(memberDoc.exists).toBe(true);
      expect(memberDoc.data()?.role).toEqual("leader");
      const playerProfileDoc = await admin.firestore().doc(`Players/${uid}/Profile/Profile`).get();
      expect(playerProfileDoc.data()?.clanId).toEqual(clanId);
    });
  });

  describe("joinClan and leaveClan", () => {
    beforeEach(async () => {
      const wrappedCreate = wrapCallable(createClan);
      const response = await wrappedCreate({
        data: {
          name: "Test Clan",
          tag: "TEST",
          type: "open",
          minimumTrophies: 0,
          opId: "op_create_clan_for_join",
        },
        ...authFor("another-user"),
      });
      clanId = response.clanId ?? response.data?.clanId;
      await seedMinimalPlayer("another-user");
    });

    it("allows a player to join and leave a clan", async () => {
      const wrappedJoin = wrapCallable(joinClan);
      await wrappedJoin({ data: { clanId, opId: "op_join_clan" }, ...authFor(uid) });

      let clanDoc = await admin.firestore().doc(`Clans/${clanId}`).get();
      expect(clanDoc.data()?.stats.members).toEqual(2);
      let playerProfileDoc = await admin.firestore().doc(`Players/${uid}/Profile/Profile`).get();
      expect(playerProfileDoc.data()?.clanId).toEqual(clanId);

      const wrappedLeave = wrapCallable(leaveClan);
      await wrappedLeave({ data: { opId: "op_leave_clan" }, ...authFor(uid) });

      clanDoc = await admin.firestore().doc(`Clans/${clanId}`).get();
      expect(clanDoc.data()?.stats.members).toEqual(1);
      playerProfileDoc = await admin.firestore().doc(`Players/${uid}/Profile/Profile`).get();
      expect(playerProfileDoc.data()?.clanId).toBeUndefined();
    });
  });

  describe("requestToJoinClan", () => {
    it("creates a join request with player details", async () => {
      const wrappedCreate = wrapCallable(createClan);
      const createResponse = await wrappedCreate({
        data: {
          name: "Join Clan",
          tag: "JOIN",
          type: "open",
          minimumTrophies: 0,
          opId: "op_create_clan_for_request",
        },
        ...authFor(uid),
      });
      clanId = createResponse.clanId ?? createResponse.data?.clanId;

      const wrapped = wrapCallable(requestToJoinClan);
      await wrapped({ data: { clanId, tag: "TEST", opId: "op_request_join" }, ...authFor(uid) });

      const requestDoc = await admin.firestore().doc(`Clans/${clanId}/Requests/${uid}`).get();
      expect(requestDoc.exists).toBe(true);
      expect(requestDoc.data()?.uid).toEqual(uid);
      expect(requestDoc.data()?.displayName).toEqual("Guest");
      expect(requestDoc.data()?.trophies).toEqual(0);
    });
  });
});
