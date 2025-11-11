import { HttpsError } from "firebase-functions/v2/https";

const DEVICE_ANCHOR_REGEX = /^[a-zA-Z0-9-]{32,64}$/;

export function assertDeviceAnchor(anchor: unknown): asserts anchor is string {
  if (typeof anchor !== "string" || !DEVICE_ANCHOR_REGEX.test(anchor)) {
    throw new HttpsError("invalid-argument", "Invalid device anchor format.");
  }
}

export function assertEmail(email: unknown): asserts email is string {
  if (typeof email !== "string" || !/.+@.+\..+/.test(email)) {
    throw new HttpsError("invalid-argument", "Invalid email format.");
  }
}

export function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < 6) {
    throw new HttpsError("invalid-argument", "Password must be at least 6 characters long.");
  }
}