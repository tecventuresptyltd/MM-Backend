import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  checkIdempotency,
  createInProgressReceipt,
} from "../core/idempotency.js";
import { runTransactionWithReceipt } from "../core/transactions.js";
import { hashOperationInputs } from "../core/hash.js";
import { getSpellsCatalog } from "../core/config.js";
import { REGION } from "../shared/region.js";
import { Spell } from "../shared/types.js";
import { callableOptions } from "../shared/callableOptions.js";
import { ensureOp } from "../shared/idempotency.js";

const db = admin.firestore();
const MAX_SPELL_LEVEL = 5;

// --- Spell Upgrade Costs Config Loader ---
let cachedUpgradeCosts: { data: Record<string, number>; lastFetched: number } | null = null;

/**
 * Fetches the default spell upgrade costs configuration from Firestore.
 * Returns a map of target level -> token cost.
 * Falls back to 1 token per level if config is missing.
 */
async function getSpellUpgradeCosts(): Promise<Record<string, number>> {
  const now = Date.now();
  const CACHE_TTL_MS = 60 * 1000; // 60 seconds

  if (cachedUpgradeCosts && now - cachedUpgradeCosts.lastFetched < CACHE_TTL_MS) {
    return cachedUpgradeCosts.data;
  }

  try {
    const doc = await db.doc("/GameData/v1/config/SpellUpgradeCosts").get();
    if (!doc.exists) {
      console.warn("[SpellUpgrade] SpellUpgradeCosts config not found, using fallback of 1 token per level");
      const fallback = { "1": 1, "2": 1, "3": 1, "4": 1, "5": 1 };
      cachedUpgradeCosts = { data: fallback, lastFetched: now };
      return fallback;
    }

    const data = doc.data()?.defaultCosts ?? {};
    cachedUpgradeCosts = { data, lastFetched: now };
    return data;
  } catch (error) {
    console.error("[SpellUpgrade] Failed to load SpellUpgradeCosts config:", error);
    // Return cached data if available, otherwise use fallback
    if (cachedUpgradeCosts) {
      return cachedUpgradeCosts.data;
    }
    return { "1": 1, "2": 1, "3": 1, "4": 1, "5": 1 };
  }
}


const normaliseSpellLevels = (
  rawLevels: Record<string, unknown> | undefined,
): { map: Record<string, Record<string, unknown>>; maxLevel: number } => {
  const levels: Record<string, Record<string, unknown>> = {};
  let maxLevel = 1;

  if (rawLevels && typeof rawLevels === "object") {
    for (const [key, value] of Object.entries(rawLevels)) {
      const levelNumber = Number(key);
      if (!Number.isFinite(levelNumber) || levelNumber < 1) {
        continue;
      }
      const entry: Record<string, any> =
        value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
      const rawTokenCost = Number(
        entry.tokenCost ??
        (typeof entry.cost === "object"
          ? (entry.cost as Record<string, unknown>).spellTokens
          : undefined) ??
        0,
      );
      const tokenCost = Number.isFinite(rawTokenCost) && rawTokenCost > 0 ? rawTokenCost : 0;
      entry.tokenCost = tokenCost;
      const costPayload =
        entry.cost && typeof entry.cost === "object"
          ? { ...(entry.cost as Record<string, unknown>), spellTokens: tokenCost }
          : { spellTokens: tokenCost };
      entry.cost = costPayload;
      levels[String(levelNumber)] = entry;
      if (levelNumber > maxLevel) {
        maxLevel = levelNumber;
      }
    }
  }

  if (!levels["1"]) {
    levels["1"] = { tokenCost: 0, cost: { spellTokens: 0 } };
  } else {
    const levelOne = levels["1"] as Record<string, any>;
    const tokenCost = Number(levelOne.tokenCost ?? 0) || 0;
    levelOne.tokenCost = tokenCost;
    levelOne.cost = { spellTokens: tokenCost };
  }

  if (maxLevel < 1) {
    maxLevel = 1;
  }

  return { map: levels, maxLevel };
};

function normalizeRequiredLevel(value?: number | string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  if (numeric < 0) {
    return 100;
  }
  return Math.floor(numeric);
}

function normalizePlayerLevel(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  return 0;
}

