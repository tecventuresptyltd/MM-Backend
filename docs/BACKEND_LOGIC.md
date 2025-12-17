# Backend Logic & Implementation Details

**Date:** 2025-10-15  
**Purpose:** This document is the living source of truth for the implementation details of the Mystic Motors Cloud Functions v2 backend. It will be updated continuously as new features are implemented.

---

## 1. Core Modules

### 1.1. Idempotency (`/core/idempotency.ts`)
- **Purpose**: Prevents the same operation from being processed more than once.
- **Logic**:
    - Before executing a function, the `checkIdempotency` helper is called with a player `uid` and a unique `opId`.
    - It checks for a document at `/Players/{uid}/Economy/Transactions/{opId}`.
    - If the document exists and its `status` is "completed", the function returns the stored `result` immediately, preventing re-execution.
    - If the `status` is "in_progress", it throws an error to prevent concurrent execution.
    - If no document exists, the function proceeds.
- **Receipts**: An "in_progress" receipt is created before the main transaction begins. The `runTransactionWithReceipt` helper updates this receipt to "completed" or "failed" atomically with the operation itself.

### 1.2. Transactions (`/core/transactions.ts`)
- **Purpose**: Provides a wrapper for Firestore transactions to ensure atomicity and automatic receipt generation.
- **Logic**:
    - The `runTransactionWithReceipt` function accepts the `uid`, `opId`, `reason`, and the core work to be done as a transactional function.
    - It starts a Firestore transaction.
    - It executes the provided work function.
    - Within the same transaction, it writes a "completed" receipt to `/Players/{uid}/Economy/Transactions/{opId}`, storing the `result` of the work.
    - If the transaction fails, it catches the error and writes a "failed" receipt for auditing purposes before re-throwing the error.

### 1.3. Configuration (`/core/config.ts`)
- **Purpose**: Provides a cached, global way to access game configuration data.
- **Logic**:
    - The `getActiveGameConfig` function reads the active version ID from `/GameConfig/active`.
    - It then fetches the corresponding versioned document from `/GameConfig/Versions/{versionId}`.
    - The result is cached in memory for 5 minutes to reduce Firestore reads on subsequent function invocations.
    - If the fetch fails, it will throw an error, ensuring that functions do not run with stale or incorrect configuration.

---

## 2. Economy Functions

### 2.1. adjustCoins (`/economy/coins.ts`) - DEPLOYED
- **Purpose**: Atomically adjusts a player's coin balance. Can be used for both granting (positive amount) and spending (negative amount).
- **Logic**:
    1.  **Authentication & Input Validation**: Ensures the user is authenticated and the `opId` and `amount` (non-zero) are valid.
    2.  **Idempotency**: Uses the `checkIdempotency` helper to prevent re-execution.
    3.  **Transactional Update**: Uses `runTransactionWithReceipt` to:
        - Read the player's `/Players/{uid}/Economy/Stats` document.
        - If spending (amount is negative), verifies the player has sufficient funds.
        - Applies the `amount` delta using `FieldValue.increment()`.
        - Returns the `coinsBefore` and `coinsAfter` values.
    4.  **Receipt Generation**: The helper automatically writes a "completed" or "failed" receipt.

### 2.2. adjustGems (`/economy/gems.ts`) - DEPLOYED
- **Purpose**: Atomically adjusts a player's gem balance. Can be used for both granting (positive amount) and spending (negative amount).
- **Logic**: Follows the exact same pattern as `adjustCoins`, but operates on the `gems` field in the `/Players/{uid}/Economy/Stats` document. It includes checks for insufficient funds when spending.

### 2.3. grantXP (`/economy/xp.ts`) - DEPLOYED
- **Purpose**: Atomically grants a specified amount of XP to a player and handles level-ups.
- **Logic**:
    1.  **Idempotency**: Performs the standard operation receipt check.
    2.  **XP Progression Helper**: Uses the "Infinite Leveling Power Curve" runtime formula from `src/shared/xp.ts` (no Firestore catalog read). Formula: $C(L) = K \cdot ((L - 1 + s)^p - s^p)$ with $K=50.0$, $p=1.7$, $s=1.0$. Includes O(1) analytic inverse for fast level calculation.
    3.  **Transactional Update**: Runs a Firestore transaction to:
        - Read the player's `/Players/{uid}/Economy/Stats` and `/Players/{uid}/Profile/Profile` documents.
        - Calculate the `levelBefore`/`levelAfter`, per-level progress, and detect level-ups.
        - Write the new `exp` (cumulative lifetime XP), `level`, `expProgress`, and `expToNextLevel` (total XP needed for the current level = progress + remaining) fields to the profile.
        - Increment `spellTokens` in `/Economy/Stats` for each level gained.
    4.  **Response Payload**: Returns cumulative XP before/after, level info, and detailed progress deltas.

