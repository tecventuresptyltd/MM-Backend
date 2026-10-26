import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./firestore.js";

export const MIN_SOCIAL_AGE = 13;
const MAX_CACHED_BIRTH_YEARS = 50000;
const birthYearCache = new Map<string, number>();

export const isOldEnoughForSocial = (birthYear: unknown, now: Date = new Date()): boolean =>
  typeof birthYear === "number" && birthYear > 0 && now.getUTCFullYear() - birthYear >= MIN_SOCIAL_AGE;

const readBirthYear = async (uid: string): Promise<number> => {
  const cached = birthYearCache.get(uid);
  if (cached !== undefined) {
    return cached;
  }

  const snap = await db.doc(`/Players/${uid}`).get();
  const birthYear = Number(snap.get("birthYear") ?? 0);
  if (birthYear > 0) {
    if (birthYearCache.size >= MAX_CACHED_BIRTH_YEARS) {
      birthYearCache.clear();
    }
    birthYearCache.set(uid, birthYear);
  }
  return birthYear;
};

export const assertSocialAgeAllowed = async (uid: string): Promise<void> => {
  if (!isOldEnoughForSocial(await readBirthYear(uid))) {
    throw new HttpsError("permission-denied", "Chat, clans and friends unlock at age 13.");
  }
};
