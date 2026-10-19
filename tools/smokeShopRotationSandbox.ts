import * as admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

async function run(): Promise<void> {
  if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error("Sandbox smoke test cannot use emulator settings.");
  const projectId = "mystic-motors-sandbox";
  const expectedVersion = JSON.parse(readFileSync(resolve(__dirname, "../seeds/gamedata/config/ShopRotationConfig.json"), "utf8")).version;
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || resolve(__dirname, "../mystic-motors-sandbox-9b64d57718a2.json");
  const key = JSON.parse(readFileSync(keyPath, "utf8"));
  if (key.project_id !== projectId) throw new Error("Sandbox credentials required.");
  const clientPath = process.argv[2];
  if (!clientPath) throw new Error("Pass the sandbox Unity google-services.json path.");
  const clientConfig = JSON.parse(readFileSync(clientPath, "utf8"));
  if (clientConfig.project_info?.project_id !== projectId) throw new Error("Sandbox client configuration required.");
  const client = clientConfig.client[0];
  const apiKey = client.api_key[0].current_key;
  const appId = client.client_info.mobilesdk_app_id;
  admin.initializeApp({ projectId, credential: admin.credential.cert(key) });
  const uid = `shop-rotation-smoke-${Date.now()}`;
  const db = admin.firestore();
  let created = false;
  try {
    await admin.auth().createUser({ uid });
    created = true;
    const customToken = await admin.auth().createCustomToken(uid);
    const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    });
    if (!signIn.ok) throw new Error(`Sandbox test authentication failed: HTTP ${signIn.status}`);
    const { idToken } = await signIn.json() as { idToken: string };
    const appCheck = await admin.appCheck().createToken(appId);
    process.stdout.write("Sandbox authentication ready.\n");
    const call = async (data: object, expectedStatus = 200): Promise<any> => {
      const response = await fetch(`https://us-central1-${projectId}.cloudfunctions.net/gameApi/getDailyOffers`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}`, "X-Firebase-AppCheck": appCheck.token }, body: JSON.stringify({ data }),
      });
      if (response.status !== expectedStatus) throw new Error(`getDailyOffers expected HTTP ${expectedStatus}, received ${response.status}`);
      const body = await response.json() as { result?: any; data?: any };
      return body.result ?? body.data;
    };
    const assertTrio = (offers: any, expectedSet: string): void => {
      if (offers?.rotating?.length !== 3 || offers.special?.length !== 0 || offers.rotation?.setId !== expectedSet) {
        throw new Error(`Unexpected sandbox presentation for ${expectedSet}`);
      }
      if (new Set(offers.rotating.map((offer: any) => offer.offerId)).size !== 3) throw new Error("Duplicate cards.");
    };
    await db.doc(`Players/${uid}`).set({ testPurpose: "shop-rotation-smoke" });
    await db.doc(`Players/${uid}/Profile/Profile`).set({ masteryRank: 0, shopWinStreak: 0 });
    let first: any;
    for (let attempt = 0; attempt < 16; attempt++) {
      first = await call({});
      if (first.rotation?.selectionMode === "automatic" && first.rotation.version === expectedVersion) break;
      if (attempt === 15) throw new Error("Sandbox rotation did not become enabled after cache refresh.");
      await new Promise(done => setTimeout(done, 5000));
    }
    const rotationRef = db.doc(`Players/${uid}/Offers/Rotation`);
    const ordinarySets = ["A1", "B1", "C1", "D1", "A2", "B2", "C2", "D2", "A3", "C3", "D3", "A4", "A5", "A6"];
    const initialState = (await rotationRef.get()).data()!;
    const weekend = initialState.specials?.S7;
    if (weekend) await rotationRef.update({ "specials.S7.consumed": true });
    assertTrio(await call({}), "A1");
    for (const setId of ordinarySets.slice(1)) {
      await rotationRef.update({ day: Math.floor(Date.now() / 86400000) - 1 });
      assertTrio(await call({}), setId);
    }
    await rotationRef.update({ day: Math.floor(Date.now() / 86400000) - 1 });
    assertTrio(await call({}), "A1");
    assertTrio(await call({ rangeId: "large", specialSetId: "S6" }), "A1");
    await call({ rangeId: "invalid-range" }, 400);
    process.stdout.write("All 14 ordinary trios advanced automatically using only temporary-account clock state.\n");
    await db.doc(`Players/${uid}/Profile/Profile`).update({ masteryRank: 20, shopWinStreak: 3 });
    let eligible: any;
    for (let attempt = 0; attempt < 12; attempt++) {
      eligible = await call({});
      const ids = new Set(eligible.rotation.availableSpecialSets.map((special: any) => special.setId));
      if (["S2", "S3", "S4", "S5"].every(id => ids.has(id))) break;
      if (attempt === 11) throw new Error("Sandbox profile triggers did not activate expected specials.");
      await new Promise(done => setTimeout(done, 2500));
    }
    assertTrio(await call({}), "S5");
    await rotationRef.update({ "specials.S5.consumed": true });
    const mastery = await call({});
    if (!["S2", "S3"].includes(mastery.rotation.setId)) throw new Error("Mastery trio was not selected automatically.");
    assertTrio(mastery, mastery.rotation.setId);
    if (mastery.rotation.nextRotationAt > (Math.floor(Date.now() / 900000) + 1) * 900000) throw new Error("Tied mastery windows lack an automatic refresh boundary.");
    await rotationRef.update({ "specials.S2.consumed": true, "specials.S3.consumed": true });
    assertTrio(await call({}), "S4");
    process.stdout.write("Live mastery and win-streak events passed.\n");
    const catalog = (await db.doc("GameData/v1/catalogs/ItemsCatalog").get()).data();
    if (!catalog) throw new Error("Sandbox item catalog missing.");
    process.env.GCLOUD_PROJECT = projectId;
    const { getItemSkusCatalog } = await import("../src/core/catalog.js");
    const skus = await getItemSkusCatalog();
    const mythical = Object.values(skus).find((sku: any) => typeof sku.skuId === "string" && sku.skuId.startsWith("sku_") && sku.type === "crate" && String(sku.rarity).toLowerCase() === "mythical") as any;
    if (!mythical) throw new Error("No Mythical crate SKU found.");
    await db.doc(`Players/${uid}/Inventory/${mythical.skuId}`).set({ skuId: mythical.skuId, quantity: 1, qty: 1 });
    for (let attempt = 0; attempt < 48; attempt++) {
      eligible = await call({});
      if (eligible.rotation.availableSpecialSets.some((special: any) => special.setId === "S6")) break;
      if (attempt === 47) throw new Error("Sandbox Mythical crate trigger did not activate S6.");
      await new Promise(done => setTimeout(done, 2500));
    }
    const fortune = await call({});
    assertTrio(fortune, "S6");
    const repeat = await call({});
    if (repeat.rotating[0].expiresAt !== fortune.rotating[0].expiresAt) throw new Error("Refresh extended a special window.");
    await rotationRef.update({ "specials.S2.consumed": true, "specials.S3.consumed": true, "specials.S4.consumed": true, "specials.S6.consumed": true });
    const beforeRepeat = (await rotationRef.get()).data()!;
    const advanceRank = async (rank: number): Promise<any> => {
      const write = await db.doc(`Players/${uid}/Profile/Profile`).update({ masteryRank: rank });
      for (let attempt = 0; attempt < 48; attempt++) {
        const state = (await rotationRef.get()).data()!;
        if (state.eventTimes.mastery >= Math.floor(write.writeTime.toMillis())) return state;
        if (attempt === 47) throw new Error(`Mastery rank ${rank} event did not settle.`);
        await new Promise(done => setTimeout(done, 2500));
      }
    };
    const at25 = await advanceRank(25);
    if (at25.milestoneRanks?.S2 !== 25 || at25.specials.S2.consumed || at25.specials.S3.expiresAt !== beforeRepeat.specials.S3.expiresAt || at25.specials.S4.expiresAt !== beforeRepeat.specials.S4.expiresAt) throw new Error("Rank 25 did not reopen only MASTERY SURGE.");
    assertTrio(await call({}), "S2");
    await rotationRef.update({ "specials.S2.consumed": true });
    const at26 = await advanceRank(26);
    if (!at26.specials.S2.consumed || at26.specials.S2.expiresAt !== at25.specials.S2.expiresAt) throw new Error("A non-milestone rank reopened MASTERY SURGE.");
    const at30 = await advanceRank(30);
    if (at30.milestoneRanks?.S3 !== 30 || at30.milestoneRanks?.S4 !== 30 || at30.specials.S3.consumed || at30.specials.S4.consumed || at30.specials.S4.expiresAt - at30.specials.S3.expiresAt !== 86400000) throw new Error("Rank 30 did not reopen SPEED VAULT and APEX VAULT with their original windows.");
    assertTrio(await call({}), "S3");
    await rotationRef.update({ "specials.S3.consumed": true });
    assertTrio(await call({}), "S4");
    process.stdout.write(JSON.stringify({ projectId, automatic: true, ordinarySets: 14, threeCards: true, manualSelectionCannotOverride: true, profileSpecials: ["S2", "S3", "S4", "S5"], mythicalSpecial: "S6", refreshPreservesExpiry: true, repeatingMilestones: { S2: 25, S3: 30, S4: 30 }, nonMilestonePreservesExpiry: true }) + "\n");
  } finally {
    if (created) {
      await db.recursiveDelete(db.doc(`Players/${uid}`));
      await admin.auth().deleteUser(uid);
      process.stdout.write("Temporary sandbox account removed.\n");
    }
    await admin.app().delete();
  }
}

run().catch(error => { process.stderr.write(String(error.message) + "\n"); process.exitCode = 1; });
