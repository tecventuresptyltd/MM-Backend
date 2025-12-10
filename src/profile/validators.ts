import * as admin from "firebase-admin";
import { containsProfanity } from "../shared/profanity.js";

const db = admin.firestore();

// Basic validation rules (length, characters)
const MIN_LENGTH = 3;
const MAX_LENGTH = 16;
const VALID_USERNAME_REGEX = /^[a-zA-Z0-9_]+$/;

// List of banned words (should be moved to a more secure location in a real app)
const BANNED_WORDS = ["admin", "root", "superuser", "moderator", "mysticmotors"];
 
export const checkUsername = async (username: string): Promise<boolean> => {
  if (!username) {
    return false;
  }
 
  // Trim leading/trailing spaces
  const trimmedUsername = username.trim();
  if (trimmedUsername !== username) {
    return false;
  }
 
  // Length check
  if (trimmedUsername.length < MIN_LENGTH || trimmedUsername.length > MAX_LENGTH) {
    return false;
  }
 
  // Character check
  if (!VALID_USERNAME_REGEX.test(trimmedUsername)) {
    return false;
  }
 
  // No leading/trailing underscores
  if (trimmedUsername.startsWith("_") || trimmedUsername.endsWith("_")) {
    return false;
  }
 
  // No double underscores
  if (trimmedUsername.includes("__")) {
    return false;
  }
 
  const usernameLower = trimmedUsername.toLowerCase();
  if (containsProfanity(usernameLower)) {
    return false;
  }
 
  // Banned words check
  if (BANNED_WORDS.some(word => usernameLower.includes(word))) {
    return false;
  }

  // Check for uniqueness in the Usernames collection
  const usernameRef = db.collection("Usernames").doc(usernameLower);
  const doc = await usernameRef.get();
  return !doc.exists;
};
