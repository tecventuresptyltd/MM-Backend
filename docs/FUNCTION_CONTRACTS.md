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

**Purpose:** Consumes a crate the player owns, decrements the associated key, rolls a reward SKU using the crate’s `rarityWeights` + `poolsByRarity`, and grants the result. The crate metadata (crate SKU, key SKU) is resolved from `/GameData/v1/catalogs/CratesCatalog`. The function mutates the affected per-SKU documents, refreshes `_summary`, returns post-operation counts for the affected SKUs, and records an idempotency receipt.

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
    "alreadyOwned": false,
    "metadata": {
      "weight": 15,
      "totalWeight": 100,
      "roll": 47.21,
      "rarity": "rare",
      "poolSize": 72,
      "variantRoll": 1337420,
      "sourceItemId": "item_cosmetic_wheel"
    }
  },
  "counts": {
    "sku_crate_common": 0,
    "sku_key_common": 0,
    "sku_cosmetic_wheel_blue": 1
  }
}
```

- `awarded.metadata` exposes the deterministic RNG inputs used during the roll (rarity weight/total, rarities selected, pool size) which are useful for debugging or telemetry.
- If a crate lacks `rarityWeights` or `poolsByRarity` the call fails with `FAILED_PRECONDITION`.

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`, `INTERNAL`

---### `openCrate`

**Purpose:** Consumes a crate the player owns, decrements the associated key, rolls a reward SKU using the crate’s `rarityWeights` + `poolsByRarity`, and grants the result. The crate metadata (crate SKU, key SKU) is resolved from `/GameData/v1/catalogs/CratesCatalog`. The function mutates the affected per-SKU documents, refreshes `_summary`, returns post-operation counts for the affected SKUs, and records an idempotency receipt.

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
    "alreadyOwned": false,
    "metadata": {
      "weight": 15,
      "totalWeight": 100,
      "roll": 47.21,
      "rarity": "rare",
      "poolSize": 72,
      "variantRoll": 1337420,
      "sourceItemId": "item_cosmetic_wheel"
    }
  },
  "counts": {
    "sku_crate_common": 0,
    "sku_key_common": 0,
    "sku_cosmetic_wheel_blue": 1
  }
}
```

- `awarded.metadata` exposes the deterministic RNG inputs used during the roll (rarity weight/total, rarities selected, pool size) which are useful for debugging or telemetry.
- If a crate lacks `rarityWeights` or `poolsByRarity` the call fails with `FAILED_PRECONDITION`.

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
  "limit": 50,                 // Optional; 1-100 (default 50)
  "pageToken": "base64cursor"     // Optional pagination cursor issued by a previous call
}
```

**Output:**
```json
{
  "myRank": 3,
  "leaderboardType": 1,
  "players": [
    {
      "avatarId": 10,
      "displayName": "mystic",
      "level": 25,
      "rank": 1,
      "stat": 5,
      "uid": "gAWy13PNRtRMrWEL06nSnqvYPS3w1",
      "clan": {
        "clanId": "clan_abc123",
        "clanName": "Mystic Racers"
      }
    },
    {
      "avatarId": 4,
      "displayName": "Kraken",
      "level": 1,
      "rank": 2,
      "stat": 0,
      "uid": "096IZ0NijQ0u60RTNw6AiyVbhwy2",
      "clan": null
    }
  ]
}
```

**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION` (leaderboard still warming up)

**Notes:** The response now follows a simplified format with `callerRank` (the authenticated user's position), `leaderboardType` (legacy metric type), and `players[]` array. Each player entry includes their stats, rank, and clan information. Clan information includes `clanId` and `clanName` when the player belongs to a clan, or `null` if they don't. This callable currently reads every `/Players/{uid}/Profile/Profile` document on demand, sorts all players by the requested metric, and slices the result in memory before returning it. That means each request scales with your player count—great for development/debugging, but expensive at scale. When you're ready for production you should reintroduce a scheduled snapshot (or another caching strategy) to avoid scanning millions of documents per call.

---

### `searchPlayer`

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
          "clan": { "clanId": "clan_123", "name": "Night Riders" }
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
          "clan": { "clanId": "clan_123", "name": "Night Riders" }
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


# Clans & Chat

This section documents all clan and chat-related Cloud Functions, with input, output, and error contracts.

---

### `createClan`
**Purpose:** Creates a new clan and returns the same payload as `getMyClanDetails` so the caller can hydrate immediately.
**Input:**
```json
{
  "opId": "string",
  "name": "string",
  "description": "string (optional)",
  "type": "anyone can join|invite only|closed (optional)",
  "location": "string (optional)",
  "language": "string (optional)",
  "badge": "string (optional)",
  "minimumTrophies": "number (optional)"
}
```
**Output:** `{ "clan": { ... }, "members": [ ... ], "membership": { ... }, "requests": [] }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `ALREADY_EXISTS`

