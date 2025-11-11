import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { ensureOp } from "../shared/idempotency.js";
import { getLevelInfo } from "../shared/xp.js";

const db = admin.firestore();

interface GrantXPRequest {
  amount: number;
  opId: string;
  reason: string;
}


export const grantXP = onCall({ enforceAppCheck: false, region: "us-central1" }, async (request) => {
  const { amount, opId } = request.data as GrantXPRequest;
  const uid = request.auth?.uid;

  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (!opId || typeof opId !== "string") {
    throw new HttpsError("invalid-argument", "Invalid opId provided.");
  }

  if (typeof amount !== "number" || amount <= 0) {
    throw new HttpsError("invalid-argument", "Amount must be a positive number.");
  }

  await ensureOp(uid, opId);

  return db.runTransaction(async (transaction) => {
    const statsRef = db.doc(`/Players/${uid}/Economy/Stats`);
    const profileRef = db.doc(`/Players/${uid}/Profile/Profile`);
    
    const [statsDoc, profileDoc] = await transaction.getAll(statsRef, profileRef);

    if (!statsDoc.exists) {
      throw new HttpsError("not-found", "Player economy stats not found.");
    }
    if (!profileDoc.exists) {
        throw new HttpsError("not-found", "Player profile not found.");
    }

    const profile = profileDoc.data()!;
    const xpBefore = Number(profile.exp ?? 0);
    const xpAfter = xpBefore + amount;

    const beforeInfo = getLevelInfo(xpBefore);
    const afterInfo = getLevelInfo(xpAfter);
    const levelsGained = afterInfo.level - beforeInfo.level;
    const leveledUp = levelsGained > 0;

    // Update Economy/Stats for spell tokens if leveled up
    if (levelsGained > 0) {
      const economyUpdate = {
        spellTokens: admin.firestore.FieldValue.increment(levelsGained),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      transaction.update(statsRef, economyUpdate);
    }

    // Update Profile/Profile
    const profileUpdate = {
        exp: xpAfter,
        level: afterInfo.level,
        expProgress: afterInfo.expInLevel,
        expToNextLevel: afterInfo.expToNext,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    transaction.update(profileRef, profileUpdate);

    return {
      success: true,
      opId,
      xpBefore,
      xpAfter,
      levelBefore: beforeInfo.level,
      levelAfter: afterInfo.level,
      leveledUp,
      expProgress: {
        before: {
          expInLevel: beforeInfo.expInLevel,
          expToNextLevel: beforeInfo.expToNext,
        },
        after: {
          expInLevel: afterInfo.expInLevel,
          expToNextLevel: afterInfo.expToNext,
        },
      },
    };
  });
});