---

## 3. Race Functions

### 3.1. startRace (`/race/index.ts`)
- **Purpose**: Pre-deducts a trophy penalty at the start of a race to discourage quitting.
- **Logic**:
    1.  **Idempotency Check**: Standard check.
    2.  **Penalty Calculation**: A placeholder function `calculateLastPlacePenalty` determines the trophy loss.
    3.  **Transactional Update**:
        - Reads the player's current `trophies`.
        - Applies the negative penalty.
        - Creates a new document at `/Races/{raceId}/Participants/{uid}` to store the `preDeductedAmount` and `originalTrophies` for later settlement.

### 3.2. recordRaceResult (`/race/index.ts`)
- **Purpose**: Settles a race, reverts the pre-deduction, and applies final rewards.
- **Logic**:
    1.  **Idempotency Check**: Standard check.
    2.  **Reward Calculation**: A placeholder function `calculateRewards` determines the final trophies, coins, and XP based on position.
    3.  **Transactional Update**:
        - Reads the `/Races/{raceId}/Participants/{uid}` document to get the `preDeductedAmount`.
        - Calculates the final trophy delta by adding the pre-deducted amount back and then applying the final reward delta.
        - Atomically updates the player's `trophies`, `coins`, and `xp` in `/Players/{uid}/Economy/Stats`.
        - Updates the participant document with the final results.

---

## 4. Garage & Inventory Functions

### 4.1. purchaseCar (`/garage/index.ts`)
- **Purpose**: Allows a player to purchase a car with coins.
- **Logic**:
    1.  **Idempotency & GameData**: Standard check, then fetches car data from `/GameData/v1/Cars/{carId}` to get the price.
    2.  **Transactional Update**:
        - Reads player's `/Economy/Stats` and checks for the `/Garage/{carId}` document.
        - Verifies the player does not already own the car and has sufficient coins.
        - Atomically decrements coins and creates the new car document in the player's garage.

### 4.2. upgradeCar (`/garage/index.ts`)
- **Purpose**: Allows a player to upgrade a car they own.
- **Logic**:
    1.  **Idempotency & GameData**: Standard check, then fetches car data to get the upgrade curve.
    2.  **Transactional Update**:
        - Reads player's `/Economy/Stats` and `/Garage/{carId}`.
        - Verifies the player owns the car, is not at max level, and has sufficient coins for the next level's cost.
        - Atomically decrements coins and increments the `level` on the car document.

### 4.3. equipCosmetic (`/garage/index.ts`)
- **Purpose**: Equips a cosmetic item to a specific slot on a car.
- **Logic**:
    1.  **Idempotency Check**.
    2.  **Transactional Update**:
        - Reads the `/Garage/{carId}` and `/Inventory/{itemId}` documents.
        - Verifies the player owns both the car and the item.
        - Updates the `equippedCosmetics` map on the car document.

### 4.4. openCrate (`/garage/index.ts`)
- **Purpose**: Opens a crate, consumes it, and grants the rewards.
- **Logic**:
    1.  **Idempotency & GameData**: Standard check, then fetches crate data from `/GameData/v1/Crates/{crateId}`.
    2.  **Reward Calculation**: A placeholder function `rollCrateRewards` determines the items to be granted.
    3.  **Transactional Update**:
        - Verifies the player owns the crate by checking `/Inventory/{crateId}`.
        - Atomically decrements the crate quantity and increments the quantity of the rewarded items in the player's inventory.

---

## 5. Clan Functions

### 5.1. createClan (`/clan/index.ts`)
- **Purpose**: Creates a new clan with the caller as the leader.
- **Logic**:
    1.  **Idempotency Check**.
    2.  **Transactional Update**:
        - Verifies the player is not already in a clan by checking `/Players/{uid}`.
        - Creates the main clan document at `/Clans/{clanId}`.
        - Creates the leader's member document at `/Clans/{clanId}/Members/{uid}`.
        - Updates the player's document with the new `clanId`.

