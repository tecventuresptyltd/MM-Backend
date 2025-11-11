// functions/test/setup.ts
// functions/test/setup.ts
import * as admin from 'firebase-admin';
import functionsTest from 'firebase-functions-test';

const PROJECT_ID = 'demo-test';
process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:6767';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:6768';

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT_ID });
}

const testEnv = functionsTest({ projectId: PROJECT_ID });

export { admin, PROJECT_ID, testEnv };