function getOrderedSpellIds(spellsCatalog: Record<string, Spell>): string[] {
  return Object.entries(spellsCatalog)
    .map(([id, spell]) => {
      const requiredLevel = normalizeRequiredLevel(spell.requiredLevel);
      const name = spell.displayName ?? spell.i18n?.en ?? id;
      const isDefault = spell.isUnlocked === true || requiredLevel <= 0;
      return { id, requiredLevel, name, isDefault };
    })
    .sort((a, b) => {
      if (a.requiredLevel !== b.requiredLevel) {
        return a.requiredLevel - b.requiredLevel;
      }
      if (a.isDefault !== b.isDefault) {
        return a.isDefault ? -1 : 1;
      }
      if (a.name !== b.name) {
        return a.name.localeCompare(b.name);
      }
      return a.id.localeCompare(b.id);
    })
    .map((entry) => entry.id);
}

export const setLoadout = onCall(callableOptions({}, true), async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const { opId, loadoutId, carId } = request.data;
  if (typeof opId !== "string" || typeof loadoutId !== "string" || typeof carId !== "string") {
    throw new HttpsError("invalid-argument", "Invalid arguments provided.");
  }

  await ensureOp(uid, opId);

  const loadoutRef = db.doc(`/Players/${uid}/Loadouts/Active`);
  await loadoutRef.update({ carId, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  return { success: true };
});

export const equipCosmetics = onCall(callableOptions({}, true), async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const { opId, loadoutId, cosmetics } = request.data;
  if (typeof opId !== "string" || typeof loadoutId !== "string" || typeof cosmetics !== "object") {
    throw new HttpsError("invalid-argument", "Invalid arguments provided.");
  }

  await ensureOp(uid, opId);

  const loadoutRef = db.doc(`/Players/${uid}/Loadouts/Active`);
  await loadoutRef.update({ cosmetics, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  return { success: true };
});

export const setSpellDeck = onCall(callableOptions({}, true), async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const { opId, deckNo, spells } = request.data;
  if (typeof opId !== "string" || typeof deckNo !== "number" || !Array.isArray(spells) || spells.length !== 5) {
    throw new HttpsError("invalid-argument", "Invalid arguments provided.");
  }

  await ensureOp(uid, opId);

  const deckRef = db.doc(`/Players/${uid}/SpellDecks/Decks`);
  await deckRef.update({
    [`decks.${deckNo}.spells`]: spells,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true };
});

export const selectActiveSpellDeck = onCall(callableOptions({}, true), async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const { opId, loadoutId, deckNo } = request.data;
  if (typeof opId !== "string" || typeof loadoutId !== "string" || typeof deckNo !== "number") {
    throw new HttpsError("invalid-argument", "Invalid arguments provided.");
  }

  await ensureOp(uid, opId);

  const loadoutRef = db.doc(`/Players/${uid}/Loadouts/Active`);
  await loadoutRef.update({ activeSpellDeck: deckNo, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  return { success: true };
});

export const upgradeSpell = onCall(callableOptions({}, true), async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  const { opId, spellId } = request.data;
  if (typeof opId !== "string" || typeof spellId !== "string") {
    throw new HttpsError("invalid-argument", "Invalid arguments provided.");
  }

  const inputsHash = hashOperationInputs({ spellId });
  const existingReceipt = await checkIdempotency(uid, opId);
  if (existingReceipt) {
    return existingReceipt;
  }

  await createInProgressReceipt(uid, opId, "upgradeSpell", {
    kind: "spell-upgrade",
    inputsHash,
  });

  return runTransactionWithReceipt(
    uid,
    opId,
    "upgradeSpell",
    async (transaction) => {
      const playerSpellsRef = db.doc(`/Players/${uid}/Spells/Levels`);
      const economyRef = db.doc(`/Players/${uid}/Economy/Stats`);
      const profileRef = db.doc(`/Players/${uid}/Profile/Profile`);

      const [playerSpellsDoc, economyDoc, profileDoc] = await transaction.getAll(
        playerSpellsRef,
        economyRef,
        profileRef,
      );

      if (!economyDoc.exists) {
        throw new HttpsError("not-found", "Player economy data not found.");
      }
      if (!profileDoc.exists) {
        throw new HttpsError("not-found", "Player profile not found.");
      }

      const spellsCatalog = await getSpellsCatalog();
      const spellGameData = spellsCatalog[spellId];

      if (!spellGameData) {
        throw new HttpsError("not-found", "Spell game data not found in catalog.");
      }

      const playerSpellsData = playerSpellsDoc.data() ?? {};
      const economyData = economyDoc.data() ?? {};
      const profileData = profileDoc.data() ?? {};

      const { map: spellLevels, maxLevel: catalogMaxLevel } = normaliseSpellLevels(
        spellGameData.levels as Record<string, unknown> | undefined,
      );

      // Determine max level from spell attributes if not defined in levels config
      let actualMaxLevel = catalogMaxLevel;
      const spellData = spellGameData as any; // Cast to access attributes from game data
      if (actualMaxLevel <= 1 && spellData.attributes && Array.isArray(spellData.attributes) && spellData.attributes.length > 0) {
        // Get max level from the first attribute's values array length
        const firstAttributeValues = spellData.attributes[0]?.values;
        if (Array.isArray(firstAttributeValues) && firstAttributeValues.length > 1) {
          actualMaxLevel = firstAttributeValues.length;
        }
      }

      const allowedMaxLevel = Math.min(MAX_SPELL_LEVEL, actualMaxLevel);

      const currentLevel = Number((playerSpellsData.levels ?? {})[spellId] ?? 0);
      if (currentLevel >= allowedMaxLevel) {
        throw new HttpsError("failed-precondition", `Spell is already at max level (${currentLevel}/${allowedMaxLevel}).`);
      }

      const nextLevel = currentLevel + 1;
      let nextLevelConfig = spellLevels[String(nextLevel)];

      // If no specific level config exists, create a default one
      if (!nextLevelConfig && nextLevel <= allowedMaxLevel) {
        nextLevelConfig = {
          tokenCost: 0, // Will be set by our cost logic below
          cost: { spellTokens: 0 }
        };
        spellLevels[String(nextLevel)] = nextLevelConfig;
      }

      if (!nextLevelConfig) {
        throw new HttpsError(
          "failed-precondition",
          "Spell is at max level or game data is missing.",
        );
      }

      const requiredLevel = normalizeRequiredLevel(spellGameData.requiredLevel);
      const playerLevel = normalizePlayerLevel(profileData.level);
      const isDefaultSpell = spellGameData.isUnlocked === true || requiredLevel <= 0;

      if (currentLevel === 0 && playerLevel < requiredLevel) {
        throw new HttpsError(
          "failed-precondition",
          `requires-level-${requiredLevel}`,
        );
      }

      if (currentLevel === 0 && !isDefaultSpell) {
        const orderedSpellIds = getOrderedSpellIds(spellsCatalog);
        const spellIndex = orderedSpellIds.indexOf(spellId);
        if (spellIndex > 0) {
          const priorSpellId = orderedSpellIds[spellIndex - 1];
          const priorSpellMeta = spellsCatalog[priorSpellId];
          const priorIsDefault =
            (priorSpellMeta?.isUnlocked === true) ||
            normalizeRequiredLevel(priorSpellMeta?.requiredLevel) <= 0;
          const priorLevel = Number((playerSpellsData.levels ?? {})[priorSpellId] ?? 0);
          if (!priorIsDefault && priorLevel < 1) {
            throw new HttpsError(
              "failed-precondition",
              "Previous spell must be unlocked first.",
            );
          }
        }
      }

      const levelConfigRecord = nextLevelConfig as Record<string, unknown>;
      let rawTokenCost = Number(
        levelConfigRecord.tokenCost ??
        (typeof levelConfigRecord.cost === "object"
          ? (levelConfigRecord.cost as Record<string, unknown>).spellTokens
          : undefined) ??
        0,
      );

      // If no cost is specified in spell-specific config, use global config
      if (!Number.isFinite(rawTokenCost) || rawTokenCost <= 0) {
        const upgradeCosts = await getSpellUpgradeCosts();
        rawTokenCost = Number(upgradeCosts[String(nextLevel)] ?? 1);
      }

      const cost = Number.isFinite(rawTokenCost) && rawTokenCost > 0 ? rawTokenCost : 0;
      const currentTokens = Number(economyData.spellTokens ?? 0);
      if (currentTokens < cost) {
        throw new HttpsError("resource-exhausted", `Insufficient spell tokens. Required: ${cost}, Available: ${currentTokens}`);
      }

      if (cost > 0) {
        transaction.update(economyRef, {
          spellTokens: admin.firestore.FieldValue.increment(-cost),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      const timestamp = admin.firestore.FieldValue.serverTimestamp();
      const nextLevels = {
        ...(playerSpellsData.levels ?? {}),
        [spellId]: nextLevel,
      };
      const nextUnlockedAt = { ...(playerSpellsData.unlockedAt ?? {}) };
      if (!nextUnlockedAt[spellId]) {
        nextUnlockedAt[spellId] = timestamp;
      }

      transaction.set(
        playerSpellsRef,
        {
          levels: nextLevels,
          unlockedAt: nextUnlockedAt,
          updatedAt: timestamp,
        },
        { merge: true },
      );

      return {
        success: true,
        newLevel: nextLevel,
        maxLevel: allowedMaxLevel,
        spentTokens: cost,
        remainingTokens: currentTokens - cost,
      };
    },
    {
      kind: "spell-upgrade",
      inputsHash,
    },
  );
});