### 5.2. updateClanSettings (`/clan/index.ts`)
- **Purpose**: Allows a clan leader/co-leader to modify clan properties.
- **Logic**:
    1.  **Idempotency Check**.
    2.  **Transactional Update**:
        - Verifies the caller is a leader or co-leader by checking their `/Clans/{clanId}/Members/{uid}` document.
        - Updates fields on the `/Clans/{clanId}` document.

### 5.3. joinClan (`/clan/index.ts`)
- **Purpose**: Allows a player to join an "open" clan.
- **Logic**:
    1.  **Idempotency Check**.
    2.  **Transactional Update**:
        - Verifies the player is not already in a clan.
        - Verifies the clan is "open".
        - Creates the new member document at `/Clans/{clanId}/Members/{uid}`.
        - Atomically increments the `memberCount` in the main `/Clans/{clanId}` document.
        - Updates the player's document with the `clanId`.

### 5.4. leaveClan (`/clan/index.ts`)
- **Purpose**: Allows a player to leave their clan.
- **Logic**:
    1.  **Idempotency Check**.
    2.  **Transactional Update**:
        - Verifies the player is in a clan.
        - Deletes the `/Clans/{clanId}/Members/{uid}` document.
        - Atomically decrements the `memberCount`.
        - Removes the `clanId` from the player's document.
        - If the player was the leader, promotes the next longest-serving member.

### 5.5. inviteToClan (`/clan/index.ts`)
- **Purpose**: Allows a clan leader/co-leader to invite a player.
- **Logic**: Creates a document in the `/Clans/{clanId}/Invites/{targetUid}` subcollection.

### 5.6. requestToJoinClan (`/clan/index.ts`)
- **Purpose**: Allows a player to request to join a clan.
- **Logic**: Creates a document in the `/Clans/{clanId}/Requests/{uid}` subcollection.

### 5.7. acceptJoinRequest (`/clan/index.ts`)
- **Purpose**: Allows a clan leader/co-leader to accept a join request.
- **Logic**:
    1.  **Idempotency Check**.
    2.  **Transactional Update**:
        - Verifies the acceptor has permission.
        - Deletes the request document.
        - Adds the player to the clan.

### 5.8. declineJoinRequest (`/clan/index.ts`)
- **Purpose**: Allows a clan leader/co-leader to decline a join request.
- **Logic**: Deletes the request document.

### 5.9. promoteClanMember (`/clan/index.ts`)
- **Purpose**: Promotes a clan member.
- **Logic**: Updates the member's role, handling leader succession if necessary.

### 5.10. demoteClanMember (`/clan/index.ts`)
- **Purpose**: Demotes a clan member.
- **Logic**: Updates the member's role.

### 5.11. kickClanMember (`/clan/index.ts`)
- **Purpose**: Kicks a member from the clan.
- **Logic**: Removes the member from the clan.

---

## 6. Game Systems

### 6.1. generateBotLoadout (`/game-systems/bots.ts`)
- **Purpose**: Generates a complete loadout for an AI opponent.
- **Logic**:
    - Currently uses a placeholder function `generateLoadout` to return a hardcoded loadout.
    - In a real scenario, this would involve complex logic reading from `/GameData/BotConfig` to generate a trophy-appropriate bot.

### 6.2. getLeaderboard (`/game-systems/leaderboards.ts`)
- **Purpose**: Retrieves a paginated leaderboard for trophies or earnings.
- **Logic**:
    - A read-only function that performs a collection group query on `Stats`.
    - It orders by the specified field (`trophies` or `earnings`) and uses `startAfter` for pagination.

### 6.3. getMaintenanceStatus (`/game-systems/maintenance.ts`)
- **Purpose**: Retrieves the global maintenance status.
- **Logic**: A simple read-only function that returns the content of the `/GameConfig/maintenance` document.

### 6.4. claimMaintenanceReward (`/game-systems/maintenance.ts`)
- **Purpose**: Allows a player to claim a maintenance reward.
- **Logic**:
    1.  **Idempotency Check**.
    2.  **Transactional Update**:
        - Verifies that a reward is available and that the player has not already claimed it.
        - Atomically grants the reward (e.g., gems) and adds the maintenance ID to the player's `claimedMaintenanceRewards` array.
