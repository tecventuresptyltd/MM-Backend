process.env.FUNCTIONS_EMULATOR = "true";
import { admin } from "./setup";
import { wipeFirestore, ensureCatalogsSeeded } from "./helpers/cleanup";
import { wrapCallable } from "./helpers/callable";
import { __resetV2ConfigCacheForTests } from "../src/core/configV2";
import { resetRotationConfigCache } from "../src/shop/curatedRotation";
import { recordRaceResult } from "../src/race";
import rotationConfig from "../seeds/gamedata/config/ShopRotationConfig.json";

jest.setTimeout(120_000);
const db = admin.firestore();
const uid = "shop-streak-player";
const race = wrapCallable(recordRaceResult);
const profile = db.doc(`Players/${uid}/Profile/Profile`);
const config = db.doc("GameData/v1/config/ShopRotationConfig");
const request = (raceId: string, win = true) => ({
  data: { raceId, finishOrder: win ? [0, 1] : [1, 0], botNames: [] },
  auth: { uid, token: {} },
});

async function prepare(raceId: string): Promise<void> {
  const batch = db.batch();
  batch.set(db.doc(`Races/${raceId}`), {
    status: "pending", createdAt: admin.firestore.Timestamp.now(),
    lobbySnapshot: [{ rating: 0, participantId: uid }, { rating: 0, participantId: null }],
  });
  batch.set(db.doc(`Races/${raceId}/Participants/${uid}`), { playerIndex: 0, preDeductedTrophies: 0, gamemode: "RANKED" });
  await batch.commit();
}

beforeEach(async () => {
  await wipeFirestore();
  __resetV2ConfigCacheForTests();
  resetRotationConfigCache();
  await ensureCatalogsSeeded();
  const batch = db.batch();
  batch.set(config, { ...rotationConfig, enabled: true });
  batch.set(profile, { displayName: "Shop Streak", trophies: 0, highestTrophies: 0, exp: 0, masteryXp: 0, masteryRank: 0, level: 1, totalWins: 0 });
  batch.set(db.doc(`Players/${uid}/Economy/Stats`), { gems: 100, coins: 1000, spellShards: 0 });
  batch.set(db.doc(`Players/${uid}/Garage/Cars`), { cars: {} });
  batch.set(db.doc(`Players/${uid}/SpellDecks/Decks`), { active: 1, decks: {} });
  batch.set(db.doc(`Players/${uid}/Spells/Levels`), { levels: {} });
  batch.set(db.doc(`Players/${uid}/Crates/Slots`), { slots: [null, null, null, null], maxSlots: 4 });
  batch.set(db.doc("GameData/v1/config/ChallengesConfig"), { enabled: false }, { merge: true });
  await batch.commit();
});

describe("shop streak at race settlement", () => {
  test("concurrent retries count a win once and a later loss resets the streak", async () => {
    await profile.update({ shopWinStreak: 2 });
    await prepare("shop-third-win");
    await Promise.all([race(request("shop-third-win")), race(request("shop-third-win"))]);
    await race(request("shop-third-win"));
    expect((await profile.get()).get("shopWinStreak")).toBe(3);
    await prepare("shop-loss");
    await race(request("shop-loss", false));
    expect((await profile.get()).get("shopWinStreak")).toBe(0);
    await prepare("shop-new-win");
    await race(request("shop-new-win"));
    expect((await profile.get()).get("shopWinStreak")).toBe(1);
  });

  test("disabled rotation leaves the profile without a shop streak field", async () => {
    await config.update({ enabled: false });
    resetRotationConfigCache();
    await prepare("shop-disabled-win");
    await race(request("shop-disabled-win"));
    expect((await profile.get()).get("shopWinStreak")).toBeUndefined();
  });
});
