import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initializeApp } from "firebase/app";
import { getFirestore, connectFirestoreEmulator, doc, getDoc } from "firebase/firestore";
import { getAuth, connectAuthEmulator, signInAnonymously, signOut } from "firebase/auth";
import { admin, PROJECT_ID } from "./setup";

function getHostAndPort(envVar: string, fallback: string): [string, number] {
  const value = process.env[envVar] ?? fallback;
  const [hostPart, portPart] = value.split(":");
  const host = hostPart || "127.0.0.1";
  const port = Number(portPart ?? "");
  if (!Number.isFinite(port)) {
    throw new Error(`Invalid port in ${envVar}: ${value}`);
  }
  return [host, port];
}

function getAuthEmulatorUrl(envVar: string, fallback: string): string {
  const value = process.env[envVar] ?? fallback;
  return value.startsWith("http") ? value : `http://${value}`;
}

describe("Security: guest can read own profile", () => {
  beforeAll(async () => {
    const [fsHost, fsPort] = getHostAndPort("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080");
    const rulesPath = resolve(__dirname, "../..", "firestore.rules");
    const rules = readFileSync(rulesPath, "utf8");

    const hostForUrl = fsHost.includes(":") && !fsHost.startsWith("[") ? `[${fsHost}]` : fsHost;
    const response = await fetch(
      `http://${hostForUrl}:${fsPort}/emulator/v1/projects/${PROJECT_ID}:securityRules`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ignore_errors: true,
          rules: {
            files: [
              {
                name: "firestore.rules",
                content: rules,
              },
            ],
          },
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to load Firestore rules: ${response.status} ${text}`);
    }
  });

  it("allows authenticated anonymous user to read their own /Players/{uid}/Profile/Profile", async () => {
    const app = initializeApp({ projectId: PROJECT_ID, apiKey: "fake", appId: "demo" }, "guest1");
    const dbClient = getFirestore(app);
    const [fsHost, fsPort] = getHostAndPort("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080");
    connectFirestoreEmulator(dbClient, fsHost, fsPort);
    const auth = getAuth(app);
    connectAuthEmulator(auth, getAuthEmulatorUrl("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099"));

    const cred = await signInAnonymously(auth);
    const uid = cred.user.uid;

    // Seed a profile doc for this uid
    await admin.firestore().doc(`Players/${uid}/Profile/Profile`).set({ displayName: "Guest", level: 1, trophies: 0 });

    const profRef = doc(dbClient, `Players/${uid}/Profile/Profile`);
    const snap = await getDoc(profRef);
    expect(snap.exists()).toBe(true);

    await signOut(auth);
  });

  it("denies unauthenticated read to someone else’s profile", async () => {
    const app = initializeApp({ projectId: PROJECT_ID, apiKey: "fake", appId: "demo2" }, "guest2");
    const dbClient = getFirestore(app);
    const [fsHost, fsPort] = getHostAndPort("FIRESTORE_EMULATOR_HOST", "127.0.0.1:8080");
    connectFirestoreEmulator(dbClient, fsHost, fsPort);

    const someUid = "someone_else";
    await admin.firestore().doc(`Players/${someUid}/Profile/Profile`).set({ displayName: "Other", level: 1 });

    const profRef = doc(dbClient, `Players/${someUid}/Profile/Profile`);
    await expect(getDoc(profRef)).rejects.toBeTruthy();
  });
});
