/**
 * Single source of truth for username formatting rules.
 *
 * These rules are mirrored in the Unity client (UsernameManager.cs) and are also
 * applied to the bot name pool at seed time, so that every name a player can see
 * in a race is a name a player could legitimately create.
 *
 * This module deliberately has no firebase-admin dependency so that seed and
 * tooling scripts can import it without initialising Firestore.
 */

// #region Constants

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 16;
export const VALID_USERNAME_REGEX = /^[a-zA-Z0-9_]+$/;

/** Reasons a username can fail the pure-format checks. */
export type UsernameFormatError =
  | "empty"
  | "untrimmed"
  | "length"
  | "charset"
  | "underscore_edge"
  | "underscore_double";

// #endregion

// #region Validation

/**
 * Applies the format-only rules (no profanity, banned word, bot name or
 * uniqueness lookups — those need I/O and live in checkUsername).
 *
 * @returns null when the name is well formed, otherwise the failing rule.
 */
export const validateUsernameFormat = (username: string): UsernameFormatError | null => {
  if (!username) {
    return "empty";
  }

  if (username.trim() !== username) {
    return "untrimmed";
  }

  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    return "length";
  }

  if (!VALID_USERNAME_REGEX.test(username)) {
    return "charset";
  }

  if (username.startsWith("_") || username.endsWith("_")) {
    return "underscore_edge";
  }

  if (username.includes("__")) {
    return "underscore_double";
  }

  return null;
};

// #endregion
