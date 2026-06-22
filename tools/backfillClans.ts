/**
 * One-time backfill: makes every clan visible on the leaderboard and corrects
 * trophy totals.
 *
 * WHY: the clan leaderboard query is
 *   .where("status","==","active").orderBy("stats.trophies","desc")
 * Firestore silently EXCLUDES any clan doc that is missing `status` or
 * `stats.trophies`, so legacy clans never appeared. This script:
 *   1. sets status:"active" where missing
 *   2. recomputes stats.members = member count
 *   3. recomputes stats.trophies = sum(max(0, member.trophies))  (never negative)
 *   4. ensures search fields exist (used by clan search)
 *   5. rebuilds the ClanLeaderboard/snapshot doc
 *
 * COST: one-time. Reads each clan + its members once, writes each clan once.
 * Tiny for a sandbox dataset; adds no recurring/scheduled cost.
 *
 * SAFETY: hard-refuses to run against any project other than the sandbox.
 *
 * RUN (sandbox credentials must be active):
 *   cd "D:/mystic motors/mystic-motors-backend"
 *   npx tsx tools/backfillClans.ts
 */
import * as admin from "firebase-admin";

const app = admin.apps.length > 0 ? admin.app() : admin.initializeApp();
const db = app.firestore();

const CLAN_LEADERBOARD_LIMIT = 100;
const EXPECTED_PROJECT = "mystic-motors-sandbox";

const resolveProjectId = (): string =>
  (app.options as { projectId?: string }).projectId ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.FIREBASE_CONFIG_PROJECT ||
  "";

const main = async () => {
  const projectId = resolveProjectId();
  console.log(`[backfillClans] target project: ${projectId || "(unknown)"}`);

  // SAFETY: never touch production.
  if (projectId && projectId !== EXPECTED_PROJECT) {
    throw new Error(
      `Refusing to run: target project is "${projectId}", expected "${EXPECTED_PROJECT}". ` +
        `Activate sandbox credentials before running.`,
    );
  }
  if (!projectId) {
    throw new Error(
      `Could not determine the target project. Refusing to run without confirming it is "${EXPECTED_PROJECT}". ` +
        `Set GOOGLE_CLOUD_PROJECT=${EXPECTED_PROJECT} (and sandbox credentials) before running.`,
    );
  }

  const clansSnap = await db.collection("Clans").get();
  console.log(`[backfillClans] scanning ${clansSnap.size} clans...`);

  let fixed = 0;
  for (const clanDoc of clansSnap.docs) {
    const data = clanDoc.data() ?? {};
    const membersSnap = await clanDoc.ref.collection("Members").get();

    let memberCount = 0;
    let totalTrophies = 0;
    membersSnap.forEach((m) => {
      memberCount += 1;
      const t = Number(m.data()?.trophies ?? 0);
      if (Number.isFinite(t) && t > 0) {
        totalTrophies += t;
      }
    });

    const existingStats = (data.stats ?? {}) as Record<string, unknown>;
    const update: Record<string, unknown> = {
      status:
        typeof data.status === "string" && data.status.length > 0 ? data.status : "active",
      stats: {
        members: memberCount,
        trophies: Math.max(0, totalTrophies),
        totalWins: Math.max(0, Number(existingStats.totalWins ?? 0)),
      },
    };

    // Ensure search fields exist so the clan is findable via search filters.
    if (!data.search || typeof data.search !== "object") {
      update.search = {
        nameLower: (typeof data.name === "string" ? data.name : "").toLowerCase(),
        location: typeof data.location === "string" ? data.location : "GLOBAL",
        language: typeof data.language === "string" ? data.language : "unknown",
      };
    }

    await clanDoc.ref.set(update, { merge: true });
    fixed += 1;
    console.log(
      `  ✓ ${clanDoc.id} (${data.name ?? "?"}): members=${memberCount} ` +
        `trophies=${Math.max(0, totalTrophies)} status=${update.status}`,
    );
  }

  // Rebuild the leaderboard snapshot from the corrected clan docs.
  const topSnap = await db
    .collection("Clans")
    .where("status", "==", "active")
    .orderBy("stats.trophies", "desc")
    .limit(CLAN_LEADERBOARD_LIMIT)
    .get();

  const top = topSnap.docs
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
        // Firestore rejects undefined — default missing location to null.
        location: typeof d.location === "string" ? d.location : null,
      };
    })
    // Skip empty clans (0 members) — abandoned/orphaned clans shouldn't be listed.
    .filter((entry) => entry.members > 0);

  await db.collection("ClanLeaderboard").doc("snapshot").set({
    limit: CLAN_LEADERBOARD_LIMIT,
    updatedAt: Date.now(),
    top,
  });

  console.log(
    `[backfillClans] done. Fixed ${fixed} clans. ` +
      `Leaderboard snapshot now has ${top.length} entries.`,
  );
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[backfillClans] FAILED:", error);
    process.exit(1);
  });
