# Function Contracts

This document provides detailed contracts for each Cloud Function, including input parameters, output formats, and potential errors.

**Note:** All Cloud Functions are deployed in `us-central1`.

## Auth + Device Anchors

### `ensureGuestSession`

**Purpose:** Recovers a guest session using a device anchor or registers a new anonymous user, recording an idempotency receipt.

**Input:**

```json
{
  "opId": "string",
  "deviceAnchor": "string",
  "platform": "ios|android|windows|mac|linux",
  "appVersion": "string"
}
```

**Output:**

*   **Success (current user):** `{ "status": "ok", "mode": "current", "uid": "string", "customToken": "string" }`
*   **Success (new user):** `{ "status": "ok", "mode": "new", "uid": "string", "customToken": "string" }`
*   **Success (recovery):** `{ "status": "recover", "uid": "string", "customToken": "string" }`

**Side-effects:**

*   Reserves `/Players/{uid}/Receipts/{opId}` with `{ status: "reserved" }` (retries become no-ops).
*   Creates or updates `/AccountsDeviceAnchors/{deviceAnchor}` with `{ uid, platform?, appVersion?, lastSeenAt }` for guest accounts only.
*   Runs `initializeUserIfNeeded` + `waitForUserBootstrap` to guarantee `/Players/{uid}` has the v3 bootstrap docs (Profile, Economy, Loadouts, SpellDecks, Inventory/{skuId}, `_summary`, etc.) before returning.
*   If the device anchor is currently mapped to a full account (non-guest), the anchor is vacated and reassigned to a guest (new or current auth user). The full account retains a reference to the device in `Players/{uid}.knownDeviceAnchors`.

**Errors:** `INVALID_ARGUMENT`, `UNAUTHENTICATED`

---

### `bindEmailPassword`

**Purpose:** Binds an email and password to the current guest account.

**Input:**

```json
{
  "opId": "string",
  "email": "string",
  "password": "string"
}
```

**Output:**

*   **Success:** `{ "status": "ok" }`

**Errors:** `EMAIL_TAKEN`, `WEAK_PASSWORD`, `ALREADY_LINKED`

**Side-effects:**
* Vacates any device anchors currently pointing to this uid and stores the anchor IDs as references on the player in `knownDeviceAnchors`.

---

### `bindGoogle`

**Purpose:** Binds a Google account to the current guest account.

**Input:**

```json
{
  "opId": "string",
  "idToken": "string"
}
```

**Output:**

*   **Success:** `{ "status": "ok" }`

**Errors:** `TOKEN_INVALID`, `ALREADY_LINKED`, `EMAIL_TAKEN`

**Side-effects:**
* Vacates any device anchors currently pointing to this uid and stores the anchor IDs as references on the player in `knownDeviceAnchors`.

---

### `signupEmailPassword`

**Purpose:** Creates a new user account with an email and password. If a `deviceAnchor` is provided, it is stored as a reference on the account but is not claimed for login.

**Input:**

```json
{
  "opId": "string",
  "email": "string",
  "password": "string",
  "deviceAnchor": "string (optional, stored as reference only)",
  "platform": "ios|android|windows|mac|linux (optional)",
  "appVersion": "string (optional)"
}
```

**Output:**

*   **Success:** `{ "status": "ok", "uid": "string", "customToken": "string" }`

**Errors:** `already-exists` (message: `email-already-exists`), `WEAK_PASSWORD`

**Note:** Email reservation is a transactional step.

---

### `signupGoogle`

**Purpose:** Creates a new user account using a Google ID token. If a `deviceAnchor` is provided, it is stored as a reference on the account but is not claimed for login.

**Input:**

```json
{
  "opId": "string",
  "idToken": "string",
  "deviceAnchor": "string (optional, stored as reference only)",
  "platform": "ios|android|windows|mac|linux (optional)",
  "appVersion": "string (optional)"
}
```

**Output:**

*   **Success:** `{ "status": "ok", "uid": "string", "customToken": "string" }`

**Errors:** `TOKEN_INVALID`, `already-exists` (message: `email-already-exists`)

**Note:** Email reservation is a transactional step.

---

### `checkEmailExists`

**Purpose:** Checks if an email is already registered.

**Input:**

```json
{
  "email": "string"
}
```

**Output:**

*   **Success:** `{ "exists": boolean }`

**Errors:** `invalid-argument`

---

### `initUser`

**Purpose:** A safety-net function to initialize a user if the `onAuthCreate` trigger is missed. Creates the player's core documents per the schema. This function is idempotent.

