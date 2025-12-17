import fs from "node:fs";
import * as admin from "firebase-admin";
import { runXpBackfill, type XpBackfillOptions } from "./jobs/xpBackfill.js";

type CliArgs = {
  job: string;
  projectId: string;
  serviceAccountPath?: string;
  dryRun: boolean;
  batchSize: number;
  limit: number;
  verbose: boolean;
  fixLevels: boolean;
};

const parseArgs = (argv: string[]): CliArgs => {
  const args: Record<string, string | boolean | number> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      positional.push(token);
    }
  }

  const job = positional[0];
  const projectId = (args.project as string) || (args.projectId as string) || "";
  const serviceAccountPath = args.sa as string | undefined;

  return {
    job,
    projectId,
    serviceAccountPath,
    dryRun: Boolean(args["dry-run"] ?? args.dryRun ?? false),
    batchSize: Number(args.batch ?? args.batchSize ?? 200),
    limit: Number(args.limit ?? 0),
    verbose: Boolean(args.verbose ?? false),
    fixLevels: Boolean(args["fix-levels"] ?? false),
  };
};

const initAdmin = (projectId: string, serviceAccountPath?: string): FirebaseFirestore.Firestore => {
  if (!projectId) {
    throw new Error("--project <projectId> is required");
  }

  const appOptions: admin.AppOptions = { projectId };
  if (serviceAccountPath) {
    const raw = fs.readFileSync(serviceAccountPath, "utf8");
    const json = JSON.parse(raw);
    appOptions.credential = admin.credential.cert(json);
  } else {
    appOptions.credential = admin.credential.applicationDefault();
  }

  admin.initializeApp(appOptions);
  return admin.firestore();
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.job || args.job !== "xp-backfill") {
    console.error("Usage: npx tsx ForceUpdated/run.ts xp-backfill [options]");
    process.exit(1);
  }

  const db = initAdmin(args.projectId, args.serviceAccountPath);
  const opts: XpBackfillOptions = {
    dryRun: args.dryRun,
    batchSize: args.batchSize,
    limit: args.limit,
    verbose: args.verbose,
    fixLevels: args.fixLevels,
  };

  console.log(
    `[run] job=${args.job} project=${args.projectId} dryRun=${opts.dryRun} batch=${opts.batchSize} limit=${opts.limit} fixLevels=${opts.fixLevels}`,
  );
  await runXpBackfill(db, opts);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
