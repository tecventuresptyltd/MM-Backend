# Release Notes

## 2025-12-16: Car Upgrade Pricing Rebalance

### Economy Changes

*   **Car upgrade pricing curve:** Replaced flat early-game pricing (15 levels at 100 coins) with progressive pricing formula that provides smoother economic progression.
*   **New pricing rules:**
    *   Prices < 200: Rounded to nearest 5 (e.g., 80, 85, 90, 95)
    *   Prices 200-999: Rounded to nearest 10 (e.g., 260, 280, 300)
    *   Prices ≥ 1000: Rounded to nearest 100 (existing logic)
    *   Monotonicity enforced: Each level's price is always ≥ previous level
*   **Impact:** Early-game car upgrades now feel more rewarding with incremental price increases. Example (Mitsabi Eon):
    *   **Before:** Levels 1-15 were all 100 coins
    *   **After:** Levels 1-5 are 80, 85, 90, 95, 105 coins (progressive increase)
*   **Pricing formula:** Upgrade budgets calculated based on next car's base price using weighted distribution across 20 levels with linear slope (weight_k = 1 + 0.07 * k)

### Data Changes

*   **CarsCatalog.json:** Updated all `priceCoins` values for levels 1-20 across all 15 cars
*   **gameDataCatalogs.v3.normalized.json:** Synchronized with updated CarsCatalog data
*   **Fields preserved:** All `carRating`, `topSpeed`, `acceleration`, `handling`, `boostRegen`, `boostPower` values remain unchanged
*   **Verification:** All 300 price entries (15 cars × 20 levels) validated for correct rounding and monotonicity across both files

### Deployment Notes

*   Run `npm run tools:seed-firestore` to publish the updated pricing to Firestore
*   The seeding process reads from `gameDataCatalogs.v3.normalized.json` which now contains the updated prices
*   No client changes required - pricing is server-authoritative
*   Existing player-owned cars retain their current upgrade levels; only future upgrades use new pricing

## 2025-12-15: Crate Rewards Cosmetic-Only Enforcement

### Bug Fixes

*   **openCrate guard:** Server now filters crate pools to cosmetic, non-default SKUs before rolling. If a crate lacks cosmetic entries, the call fails with `failed-precondition` instead of granting an invalid item.
*   **Catalog cleanup:** Crate pools were scrubbed to remove crate/key/default SKUs in both `CratesCatalog.json` and `gameDataCatalogs.v3.normalized.json` so only cosmetics remain.

### Deployment Notes

*   Redeploy the `openCrate` function and publish the updated game data bundle (`gameDataCatalogs.v3.normalized.json`). Refresh any cached catalogs (Remote Config/CDN/app bundle) after publishing.

## 2025-12-14: Session-Based Room Assignment

This release changes global chat room assignment from persistent (cross-session) to session-based, ensuring optimal load balancing on every app launch.

### Breaking Changes

*   **Removed Cross-Session Stickiness:** Backend no longer persists `assignedChatRoomId` to `/Players/{uid}/Profile/Profile`.
    *   **Previous Behavior:** Users were "sticky" to their last assigned room across app restarts.
    *   **New Behavior:** Each app launch triggers fresh room assignment using water-filling algorithm.
    *   **Rationale:** Ensures optimal load balancing and prevents users from clustering in old rooms.

*   **Added Session-Based Stickiness:** New optional `currentRoomId` parameter for in-session stability.
    *   **Client Impact:** Client must manage `roomId` in session/memory storage (NOT persistent storage).
    *   **First call (app launch):** `assignGlobalChatRoom({})` → Gets optimal room
    *   **Subsequent calls (same session):** `assignGlobalChatRoom({ currentRoomId: roomId })` → Reuses same room
    *   **App restart:** `assignGlobalChatRoom({})` → Gets fresh optimal assignment

*   **🛑 CRITICAL - Presence Payload Required:** Client MUST write `roomId` to `/presence/online/{uid}`.
    *   **Why:** This is now the ONLY way backend knows which room to decrement on disconnect.
    *   **Example:**
        ```javascript
        const presencePayload = {
          roomId: assignedRoomId,  // REQUIRED - from assignGlobalChatRoom response
          clanId: userClanId,
          lastSeen: serverTimestamp()
        };
        onDisconnect(presenceRef).remove();
        set(presenceRef, presencePayload);
        ```
    *   **Impact if missing:** Room `connectedCount` will drift, causing incorrect load balancing.

### Technical Changes

*   **Function:** `assignGlobalChatRoom`
    *   Removed `assignedChatRoomId` read from Firestore Profile
    *   Removed `assignedChatRoomId` writes to Firestore Profile
    *   Added `currentRoomId` optional parameter for in-session stickiness
    *   Added region validation in `attachToExisting` to reject old-region rooms

*   **Function:** `sendGlobalChatMessage`
    *   Removed `assignedChatRoomId` validation check

*   **Trigger:** `onPresenceOffline`
    *   Changed to read `roomId` from RTDB presence data (instead of Firestore Profile)
    *   No longer requires Firestore read on disconnect

### Expected Behavior After Deployment

*   **Users launching app:** Always get optimal room assignment (water-filling algorithm)
*   **Users staying in app:** Remain in same room throughout session
*   **2-3 concurrent users:** All consolidated into single `global_general` room
*   **User disconnects:** Room count decrements correctly via presence trigger
*   **App restarts:** May join different room than previous session (desired behavior)

### Migration Notes

*   **No data migration required:** Old `assignedChatRoomId` values in profiles are simply ignored
*   **Client update required:** See breaking changes above
*   **Testing:** Verify presence payload includes `roomId` before deploying to production

---

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