**Initialization includes:**
- Root `/Players/{uid}` document with `authProviders`, `email`, `isGuest`, timestamps.
- `/Profile/Profile` with default stats (displayName `"Guest"` or `"New Racer"`, avatar `1`, trophies/levels zeroed, booster timers empty).
- `/Economy/Stats` with `coins: 1000`, `gems: 0`, `spellTokens: 0`.
- `/Garage/Cars` containing `car_h4ayzwf31g` at upgrade level `0`.
- `/Loadouts/Active` pointing at `car_h4ayzwf31g`, deck `1`, all cosmetic slots `null`.
- `/SpellDecks/Decks` pre-populated with five decks (`1` contains the starter spells, `2-5` empty placeholders) and `active: 1`.
- `/Spells/Levels` unlocking the starter spells at level `1`.
- Inventory seeded by granting the starter crate/key SKUs (per-SKU documents created with quantity `1`) and recomputing `_summary`.
- Idempotent grant of the starter crate & key via `Receipts/initializeUser.starterRewards`.

**Starter Spells:** taken from `loadStarterSpellIds()` (currently: Ice Lock, Storm Aura, Phantom Veil, Void Blades, Crimson Crush).

**Input:**

```json
{
  "opId": "string"
}
```

**Output:**

*   **Success:** `{ "ok": true }`

## Player Profile & Settings

### `checkUsernameAvailable`

**Purpose:** Checks if a username is available.

**Input:**

```json
{
  "username": "string"
}
```

**Output:**

*   **Success:** `{ "available": boolean }`

**Errors:** `INVALID_ARGUMENT`

---

### `setUsername`

**Purpose:** Sets a unique, case-insensitive display name for the player. This function writes to `/Players/{uid}/Profile/Profile` and creates a reservation document in `/Usernames/{usernameLower}` to enforce uniqueness. It also enforces validation rules (length, characters, etc.).

**Input:**

```json
{
  "opId": "string",
  "username": "string"
}
```

**Output:**

*   **Success:** `{ "status": "ok" }`

**Errors:** `UNAUTHENTICATED`, `ALREADY_EXISTS`, `INVALID_ARGUMENT`

---

### `setAvatar`

**Purpose:** Sets the player's selected avatar. This function updates the `avatarId` field in `/Players/{uid}/Profile/Profile`.

**Input:**

```json
{
  "opId": "string",
  "avatarId": "number"
}
```

**Output:**

*   **Success:** `{ "status": "ok" }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`

---

### `setAgeYears`

**Purpose:** Sets the player's age, which calculates and stores `birthYear` and `isOver13` on `Players/{uid}`.

**Input:**

```json
{
  "opId": "string",
  "ageYears": "number"
}
```

**Output:**

*   **Success:** `{ "status": "ok", "birthYear": "number", "isOver13": "boolean" }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`

---

### `getPlayerAge`

**Purpose:** Retrieves the player's derived age and over-13 status.

**Input:**

```json
{
  "uid": "string"
}
```

**Output:**

*   **Success:** `{ "age": "number", "isOver13": "boolean" }`

**Errors:** `NOT_FOUND`, `FAILED_PRECONDITION`

---

### `setSubscriptionFlag`

**Purpose:** Sets the player's social media subscription preferences in `/Players/{uid}/Social/Subscriptions`.

**Input:**

```json
{
  "opId": "string",
  "key": "youtube|instagram|discord|tiktok",
  "value": "boolean"
}
```

**Output:**

*   **Success:** `{ "status": "ok" }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`

## Garage, Loadouts & Spells

### `upgradeCar`

**Purpose:** Upgrades a player-owned car to the next level.

**Input:**
```json
{
  "carId": "string"
}
```

**Output:**
*   **Success:** `{ "success": true, "newLevel": "number" }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `INTERNAL`, `FAILED_PRECONDITION`, `RESOURCE_EXHAUSTED`

---

### `purchaseCar`

**Purpose:** Allows a player to purchase a new car.

**Input:**
```json
{
  "carId": "string"
}
```

**Output:**
*   **Success:** `{ "success": true, "carId": "string" }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `ALREADY_EXISTS`, `NOT_FOUND`, `INTERNAL`, `RESOURCE_EXHAUSTED`

---

### `setLoadout`

**Purpose:** Sets the selected car for a given loadout. This function updates the `carId` field in `/Players/{uid}/Loadouts/Active`.

**Input:**
```json
{
  "opId": "string",
  "loadoutId": "string",
  "carId": "string"
}
```

**Output:**
*   **Success:** `{ "success": true }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`

---

### `equipCosmetic`

**Purpose:** Equips a single cosmetic variant on a loadout slot. The callable verifies ownership via the per-SKU inventory document (`/Players/{uid}/Inventory/{skuId}`), updates `/Players/{uid}/Loadouts/{loadoutId}` with both the SKU and backing `itemId`, and records an idempotency receipt.

