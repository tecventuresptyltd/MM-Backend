import { HttpsError } from "firebase-functions/v2/https";

const skipCheck = process.env.SKIP_APP_VERSION_CHECK === "true";
const minimumVersion = process.env.MIN_SUPPORTED_APP_VERSION ?? "";

function parseVersion(input: string): number[] {
  return input
    .split(".")
    .map((segment) => Number.parseInt(segment, 10))
    .filter((value) => Number.isFinite(value) && value >= 0);
}

function isVersionAtLeast(current: string, minimum: string): boolean {
  const currentParts = parseVersion(current);
  const minimumParts = parseVersion(minimum);

  const length = Math.max(currentParts.length, minimumParts.length);
  for (let i = 0; i < length; i += 1) {
    const currentValue = currentParts[i] ?? 0;
    const minimumValue = minimumParts[i] ?? 0;
    if (currentValue > minimumValue) return true;
    if (currentValue < minimumValue) return false;
  }
  return true;
}

export function assertSupportedAppVersion(appVersion: unknown): void {
  if (skipCheck || !minimumVersion) {
    return;
  }

  if (typeof appVersion !== "string" || appVersion.trim() === "") {
    throw new HttpsError("failed-precondition", "Client app version is required.");
  }

  if (!isVersionAtLeast(appVersion, minimumVersion)) {
    throw new HttpsError("failed-precondition", "Client app version is no longer supported.");
  }
}