---

### `updateClanSettings`
**Purpose:** Officers only; updates clan info, search mirror, timestamp.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string",
  "name": "string (optional)",
  "description": "string (optional)",
  "type": "anyone can join|invite only|closed (optional)",
  "location": "string (optional)",
  "language": "string (optional)",
  "badge": "string (optional)",
  "minimumTrophies": "number (optional)"
}
```
**Output:** `{ "clanId": "string", "updated": ["field1", ...] }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `FAILED_PRECONDITION`

---

### `deleteClan`
**Purpose:** Leader-only; clan must be empty except leader. Recursively deletes clan tree.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string"
}
```
**Output:** `{ "clanId": "string", "deleted": true }`
**Errors:** `UNAUTHENTICATED`, `PERMISSION_DENIED`, `FAILED_PRECONDITION`, `NOT_FOUND`

---

### `joinClan`
**Purpose:** Join an “anyone can join” clan; checks trophies, capacity, clears requests/invites.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string"
}
```
**Output:** `{ "clanId": "string" }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `NOT_FOUND`

---

### `requestToJoinClan`
**Purpose:** Request to join an invite-only clan; prevents duplicates, enforces capacity/trophies.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string",
  "message": "string (optional)"
}
```
**Output:** `{ "clanId": "string" }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `NOT_FOUND`

---

### `cancelJoinRequest`
**Purpose:** Deletes pending join request atomically.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string"
}
```
**Output:** `{ "clanId": "string" }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `NOT_FOUND`

---

### `leaveClan`
**Purpose:** Removes membership, decrements stats, handles leader succession.
**Input:**
```json
{
  "opId": "string"
}
```
**Output:** `{ "clanId": "string" }`
**Errors:** `UNAUTHENTICATED`, `FAILED_PRECONDITION`, `NOT_FOUND`

---

### `acceptJoinRequest`
**Purpose:** Officer+; moves request into membership, updates social docs, posts system message.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string",
  "targetUid": "string"
}
```
**Output:** `{ "clanId": "string" }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `NOT_FOUND`

---

### `declineJoinRequest`
**Purpose:** Officer+; deletes join request.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string",
  "targetUid": "string"
}
```
**Output:** `{ "clanId": "string" }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `NOT_FOUND`

---

### `promoteClanMember`
**Purpose:** Officer+ with higher priority than target; optional explicit role, otherwise +1 rank (never to leader).
**Input:**
```json
{
  "opId": "string",
  "clanId": "string",
  "targetUid": "string",
  "role": "string (optional)"
}
```
**Output:** `{ "clanId": "string" }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `NOT_FOUND`, `FAILED_PRECONDITION`

---

### `demoteClanMember`
**Purpose:** Officer+; ensures lowered rank and target not leader.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string",
  "targetUid": "string",
  "role": "string (optional)"
}
```
**Output:** `{ "clanId": "string" }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `NOT_FOUND`, `FAILED_PRECONDITION`

---

### `transferClanLeadership`
**Purpose:** Leader only; promotes target to leader, demotes self to coLeader, posts system message.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string",
  "targetUid": "string"
}
```
**Output:** `{ "clanId": "string" }`
**Errors:** `UNAUTHENTICATED`, `PERMISSION_DENIED`, `FAILED_PRECONDITION`, `NOT_FOUND`

---

### `kickClanMember`
**Purpose:** Officer+; cannot kick leader, clears member's social docs and invite.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string",
  "targetUid": "string"
}
```
**Output:** `{ "clanId": "string" }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `NOT_FOUND`, `FAILED_PRECONDITION`

---

### `updateMemberTrophies`
**Purpose:** Internal helper called by race results; increments clan + member trophies when player currently in a clan.
**Input:**
```json
{
  "opId": "string",
  "trophyDelta": "number"
}
```
**Output:** `{ "opId": "string", "updated": true }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `NOT_FOUND`

