/**
 * V2 Spells Module Index
 *
 * Exports all V2 spell-related Cloud Functions.
 */

// Spell Research (Library)
export {
    startSpellResearchV2,
    claimSpellResearchV2,
    skipSpellResearchV2,
    getLibraryStatusV2,
} from "./researchV2.js";

// Spell Decks (3-spell system)
export {
    setSpellDeckV2,
    selectActiveSpellDeckV2,
} from "./deckV2.js";