**Input:**
```json
{
  "opId": "string",
  "loadoutId": "string",
  "slot": "wheels|decals|spoilers|underglow|boost",
  "skuId": "string"
}
```

**Output:**
```json
{ "success": true, "opId": "string" }
```

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`, `INTERNAL`

---

### `grantItem`

**Purpose:** Convenience/test helper that grants an arbitrary SKU directly to the player. Honors stackability rules, updates the per-SKU inventory document and `_summary`, and records the operation under `/Players/{uid}/Receipts/{opId}`. Because it bypasses catalog pricing it should only be exposed to trusted callers (QA tooling, scripts).

**Input:**
```json
{
  "opId": "string",
  "skuId": "string",
  "quantity": 1,
  "reason": "string"
}
```

**Output:**
```json
{ "success": true, "opId": "string" }
```

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`, `INTERNAL`

---

### `setSpellDeck`

**Purpose:** Updates the array of spell IDs for a specific spell deck. This function writes to the `spells` field in `/Players/{uid}/SpellDecks/Decks`.

**Input:**
```json
{
  "opId": "string",
  "deckNo": "number",
  "spells": ["string", "string", "string", "string", "string"]
}
```

**Output:**
*   **Success:** `{ "success": true }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`

---

### `selectActiveSpellDeck`

**Purpose:** Sets the active spell deck for a specific loadout. This function updates the `activeSpellDeck` field in the `/Players/{uid}/Loadouts/Active` document with a number (1-5) to indicate which spell deck is currently active.

**Input:**
```json
{
  "opId": "string",
  "loadoutId": "string",
  "deckNo": "number"
}
```

**Output:**
*   **Success:** `{ "success": true }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`

---

### `upgradeSpell`

**Purpose:** Unlocks (level 0 → 1) or upgrades (level 1-4 → next) a spell. Reads the cost from `/GameData/v1/catalogs/SpellsCatalog`, validates player level/prerequisite spells, deducts `spellTokens` from `/Players/{uid}/Economy/Stats`, and updates `/Players/{uid}/Spells/Levels` in a single transaction.

**Input:**
```json
{
  "opId": "string",
  "spellId": "string"
}
```

**Output:**
```json
{
  "success": true,
  "newLevel": 2,
  "spentTokens": 5
}
```

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION` (max level reached, player level too low, prerequisite spell locked, missing catalog levels), `RESOURCE_EXHAUSTED` (insufficient spell tokens)

**Receipts & Idempotency:**
* Writes `/Players/{uid}/Receipts/{opId}` with `{ kind: "spell-upgrade", inputsHash }` and the final result payload.
* Replays with the same `opId` return the cached result with no additional token spend.

## Race

### `prepareRace`

Creates a single server-authored payload to start a race with minimal reads.

Trigger: HTTPS Callable v2 (region `us-central1`)

Input:
```json
{ "opId": "string", "laps": 3, "botCount": 7, "seed": "optional", "trophyHint": 0, "trackId": "optional" }
```

Reads (cold): CarsCatalog, SpellsCatalog, ItemSkusCatalog, RanksCatalog, BotConfig; Player: Profile/Profile, Loadouts/Active, Spells/Levels, Garage/Cars, SpellDecks/Decks.

Output: `{ raceId, issuedAt, seed, laps, trackId, player: { uid, trophies, carId, carStats: { display, real }, cosmetics, spells, deckIndex }, bots: [...], proof: { hmac } }`. Cosmetic payloads include both `*SkuId` and `*ItemId` so the client can render legacy assets while operating on SKU inventory.

Notes:
- Resolves car stats via `CarsCatalog.cars[carId].levels[level]` using value-vs-real model. Players use `CarTuningConfig.player`; bots use `CarTuningConfig.bot`.
- Deterministic when `seed` is supplied; idempotent via `opId` receipt.

### `startRace`

**Purpose:** To initialize a race and apply a pre-deduction penalty.

**Input:**
```json
{
  "lobbyRatings": ["number"],
  "playerIndex": "number"
}
```

**Output:**
*   **Success:** `{ "success": true, "raceId": "string", "preDeductedTrophies": "number" }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`

---

### `generateBotLoadout`

**Purpose:** To generate a complete loadout for an AI opponent.

**Input:**
```json
{
  "trophyCount": "number"
}
```

**Output:**
*   **Success:** `{ "carId": "string", "cosmetics": {}, "spellDeck": [], "difficulty": {} }`

**Errors:** `INVALID_ARGUMENT`

---

### `recordRaceResult`

**Purpose:** Settles a race and applies rewards. Recalculates XP using the shared progression helpers, writes `exp`, `level`, `expProgress`, and `expToNextLevel` to `Profile/Profile`, and increments `spellTokens` on level-up. Also updates `Profile/Profile` (trophies, highestTrophies, careerCoins, totalWins, totalRaces) and `Economy/Stats` (coins).

**Input:**
```json
{
  "raceId": "string",
  "finishOrder": ["string"]
}
```

**Output:**
*   **Success:** `{ "success": true, "rewards": { "trophies": "number", "coins": "number", "xp": "number" }, "xpProgress": { "xpBefore": "number", "xpAfter": "number", "levelBefore": "number", "levelAfter": "number", "expInLevelBefore": "number", "expInLevelAfter": "number", "expToNextLevel": "number" } }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `NOT_FOUND`

