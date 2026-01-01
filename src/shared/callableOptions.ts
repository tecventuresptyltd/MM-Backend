import type { CallableOptions } from "firebase-functions/v2/https";
import { REGION } from "./region.js";

const defaultEnforceAppCheck = true;  // ✅ App Check required for all functions

// Helper to determine if we're running in production
const isProduction = (): boolean => {
  const project = process.env.GCLOUD_PROJECT || process.env.FIREBASE_CONFIG;
  return project === 'mystic-motors-prod' || (typeof project === 'string' && project.includes('"projectId":"mystic-motors-prod"'));
};

// Helper to get minInstances based on environment and warmInProd flag
export const getMinInstances = (warmInProd: boolean): number => {
  return warmInProd && isProduction() ? 1 : 0;
};

export const callableOptions = (
  overrides: Partial<CallableOptions> = {},
  warmInProd = false,
  memoryMiB: "128MiB" | "256MiB" = "256MiB"
): CallableOptions => ({
  region: REGION,
  enforceAppCheck: overrides.enforceAppCheck ?? defaultEnforceAppCheck,
  minInstances: overrides.minInstances ?? getMinInstances(warmInProd),
  memory: warmInProd && isProduction() ? (overrides.memory ?? memoryMiB) : overrides.memory,
  ...overrides,
});
