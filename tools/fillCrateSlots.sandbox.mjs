/**
 * Fill a player's crate slots with different crates, mirroring receiveCrateV2 (SANDBOX).
 *
 * Usage: node tools/fillCrateSlots.sandbox.mjs <uid> [rarity,rarity,...]
 *        default rarities: common,rare,exotic,legendary
 *
 * Writes /Players/{uid}/Crates/Slots with the exact CrateSlotEntry shape:
 * crateSkuId, crateId, rarity, receivedAt, isUnlocking:false, startedAt:null,
 * completesAt:null, unlockDurationSeconds (from CrateSlotsConfig.unlockDurations).
 *
 * Slots are left idle because CrateSlotsConfig.simultaneousUnlocks caps how many
 * may unlock at once; startCrateUnlockV2 rejects starting a second one.
 */
import admin from "firebase-admin";
import { readFileSync } from "fs";

const CRED_FILE = "./mystic-motors-sandbox-9b64d57718a2.json";

const uid = process.argv[2];
const rarityArg = process.argv[3] ?? "common,rare,exotic,legendary";
if (!uid) {
  console.error("Usage: node tools/fillCrateSlots.sandbox.mjs <uid> [rarity,...]");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(readFileSync(CRED_FILE, "utf8"))),
});
const db = admin.firestore();
const get = async (p) => (await db.doc(p).get()).data() ?? {};

const cfg = await get("GameData/v1/config/CrateSlotsConfig");
const cratesCat = (await get("GameData/v1/catalogs/CratesCatalog")).crates ?? {};
const maxSlots = Number(cfg.maxSlots ?? 4);

const byRarity = {};
for (const [crateId, c] of Object.entries(cratesCat)) {
  if (c.rarity && !byRarity[c.rarity]) byRarity[c.rarity] = { crateId, ...c };
}

const rarities = rarityArg.split(",").map((r) => r.trim()).filter(Boolean);
if (rarities.length > maxSlots) {
  console.error(`Only ${maxSlots} slots available; got ${rarities.length} rarities.`);
  process.exit(1);
}
if (new Set(rarities).size !== rarities.length) {
  console.error("Rarities must be distinct so every slot holds a different crate.");
  process.exit(1);
}

const now = admin.firestore.Timestamp.now();
const slots = [];
const rows = [];
for (let i = 0; i < maxSlots; i++) {
  const rarity = rarities[i];
  if (!rarity) { slots.push(null); rows.push([i, "(empty)", "-", "-"]); continue; }
  const crate = byRarity[rarity];
  if (!crate) {
    console.error(`No crate of rarity "${rarity}" in CratesCatalog.`);
    process.exit(1);
  }
  if (!crate.crateSkuId) { console.error(`Crate ${crate.crateId} has no crateSkuId.`); process.exit(1); }
  const duration = Number(cfg.unlockDurations?.[rarity]?.durationSeconds ?? 0);
  if (!(duration > 0)) {
    console.error(`No unlockDurations["${rarity}"].durationSeconds in CrateSlotsConfig.`);
    process.exit(1);
  }
  slots.push({
    crateSkuId: crate.crateSkuId,
    crateId: crate.crateId,
    rarity,
    receivedAt: now,
    isUnlocking: false,
    startedAt: null,
    completesAt: null,
    unlockDurationSeconds: duration,
  });
  rows.push([i, crate.displayName ?? crate.crateId, crate.crateId, `${duration}s (${cfg.unlockDurations[rarity].displayDuration})`]);
}

await db.doc(`Players/${uid}/Crates/Slots`).set({
  slots,
  maxSlots,
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
}, { merge: true });

console.log(`Crate slots for ${uid} (maxSlots=${maxSlots}, simultaneousUnlocks=${cfg.simultaneousUnlocks}):\n`);
for (const [i, name, id, dur] of rows) {
  console.log(`  slot ${i}  ${String(name).padEnd(18)} ${String(id).padEnd(16)} unlock ${dur}`);
}
console.log("\nAll idle (isUnlocking=false) — ready for startCrateUnlockV2.");
process.exit(0);
