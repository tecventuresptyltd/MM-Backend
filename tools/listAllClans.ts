import * as admin from "firebase-admin";
const app = admin.apps.length ? admin.app() : admin.initializeApp();
const db = app.firestore();
(async () => {
  const snap = await db.collection("Clans").get();
  console.log(`TOTAL CLANS IN SANDBOX (default db): ${snap.size}`);
  let nametest = false;
  for (const d of snap.docs) {
    const data: any = d.data() ?? {};
    const name = (data.name ?? "").toString();
    if (name.toLowerCase().includes("nametest")) nametest = true;
    if (name.toLowerCase().includes("nametest") || name.toLowerCase().includes("test#21") || name.toLowerCase().includes("hfgh")) {
      console.log(`  MATCH: id=${d.id} name="${name}" status=${data.status} members=${data.stats?.members}`);
    }
  }
  console.log(`NAMETEST present in this DB: ${nametest}`);
  process.exit(0);
})().catch((e) => { console.error("FAILED", e); process.exit(1); });
