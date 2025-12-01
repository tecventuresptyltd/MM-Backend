import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { REGION } from "../shared/region.js";
import { calculateGemConversionRate } from "./rates.js";

const db = admin.firestore();
const PREVIEW_PACKAGE_AMOUNTS = [100, 500];

export const getGemConversionPreview = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const profileSnap = await db.doc(`Players/${uid}/Profile/Profile`).get();
  const trophies = Number(profileSnap.data()?.trophies ?? 0);

  const ratePerGem = calculateGemConversionRate(trophies);
  const ratePerHundred = ratePerGem * 100;

  const packages = PREVIEW_PACKAGE_AMOUNTS.map((gems) => ({
    gems,
    coins: gems * ratePerGem,
  }));

  return {
    rate: ratePerHundred,
    trophies,
    packages,
  };
});
