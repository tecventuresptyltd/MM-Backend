import { admin } from "./setup";
import { wrapCallable } from "./helpers/callable";
import { startRace } from "../src/race";
import { wipeFirestore, wipeAuth, seedMinimalPlayer } from "./helpers/cleanup";

jest.setTimeout(30000);

describe("race.startRace", () => {
  let callerUid: string;
  let opponentUid: string;
  const db = admin.firestore();
  
  const authFor = (uid: string) => ({
    auth: {
      uid,
      token: { firebase: { sign_in_provider: "anonymous" } },
    },
  });

  beforeEach(async () => {
    await wipeFirestore();
    await wipeAuth();
    
    callerUid = `caller-uid-${Date.now()}`;
    opponentUid = `opponent-uid-${Date.now()}`;
    
    // Seed player profiles
    await seedMinimalPlayer(callerUid);
    await seedMinimalPlayer(opponentUid);

    // Set custom trophies
    await db.doc(`/Players/${callerUid}/Profile/Profile`).set({ trophies: 1500 }, { merge: true });
    await db.doc(`/Players/${opponentUid}/Profile/Profile`).set({ trophies: 2000 }, { merge: true });
  });

  it("maintains backward compatibility with numeric arrays", async () => {
    const wrapped = wrapCallable(startRace);
    const res = await wrapped({
      data: {
        lobbyRatings: [1000, 1100, 1200],
        playerIndex: 0,
        gamemode: "RANKED"
      },
      ...authFor(callerUid),
    });

    expect(res.success).toBe(true);
    expect(res.raceId).toBeDefined();
    expect(res.preDeductedTrophies).toBeDefined();

    // Verify database document
    const raceDoc = await db.doc(`/Races/${res.raceId}`).get();
    expect(raceDoc.exists).toBe(true);
    const raceData = raceDoc.data()!;
    
    expect(raceData.status).toBe("pending");
    expect(raceData.gamemode).toBe("RANKED");
    expect(raceData.lobbySnapshot).toEqual([
      { rating: 1500, participantId: callerUid }, // Caller rating should be updated to authoritative 1500
      { rating: 1100, participantId: null },
      { rating: 1200, participantId: null },
    ]);
  });

  it("resolves other players profile trophies dynamically", async () => {
    const wrapped = wrapCallable(startRace);
    const res = await wrapped({
      data: {
        lobbyRatings: [
          { rating: 1200, participantId: callerUid },
          { rating: 1200, participantId: opponentUid },
          1100
        ],
        playerIndex: 0,
        gamemode: "RANKED"
      },
      ...authFor(callerUid),
    });

    expect(res.success).toBe(true);
    
    // Verify database document has resolved authoritative trophies (1500 and 2000)
    const raceDoc = await db.doc(`/Races/${res.raceId}`).get();
    const raceData = raceDoc.data()!;
    expect(raceData.lobbySnapshot).toEqual([
      { rating: 1500, participantId: callerUid },
      { rating: 2000, participantId: opponentUid },
      { rating: 1100, participantId: null },
    ]);
  });

  it("falls back to client-provided rating if profile does not exist", async () => {
    const missingUid = `missing-uid-${Date.now()}`;
    const wrapped = wrapCallable(startRace);
    const res = await wrapped({
      data: {
        lobbyRatings: [
          { rating: 1200, participantId: callerUid },
          { rating: 1400, participantId: missingUid }
        ],
        playerIndex: 0,
        gamemode: "RANKED"
      },
      ...authFor(callerUid),
    });

    expect(res.success).toBe(true);
    
    // Verify database document fell back to 1400 for missing player
    const raceDoc = await db.doc(`/Races/${res.raceId}`).get();
    const raceData = raceDoc.data()!;
    expect(raceData.lobbySnapshot).toEqual([
      { rating: 1500, participantId: callerUid },
      { rating: 1400, participantId: missingUid } // fallback to client rating
    ]);
  });
});
