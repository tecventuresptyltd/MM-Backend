import { createHash } from "crypto";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return JSON.stringify(null);
    }
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const serialized = value.map((entry) => canonicalize(entry)).join(",");
    return `[${serialized}]`;
  }

  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    const serialized = keys
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",");
    return `{${serialized}}`;
  }

  return JSON.stringify(null);
};

export const hashOperationInputs = (value: unknown): string =>
  createHash("sha256").update(canonicalize(value)).digest("hex");
