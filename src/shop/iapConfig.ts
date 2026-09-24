import * as admin from "firebase-admin";

const CONFIG_PATH = "GameData/v1/config/IapConfig";
const CACHE_TTL_MS = 60 * 1000;

let cache: { verifyReceipts: boolean; fetchedAt: number } | null = null;

export const isReceiptVerificationEnabled = async (): Promise<boolean> => {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.verifyReceipts;
  }

  let verifyReceipts = false;
  try {
    const snapshot = await admin.firestore().doc(CONFIG_PATH).get();
    verifyReceipts = snapshot.exists && snapshot.data()?.verifyReceipts === true;
  } catch {
    verifyReceipts = cache?.verifyReceipts ?? false;
  }

  cache = { verifyReceipts, fetchedAt: now };
  return verifyReceipts;
};

export const __resetIapConfigCacheForTests = (): void => {
  cache = null;
};
