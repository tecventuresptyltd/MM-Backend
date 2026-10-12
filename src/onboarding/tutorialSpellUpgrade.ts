import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { getResearchCostForLevel } from "../core/configV2.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import { callableOptions } from "../shared/callableOptions.js";
import { cancelUpgradeCompletion } from "../upgrades/upgradeScheduler.js";

const db = admin.firestore();
const TUTORIAL_SPELL_ID = "spell_2382r2jk";
const RESEARCH_OP_ID = "tutorial-spell-start";
const RECEIPT_REASON = "completeTutorialSpellUpgrade";

type TutorialSpellResult = {
  success: true;
  spellId: string;
  spell: { level: number; xp: number; isXpCapped: boolean };
  shardsSpent: number;
  completedExistingResearch: boolean;
  balances: { spellShards: number };
};

export const completeTutorialSpellUpgrade = onCall(
  callableOptions({ cpu: 1, concurrency: 80 }),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "User must be authenticated.");

    const data = request.data;
    const opId = data && typeof data === "object" && !Array.isArray(data) ? data.opId : null;
    if (typeof opId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(opId)) {
      throw new HttpsError("invalid-argument", "A valid opId is required.");
    }

    const receiptRef = db.doc(`Players/${uid}/Receipts/${opId}`);
    const existingReceipt = await receiptRef.get();
    if (existingReceipt.exists && existingReceipt.data()?.status === "completed" && existingReceipt.data()?.reason !== RECEIPT_REASON) {
      throw new HttpsError("already-exists", "This opId was already used for a different operation.");
    }
    const prior = await checkIdempotency(uid, opId) as TutorialSpellResult | null;
    if (prior) {
      const [spellsSnap, economySnap] = await Promise.all([
        db.doc(`Players/${uid}/Spells/Levels`).get(),
        db.doc(`Players/${uid}/Economy/Stats`).get(),
      ]);
      const spellData = (spellsSnap.data()?.spells ?? {})[TUTORIAL_SPELL_ID] as Record<string, unknown> | undefined;
      return {
        ...prior,
        spell: spellData ? {
          level: Number(spellData.level ?? prior.spell.level),
          xp: Number(spellData.xp ?? prior.spell.xp),
          isXpCapped: spellData.isXpCapped === true,
        } : prior.spell,
        balances: { spellShards: Number(economySnap.data()?.spellShards ?? 0) },
      };
    }

    const levelTwoCost = await getResearchCostForLevel(2);
    if (!levelTwoCost || !Number.isFinite(levelTwoCost.shards) || levelTwoCost.shards < 0) {
      throw new HttpsError("failed-precondition", "Tutorial spell research is not configured.");
    }

    await createInProgressReceipt(uid, opId, RECEIPT_REASON);
    const result = await runTransactionWithReceipt<TutorialSpellResult>(uid, opId, RECEIPT_REASON, async (tx) => {
      const progressRef = db.doc(`Players/${uid}/Progress/Initial`);
      const spellsRef = db.doc(`Players/${uid}/Spells/Levels`);
      const economyRef = db.doc(`Players/${uid}/Economy/Stats`);
      const libraryRef = db.doc(`Players/${uid}/Queues/Library`);
      const researchReceiptRef = db.doc(`Players/${uid}/Receipts/${RESEARCH_OP_ID}`);
      const [progressSnap, spellsSnap, economySnap, librarySnap, researchReceiptSnap] = await Promise.all([
        tx.get(progressRef), tx.get(spellsRef), tx.get(economyRef), tx.get(libraryRef), tx.get(researchReceiptRef),
      ]);

      const progress = progressSnap.data() ?? {};
      if (!progressSnap.exists || progress.tutorialComplete !== false || progress.tutorialPracticeRewardGranted !== true) {
        throw new HttpsError("failed-precondition", "Tutorial spell upgrade requires an incomplete tutorial and completed practice reward.");
      }
      if (progress.tutorialSpellUpgradeCompleted === true) {
        throw new HttpsError("already-exists", "Tutorial spell upgrade was already completed.");
      }
      if (!spellsSnap.exists || !economySnap.exists) {
        throw new HttpsError("failed-precondition", "Tutorial spell progression data is incomplete.");
      }

      const spellsData = spellsSnap.data() ?? {};
      const spells = (spellsData.spells ?? {}) as Record<string, { level?: number; xp?: number; isXpCapped?: boolean }>;
      const legacyLevels = (spellsData.levels ?? {}) as Record<string, number>;
      const currentSpell = spells[TUTORIAL_SPELL_ID];
      const currentLevel = Number(currentSpell?.level ?? legacyLevels[TUTORIAL_SPELL_ID] ?? 0);
      if (currentLevel < 1) throw new HttpsError("failed-precondition", "Tutorial spell is not owned.");

      const libraryData = librarySnap.data() ?? {};
      const slots = Array.isArray(libraryData.slots) ? libraryData.slots as Array<Record<string, unknown>> : [];
      const matchingSlot = slots.find((slot) => slot.spellId === TUTORIAL_SPELL_ID);
      const economy = economySnap.data() ?? {};
      const currentShards = Math.max(0, Number(economy.spellShards ?? 0));
      let shardsSpent = 0;
      let completedExistingResearch = false;
      const shouldPreserveLaterResearch = currentLevel >= 2 && Number(matchingSlot?.targetLevel ?? 0) > 2;

      if (matchingSlot && !shouldPreserveLaterResearch) {
        const receiptResult = researchReceiptSnap.data()?.result as Record<string, unknown> | undefined;
        if (
          matchingSlot.targetLevel !== 2 ||
          researchReceiptSnap.data()?.status !== "completed" ||
          researchReceiptSnap.data()?.reason !== "startSpellResearchV2" ||
          receiptResult?.spellId !== TUTORIAL_SPELL_ID ||
          receiptResult?.targetLevel !== 2 ||
          typeof receiptResult?.shardsSpent !== "number" ||
          matchingSlot.shardsPaid !== receiptResult.shardsSpent
        ) {
          throw new HttpsError("failed-precondition", "The queued spell research is not the paid tutorial level-two upgrade.");
        }
        completedExistingResearch = true;
      } else if (currentLevel === 1) {
        if (currentShards < levelTwoCost.shards) {
          throw new HttpsError("failed-precondition", "Insufficient Spell Shards for the tutorial spell upgrade.");
        }
        shardsSpent = levelTwoCost.shards;
      }

      const resultingSpell = currentLevel >= 2
        ? { level: currentLevel, xp: Number(currentSpell?.xp ?? 0), isXpCapped: currentSpell?.isXpCapped === true }
        : { level: 2, xp: 0, isXpCapped: false };
      if (shardsSpent > 0) {
        tx.update(economyRef, {
          spellShards: admin.firestore.FieldValue.increment(-shardsSpent),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      tx.update(spellsRef, {
        [`spells.${TUTORIAL_SPELL_ID}`]: resultingSpell,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (matchingSlot && completedExistingResearch) {
        tx.update(libraryRef, {
          slots: slots.filter((slot) => slot.spellId !== TUTORIAL_SPELL_ID),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      tx.set(progressRef, {
        tutorialSpellUpgradeCompleted: true,
        tutorialSpellUpgradeOpId: opId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      return {
        success: true,
        spellId: TUTORIAL_SPELL_ID,
        spell: resultingSpell,
        shardsSpent,
        completedExistingResearch,
        balances: { spellShards: currentShards - shardsSpent },
      };
    });

    if (result.completedExistingResearch) {
      try {
        await cancelUpgradeCompletion(uid, "spellResearch", TUTORIAL_SPELL_ID);
      } catch (error) {
        console.warn(`[TutorialSpellUpgrade] Failed to cancel scheduled completion for ${uid}/${TUTORIAL_SPELL_ID}`, error);
      }
    }
    return result;
  },
);