## Clans

### `createClan`

**Purpose:** Creates a new clan.

**Input:**
```json
{
  "clanName": "string",
  "clanTag": "string"
}
```

**Output:**
*   **Success:** `{ "success": true, "clanId": "string" }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`

---

### `joinClan`

**Purpose:** Joins an "open" clan.

**Input:**
```json
{
  "clanId": "string"
}
```

**Output:**
*   **Success:** `{ "success": true, "clanId": "string" }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `NOT_FOUND`

---

### `leaveClan`

**Purpose:** Leaves the current clan, handling leader succession.

**Input:** `{}`

**Output:**
*   **Success:** `{ "success": true }`

**Errors:** `UNAUTHENTICATED`, `FAILED_PRECONDITION`

---

### `inviteToClan`

**Purpose:** Invites a player to a clan.

**Input:**
```json
{
  "inviteeId": "string"
}
```

**Output:**
*   **Success:** `{ "success": true }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `PERMISSION_DENIED`

---

### `requestToJoinClan`

**Purpose:** Requests to join a closed/invite-only clan.

**Input:**
```json
{
  "clanId": "string"
}
```

**Output:**
*   **Success:** `{ "success": true }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`

---

### `acceptJoinRequest`

**Purpose:** Manages join requests.

**Input:**
```json
{
  "clanId": "string",
  "requesteeId": "string"
}
```

**Output:**
*   **Success:** `{ "success": true }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `NOT_FOUND`

---

### `declineJoinRequest`

**Purpose:** Manages join requests.

**Input:**
```json
{
  "clanId": "string",
  "requesteeId": "string"
}
```

**Output:**
*   **Success:** `{ "success": true }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`

---

### `promoteClanMember`

**Purpose:** Manages member roles.

**Input:**
```json
{
  "clanId": "string",
  "memberId": "string"
}
```

**Output:**
*   **Success:** `{ "success": true }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`

---

### `demoteClanMember`

**Purpose:** Manages member roles.

**Input:**
```json
{
  "clanId": "string",
  "memberId": "string"
}
```

**Output:**
*   **Success:** `{ "success": true }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`, `FAILED_PRECONDITION`

---

### `kickClanMember`

**Purpose:** Removes a member from the clan.

**Input:**
```json
{
  "clanId": "string",
  "memberId": "string"
}
```

**Output:**
*   **Success:** `{ "success": true }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`

---

### `updateClanSettings`

**Purpose:** Updates a clan's public information.

**Input:**
```json
{
  "clanId": "string",
  "newSettings": {}
}
```

**Output:**
*   **Success:** `{ "success": true }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`

## Economy & Offers

### `grantXP`

**Purpose:** Grants XP to a player using the runtime XP progression formula (no Firestore lookups). The helper computes the active level, current progress, and XP required for the next level. On level-up the player earns spell tokens. The function writes the derived values to `/Players/{uid}/Profile/Profile` (`exp`, `level`, `expProgress`, `expToNextLevel`) and, when applicable, increments `spellTokens` in `/Players/{uid}/Economy/Stats`.

**Input:**
```json
{
  "amount": "number",
  "opId": "string",
  "reason": "string"
}
```

**Output:**
*   **Success:** `{ "success": true, "opId": "string", "xpBefore": "number", "xpAfter": "number", "levelBefore": "number", "levelAfter": "number", "leveledUp": "boolean", "expProgress": { "before": { "expInLevel": "number", "expToNextLevel": "number" }, "after": { "expInLevel": "number", "expToNextLevel": "number" } } }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `INTERNAL`

---

### `exchangeGemsForCoins`

**Purpose:** To convert gems to coins based on a trophy-scaled rate.

**Input:**
```json
{
  "gemAmount": "number"
}
```

