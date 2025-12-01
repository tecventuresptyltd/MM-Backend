/**
 * Utility script to wipe Firestore data while preserving specific collections.
 * Run with: TS_NODE_PROJECT=../tsconfig.tools.json node -r ts-node/register ./tools/clearFirestore.ts
 *
 * The default protected collections:
 *  - /GameConfig      (preserves all documents and subcollections)
 *  - /GameData        (preserves all documents and subcollections)
 *  - /Races           (preserves all documents and subcollections)
 *
 * Provide a comma-separated list via the FIRESTORE_PROTECTED_PATHS env var to override.
 */

import * as admin from 'firebase-admin';

const serviceAccount = require('../mystic-motors-sandbox-9b64d57718a2.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: 'mystic-motors-sandbox'
});

const db = admin.firestore();

// Protect entire collections (all docs inside these collections will be skipped)
const DEFAULT_PROTECTED = [
  'GameConfig',
  'GameData',
  'Races'
];
const protectedPaths = (process.env.FIRESTORE_PROTECTED_PATHS ?? DEFAULT_PROTECTED.join(','))
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => normalizeFirestorePath(entry));

function normalizeFirestorePath(path: string): string {
  return path.replace(/^\/+/, '');
}

function isProtectedPath(path: string): boolean {
  // Checks if the path matches or is a child of any protected document.
  const normalized = normalizeFirestorePath(path);
  return protectedPaths.some((protectedPath) => {
    if (normalized === protectedPath) {
      return true;
    }
    return normalized.startsWith(`${protectedPath}/`);
  });
}

async function deleteDocumentTree(docRef: FirebaseFirestore.DocumentReference): Promise<void> {
  const path = docRef.path;

  if (isProtectedPath(path)) {
    console.log(`Skipping protected document: /${path}`);
    return;
  }

  const subCollections = await docRef.listCollections();
  for (const subCollection of subCollections) {
    await deleteCollection(subCollection);
  }

  await docRef.delete();
  console.log(`Deleted document: /${path}`);
}

async function deleteCollection(collectionRef: FirebaseFirestore.CollectionReference): Promise<void> {
  const snapshot = await collectionRef.get();

  if (snapshot.empty) {
    return;
  }

  for (const doc of snapshot.docs) {
    // If this document is protected, skip it and everything inside it.
    if (isProtectedPath(doc.ref.path)) {
      console.log(`Skipping protected document and its contents: /${doc.ref.path}`);
      continue;
    }
    await deleteDocumentTree(doc.ref);
  }
}

async function clearFirestore(): Promise<void> {
  console.log('Starting Firestore cleanup...\n');
  console.log('Protected document paths:');
  for (const path of protectedPaths) {
    console.log(` - /${path}`);
  }
  console.log('');

  const rootCollections = await db.listCollections();
  if (!rootCollections.length) {
    console.log('No collections found. Firestore is already empty.');
    return;
  }

  for (const collection of rootCollections) {
    console.log(`Processing collection: ${collection.id}`);
    await deleteCollection(collection);
  }

  console.log('\nFirestore cleanup complete.');
}

clearFirestore()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Firestore cleanup failed:', error);
    process.exit(1);
  });
