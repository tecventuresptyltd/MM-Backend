import { validateUsernameFormat } from "../src/shared/usernameRules.js";

/**
 * Guards the bot name pool at seed time.
 *
 * Bot display names appear beside player names on the race HUD and end-race
 * leaderboard. If a bot can be called something a player is not allowed to type,
 * players read it as an inconsistency. Every name in the pool must therefore pass
 * the same format rules as a username, and be unique case-insensitively (the
 * Usernames collection is keyed on the lowercased name).
 *
 * @throws when any name is malformed or duplicated.
 */
export function assertBotNamesAreValidUsernames(names: unknown): void {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error("BotNamesConfig: expected a non-empty 'names' array.");
  }

  const problems: string[] = [];
  const seen = new Map<string, string>();

  for (const entry of names) {
    if (typeof entry !== "string") {
      problems.push(`non-string entry: ${JSON.stringify(entry)}`);
      continue;
    }

    const failure = validateUsernameFormat(entry);
    if (failure !== null) {
      problems.push(`"${entry}" fails username rule: ${failure}`);
      continue;
    }

    const key = entry.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      problems.push(`"${entry}" duplicates "${previous}" (case-insensitive)`);
      continue;
    }
    seen.set(key, entry);
  }

  if (problems.length > 0) {
    throw new Error(
      `BotNamesConfig: ${problems.length} invalid bot name(s).\n  ` +
      problems.slice(0, 20).join("\n  ") +
      (problems.length > 20 ? `\n  ...and ${problems.length - 20} more` : "")
    );
  }
}
