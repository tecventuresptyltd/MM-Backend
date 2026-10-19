import * as admin from "firebase-admin";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

async function run(): Promise<void> {
  if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error("This preflight checks sandbox, not emulators.");
  const projectId = "mystic-motors-sandbox";
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || resolve(__dirname, "../mystic-motors-sandbox-9b64d57718a2.json");
  const key = JSON.parse(readFileSync(keyPath, "utf8"));
  if (key.project_id !== projectId) throw new Error("Sandbox credentials required.");
  process.env.GCLOUD_PROJECT = projectId;
  admin.initializeApp({ projectId, credential: admin.credential.cert(key) });
  const { validateRotationConfig } = await import("../src/shop/curatedRotation.js");
  const config = JSON.parse(readFileSync(resolve(__dirname, "../seeds/gamedata/config/ShopRotationConfig.json"), "utf8"));
  const seed = JSON.parse(readFileSync(resolve(__dirname, "../seeds/gamedata/catalogs/OffersCatalog.json"), "utf8")).offers;
  const live = (await admin.firestore().doc("GameData/v1/catalogs/OffersCatalog").get()).data()?.offers;
  if (!live) throw new Error("Sandbox offer catalog missing.");
  validateRotationConfig(config, live);
  const ids = new Set<string>([...config.ranges.flatMap((range: any) => range.sets), ...config.specialSets].flatMap((set: any) => set.offerIds));
  for (const id of ids) {
    for (const field of ["price", "productId", "entitlements", "displayName"]) {
      if (!isDeepStrictEqual(seed[id]?.[field], live[id]?.[field])) throw new Error(`Sandbox catalog differs from reviewed offer ${id}: ${field}`);
    }
  }
  if (ids.size !== Object.keys(live).length) throw new Error("Rotation does not cover the complete sandbox offer catalog.");
  const enable = process.argv.includes("--enable");
  if (enable) await admin.firestore().doc("GameData/v1/config/ShopRotationConfig").set({ ...config, enabled: true });
  process.stdout.write(JSON.stringify({ projectId, offers: ids.size, ordinarySets: config.ranges.reduce((n: number, range: any) => n + range.sets.length, 0), specialSets: config.specialSets.length, catalogUnchanged: true, enabled: enable }) + "\n");
  await admin.app().delete();
}

run().catch(error => { process.stderr.write(String(error.message) + "\n"); process.exitCode = 1; });