**Output:**
*   **Success:** `{ "success": true, "coinsGained": "number", "gemsSpent": "number" }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `RESOURCE_EXHAUSTED`

---

### `purchaseShopSku`

**Purpose:** Unified shop purchase callable. Buys any SKU whose `purchasable` block is defined in `/GameData/v1/catalogs/ItemSkusCatalog` (crates, keys, boosters, cosmetics, etc.), multiplies the configured amount by the requested quantity, enforces stackability rules, deducts the specified currency, updates the per-SKU inventory documents, refreshes `_summary`, and writes an idempotency receipt under `/Players/{uid}/Receipts/{opId}`. Catalog reads are cached for 60 seconds to minimize round-trips.

**Input:**
```jsonc
{
  "opId": "string",
  "skuId": "string",
  "quantity": 1 // optional, defaults to 1
}
```

**Output (gems example):**
```json
{
  "success": true,
  "opId": "op-shop-123",
  "skuId": "sku_shop_booster_coin",
  "quantity": 2,
  "currency": "gems",
  "unitCost": 60,
  "totalCost": 120,
  "gemsBefore": 520,
  "gemsAfter": 400,
  "coinsBefore": 0,
  "coinsAfter": 0,
  "totalCostGems": 120
}
```
When the SKU is coin-priced the response mirrors this shape with `currency: "coins"` and a `totalCostCoins` field instead of `totalCostGems`.

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`, `RESOURCE_EXHAUSTED`, `INTERNAL`

---

### `activateBooster`

**Purpose:** Consumes a booster (referenced by `skuId`, legacy `itemId` is still accepted for backwards compatibility) from the player’s inventory and extends the corresponding timer in `/Players/{uid}/Profile/Profile.boosters`. Coin and XP boosters are tracked independently; re-activating while an effect is active stacks duration and increments `stackedCount`. The function decrements the per-SKU document, updates `_summary`, and records the receipt under `/Players/{uid}/Receipts/{opId}`.

**Input:**
```json
{
  "opId": "string",
  "boosterId": "string" // accepts a skuId (preferred) or legacy itemId for compat
}
```

**Output:**
```json
{
  "success": true,
  "opId": "op-booster-123",
  "boosterSkuId": "sku_booster_coin_daily",
  "boosterItemId": "item_booster_coin_daily",
  "subType": "coin",
  "activeUntil": 1740002400000,
  "stackedCount": 2,
  "remaining": 0
}
```

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`, `INTERNAL`

---

### `claimRankUpReward`

**Purpose:** To claim the one-time reward for achieving a new rank.

**Input:**
```json
{
  "rankId": "string"
}
```

**Output:**
*   **Success:** `{ "success": true, "rewards": {} }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `ALREADY_EXISTS`, `NOT_FOUND`, `INTERNAL`, `FAILED_PRECONDITION`

---

### `claimStarterOffer`

**Purpose:** Claims the one-time welcome offer, resolving the starter crate and key SKUs from `/GameData/v1/catalogs/ItemSkusCatalog.defaults` (falling back to the crate record if needed). Grants `+1` to both SKUs under `/Players/{uid}/Inventory/{skuId}` (per-SKU documents), updates the optional `_summary` rollup, and upserts `/Players/{uid}/Progress/Flags` with `starterOfferClaimed: true`. The function is idempotent and records its outcome under `/Players/{uid}/Receipts/{opId}`.

**Input:**

```json
{
  "opId": "string"
}
```

**Output:**

*   **Success:** `{ "status": "ok" }`

**Errors:** `UNAUTHENTICATED`, `ALREADY_EXISTS`, `INTERNAL`

---

### `purchaseOffer`

**Purpose:** Processes a catalog offer. The callable loads `/GameData/v1/catalogs/OffersCatalog`, resolves each entitlement to a concrete SKU (legacy `itemId` entitlements expand to the item’s primary variant), enforces stackability rules, deducts the configured currency, grants the SKUs, updates the per-SKU docs and `_summary`, and persists an idempotent receipt.

**Input:**
```json
{
  "opId": "string",
  "offerId": "string"
}
```

**Output:**
```json
{
  "success": true,
  "opId": "op-offer-123",
  "offerId": "offer_welcome_bundle",
  "currency": "gems",
  "amount": 500,
  "grants": [
    { "type": "sku", "skuId": "sku_crate_epic", "itemId": "item_crate_epic", "quantity": 1, "total": 1 },
    { "type": "sku", "skuId": "sku_key_epic", "itemId": "item_key_epic", "quantity": 1, "total": 1 },
    { "type": "gems", "quantity": 200 }
  ],
  "balances": { "gems": 750, "coins": 1000 }
}
```

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`, `RESOURCE_EXHAUSTED`, `INTERNAL`

---

### `openCrate`

**Purpose:** Consumes a crate the player owns, decrements the associated key, rolls a reward SKU from the crate’s weighted loot table, and grants the result. The crate metadata (crate SKU, key SKU) is resolved from `/GameData/v1/catalogs/CratesCatalog`. The function mutates the affected per-SKU documents, refreshes `_summary`, returns post-operation counts for the affected SKUs, and records an idempotency receipt.

**Input:**
```json
{
  "crateId": "string",
  "opId": "string"
}
```

**Output:**
```json
{
  "success": true,
  "opId": "op-crate-123",
  "crateId": "crt_common",
  "crateSkuId": "sku_crate_common",
  "awarded": {
    "skuId": "sku_cosmetic_wheel_blue",
    "itemId": "item_cosmetic_wheel",
    "type": "cosmetic",
    "rarity": "rare",
    "quantity": 1,
    "alreadyOwned": false
  },
  "counts": {
    "sku_crate_common": 0,
    "sku_key_common": 0,
    "sku_cosmetic_wheel_blue": 1
  }
}
```

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`, `INTERNAL`

