/**
 * ONE-TIME manual rebuild of ClanLeaderboard/snapshot (for testing).
 * Mirrors the scheduled 6-hour job: top 100 active clans, members>0, trophies clamped.
 * Cost: one query + ONE write. Does NOT change the ongoing 6-hour behaviour.
 * Sandbox-guarded — refuses any project other than mystic-motors-sandbox.
 *
 * RUN: npx tsx tools/rebuildClanLeaderboardOnce.ts
 */
import * as admin from "firebase-admin";

const app = admin.apps.length > 0 ? admin.app() : admin.initializeApp();
const db = app.firestore();

const CLAN_LEADERBOARD_LIMIT = 100;
const EXPECTED_PROJECT = "mystic-motors-sandbox";

const projectId =
  (app.options as { projectId?: string }).projectId ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  "";

const main = async () => {
  console.log(`[rebuild] target project: ${projectId || "(unknown)"}`);
  if (projectId !== EXPECTED_PROJECT) {
    throw new Error(
      `Refusing to run: target project is "${projectId || "(unknown)"}", expected "${EXPECTED_PROJECT}".`,
    );
  }

  const snap = await db
    .collection("Clans")
    .where("status", "==", "active")
    .orderBy("stats.trophies", "desc")
    .limit(CLAN_LEADERBOARD_LIMIT)
    .get();

  const top = snap.docs
    .map((doc) => {
      const d = doc.data() ?? {};
      const s = (d.stats ?? {}) as Record<string, unknown>;
      return {
        clanId: d.clanId ?? doc.id,
        name: d.name ?? "Clan",
        badge: typeof d.badge === "string" ? d.badge : null,
        type: d.type ?? "anyone can join",
        members: Math.max(0, Number(s.members ?? 0)),
        totalTrophies: Math.max(0, Number(s.trophies ?? 0)),
        location: typeof d.location === "string" ? d.location : null,
      };
    })
    .filter((e) => e.members > 0);

  await db.collection("ClanLeaderboard").doc("snapshot").set({
    limit: CLAN_LEADERBOARD_LIMIT,
    updatedAt: Date.now(),
    top,
  });

  console.log(`[rebuild] done. Snapshot now has ${top.length} entries (members>0).`);
};

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[rebuild] FAILED:", e);
    process.exit(1);
  });
