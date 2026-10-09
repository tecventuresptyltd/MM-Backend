const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const admin = require("firebase-admin");

const projectId = "mystic-motors-sandbox";
const baseUrl = "https://us-central1-mystic-motors-sandbox.cloudfunctions.net/gameApi";
const uid = `codex-challenges-verification-${Date.now()}-${randomUUID().slice(0, 8)}`;
const recoveryFile = path.join(__dirname, "data", "challenges-sandbox-verification.json");
const checks = [];
let app;
let userCreated = false;
let fixtureCreated = false;
let verified = false;
let cleanup = false;

async function main() {
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Live verification refuses emulator environment overrides.");
  const key = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "mystic-motors-sandbox-9b64d57718a2.json"), "utf8"));
  assert.equal(key.project_id, projectId);
  const config = JSON.parse(fs.readFileSync("D:/mystic-motors/mystic-motors-optimised/Assets/FirebaseConfigs/google-services-dev.json", "utf8"));
  assert.equal(config.project_info.project_id, projectId);
  assert.ok(baseUrl.includes(`${projectId}.cloudfunctions.net`));
  const client = config.client[0];
  const apiKey = client.api_key[0].current_key;
  const appId = client.client_info.mobilesdk_app_id;
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.status, "ok");
  checks.push({ check: "deployed_gateway_health", routes: healthBody.routes });
  app = admin.initializeApp({ credential: admin.credential.cert(key), projectId }, `challenges-verification-${Date.now()}`);
  const db = app.firestore();
  fs.writeFileSync(recoveryFile, JSON.stringify({ projectId, uid, startedAt: new Date().toISOString(), cleaned: false }, null, 2));
  console.log(JSON.stringify({ stage: "starting", projectId, uid }));
  const appCheck = await app.appCheck().createToken(appId, { ttlMillis: 30 * 60 * 1000 });
  await app.auth().createUser({ uid, displayName: "Temporary Challenge Verification" });
  userCreated = true;
  const customToken = await app.auth().createCustomToken(uid);
  const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(apiKey)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  assert.equal(signIn.status, 200, "Sandbox custom-token authentication failed.");
  const auth = await signIn.json();
  assert.ok(auth.idToken);
  assert.equal((await app.auth().verifyIdToken(auth.idToken)).uid, uid);
  const call = async (name, data = {}, expectedError) => {
    const response = await fetch(`${baseUrl}/${name}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.idToken}`, "X-Firebase-AppCheck": appCheck.token }, body: JSON.stringify({ data }) });
    const body = await response.json();
    if (expectedError) { assert.equal(body.error?.status, expectedError, `${name} did not return ${expectedError}`); return body; }
    if (body.error) throw new Error(`${name}: ${body.error.status}: ${body.error.message}`);
    assert.equal(response.status, 200, `${name} HTTP ${response.status}`);
    return body.result;
  };
  const carDoc = await db.doc("GameData/v1/catalogs/CarsCatalog").get();
  const rawCars = carDoc.data();
  const carMap = rawCars.cars ?? rawCars;
  const carIds = Object.keys(carMap).filter(id => id.startsWith("car_")).slice(0, 10);
  assert.equal(carIds.length, 10, "Fixture requires ten real catalog cars.");
  const fixture = db.batch();
  fixture.set(db.doc(`Players/${uid}`), { temporaryVerification: true, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  fixture.set(db.doc(`Players/${uid}/Profile/Profile`), { displayName: "Temporary Challenge Verification", trophies: 0, highestTrophies: 0, exp: 0, masteryXp: 0, level: 1, totalWins: 0 });
  fixture.set(db.doc(`Players/${uid}/Economy/Stats`), { coins: 1000, gems: 100, spellShards: 0 });
  fixture.set(db.doc(`Players/${uid}/Garage/Cars`), { cars: Object.fromEntries(carIds.map((id, index) => [id, { carId: id, carLevel: index === 0 ? 10 : 1, starLevel: index === 0 ? 10 : 1 }])) });
  fixtureCreated = true;
  await fixture.commit();
  const initial = await call("getChallengesStatus");
  assert.equal(initial.challenges.length, 5);
  assert.equal(initial.challenges.filter(c => c.hard).length, 1);
  const refetched = await call("getChallengesStatus");
  assert.deepEqual(refetched.challenges, initial.challenges);
  assert.ok(initial.resetAtMs > initial.serverNowMs);
  checks.push({ check: "status_determinism_reset", passed: true });
  const swapped = await call("swapDailyChallenge", { challengeId: initial.challenges[0].id, opId: "live-swap" });
  assert.equal(swapped.gems.after, 90);
  assert.equal(swapped.status.swapsUsed, 1);
  assert.deepEqual(await call("swapDailyChallenge", { challengeId: initial.challenges[0].id, opId: "live-swap" }), swapped);
  await call("swapDailyChallenge", { challengeId: swapped.status.challenges[0].id, opId: "live-swap-over-limit" }, "FAILED_PRECONDITION");
  checks.push({ check: "swap_charge_limit_idempotency", passed: true });
  const daily = db.doc(`Players/${uid}/Challenges/Daily`);
  const dailyData = (await daily.get()).data();
  dailyData.challenges.forEach(c => { c.progress = c.objective.target; });
  await daily.set(dailyData);
  const ready = await call("getChallengesStatus");
  assert.equal(ready.completedCount, 5);
  assert.equal(ready.dailyClaimableCount, 8);
  const challengeId = ready.challenges[0].id;
  const claimed = await call("claimDailyChallenge", { challengeId, opId: "live-challenge" });
  assert.equal(claimed.status.challenges.find(c => c.id === challengeId).state, "claimed");
  assert.deepEqual(await call("claimDailyChallenge", { challengeId, opId: "live-challenge" }), claimed);
  await call("claimDailyChallenge", { challengeId, opId: "live-challenge-duplicate" }, "FAILED_PRECONDITION");
  checks.push({ check: "challenge_reward_idempotency_double_claim", passed: true });
  const milestone = await call("claimChallengeMilestone", { milestoneIndex: 2, opId: "live-milestone" });
  assert.equal(milestone.rewards[0].kind, "crate");
  const crateSku = milestone.rewards[0].skuId;
  assert.equal((await db.doc(`Players/${uid}/Inventory/${crateSku}`).get()).data().quantity, milestone.rewards[0].quantity);
  assert.deepEqual(await call("claimChallengeMilestone", { milestoneIndex: 2, opId: "live-milestone" }), milestone);
  checks.push({ check: "milestone_crate_inventory_idempotency", passed: true });
  const collected = await call("claimAchievement", { achievementId: "collector", opId: "live-achievement" });
  assert.equal(collected.status.achievements.find(a => a.id === "collector").state, "completed");
  assert.equal(collected.status.achievementPoints, 50);
  assert.deepEqual(await call("claimAchievement", { achievementId: "collector", opId: "live-achievement" }), collected);
  await call("claimAchievement", { achievementId: "collector", opId: "live-achievement-again" }, "FAILED_PRECONDITION");
  checks.push({ check: "account_achievement_reward_points_idempotency", passed: true });
  verified = true;
}

main().catch(error => {
  console.error(JSON.stringify({ stage: "failed", projectId, uid, message: error.message, code: error.code ?? null }));
  process.exitCode = 1;
}).finally(async () => {
  try {
    if (app) {
      assert.equal(app.options.projectId, projectId);
      assert.match(uid, /^codex-challenges-verification-\d+-[a-f0-9]{8}$/);
      if (fixtureCreated) await app.firestore().recursiveDelete(app.firestore().doc(`Players/${uid}`));
      if (userCreated) await app.auth().deleteUser(uid);
      if (fixtureCreated) {
        assert.equal((await app.firestore().doc(`Players/${uid}`).get()).exists, false);
        assert.equal((await app.firestore().doc(`Players/${uid}`).listCollections()).length, 0);
      }
      if (userCreated) {
        await assert.rejects(app.auth().getUser(uid), error => error.code === "auth/user-not-found");
      }
      cleanup = true;
      await app.delete();
    }
    fs.writeFileSync(recoveryFile, JSON.stringify({ projectId, uid, verified, cleaned: cleanup, checks, finishedAt: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ projectId, uid, verified, cleaned: cleanup, checks }));
  } catch (error) {
    console.error(JSON.stringify({ stage: "cleanup_failed", projectId, uid, message: error.message }));
    process.exitCode = 1;
  }
});
