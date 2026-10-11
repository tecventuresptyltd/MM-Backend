import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions } from "../shared/callableOptions.js";
import { checkIdempotency, createInProgressReceipt } from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import { getMasteryConfig, getMasteryProgress, getMasteryRank, getResearchCostForLevel, getSpellEvolutionV2Catalog } from "../core/configV2.js";

const db = admin.firestore();
const TUTORIAL_CAR_ID = "car_h4ayzwf31g";
const TUTORIAL_SPELL_ID = "spell_2382r2jk";
const RECEIPT_REASON = "completeTutorialPractice";

export const completeTutorialPractice = onCall(
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
    const receiptSnap = await receiptRef.get();
    if (receiptSnap.exists && receiptSnap.data()?.status === "completed" && receiptSnap.data()?.reason !== RECEIPT_REASON) {
      throw new HttpsError("already-exists", "This opId was already used for a different operation.");
    }
    const prior = await checkIdempotency(uid, opId) as { success?: boolean; spellId?: string; xpGranted?: number; spellShardsGranted?: number; masteryXp?: number; masteryRank?: number; spell?: Record<string, unknown>; balances?: Record<string, unknown> } | null;
    if (prior) {
      const [spellsSnap, economySnap, profileSnap] = await Promise.all([
        db.doc(`Players/${uid}/Spells/Levels`).get(),
        db.doc(`Players/${uid}/Economy/Stats`).get(),
        db.doc(`Players/${uid}/Profile/Profile`).get(),
      ]);
      const spell = (spellsSnap.data()?.spells ?? {})[TUTORIAL_SPELL_ID] as Record<string, unknown> | undefined;
      const profile = profileSnap.data() ?? {};
      return {
        ...prior,
        spell: spell ? { level: Number(spell.level ?? 1), xp: Number(spell.xp ?? 0), isXpCapped: spell.isXpCapped === true } : prior.spell,
        balances: { spellShards: Number(economySnap.data()?.spellShards ?? 0) },
        masteryXp: Number(profile.masteryXp ?? prior.masteryXp ?? 0),
        masteryRank: Number(profile.masteryRank ?? prior.masteryRank ?? 0),
      };
    }

    const [catalog, levelTwoCost, masteryConfig] = await Promise.all([
      getSpellEvolutionV2Catalog(),
      getResearchCostForLevel(2),
      getMasteryConfig(),
    ]);
    const xpCap = Number(catalog.spellXpConfig?.xpCapPerLevel?.["1"]);
    if (!Number.isFinite(xpCap) || xpCap < 0 || !levelTwoCost || !Number.isFinite(levelTwoCost.shards) || levelTwoCost.shards < 0 || !Number.isFinite(masteryConfig.spellWeight)) {
      throw new HttpsError("failed-precondition", "Tutorial spell practice rewards are not configured.");
    }

    await createInProgressReceipt(uid, opId, RECEIPT_REASON);
    return runTransactionWithReceipt(uid, opId, RECEIPT_REASON, async (tx) => {
      const progressRef = db.doc(`Players/${uid}/Progress/Initial`);
      const garageRef = db.doc(`Players/${uid}/Garage/Cars`);
      const spellsRef = db.doc(`Players/${uid}/Spells/Levels`);
      const economyRef = db.doc(`Players/${uid}/Economy/Stats`);
      const profileRef = db.doc(`Players/${uid}/Profile/Profile`);
      const [progressSnap, garageSnap, spellsSnap, economySnap, profileSnap] = await Promise.all([
        tx.get(progressRef), tx.get(garageRef), tx.get(spellsRef), tx.get(economyRef), tx.get(profileRef),
      ]);

      const progress = progressSnap.data() ?? {};
      if (!progressSnap.exists || progress.tutorialComplete !== false || progress.tutorialCarEvolutionStarted !== true) {
        throw new HttpsError("failed-precondition", "Tutorial practice is only available during an incomplete tutorial after the car evolution starts.");
      }
      if (progress.tutorialPracticeRewardGranted === true) {
        throw new HttpsError("already-exists", "Tutorial practice rewards were already claimed.");
      }
      if (!garageSnap.exists || !spellsSnap.exists || !economySnap.exists || !profileSnap.exists) {
        throw new HttpsError("failed-precondition", "Tutorial player progression data is incomplete.");
      }

      const targetLevel = Number(progress.tutorialCarEvolutionTargetLevel ?? 2);
      const car = (garageSnap.data()?.cars ?? {})[TUTORIAL_CAR_ID] as Record<string, unknown> | undefined;
      const carLevel = Number(car?.starLevel ?? car?.carLevel ?? 1);
      if (!car || carLevel < targetLevel || targetLevel < 2) {
        throw new HttpsError("failed-precondition", "Complete the tutorial car evolution before claiming practice rewards.");
      }

      const spellsData = spellsSnap.data() ?? {};
      const spellMap = (spellsData.spells ?? {}) as Record<string, { level?: number; xp?: number; isXpCapped?: boolean }>;
      const legacyLevels = (spellsData.levels ?? {}) as Record<string, number>;
      const existingSpell = spellMap[TUTORIAL_SPELL_ID];
      const currentLevel = Number(existingSpell?.level ?? legacyLevels[TUTORIAL_SPELL_ID] ?? 0);
      if (currentLevel < 1) {
        throw new HttpsError("failed-precondition", "Tutorial spell is not owned.");
      }

      const economy = economySnap.data() ?? {};
      const currentShards = Math.max(0, Number(economy.spellShards ?? 0));
      const spellShardsGranted = Math.max(0, levelTwoCost.shards - currentShards);
      const currentXp = Math.max(0, Number(existingSpell?.xp ?? 0));
      const shouldFillLevelOneCap = currentLevel === 1;
      const xpGranted = shouldFillLevelOneCap ? Math.max(0, xpCap - currentXp) : 0;
      const resultingXp = shouldFillLevelOneCap ? Math.max(currentXp, Math.min(xpCap, currentXp + xpGranted)) : currentXp;
      const isXpCapped = shouldFillLevelOneCap ? resultingXp >= xpCap : existingSpell?.isXpCapped === true;
      const resultingSpell = {
        level: currentLevel,
        xp: resultingXp,
        isXpCapped,
      };
      const profile = profileSnap.data() ?? {};
      const masteryXp = Number(profile.masteryXp ?? 0) + Math.round(xpGranted * masteryConfig.spellWeight);
      const pinnedRank = typeof profile.pinnedMasteryRank === "number" ? profile.pinnedMasteryRank : null;
      const masteryRank = pinnedRank ?? getMasteryRank(masteryXp, masteryConfig);
      const masteryProgress = getMasteryProgress(masteryXp, masteryConfig);
      const timestamp = admin.firestore.FieldValue.serverTimestamp();

      if (spellShardsGranted > 0) {
        tx.update(economyRef, {
          spellShards: admin.firestore.FieldValue.increment(spellShardsGranted),
          updatedAt: timestamp,
        });
      }
      if (!existingSpell || xpGranted > 0 || isXpCapped !== existingSpell.isXpCapped) {
        const update = {
          [`spells.${TUTORIAL_SPELL_ID}`]: resultingSpell,
          updatedAt: timestamp,
        };
        if (spellsSnap.exists) tx.update(spellsRef, update);
        else tx.set(spellsRef, { spells: { [TUTORIAL_SPELL_ID]: resultingSpell }, updatedAt: timestamp }, { merge: true });
      }
      const masteryXpGranted = Math.round(xpGranted * masteryConfig.spellWeight);
      if (masteryXpGranted > 0) {
        tx.update(profileRef, {
          masteryXp,
          masteryRank,
          level: masteryRank,
          expProgress: pinnedRank !== null ? 0 : masteryProgress.expProgress,
          expToNextLevel: pinnedRank !== null ? 0 : masteryProgress.expToNextLevel,
          expProgressDisplay: pinnedRank !== null ? "Max Rank" : masteryProgress.expProgressDisplay,
          updatedAt: timestamp,
        });
      }
      tx.set(progressRef, {
        tutorialPracticeRewardGranted: true,
        tutorialPracticeRewardOpId: opId,
        updatedAt: timestamp,
      }, { merge: true });

      return {
        success: true,
        spellId: TUTORIAL_SPELL_ID,
        xpGranted,
        spellShardsGranted,
        masteryXpGranted,
        masteryXp,
        masteryRank,
        spell: resultingSpell,
        balances: { spellShards: currentShards + spellShardsGranted },
      };
    });
  },
);
