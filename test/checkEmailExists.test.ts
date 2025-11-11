// functions/test/checkEmailExists.test.ts
import * as admin from "firebase-admin";
import { wrapCallable } from "./helpers/callable";
import { checkEmailExists } from "../src/auth";
import { normalizeEmail } from "../src/shared/normalize";
import { wipeFirestore } from "./helpers/cleanup";

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: "test-project",
  });
}

describe("checkEmailExists", () => {
  const db = admin.firestore();
  const wrappedCheckEmail = wrapCallable(checkEmailExists);

  afterEach(async () => {
    await wipeFirestore();
  });

  it("should return { exists: false } for an unknown email", async () => {
    const email = "unknown@example.com";
    const result = await wrappedCheckEmail({ data: { email } });
    expect(result).toEqual({ exists: false });
  });

  it("should return { exists: true } for a pre-existing email", async () => {
    const email = "exists@example.com";
    const normalizedEmail = normalizeEmail(email);
    await db.collection("AccountsEmails").doc(normalizedEmail).set({ uid: "some-uid" });

    const result = await wrappedCheckEmail({ data: { email } });
    expect(result).toEqual({ exists: true });
  });
});