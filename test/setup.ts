// functions/test/setup.ts
// functions/test/setup.ts
import * as admin from 'firebase-admin';
import functionsTest from 'firebase-functions-test';

// Minimal localStorage polyfill to satisfy Node 20 environments that expect it.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

const PROJECT_ID = 'demo-test';
process.env.GCLOUD_PROJECT = PROJECT_ID;
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:6767';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:6768';

if (admin.apps.length === 0) {
  admin.initializeApp({ projectId: PROJECT_ID });
}

const testEnv = functionsTest({ projectId: PROJECT_ID });

export { admin, PROJECT_ID, testEnv };
