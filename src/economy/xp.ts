import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { ensureOp } from "../shared/idempotency.js";
import { getLevelInfo } from "../shared/xp.js";
import { updateClanMemberSnapshot } from "../clan/helpers.js";
import { refreshFriendSnapshots } from "../Socials/updateSnapshots.js";
import {
  activeOffersRef,
  normaliseActiveOffers,
  pruneExpiredSpecialOffers,
} from "../shop/offerState.js";

const db = admin.firestore();
const LEVEL_UP_SPECIAL_DURATION_MS = 24 * 60 * 60 * 1000;
const LEVEL_UP_OFFERS: Array<{ level: number; offerId: string }> = [
  { level: 5, offerId: "offer_3vv3me0e" },
  { level: 10, offerId: "offer_jw7ms0ny" },
];

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

  const result = await db.runTransaction(async (transaction) => {
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

    const unlockedOffers = LEVEL_UP_OFFERS.filter(
      (entry) => beforeInfo.level < entry.level && afterInfo.level >= entry.level,
    );

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
        expProgressDisplay: `${afterInfo.expInLevel} / ${afterInfo.expToNext}`,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    transaction.update(profileRef, profileUpdate);

    if (unlockedOffers.length > 0) {
      const offersRef = activeOffersRef(uid);
      const offersSnap = await transaction.get(offersRef);
      const nowMs = Date.now();
      const activeState = normaliseActiveOffers(offersSnap.data());
      const existing = pruneExpiredSpecialOffers(activeState.special, nowMs).filter(
        (entry) => !unlockedOffers.some((offer) => offer.offerId === entry.offerId),
      );
      const additions = unlockedOffers.map((offer) => ({
        offerId: offer.offerId,
        triggerType: "level_up" as const,
        expiresAt: nowMs + LEVEL_UP_SPECIAL_DURATION_MS,
      }));
      transaction.set(
        offersRef,
        {
          special: [...existing, ...additions],
          updatedAt: nowMs,
        },
        { merge: true },
      );
    }

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

  await Promise.all([
    updateClanMemberSnapshot(uid, { level: result.levelAfter }),
    refreshFriendSnapshots(uid),
  ]);

  return result;
});
