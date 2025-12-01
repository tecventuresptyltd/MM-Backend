/**
 * Utility script to delete every user from Firebase Authentication.
 * Run with: TS_NODE_PROJECT=../tsconfig.tools.json node -r ts-node/register ./tools/deleteAuth.ts
 */

import * as admin from 'firebase-admin';

const serviceAccount = require('../mystic-motors-sandbox-9b64d57718a2.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'mystic-motors-sandbox'
});

const auth = admin.auth();
const BATCH_SIZE = Number(process.env.DELETE_AUTH_BATCH_SIZE ?? 1000);
const IGNORED_ERROR_CODES = new Set(['auth/user-not-found']);

async function deleteAllUsers(batchSize: number): Promise<void> {
  console.log('Starting Firebase Auth user deletion...\n');

  let pageToken: string | undefined;
  let totalDeleted = 0;
  let totalFailed = 0;
  let totalIgnored = 0;

  while (true) {
    const result = await auth.listUsers(batchSize, pageToken);

    if (!result.users.length) {
      console.log('No users found - nothing to delete.');
      break;
    }

    const uids = result.users.map((user) => user.uid);
    console.log(`Deleting batch of ${uids.length} users...`);

    const { successCount, failureCount, errors } = await auth.deleteUsers(uids);

    let ignoredInBatch = 0;
    if (errors.length) {
      console.warn('Encountered errors while deleting users:');
      for (const error of errors) {
        const code = error.error?.code ?? 'unknown';
        const message = error.error?.message ?? 'n/a';

        if (IGNORED_ERROR_CODES.has(code)) {
          console.warn(` - UID: ${error.index} already removed (${code}). Skipping.`);
          ignoredInBatch++;
          continue;
        }

        console.error(` - UID: ${error.index}, Code: ${code}, Message: ${message}`);
      }
    }

    totalDeleted += successCount + ignoredInBatch;
    totalFailed += Math.max(failureCount - ignoredInBatch, 0);
    totalIgnored += ignoredInBatch;

    if (!result.pageToken) {
      break;
    }

    pageToken = result.pageToken;
  }

  console.log(`\nDeletion complete. Success: ${totalDeleted}, Failed: ${totalFailed}, Ignored (already gone): ${totalIgnored}`);

  if (totalFailed > 0) {
    throw new Error('Failed to delete some users. Check the logs above for details.');
  }
}

deleteAllUsers(BATCH_SIZE)
  .then(() => {
    console.log('\nAll Firebase Auth users deleted successfully.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nDeleting Firebase Auth users failed:', error);
    process.exit(1);
  });
