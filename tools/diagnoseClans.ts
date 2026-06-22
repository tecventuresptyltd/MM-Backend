/**
 * READ-ONLY diagnostic. Does not modify anything.
 * Prints the current ClanLeaderboard/snapshot and validates each entry:
 *   - does the clan doc still exist?
 *   - status, stats.members, stats.trophies
 *   - actual member subcollection count
 * Also flags entries that getClanDetails would reject (missing doc / status != active).
 */
import * as admin from "firebase-admin";

const app = admin.apps.length > 0 ? admin.app() : admin.initializeApp();
const db = app.firestore();

const main = async () => {
  const snap = await db.collection("ClanLeaderboard").doc("snapshot").get();
  const data = snap.data() ?? {};
  const top: any[] = Array.isArray(data.top) ? data.top : [];
  console.log(`[diagnose] snapshot exists=${snap.exists} entries=${top.length} limit=${data.limit} updatedAt=${data.updatedAt}`);

  let missing = 0;
  let inactive = 0;
  let zeroMembers = 0;
  for (let i = 0; i < top.length; i++) {
    const e = top[i];
    const clanId = e?.clanId ?? "";
    const clanSnap = clanId ? await db.collection("Clans").doc(clanId).get() : null;
    const exists = !!clanSnap?.exists;
    const cdata = clanSnap?.data() ?? {};
    const realMembers = clanId ? (await db.collection("Clans").doc(clanId).collection("Members").get()).size : 0;
    const flags: string[] = [];
    if (!exists) { flags.push("DOC_MISSING"); missing++; }
    if (exists && cdata.status && cdata.status !== "active") { flags.push(`STATUS=${cdata.status}`); inactive++; }
    if ((e?.members ?? 0) <= 0) { flags.push("SNAP_0_MEMBERS"); zeroMembers++; }
    console.log(
      `  #${i + 1} ${clanId} name="${e?.name}" snapMembers=${e?.members} snapTrophies=${e?.totalTrophies} ` +
        `realMembers=${realMembers} docExists=${exists}${flags.length ? "  <<< " + flags.join(",") : ""}`,
    );
  }
  console.log(`[diagnose] summary: missingDocs=${missing} inactive=${inactive} zeroMemberEntries=${zeroMembers}`);
};

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error("[diagnose] FAILED:", e); process.exit(1); });
