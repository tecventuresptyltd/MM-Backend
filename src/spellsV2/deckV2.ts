/**
 * V2 Spell Deck Functions
 *
 * Handles the new spell deck system with 3 spells instead of 5.
 * This is separate from the legacy 5-spell deck system.
 *
 * @module spellsV2
 */

import * as admin from "firebase-admin";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { callableOptions, getMinInstances } from "../shared/callableOptions.js";
import { ensureOp } from "../shared/idempotency.js";

const db = admin.firestore();

// =============================================================================
// setSpellDeckV2
// =============================================================================

/**
 * Set a spell deck with 3 spells (V2 system).
 *
 * This function allows players to configure a deck with exactly 3 spells,
 * which is the new system compared to the legacy 5-spell decks.
 *
 * @param opId - Operation ID for idempotency
 * @param deckNo - Deck number (0-based index)
 * @param spells - Array of exactly 3 spell IDs
 *
 * @returns Success status
 *
 * @throws {HttpsError} unauthenticated - If user is not authenticated
 * @throws {HttpsError} invalid-argument - If arguments are invalid or spells array is not exactly 3 items
 */
export const setSpellDeckV2 = onCall(
  callableOptions({ minInstances: getMinInstances(false), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "User must be authenticated.");
    }

    const { opId, deckNo, spells } = request.data;

    // Validate inputs
    if (typeof opId !== "string" || typeof deckNo !== "number" || !Array.isArray(spells)) {
      throw new HttpsError("invalid-argument", "Invalid arguments provided.");
    }

    // V2 system requires exactly 3 spells
    if (spells.length !== 3) {
      throw new HttpsError("invalid-argument", "Spell deck must contain exactly 3 spells.");
    }

    // Validate all spells are strings
    if (!spells.every((spell) => typeof spell === "string")) {
      throw new HttpsError("invalid-argument", "All spells must be valid spell IDs (strings).");
    }

    // Ensure operation idempotency
    await ensureOp(uid, opId);

    // Use same path as legacy function
    const deckRef = db.doc(`/Players/${uid}/SpellDecks/Decks`);
    await deckRef.update({
      [`decks.${deckNo}.spells`]: spells,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true };
  }
);

// =============================================================================
// selectActiveSpellDeckV2
// =============================================================================

/**
 * Select the active spell deck (V2 system).
 *
 * This sets which deck number is currently active for the player in the V2 system.
 *
 * @param opId - Operation ID for idempotency
 * @param deckNo - Deck number to activate
 *
 * @returns Success status
 *
 * @throws {HttpsError} unauthenticated - If user is not authenticated
 * @throws {HttpsError} invalid-argument - If arguments are invalid
 */
export const selectActiveSpellDeckV2 = onCall(
  callableOptions({ minInstances: getMinInstances(false), memory: "512MiB", cpu: 1, concurrency: 80 }, true),
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError("unauthenticated", "User must be authenticated.");
    }

    const { opId, deckNo } = request.data;

    // Validate inputs
    if (typeof opId !== "string" || typeof deckNo !== "number") {
      throw new HttpsError("invalid-argument", "Invalid arguments provided.");
    }

    // Ensure operation idempotency
    await ensureOp(uid, opId);

    // Use same path as legacy function
    const loadoutRef = db.doc(`/Players/${uid}/Loadouts/Active`);
    await loadoutRef.update({
      activeSpellDeck: deckNo,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true };
  }
);