---

### `purchaseCrateItem`

**Purpose:** Convenience wrapper around `purchaseShopSku` that resolves the crate/key SKUs from `/GameData/v1/catalogs/CratesCatalog` and forwards the purchase. Returns a crate/key specific payload (`opId`, `crateId`, `kind`, `skuId`, gem deltas) expected by the legacy garage UI. New flows may call `purchaseShopSku` directly when they already know the target `skuId`.

**Input:**
```json
{
  "crateId": "string",
  "kind": "crate | key",
  "quantity": 1,
  "opId": "string"
}
```

**Output:**
* **Success:** 
  ```json
  {
    "success": true,
    "opId": "string",
    "crateId": "string",
    "kind": "crate",
    "skuId": "sku_crate_common",
    "quantity": 2,
    "totalCostGems": 100,
    "gemsBefore": 400,
    "gemsAfter": 300
  }
  ```

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`, `RESOURCE_EXHAUSTED`, `INTERNAL`


## Social & Leaderboards
---

### `getGlobalLeaderboard`

**Purpose:** Returns the cached leaderboard snapshot (trophies, careerCoins, or totalWins) in a single read, including the caller's personal rank/value even if they are outside the top 100.

**Input:**
```json
{
  "metric": "trophies",           // Optional; defaults to "trophies"
  "type": 1,                      // Legacy alias: 1=trophies, 2=careerCoins, 3=totalWins
  "pageSize": 50,                 // Optional; 1-100 (default 50)
  "pageToken": "base64cursor"     // Optional pagination cursor issued by a previous call
}
```

**Output:**
```json
{
  "ok": true,
  "data": {
    "metric": "trophies",
    "updatedAt": 1731532800000,
    "entries": [
      { "rank": 1, "value": 4200, "player": { "uid": "uid_alice", "displayName": "ALICE", "avatarId": 2, "level": 15, "trophies": 4200, "clan": { "clanId": "clan_123", "name": "Night Riders", "tag": "NR" } } }
    ],
    "pageToken": "base64cursor-or-null",
    "you": {
      "rank": 86,
      "value": 1234,
      "player": { "uid": "caller", "displayName": "CALLER", "avatarId": 4, "level": 12, "trophies": 1234 }
    },
    "watermark": "sha256 digest for caching"
  },
  // Backward-compatible fields for legacy clients:
  "success": true,
  "leaderboardType": 1,
  "totalPlayers": 50,
  "players": [{ "uid": "uid_alice", "displayName": "ALICE", "avatarId": 2, "level": 15, "rank": 1, "stat": 4200 }],
  "callerRank": 86
}
```

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION` (leaderboard still warming up)

**Notes:** This callable currently reads every `/Players/{uid}/Profile/Profile` document on demand, sorts all players by the requested metric, and slices the result in memory before returning it. That means each request scales with your player count—great for development/debugging, but expensive at scale. When you’re ready for production you should reintroduce a scheduled snapshot (or another caching strategy) to avoid scanning millions of documents per call.

---

### `searchPlayers` *(aka `searchPlayer` for backward compatibility)*

**Purpose:** Performs case-insensitive player search using the `/Usernames/{displayNameLower}` registry. Short queries (≤2 characters) run a prefix range query; longer queries require an exact match.

**Input:**
```json
{ "query": "de" }
```

**Output (prefix search, ≤2 chars):**
```json
{
  "success": true,
  "results": [
    { "uid": "uid_dean", "displayName": "DEAN", "avatarId": 4, "level": 10, "trophies": 2500 }
  ]
}
```

**Output (exact match, ≥3 chars):**
```json
{
  "success": true,
  "player": { "uid": "uid_dew", "displayName": "DEW", "avatarId": 3, "level": 1, "trophies": 566 }
}
```

**No match:** `{ "success": false, "message": "user not found" }`

**Errors:** `INVALID_ARGUMENT`