---

### `inviteToClan`
**Purpose:** Officer+; writes invite blob under target's `/Social/ClanInvites`.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string",
  "targetUid": "string",
  "message": "string (optional)"
}
```
**Output:** `{ "clanId": "string" }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `NOT_FOUND`, `FAILED_PRECONDITION`

---

### `acceptClanInvite`
**Purpose:** Converts invite to membership after validating capacity/trophies.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string"
}
```
**Output:** `{ "clanId": "string" }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, `NOT_FOUND`

---

### `declineClanInvite`
**Purpose:** Removes stored invite.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string"
}
```
**Output:** `{ "clanId": "string" }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`

---

### `bookmarkClan`
**Purpose:** Stores snapshot in `/Social/ClanBookmarks` + array helper for quick UI rendering.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string"
}
```
**Output:** `{ "clanId": "string" }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`

---

### `unbookmarkClan`
**Purpose:** Removes bookmark snapshot + ID.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string"
}
```
**Output:** `{ "clanId": "string" }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `FAILED_PRECONDITION`

---

### `getBookmarkedClans`
**Purpose:** Hydrates live data when available, otherwise falls back to cached bookmark metadata.
**Input:** `{}`
**Output:** `{ "clans": [ClanSummary, ...] }`
**Errors:** `UNAUTHENTICATED`

---

