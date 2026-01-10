import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { normalizeEmail } from "../shared/normalize";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";

interface RequestData {
  email: string;
}

interface ResponseData {
  exists: boolean;
}

// TEMPORARY: Disabled App Check until Firebase Authentication service sends tokens
// TODO: Re-enable once Authentication shows >90% verified requests
export const checkEmailExists = onCall<RequestData>(
  callableOptions({ enforceAppCheck: false, minInstances: getMinInstances(true), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
  async (request): Promise<ResponseData> => {
    const { email } = request.data;

    if (typeof email !== "string" || email.length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "The function must be called with one argument 'email' which must be a non-empty string."
      );
    }

    const normalizedEmail = normalizeEmail(email);

    const docRef = getFirestore().doc(`/AccountsEmails/${normalizedEmail}`);
    const docSnap = await docRef.get();

    return { exists: docSnap.exists };
  }
);