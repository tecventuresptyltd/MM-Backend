import { onCall, HttpsError } from "firebase-functions/v2/https";
import * as admin from "firebase-admin";
import { callableOptions } from "./shared/callableOptions.js";

const MAX_FEEDBACK_BYTES = 950_000; // stay under the 1 MB Firestore doc limit

interface SubmitFeedbackRequest {
  feedback?: unknown;
  name?: unknown;
}

export const submitFeedback = onCall(callableOptions({ cpu: 1, concurrency: 80 }), async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const { feedback, name } = (request.data ?? {}) as SubmitFeedbackRequest;

  if (typeof feedback !== "string") {
    throw new HttpsError("invalid-argument", "feedback must be a string.");
  }
  const trimmedFeedback = feedback.trim();
  if (!trimmedFeedback) {
    throw new HttpsError("invalid-argument", "feedback cannot be empty.");
  }

  const feedbackBytes = Buffer.byteLength(trimmedFeedback, "utf8");
  if (feedbackBytes > MAX_FEEDBACK_BYTES) {
    throw new HttpsError("invalid-argument", "feedback is too large to store.");
  }

  const nameString =
    typeof name === "string" && name.trim().length > 0 ? name.trim() : null;

  const payload = {
    userId: uid,
    name: nameString,
    feedback: trimmedFeedback,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const docRef = admin.firestore().collection("Feedbacks").doc();
  await docRef.set(payload);

  return { success: true, id: docRef.id };
});
