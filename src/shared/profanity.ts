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

const LEET_MAP: Record<string, string> = {
  "@": "a",
  "4": "a",
  "8": "b",
  "3": "e",
  "1": "i",
  "!": "i",
  "|": "i",
  "0": "o",
  "5": "s",
  "$": "s",
  "7": "t",
};

// Wordlist sourced from chucknorris-io/swear-words plus local variants.
const BASE_PROFANE_WORDS = Array.from(new Set(rawProfaneWords.map((word) => word.toLowerCase())));

export const PROFANE_WORDS: string[] = BASE_PROFANE_WORDS;

const PROFANE_PATTERNS: string[] = Array.from(
  new Set(
    PROFANE_WORDS.flatMap((word) => {
      const withoutVowels = word.replace(/[aeiou]/g, "");
      if (withoutVowels.length >= 3 && withoutVowels !== word) {
        return [word, withoutVowels];
      }
      return [word];
    }),
  ),
);

const stripDiacritics = (value: string): string =>
  value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

const normalizeToken = (token: string): string => {
  let normalized = "";
  for (const rawChar of stripDiacritics(token.toLowerCase())) {
    const mapped = LEET_MAP[rawChar] ?? rawChar;
    if (/\p{L}|\p{N}/u.test(mapped)) {
      normalized += mapped;
    }
  }
  return normalized;
};

const hasProfanity = (token: string): string | null => {
  if (!token) {
    return null;
  }
  const normalized = normalizeToken(token);
  if (!normalized) {
    return null;
  }
  for (const word of PROFANE_PATTERNS) {
    if (normalized.includes(word)) {
      return word;
    }
  }
  return null;
};

export const containsProfanity = (value: string): boolean => {
  if (!value) {
    return false;
  }
  const parts = value.split(/\s+/);
  return parts.some((part) => hasProfanity(part) !== null);
};

export const maskProfanity = (value: string): string => {
  if (!value) {
    return value;
  }
  const parts = value.split(/(\s+)/); // Keep whitespace delimiters for reconstruction.
  return parts
    .map((part) => {
      const match = hasProfanity(part);
      if (!match) {
        return part;
      }
      return "*".repeat(part.length);
    })
    .join("");
};
