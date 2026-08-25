import * as admin from "firebase-admin";
import { containsProfanity } from "../shared/profanity.js";
import { getBotNamesConfig } from "../core/config.js";
import { validateUsernameFormat } from "../shared/usernameRules.js";

const db = admin.firestore();

// List of banned words (should be moved to a more secure location in a real app)
const BANNED_WORDS = ["admin", "root", "superuser", "moderator", "mysticmotors"];

/**
 * Bot display names are drawn from /GameData/v1/config/BotNames. Players must not be
 * able to take one, otherwise a human and a bot can share an identity in the same race.
 * Falls open on a config read failure so a catalog outage cannot block all name changes.
 */
const isBotName = async (usernameLower: string): Promise<boolean> => {
  try {
    const botNames = await getBotNamesConfig();
    return botNames.some((name) => name.trim().toLowerCase() === usernameLower);
  } catch (error) {
    console.error("checkUsername: bot name reservation lookup failed", error);
    return false;
  }
};

export const checkUsername = async (username: string): Promise<boolean> => {
  // Length, charset and underscore rules (shared with the client and the bot name seed).
  if (typeof username !== "string" || validateUsernameFormat(username) !== null) {
    return false;
  }

  const usernameLower = username.toLowerCase();

  if (containsProfanity(usernameLower)) {
    return false;
  }

  // Banned words check
  if (BANNED_WORDS.some(word => usernameLower.includes(word))) {
    return false;
  }

  // Reserved bot display names
  if (await isBotName(usernameLower)) {
    return false;
  }

  // Check for uniqueness in the Usernames collection
  const usernameRef = db.collection("Usernames").doc(usernameLower);
  const doc = await usernameRef.get();
  return !doc.exists;
};
