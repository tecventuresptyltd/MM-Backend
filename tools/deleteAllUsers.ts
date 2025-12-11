/**
 * Destructive helper: deletes all Firebase Auth users and their Player documents.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=./path/to/serviceAccount.json \
 *   npx tsx tools/deleteAllUsers.ts --project your-project-id [--dry-run]
 *
 * By default this points at the default project from credentials. Pass --project to override.
 * Add --dry-run to see counts without deleting.
 */
import * as admin from "firebase-admin";

interface Options {
  projectId?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { dryRun: false };
  argv.forEach((arg) => {
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg.startsWith("--project=")) {
      opts.projectId = arg.split("=")[1];
    } else if (arg === "--project") {
      // eslint-disable-next-line no-console
      console.warn("Pass project id as --project=your-project-id");
    }
  });
  return opts;
}

async function deleteAuthUsers(dryRun: boolean): Promise<number> {
  const auth = admin.auth();
  const uids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await auth.listUsers(1000, pageToken);
    res.users.forEach((user) => uids.push(user.uid));
    pageToken = res.pageToken;
  } while (pageToken);

  if (dryRun) {
    return uids.length;
  }

  if (uids.length > 0) {
    const result = await auth.deleteUsers(uids);
    // eslint-disable-next-line no-console
    console.log(
      `Deleted auth users: success=${result.successCount}, errors=${result.failureCount}`,
    );
  }
  return uids.length;
}

async function deleteCollectionDocs(
  collectionPath: string,
  dryRun: boolean,
  recursive = false,
): Promise<number> {
  const db = admin.firestore();
  const refs = await db.collection(collectionPath).listDocuments();
  if (dryRun) {
    return refs.length;
  }
  for (const ref of refs) {
    if (recursive) {
      // @ts-ignore: recursiveDelete is available in firebase-admin >= 11
      if (typeof db.recursiveDelete !== "function") {
        throw new Error("firebase-admin lacks recursiveDelete; update admin SDK.");
      }
      // @ts-ignore: see above
      await db.recursiveDelete(ref);
    } else {
      await ref.delete();
    }
  }
  return refs.length;
}

async function main() {
  const { projectId, dryRun } = parseArgs(process.argv.slice(2));
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    ...(projectId ? { projectId } : {}),
  });

  // eslint-disable-next-line no-console
  console.log(
    `Starting deletion${dryRun ? " (dry-run)" : ""}${
      projectId ? ` for project ${projectId}` : ""
    }`,
  );

  const authCount = await deleteAuthUsers(dryRun);
  // eslint-disable-next-line no-console
  console.log(`${dryRun ? "Would delete" : "Deleted"} ${authCount} auth user(s).`);

  const collections = [
    { path: "Players", recursive: true, label: "Player doc(s)" },
    { path: "Usernames", recursive: false, label: "Username doc(s)" },
    { path: "AccountsDeviceAnchors", recursive: false, label: "AccountsDeviceAnchors doc(s)" },
    { path: "AccountsProviders", recursive: false, label: "AccountsProviders doc(s)" },
    { path: "ReferralRegistryCodeToUid", recursive: false, label: "ReferralRegistryCodeToUid doc(s)" },
    { path: "ReferralRegistryUidToCode", recursive: false, label: "ReferralRegistryUidToCode doc(s)" },
  ];

  for (const entry of collections) {
    const count = await deleteCollectionDocs(entry.path, dryRun, entry.recursive);
    // eslint-disable-next-line no-console
    console.log(
      `${dryRun ? "Would delete" : "Deleted"} ${count} ${entry.label}`,
    );
  }

  // eslint-disable-next-line no-console
  console.log("Done.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Delete failed", err);
  process.exit(1);
});
