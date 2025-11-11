import type { CallableOptions } from "firebase-functions/v2/https";
import { REGION } from "./region.js";

const defaultEnforceAppCheck = false;

export const callableOptions = (overrides: Partial<CallableOptions> = {}): CallableOptions => ({
  region: REGION,
  enforceAppCheck: overrides.enforceAppCheck ?? defaultEnforceAppCheck,
  ...overrides,
});
