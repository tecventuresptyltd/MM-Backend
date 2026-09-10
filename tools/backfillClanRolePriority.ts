import * as admin from "firebase-admin";

const ROLE_PRIORITY: Record<string, number> = {
  leader: 4,
  coLeader: 3,
  elder: 2,
  member: 1,
};

const SANDBOX_PROJECT = "mystic-motors-sandbox";
const PRODUCTION_PROJECT = "mystic-motors-prod";
const PRODUCTION_CONFIRMATION = "PRODUCTION";

const app = admin.apps.length > 0 ? admin.app() : admin.initializeApp();
const db = app.firestore();

const readFlag = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const resolveProjectId = (): string =>
  (app.options as { projectId?: string }).projectId ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.FIREBASE_CONFIG_PROJECT ||
  "";

const normalizeRole = (value: unknown): string => {
  if (typeof value !== "string") {
    return "member";
  }
  const cleaned = value.trim().toLowerCase();
  if (cleaned === "leader") return "leader";
  if (cleaned === "coleader" || cleaned === "co-leader" || cleaned === "co_leader") return "coLeader";
  if (cleaned === "elder") return "elder";
  return "member";
};

const main = async () => {
  const projectId = resolveProjectId();
  const expectedProject = readFlag("project") ?? SANDBOX_PROJECT;
  const dryRun = process.argv.includes("--dry-run");

  console.log(`[backfillClanRolePriority] target project: ${projectId || "(unknown)"}`);

  if (!projectId) {
    throw new Error(
      `Could not determine the target project. Refusing to run. ` +
        `Set GOOGLE_CLOUD_PROJECT=${expectedProject} and activate matching credentials before running.`,
    );
  }
  if (projectId !== expectedProject) {
    throw new Error(
      `Refusing to run: credentials point at "${projectId}", but --project is "${expectedProject}".`,
    );
  }
  if (expectedProject === PRODUCTION_PROJECT && readFlag("confirm") !== PRODUCTION_CONFIRMATION) {
    throw new Error(
      `Refusing to run against production without --confirm ${PRODUCTION_CONFIRMATION}.`,
    );
  }

  const clansSnap = await db.collection("Clans").get();
  console.log(`[backfillClanRolePriority] scanning ${clansSnap.size} clans...`);

  let scanned = 0;
  let updated = 0;
  let roleCorrected = 0;

  for (const clanDoc of clansSnap.docs) {
    const membersSnap = await clanDoc.ref.collection("Members").get();
    let batch = db.batch();
    let pending = 0;

    for (const memberDoc of membersSnap.docs) {
      scanned += 1;
      const data = memberDoc.data() ?? {};
      const canonicalRole = normalizeRole(data.role);
      const expectedPriority = ROLE_PRIORITY[canonicalRole];
      const storedPriority = typeof data.rolePriority === "number" ? data.rolePriority : null;
      const roleNeedsFix = data.role !== canonicalRole;
      const priorityNeedsFix = storedPriority !== expectedPriority;

      if (!roleNeedsFix && !priorityNeedsFix) {
        continue;
      }

      if (roleNeedsFix) {
        roleCorrected += 1;
      }
      updated += 1;

      console.log(
        `  - ${clanDoc.id}/${memberDoc.id}: role "${String(data.role)}" -> "${canonicalRole}", ` +
          `rolePriority ${String(storedPriority)} -> ${expectedPriority}`,
      );

      if (!dryRun) {
        batch.update(memberDoc.ref, { role: canonicalRole, rolePriority: expectedPriority });
        pending += 1;
        if (pending >= 400) {
          await batch.commit();
          batch = db.batch();
          pending = 0;
        }
      }
    }

    if (!dryRun && pending > 0) {
      await batch.commit();
    }
  }

  console.log(
    `[backfillClanRolePriority] done. scanned ${scanned} members, ` +
      `${updated} needed updating (${roleCorrected} had a non-canonical role string)` +
      `${dryRun ? " [DRY RUN, nothing written]" : ""}.`,
  );
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[backfillClanRolePriority] failed:", error);
    process.exit(1);
  });
