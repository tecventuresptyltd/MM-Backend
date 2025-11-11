import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { normalizeEmail } from "../shared/normalize";

interface RequestData {
  email: string;
}

interface ResponseData {
  exists: boolean;
}

export const checkEmailExists = onCall<RequestData>(
  { region: "us-central1" },
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