import fs from "fs";
import path from "path";

const PROFANITY_PATHS = [
  path.join(__dirname, "profanityList.json"), // built asset
  path.join(__dirname, "../../src/shared/profanityList.json"), // fallback to source for local/dev
];

const profanityListPath = PROFANITY_PATHS.find((p) => fs.existsSync(p));
if (!profanityListPath) {
  throw new Error("profanityList.json not found alongside shared/profanity");
}

const rawProfaneWords = JSON.parse(fs.readFileSync(profanityListPath, "utf8")) as string[];

// Wordlist sourced from chucknorris-io/swear-words plus local variants.
export const PROFANE_WORDS: string[] = Array.from(new Set(rawProfaneWords.map((word) => word.toLowerCase())));
const PROFANE_SET = new Set(PROFANE_WORDS);

const normalizeToken = (token: string): string => token.trim().toLowerCase();

export const containsProfanity = (value: string): boolean => {
  if (!value) {
    return false;
  }
  const parts = value.split(/\s+/);
  return parts.some((part) => {
    const normalized = normalizeToken(part);
    return normalized.length > 0 && PROFANE_SET.has(normalized);
  });
};

export const maskProfanity = (value: string): string => {
  if (!value) {
    return value;
  }
  const parts = value.split(/(\s+)/); // Keep whitespace delimiters for reconstruction.
  return parts
    .map((part) => {
      const normalized = normalizeToken(part);
      if (normalized.length === 0) {
        return part;
      }
      if (PROFANE_SET.has(normalized)) {
        return "*".repeat(part.length);
      }
      return part;
    })
    .join("");
};