**Notes:** Prefix results are capped at 10 by the range query (`docId >= prefix` and `< prefix + "~"`). Clients do not supply pagination parameters in this dev-mode implementation; results are already small. Consider reintroducing a dedicated search index when you need scalable, paginated search.

---

### `sendFriendRequest`

**Purpose:** Sends a friend request from the caller to `targetUid`, ensuring idempotency via `opId`. Duplicate requests, self-targeting, or blocked relationships are rejected.

**Input:**
```json
{
  "opId": "friend-request-123",
  "targetUid": "otherUid",
  "message": "Optional note (<=140 chars)"
}
```

**Output:**
```json
{
  "ok": true,
  "data": { "requestId": "01HF...", "status": "pending" }
}
```

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND` (target missing), `FAILED_PRECONDITION` (already friends, blocked, duplicate), `RESOURCE_EXHAUSTED` (friend/request cap)

**Side-effects:**
* Appends to `/Players/{caller}/Social/Requests.outgoing` and `/Players/{target}/Social/Requests.incoming` inside a single transaction.
* Sets `/Players/{target}/Social/Profile.hasFriendRequests = true`.
* Writes receipt `/Players/{caller}/Receipts/{opId}` with `kind: "friend-request"` so retries return the cached payload.

---

### `acceptFriendRequest`

**Purpose:** Accepts a pending request and establishes a mutual friendship.

**Input:**
```json
{
  "opId": "friend-accept-123",
  "requestId": "01HF..."
}
```

**Output:**
```json
{
  "ok": true,
  "data": {
    "friend": { "uid": "otherUid", "displayName": "OTHER", "avatarId": 5, "level": 20, "trophies": 3100 },
    "since": 1731529200000
  }
}
```

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND` (request missing), `FAILED_PRECONDITION` (blocked or already friends), `RESOURCE_EXHAUSTED`

**Side-effects:** Removes the request from both players, writes friendship entries under `/Social/Friends`, increments `friendsCount` for both profiles, and clears the `hasFriendRequests` badge when no other requests remain. Receipt: `/Receipts/{opId}` with `kind: "friend-accept"`.

---

### `rejectFriendRequest`

**Purpose:** Declines a pending incoming request without creating a friendship. Useful for spam controls and "ignore" behaviour.

**Input:** `{ "opId": "friend-reject-123", "requestId": "01HF...", "reason": "optional string" }`

**Output:** `{ "ok": true }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`

**Notes:** Removes the request from both `/Social/Requests` documents and flips `hasFriendRequests` when appropriate. Receipt `kind: "friend-reject"`.

---

### `cancelFriendRequest`

**Purpose:** Lets the original sender withdraw a pending outgoing request.

**Input:** `{ "opId": "friend-cancel-123", "requestId": "01HF..." }`

**Output:** `{ "ok": true }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`

**Notes:** Mirrors the reject flow but initiated by the sender. Receipt `kind: "friend-cancel"`.

---

### `getFriendRequests`

**Purpose:** Returns the caller's *incoming* pending requests with fresh player summaries so the UI can immediately render names/avatars/trophies without extra reads. Outgoing requests remain stored in `/Social/Requests` but are not returned by this API.

**Input:** `{}`

**Output:**
```json
{
  "ok": true,
  "data": {
    "incoming": [
      {
        "requestId": "01HF...",
        "fromUid": "otherUid",
        "sentAt": 1731529200000,
        "message": "GG",
        "player": {
          "uid": "otherUid",
          "displayName": "OTHER",
          "avatarId": 5,
          "level": 20,
          "trophies": 3100,
          "clan": { "clanId": "clan_123", "name": "Night Riders", "tag": "NR" }
        }
      }
    ]
  }
}
```

**Errors:** `UNAUTHENTICATED`

**Notes:** Each call rehydrates summaries from `/Players/{uid}/Profile/Profile`, so the response reflects any name/avatar/trophy changes made after the request was created.

---

### `getFriends`

**Purpose:** Returns all confirmed friends with timestamps and live `player` summaries (displayName, avatarId, level, trophies, clan).

**Input:** `{}`

**Output:**
```json
{
  "ok": true,
  "data": {
    "friends": [
      {
        "since": 1731532800000,
        "lastInteractedAt": 1733600000000,
        "player": {
          "uid": "friendUid",
          "displayName": "FRIEND",
          "avatarId": 4,
          "level": 18,
          "trophies": 4200,
          "clan": { "clanId": "clan_123", "name": "Night Riders", "tag": "NR" }
        }
      }
    ]
  }
}
```

**Errors:** `UNAUTHENTICATED`

**Notes:** Live summaries ensure the Friends tab always shows the latest profile data. The cached snapshot stored in `/Social/Friends` is only used as a fallback if the profile document is missing.

---

### `viewPlayerProfile`

