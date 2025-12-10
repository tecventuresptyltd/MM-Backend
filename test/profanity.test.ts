import { containsProfanity, maskProfanity, PROFANE_WORDS } from "../src/shared/profanity.js";

describe("profanity mask", () => {
  it("masks English profanity and preserves length", () => {
    const input = "hello fuck world";
    const masked = maskProfanity(input);
    expect(masked).toBe("hello **** world");
  });

  it("catches obfuscated variants with punctuation", () => {
    const input = "F*ck you";
    const masked = maskProfanity(input);
    expect(masked.startsWith("*".repeat("F*ck".length))).toBe(true);
    expect(masked.endsWith(" you")).toBe(true);
  });

  it("masks Hindi transliterated profanity", () => {
    const input = "tum gandu ho";
    const masked = maskProfanity(input);
    expect(masked).toBe("tum ***** ho");
  });

  it("leaves clean text unchanged", () => {
    const input = "friendly chat message";
    expect(maskProfanity(input)).toBe(input);
  });
});

describe("profanity detection", () => {
  it("detects bad words in different casings", () => {
    expect(containsProfanity("This ShIt again")).toBe(true);
  });

  it("exposes the wordlist", () => {
    expect(PROFANE_WORDS.length).toBeGreaterThan(5);
  });
});
