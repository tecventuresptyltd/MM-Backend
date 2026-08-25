/**
 * SANDBOX ONLY. Validates the local bot name pool, reports how it differs from the
 * deployed /GameData/v1/config/BotNames doc, and lists any existing player whose
 * username collides with a bot name.
 *
 * Read-only by default. Pass --write to publish the local pool to sandbox Firestore.
 */

import * as admin from "firebase-admin";
import * as fs from "fs";
import * as path from "path";
import { assertBotNamesAreValidUsernames } from "../seeds/validateBotNames.js";

const SANDBOX_PROJECT_ID = "mystic-motors-sandbox";
const BOT_NAMES_PATH = "GameData/v1/config/BotNames";

const serviceAccount = require("../mystic-motors-sandbox-9b64d57718a2.json");

// Hard guard: this tool must never be pointed at production.
if (serviceAccount.project_id !== SANDBOX_PROJECT_ID) {
  console.error(`REFUSING TO RUN: service account is for '${serviceAccount.project_id}', expected '${SANDBOX_PROJECT_ID}'.`);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: SANDBOX_PROJECT_ID,
});

const db = admin.firestore();

(async () => {
  const shouldWrite = process.argv.includes("--write");

  const seedFile = path.join(__dirname, "..", "seeds", "Atul-Final-Seeds", "BotNamesConfig.json");
  const localDoc = JSON.parse(fs.readFileSync(seedFile, "utf-8"));
  const localNames: string[] = localDoc.data.names;

  // 1. Local pool must satisfy the username rules before it can go anywhere.
  assertBotNamesAreValidUsernames(localNames);
  console.log(`✅ local pool valid: ${localNames.length} names`);

  // 2. Compare against what is currently deployed.
  const remoteSnap = await db.doc(BOT_NAMES_PATH).get();
  const remoteNames: string[] = remoteSnap.exists ? (remoteSnap.data()?.names ?? []) : [];
  console.log(`   deployed pool: ${remoteNames.length} names${remoteSnap.exists ? "" : " (doc missing)"}`);

  const localSet = new Set(localNames);
  const removed = remoteNames.filter((n) => !localSet.has(n));
  const added = localNames.filter((n) => !remoteNames.includes(n));
  console.log(`   diff: +${added.length} / -${removed.length}`);
  if (removed.length > 0) {
    console.log(`   sample removed: ${removed.slice(0, 5).join(", ")}`);
    console.log(`   sample added:   ${added.slice(0, 5).join(", ")}`);
  }

  // 3. Existing players holding a name that is now reserved for a bot.
  const usernamesSnap = await db.collection("Usernames").get();
  const botLower = new Set(localNames.map((n) => n.toLowerCase()));
  const collisions = usernamesSnap.docs.filter((d) => botLower.has(d.id));
  console.log(`\n   registered usernames in sandbox: ${usernamesSnap.size}`);
  console.log(`   players holding a bot name: ${collisions.length}`);
  for (const doc of collisions) {
    console.log(`     - "${doc.id}" uid=${(doc.data() ?? {}).uid}`);
  }

  // 4. Publish only when explicitly asked.
  if (!shouldWrite) {
    console.log("\n(read-only; pass --write to publish to sandbox)");
    process.exit(0);
  }

  await db.doc(BOT_NAMES_PATH).set({ names: localNames }, { merge: true });
  console.log(`\n✅ wrote ${localNames.length} names to sandbox ${BOT_NAMES_PATH}`);
  process.exit(0);
})().catch((e) => {
  console.error("FAILED", e);
  process.exit(1);
});
