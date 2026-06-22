import * as admin from "firebase-admin";
const app = admin.apps.length ? admin.app() : admin.initializeApp();
const db = app.firestore();
(async () => {
  for (const id of ["3dj009QKkiy4Qg6Fc4y7", "WS95c9iICZSZ8UfCsnCH"]) {
    const d = await db.collection("Clans").doc(id).get();
    if (!d.exists) {
      console.log(id, "=> DOC DOES NOT EXIST ON SERVER");
      continue;
    }
    const data: any = d.data() ?? {};
    const m = await db.collection("Clans").doc(id).collection("Members").get();
    console.log(
      id,
      "name=", data.name,
      "status=", data.status,
      "stats=", JSON.stringify(data.stats),
      "realMembers=", m.size,
    );
  }
  process.exit(0);
})().catch((e) => { console.error("FAILED", e); process.exit(1); });
