# Release Notes

## 2025-12-13: Global Chat Bug Fixes & Region Merge

This release fixes a critical bug in the global chat room assignment logic and implements a region merge strategy for launch.

### Bug Fixes

*   **Fixed "Ghost Room" Bug:** The `assignGlobalChatRoom` function was creating new rooms even when existing rooms had available capacity. This was caused by archived rooms consuming all query result slots and being filtered out after the query limit was applied.
    *   **Solution:** Added `.where("isArchived", "==", false)` filter to the Firestore query to exclude archived rooms before the limit is applied.
    *   **Impact:** Users will now properly fill rooms to 80 users before new rooms are created.

### Breaking Changes

*   **Region Merge:** All users are now assigned to the `"global_general"` region regardless of their location or the `region` parameter passed to `assignGlobalChatRoom`.
    *   **Rationale:** Maximize concurrency and ensure high user density in chat rooms during launch.
    *   **Client Impact:** The `region` parameter in `assignGlobalChatRoom` is now ignored. All responses will return `region: "global_general"`.
    *   **Future:** May be regionalized post-launch based on user distribution and performance metrics.

### Performance Improvements

*   **Query Optimization:** Changed `assignGlobalChatRoom` query ordering from `DESC` to `ASC` on `connectedCount` field.
    *   **Benefit:** Warmup rooms (<20 users) now appear first in query results, improving selection efficiency.

### Index Updates

*   **Required:** Updated Firestore composite index for `Rooms` collection to support the new query pattern:
    ```json
    {
      "collectionId": "Rooms",
      "fields": [
        { "fieldPath": "type", "order": "ASCENDING" },
        { "fieldPath": "region", "order": "ASCENDING" },
        { "fieldPath": "isArchived", "order": "ASCENDING" },
        { "fieldPath": "connectedCount", "order": "ASCENDING" }
      ]
    }
    ```

### Expected Behavior After Deployment

*   **User 1-80:** All join `global_general_xxxxx` (count increases from 1 to 80)
*   **User 81:** Creates `global_general_yyyyy` (count: 1) because first room hit softCap
*   **Archived rooms:** Completely ignored by assignment logic, won't interfere with room selection

---

## 2025-10-21: Player Data Refactor

This release introduces significant breaking changes to the player data model in Firestore. Client-side code that reads player data must be updated to reflect the new structure.

### Breaking Schema Changes

*   **Player Data Split:** Many fields previously located in the root `/Players/{uid}` document have been moved into a new `/Players/{uid}/Profile/Profile` subcollection document. This was done to separate public-facing "menu" stats from the player's private economic state.
    *   The client should now listen to `/Players/{uid}/Profile/Profile` for real-time updates to display in the UI (e.g., coins, gems, level, trophies).
    *   The `/Players/{uid}` document is now a minimal identity shell.

*   **New `Profile` Document:** The `/Players/{uid}/Profile/Profile` document now contains the following fields:
    *   `displayName`
    *   `avatarId`
    *   `coins`
    *   `gems`
    *   `exp`
    *   `level`
    *   `trophies`
    *   `highestTrophies`
    *   `careerCoins`
    *   `totalWin`

*   **New `SpellDecks` Collection:** Player spell decks are now stored in a new `/Players/{uid}/SpellDecks/{deckNo}` collection, where `deckNo` is a number from 1 to 5.

*   **Updated `Loadouts` Document:** The `/Players/{uid}/Loadouts/{loadoutId}` document has been updated to include:
    *   `activeSpellDeck`: A number (1-5) that points to the currently active spell deck.
    *   `cosmetics`: A map for account-level equipped cosmetics.

### New Cloud Functions

*   `equipCosmetics({ opId, loadoutId, cosmetics })`: Equips cosmetics to a loadout.
*   `setSpellDeck({ opId, deckNo, spells })`: Updates the spells in a specific deck.
*   `selectActiveSpellDeck({ opId, loadoutId, deckNo })`: Selects the active spell deck for a loadout.

### Updated Cloud Functions

*   `setUsername` now writes to `/Players/{uid}/Profile/Profile`.
*   `setAvatar` now writes to `/Players/{uid}/Profile/Profile`.
*   `upgradeSpell` now correctly deducts `spellTokens` from `/Players/{uid}/Economy/Stats`.
*   `grantXP` now updates `level` and `exp` in both `/Players/{uid}/Economy/Stats` and `/Players/{uid}/Profile/Profile`.
*   `recordRaceResult` now updates stats in both `Economy` and `Profile` documents.