### `getClanDetails`
**Purpose:** Returns clan summary plus roster entries (each member includes `displayName`, `avatarId`, `level`, `role`, `trophies`, `joinedAt`). Pending requests are included when the caller is officer+. Member rows mirror `/Clans/{clanId}/Members/{uid}`, which is kept up to date when players change profile fields.
**Input:**
```json
{
  "clanId": "string"
}
```
**Output:** `{ "clan": { ... }, "members": [ ... ], "membership": { ... }, "requests": [ ... ] }`
**Example:**
```json
{
  "clan": {
    "clanId": "clan_SUN",
    "name": "Solar Syndicate",
    "description": "Top-speed freaks who love night drives.",
    "type": "invite only",
    "location": "AUSTRALIA",
    "language": "en",
    "badge": "badge_solar",
    "minimumTrophies": 2500,
    "stats": { "members": 5, "trophies": 17850, "totalWins": 120 }
  },
  "members": [
    { "uid": "uid_leader", "displayName": "RAVEN", "avatarId": 8, "level": 42, "role": "leader", "trophies": 4200, "joinedAt": 1731650000000 },
    { "uid": "uid_co1", "displayName": "LYNX", "avatarId": 11, "level": 37, "role": "coLeader", "trophies": 3650, "joinedAt": 1731300000000 },
    { "uid": "uid_co2", "displayName": "MIRA", "avatarId": 3, "level": 33, "role": "coLeader", "trophies": 3525, "joinedAt": 1731210000000 },
    { "uid": "uid_memberB", "displayName": "ZED", "avatarId": 19, "level": 28, "role": "member", "trophies": 3400, "joinedAt": 1731000000000 },
    { "uid": "uid_member", "displayName": "ATUL22", "avatarId": 5, "level": 24, "role": "member", "trophies": 3075, "joinedAt": 1730900000000 }
  ],
  "membership": { "role": "coLeader", "joinedAt": 1731300000000 },
  "requests": [
    { "uid": "uid_req01", "displayName": "NITROGIRL", "trophies": 2950, "message": "Ready to grind", "requestedAt": 1731700000000 },
    { "uid": "uid_req02", "displayName": "DRIFTKING", "trophies": 3100, "message": "Need a fast clan", "requestedAt": 1731710000000 }
  ]
}
```
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`, `PERMISSION_DENIED`

---

### `getMyClanDetails`
**Purpose:** Convenience helper that reads `/Players/{uid}/Social/Clan` to hydrate the caller's own clan without passing an ID.
**Input:** `{ }`
**Output:** Same as `getClanDetails`.
**Example:**
```json
{
  "clan": {
    "clanId": "clan_NOVA",
    "name": "Neon Novas",
    "description": "We race at dawn.",
    "type": "anyone can join",
    "location": "USA-WEST",
    "language": "en",
    "badge": "badge_neon",
    "minimumTrophies": 1200,
    "stats": { "members": 5, "trophies": 14320, "totalWins": 64 }
  },
  "members": [
    { "uid": "uid_lead2", "displayName": "EMBER", "avatarId": 2, "level": 39, "role": "leader", "trophies": 3600, "joinedAt": 1731100000000 },
    { "uid": "uid_co3", "displayName": "GLITCH", "avatarId": 15, "level": 34, "role": "coLeader", "trophies": 3300, "joinedAt": 1731050000000 },
    { "uid": "uid_co4", "displayName": "JAY", "avatarId": 1, "level": 32, "role": "coLeader", "trophies": 2890, "joinedAt": 1730990000000 },
    { "uid": "uid_memberC", "displayName": "PIXEL", "avatarId": 9, "level": 27, "role": "member", "trophies": 2580, "joinedAt": 1730960000000 },
    { "uid": "myUid", "displayName": "PLAYER_ME", "avatarId": 7, "level": 25, "role": "member", "trophies": 2450, "joinedAt": 1730950000000 }
  ],
  "membership": { "role": "member", "joinedAt": 1730950000000 }
}
```
**Errors:** `UNAUTHENTICATED`, `FAILED_PRECONDITION`

---

### `searchClans`
**Purpose:** Supports case-insensitive name filtering plus location/language/trophy filters.
**Input:**
```json
{
  "query": "string (optional)",
  "location": "string (optional)",
  "language": "string (optional)",
  "type": "string (optional)",
  "limit": "number (optional)",
  "minMembers": "number (optional)",
  "maxMembers": "number (optional)",
  "minTrophies": "number (optional)",
  "requireOpenSpots": "boolean (optional)"
}
```
**Output:** `{ "clans": [ClanSummary, ...] }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`

---

### `getClanLeaderboard`
**Purpose:** Ordered by `stats.trophies`, supports location filter.
**Input:**
```json
{
  "limit": "number (optional)",
  "location": "string (optional)"
}
```
**Output:** `{ "clans": [ClanSummary, ...] }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`

---

### `sendGlobalChatMessage`
**Purpose:** Enforces room slow mode, trims history, stamps profile + clan snapshot on every message.
**Input:**
```json
{
  "opId": "string",
  "roomId": "string",
  "text": "string",
  "clientCreatedAt": "string (optional ISO8601)"
}
```
**Output:** `{ "roomId": "string", "messageId": "string" }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `RESOURCE_EXHAUSTED`, `FAILED_PRECONDITION`, `NOT_FOUND`

Each stored message contains `{ roomId, authorUid, authorDisplayName, authorAvatarId, authorTrophies, authorClanName?, authorClanBadge?, type, text, clientCreatedAt?, createdAt, deleted, deletedReason }`.

---

### `getGlobalChatMessages`
**Purpose:** Returns the most recent global messages (server capped at 25).
**Input:**
```json
{
  "roomId": "string",
  "limit": 25
}
```
**Output:** `{ "roomId": "string", "messages": [ { ...Message } ] }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `NOT_FOUND`

---

### `sendClanChatMessage`
**Purpose:** Requires current membership, enforces clan slow mode, logs latest profile/clan snapshot.
**Input:**
```json
{
  "opId": "string",
  "clanId": "string (optional)",
  "text": "string",
  "clientCreatedAt": "string (optional ISO8601)"
}
```
**Output:** `{ "clanId": "string", "messageId": "string" }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `RESOURCE_EXHAUSTED`, `FAILED_PRECONDITION`, `NOT_FOUND`

---

### `getClanChatMessages`
**Purpose:** Returns up to 25 of the latest clan messages for the caller’s clan.
**Input:**
```json
{
  "limit": 25
}
```
**Output:** `{ "clanId": "string", "messages": [ { ...Message } ] }`
**Errors:** `UNAUTHENTICATED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`

---
