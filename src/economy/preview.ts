import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";

import { REGION } from "../shared/region.js";
import { calculateGemConversionRate } from "./rates.js";

const db = admin.firestore();
const PREVIEW_PACKAGES = [
  { id: "pack_small", name: "Sack of Coin", gems: 10 },
  { id: "pack_medium", name: "Chest of Coin", gems: 50 },
  { id: "pack_large", name: "Crate of Coin", gems: 250 },
  { id: "pack_xl", name: "Vault of Coin", gems: 500 },
];

export const getGemConversionPreview = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }

  const profileSnap = await db.doc(`Players/${uid}/Profile/Profile`).get();
  const trophies = Number(profileSnap.data()?.trophies ?? 0);

  const ratePerGem = calculateGemConversionRate(trophies);
  const ratePerHundred = ratePerGem * 100;

  const packages = PREVIEW_PACKAGES.map(({ id, name, gems }) => ({
    id,
    name,
    gems,
    coins: gems * ratePerGem,
  }));

  return {
    rate: ratePerHundred,
    trophies,
    packages,
  };
});