**Purpose:** Returns the full profile document plus loadout + active spell deck for `uid`. Supports viewing other players or the caller themselves.

**Input:** `{ "uid": "targetUid" }` (optional; defaults to the caller)

**Output:**
```json
{
  "ok": true,
  "data": {
    "profile": { "...": "full Profile/Profile document" },
    "loadout": { "carId": "car_h4ayzwf31g", "activeSpellDeck": 2, "cosmetics": { ... } },
    "activeSpellDeck": { "deckId": "2", "deck": { "name": "My Deck", "spells": ["spell_1", ...] } }
  }
}
```

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`

**Notes:** Reads `/Players/{uid}/Profile/Profile`, `/Players/{uid}/Loadouts/Active`, and `/Players/{uid}/SpellDecks/Decks`. No mutating side-effects.

---

## Referrals

### `referralGetMyReferralCode`

**Purpose:** Returns the caller’s immutable referral code, lazily creating one if it does not already exist.

**Input:** none

**Output:** `{ "referralCode": "AB12CD34" }`

**Errors:** `UNAUTHENTICATED`

**Notes:** Generates and reserves a code inside a Firestore transaction (`/ReferralCodes/{code}` + profile patch) if the profile is missing one. Also normalises `referralStats` to the canonical shape.

---

### `referralClaimReferralCode`

**Purpose:** Allows an invitee to redeem an inviter’s code, awarding both sides and recording the event idempotently.

**Input:**

```json
{
  "opId": "string",
  "referralCode": "string"
}
```

**Output:**

```json
{
  "status": "ok",
  "referredBy": "AB12CD34",
  "inviteeRewards": [{ "skuId": "sku_rjwe5tdtc4", "qty": 1 }],
  "inviter": {
    "uid": "otherUid",
    "newSentTotal": 3,
    "thresholdsReached": [1]
  }
}
```

**Errors:**
* `UNAUTHENTICATED`
* `INVALID_ARGUMENT`
* `NOT_FOUND`
* `FAILED_PRECONDITION` (already referred, self-referral, circular referral, exhausted invitee claim)

**Side-effects:**
* Sets `/Players/{uid}/Profile/Profile.referredBy` once, updates both players’ `referralStats`.
* Grants invitee reward SKUs and updates inventory summary.
* Increments inviter progress in `/Players/{inviterUid}/Referrals/Progress`, awarding threshold rewards when crossed.
* Appends audit events for both players under `/Players/{uid}/Referrals/Events`.
* Writes receipts: invitee (`kind: "referral-claim"`, `inputsHash`) and inviter (`kind: "referral-reward"`, document ID `referralReward.{opId}`).
* Emits a best-effort Pub/Sub `referral-claimed` message when `REFERRAL_METRICS_TOPIC` is configured.

**Idempotency:** Replays with the same `opId` return the cached success payload. Different `opId`s after a successful claim are rejected with `FAILED_PRECONDITION`.

---

### `referralDebugLookup`

**Purpose:** Admin-only helper to inspect the global referral registry.

**Input:** `{ "referralCode": "AB12CD34" }`

**Output:** `{ "referralCode": "AB12CD34", "uid": "someUid", "createdAt": 1739942400000, "checksum": "deadbeef" }`

**Errors:** `UNAUTHENTICATED`, `PERMISSION_DENIED`, `INVALID_ARGUMENT`, `NOT_FOUND`

**Notes:** Requires either a custom auth claim (e.g., `admin=true`) or the `X-Admin` header when called through privileged infrastructure. Intended for BI/debug tooling; not exposed to the retail client.

---

## Game Systems & Health

### `getMaintenanceStatus`

**Purpose:** Retrieves the current maintenance status of the game.

**Input:** `{}`

**Output:**

*   **Success:** `{ "maintenance": "boolean" }`

**Errors:** None

---

### `claimMaintenanceReward`

**Purpose:** Allows a player to claim a reward after a maintenance period.

**Input:**

```json
{
  "opId": "string"
}
```

**Output:**

*   **Success:** `{ "success": true, "opId": "string" }`

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`, `INTERNAL`

---

### `healthcheck`

**Purpose:** A simple health check endpoint to verify that the functions are running.

**Trigger:** HTTPS Request

**Input:** None

**Output:**

*   **Success:** `{ "ok": true, "ts": "number" }`

**Errors:** None

---

## Triggers

### `onAuthCreate` (disabled)

- Status: Not exported/deployed. User initialization is handled by the HTTPS callables (`ensureGuestSession`, `signupEmailPassword`, `signupGoogle`) which call `initializeUserIfNeeded`, and by the safety‑net callable `initUser`.
 - If accounts are created outside these callables, call `initUser` once after sign-in to initialize player documents.
