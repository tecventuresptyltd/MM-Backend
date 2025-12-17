# Cloud Functions Test Plan

This document outlines the test plan for validating all deployed cloud functions in the `mystic-motors-sandbox` environment.

## Auth + Device Anchors

### `ensureGuestSession`

**Test Case:** Recover a guest session successfully.
**Input:**
```json
{
  "opId": "ensure-guest-session-recover-1",
  "deviceAnchor": "existing-device-anchor",
  "platform": "ios",
  "appVersion": "1.0.0"
}
```
**Expected Output:**
```json
{
  "status": "recover",
  "uid": "string",
  "customToken": "string"
}
```
**Expected DB Changes:** None.

---

**Test Case:** Register a new guest session successfully.
**Input:**
```json
{
  "opId": "ensure-guest-session-new-1",
  "deviceAnchor": "new-device-anchor",
  "platform": "android",
  "appVersion": "1.0.0"
}
```
**Expected Output:**
```json
{
  "status": "ok",
  "mode": "new",
  "uid": "string"
}
```
**Expected DB Changes:**
*   A new user document is created in `/Players/{uid}`.
*   The following sub-collections are created under the new user document: `Economy`, `Garage`, `Inventory`, `Progress`, `Daily`, `Social`, `Loadouts`.
*   A new device anchor document is created in `/AccountsDeviceAnchors/{deviceAnchor}` (guest accounts only).

---

**Test Case:** Current user session is returned.
**Input:**
```json
{
  "opId": "ensure-guest-session-current-1",
  "deviceAnchor": "existing-device-anchor-for-current-user",
  "platform": "ios",
  "appVersion": "1.0.0"
}
```
**Expected Output:**
```json
{
  "status": "ok",
  "mode": "current",
  "uid": "string"
}
```
**Expected DB Changes:** None.

---

**Test Case:** Error - Invalid device anchor.
**Input:**
```json
{
  "opId": "ensure-guest-session-invalid-anchor-1",
  "deviceAnchor": "invalid-anchor",
  "platform": "ios",
  "appVersion": "1.0.0"
}
```
**Expected Output:** Error: `INVALID_ANCHOR`

---

### `bindEmailPassword`

**Test Case:** Successfully bind an email and password to a guest account.
**Input:**
```json
{
  "opId": "bind-email-password-success-1",
  "email": "test@example.com",
  "password": "password123"
}
```
**Expected Output:**
```json
{
  "status": "ok"
}
```
**Expected DB Changes:** The user's authentication provider is updated to include email/password.

---

**Test Case:** Error - Email already taken.
**Input:**
```json
{
  "opId": "bind-email-password-email-taken-1",
  "email": "existing@example.com",
  "password": "password123"
}
```
**Expected Output:** Error: `EMAIL_TAKEN`

---

**Test Case:** Error - Weak password.
**Input:**
```json
{
  "opId": "bind-email-password-weak-password-1",
  "email": "test2@example.com",
  "password": "123"
}
```
**Expected Output:** Error: `WEAK_PASSWORD`

---

**Test Case:** Idempotency Test.
**Input:**
```json
{
  "opId": "bind-email-password-idempotency-1",
  "email": "idempotency@example.com",
  "password": "password123"
}
```
**Steps:**
1. Call the function once with the input above.
2. Verify the call is successful.
3. Call the function again with the same `opId`.
**Expected Output (second call):** Error: `ALREADY_LINKED` or a success message indicating no change.
**Expected DB Changes:** The user's authentication provider is updated only once.

---

### `bindGoogle`

**Test Case:** Successfully bind a Google account.
**Input:**
```json
{
  "opId": "bind-google-success-1",
  "idToken": "valid-google-id-token"
}
```
**Expected Output:**
```json
{
  "status": "ok"
}
```
**Expected DB Changes:** The user's authentication provider is updated to include Google.

---

**Test Case:** Error - Invalid token.
**Input:**
```json
{
  "opId": "bind-google-invalid-token-1",
  "idToken": "invalid-google-id-token"
}
```
**Expected Output:** Error: `TOKEN_INVALID`

---

**Test Case:** Idempotency Test.
**Input:**
```json
{
  "opId": "bind-google-idempotency-1",
  "idToken": "valid-google-id-token-for-idempotency"
}
```
**Steps:**
1. Call the function once with the input above.
2. Verify the call is successful.
3. Call the function again with the same `opId`.
**Expected Output (second call):** Error: `ALREADY_LINKED` or a success message indicating no change.
**Expected DB Changes:** The user's authentication provider is updated only once.

---

## Direct Sign-Up Functions

The test suite for the direct sign-up functions (`signupEmailPassword` and `signupGoogle`) is located at `backend-sandbox/functions/test/auth.signup.test.ts`. The tests cover the following scenarios:

*   **Success Cases:**
    *   Successfully creating a new user with an email and password.
    *   Successfully creating a new user with a Google ID token.
    *   Storing a provided device anchor as a reference on the account (does not claim the anchor).

*   **Failure Cases:**
    *   Attempting to sign up with an email that is already in use (`EMAIL_TAKEN`).
    *   Attempting to sign up with a device anchor that is already in use is allowed; the anchor remains with its current owner and is stored as a reference on the new account.
    *   Providing a weak password (`WEAK_PASSWORD`).
    *   Providing an invalid Google ID token (`TOKEN_INVALID`).

*   **Idempotency:**
    *   Ensuring that repeated calls with the same `opId` do not result in duplicate accounts or conflicting states.

### `signupEmailPassword`

**Test Case:** Successfully signs up a new user.
**Input:**
```json
{
  "opId": "signup-email-password-success-1",
  "email": "new-user@example.com",
  "password": "password123",
  "deviceAnchor": "new-device-anchor-for-signup",
  "platform": "ios",
  "appVersion": "1.0.0"
}
```
**Expected Output:**
```json
{
  "status": "ok",
  "uid": "string",
  "customToken": "string"
}
```
**Expected DB Changes:**
*   A new user document is created in `/Players/{uid}`.
*   The following sub-collections are created under the new user document: `Economy`, `Garage`, `Inventory`, `Progress`, `Daily`, `Social`, `Loadouts`.
*   If `deviceAnchor` is provided, it is recorded as a reference on the player (field: `knownDeviceAnchors`).
*   An email index document is created in `/AccountEmails/{email}`.

---

**Test Case:** Error - Email already taken.
**Input:**
```json
{
  "opId": "signup-email-password-email-taken-1",
  "email": "existing@example.com",
  "password": "password123"
}
```
**Expected Output:** Error: `EMAIL_TAKEN`

---

### `signupGoogle`

**Test Case:** Successfully signs up a new user with Google.
**Input:**
```json
{
  "opId": "signup-google-success-1",
  "idToken": "valid-google-id-token-for-signup",
  "deviceAnchor": "new-device-anchor-for-google-signup",
  "platform": "android",
  "appVersion": "1.0.0"
}
```
**Expected Output:**
```json
{
  "status": "ok",
  "uid": "string",
  "customToken": "string"
}
```
**Expected DB Changes:**
*   A new user document is created in `/Players/{uid}`.
*   The following sub-collections are created under the new user document: `Economy`, `Garage`, `Inventory`, `Progress`, `Daily`, `Social`, `Loadouts`.
*   If `deviceAnchor` is provided, it is recorded as a reference on the player (field: `knownDeviceAnchors`).
*   An email index document is created in `/AccountEmails/{email}`.

---

**Test Case:** Error - Invalid Google ID token.
**Input:**
```json
{
  "opId": "signup-google-invalid-token-1",
  "idToken": "invalid-google-id-token"
}
```
**Expected Output:** Error: `TOKEN_INVALID`

---

## Garage

### `purchaseCar`

**Test Case:** Player successfully purchases a car.
**Input:**
```json
{
  "opId": "purchase-car-success-1",
  "carId": "test-car"
}
```
**Expected Output:**
```json
{
  "success": true,
  "carId": "test-car"
}
```
**Expected DB Changes:**
*   `/Players/{uid}/Garage/test-car` document is created.
*   `/Players/{uid}/Economy/Stats` `coins` field is decremented by the price of the car.

---

**Test Case:** Error - Player already owns the car.
**Input:**
```json
{
  "opId": "purchase-car-already-exists-1",
  "carId": "owned-car"
}
```
**Expected Output:** Error: `ALREADY_EXISTS`

---

**Test Case:** Error - Player does not have enough coins.
**Input:**
```json
{
  "opId": "purchase-car-not-enough-coins-1",
  "carId": "expensive-car"
}
```
**Expected Output:** Error: `RESOURCE_EXHAUSTED`

---

**Test Case:** Idempotency Test.
**Input:**
```json
{
  "opId": "purchase-car-idempotency-1",
  "carId": "idempotent-car"
}
```
**Steps:**
1. Call the function once with the input above.
2. Verify the car is purchased and coins are deducted.
3. Call the function again with the same `opId`.
**Expected Output (second call):** Success, but no additional car is granted and no coins are deducted.
**Expected DB Changes:** The car document is created only once, and coins are deducted only once.

---

## Clans

### `leaveClan`

**Test Case:** A regular member successfully leaves a clan.
**Input:** `{ "opId": "leave-clan-member-1" }`
**Expected Output:** `{ "success": true }`
**Expected DB Changes:**
*   The player's document at `/Players/{uid}/Private/clanId` is removed.
*   The player is removed from the `/Clans/{clanId}/members` subcollection.
*   The `memberCount` in the `/Clans/{clanId}` document is decremented.

---

**Test Case:** The leader of a clan with other members leaves, and leadership is transferred.
**Input:** `{ "opId": "leave-clan-leader-transfer-1" }`
**Expected Output:** `{ "success": true }`
**Expected DB Changes:**
*   The original leader's `clanId` is removed.
*   The original leader is removed from the clan members.
*   A new leader is promoted from the existing members (e.g., the longest-serving member).
*   The `leaderId` in the `/Clans/{clanId}` document is updated to the new leader's UID.
*   The `memberCount` is decremented.

---

**Test Case:** The last member (leader) of a clan leaves, and the clan is deleted.
**Input:** `{ "opId": "leave-clan-last-member-1" }`
**Expected Output:** `{ "success": true }`
**Expected DB Changes:**
*   The player's `clanId` is removed.
*   The `/Clans/{clanId}` document and all its subcollections are deleted.

---

**Test Case:** Error - Player is not in a clan.
**Input:** `{ "opId": "leave-clan-not-in-clan-1" }`
**Expected Output:** Error: `FAILED_PRECONDITION`

---

**Test Case:** Idempotency Test.
**Input:** `{ "opId": "leave-clan-idempotency-1" }`
**Steps:**
1. Have a player join a clan.
2. Call `leaveClan` once with the `opId`.
3. Verify the player has left the clan.
4. Call `leaveClan` again with the same `opId`.
**Expected Output (second call):** Error: `FAILED_PRECONDITION` or a success message indicating no change.
**Expected DB Changes:** The player is removed from the clan only once.

---

## Spells

### `upgradeSpell`

**Test Case:** Player successfully upgrades a spell.
**Input:**
```json
{
  "opId": "upgrade-spell-success-1",
  "spellId": "owned-spell"
}
```
**Expected Output:**
```json
{
  "success": true,
  "newLevel": 2
}
```
**Expected DB Changes:**
*   The `/Players/{uid}/Spells/Levels` document is updated with the new level.
*   `/Players/{uid}/Economy/Stats.spellTokens` is decremented by the upgrade cost.

---

**Test Case:** Error - Spell not owned.
**Input:**
```json
{
  "opId": "upgrade-spell-not-found-1",
  "spellId": "not-owned-spell"
}
```
**Expected Output:** Error: `NOT_FOUND`

---

**Test Case:** Error - Not enough spell tokens for upgrade.
**Input:**
```json
{
  "opId": "upgrade-spell-not-enough-coins-1",
  "spellId": "owned-spell"
}
```
**Expected Output:** Error: `RESOURCE_EXHAUSTED`

---

**Test Case:** Error - Player level too low to unlock.
**Input:**
```json
{
  "opId": "upgrade-spell-level-gate-1",
  "spellId": "locked-spell"
}
```
**Setup:** Player spell level is `0`; player profile `level` is below the requirement in the catalog.
**Expected Output:** Error: `FAILED_PRECONDITION`

---

**Test Case:** Error - Previous spell not unlocked.
**Input:**
```json
{
  "opId": "upgrade-spell-prereq-1",
  "spellId": "later-spell"
}
```
**Setup:** Player spell level is `0`; previous spell in unlock order is still level `0`.
**Expected Output:** Error: `FAILED_PRECONDITION`

---

**Test Case:** Idempotency Test.
**Input:**
```json
{
  "opId": "upgrade-spell-idempotency-1",
  "spellId": "owned-spell-for-idempotency"
}
```
**Steps:**
1. Call the function once with the input above.
2. Verify the spell is upgraded and coins are deducted.
3. Call the function again with the same `opId`.
**Expected Output (second call):** Success, but the spell is not upgraded again and no coins are deducted.
**Expected DB Changes:** The spell level is incremented only once, and coins are deducted only once.

---

## Race

### `startRace`

**Test Case:** Successfully start a race.
**Input:**
```json
{
  "opId": "start-race-success-1",
  "lobbyRatings": [1000, 1100, 1200, 1300],
  "playerIndex": 0
}
```
**Expected Output:**
```json
{
  "success": true,
  "raceId": "string",
  "preDeductedTrophies": "number"
}
```
**Expected DB Changes:**
*   A new race document is created in `/Races/{raceId}`.
*   The player's trophy count is pre-deducted.

---

### `recordRaceResult`

**Test Case:** Successfully record a race result.
**Input:**
```json
{
  "opId": "record-race-result-success-1",
  "raceId": "existing-race-id",
  "finishOrder": ["player1-uid", "player2-uid", "player3-uid", "player4-uid"]
}
```
**Expected Output:**
```json
{
  "success": true,
  "rewards": {
    "trophies": "number",
    "coins": "number",
    "xp": "number",
    "randomReward": "string"
  }
}
```
**Expected DB Changes:**
*   Player's trophies, coins, and XP are updated based on the race result.
*   The race document in `/Races/{raceId}` is marked as complete.

---

**Test Case:** Error - Race not found.
**Input:**
```json
{
  "opId": "record-race-result-not-found-1",
  "raceId": "non-existent-race-id",
  "finishOrder": ["player1-uid", "player2-uid", "player3-uid", "player4-uid"]
}
```
**Expected Output:** Error: `NOT_FOUND`

---

**Test Case:** Idempotency Test.
**Input:**
```json
{
  "opId": "record-race-result-idempotency-1",
  "raceId": "idempotent-race-id",
  "finishOrder": ["player1-uid", "player2-uid", "player3-uid", "player4-uid"]
}
```
**Steps:**
1. Call the function once with the input above.
2. Verify rewards are granted.
3. Call the function again with the same `opId`.
**Expected Output (second call):** Success, but no additional rewards are granted.
**Expected DB Changes:** Rewards are granted only once.

---

## Economy

### `exchangeGemsForCoins`

**Test Case:** Successfully exchange gems for coins.
**Input:**
```json
{
  "opId": "exchange-gems-success-1",
  "gemAmount": 100
}
```
**Expected Output:**
```json
{
  "success": true,
  "coinsGained": "number",
  "gemsSpent": 100
}
```
**Expected DB Changes:**
*   Player's `gems` are decremented by 100.
*   Player's `coins` are incremented by the calculated amount.

---

**Test Case:** Error - Not enough gems.
**Input:**
```json
{
  "opId": "exchange-gems-not-enough-gems-1",
  "gemAmount": 10000
}
```
**Expected Output:** Error: `RESOURCE_EXHAUSTED`

---

**Test Case:** Idempotency Test.
**Input:**
```json
{
  "opId": "exchange-gems-idempotency-1",
  "gemAmount": 50
}
```
**Steps:**
1. Call the function once with the input above.
2. Verify gems are exchanged for coins.
3. Call the function again with the same `opId`.
**Expected Output (second call):** Success, but no additional exchange occurs.
**Expected DB Changes:** The exchange happens only once.

---

### `createClan`

**Test Case:** Player successfully creates a clan.
**Input:**
```json
{
  "opId": "create-clan-success-1",
  "clanName": "Test Clan",
  "clanTag": "TEST"
}
```
**Expected Output:**
```json
{
  "success": true,
  "clanId": "string"
}
```
**Expected DB Changes:**
*   A new clan document is created in `/Clans/{clanId}`.
*   The player's `clanId` is updated in `/Players/{uid}/Private/clanId`.
*   The player is added as the leader in `/Clans/{clanId}/members`.

---

**Test Case:** Error - Player is already in a clan.
**Input:**
```json
{
  "opId": "create-clan-already-in-clan-1",
  "clanName": "Another Clan",
  "clanTag": "ANO"
}
```
**Expected Output:** Error: `FAILED_PRECONDITION`

---

**Test Case:** Idempotency Test.
**Input:**
```json
{
  "opId": "create-clan-idempotency-1",
  "clanName": "Idempotent Clan",
  "clanTag": "IDEM"
}
```
**Steps:**
1. Call the function once with the input above.
2. Verify the clan is created.
3. Call the function again with the same `opId`.
**Expected Output (second call):** Success, but no new clan is created.
**Expected DB Changes:** The clan is created only once.

---

### `joinClan`

**Test Case:** Player successfully joins an open clan.
**Input:**
```json
{
  "opId": "join-clan-success-1",
  "clanId": "open-clan-id"
}
```
**Expected Output:**
```json
{
  "success": true,
  "clanId": "open-clan-id"
}
```
**Expected DB Changes:**
*   The player's `clanId` is updated.
*   The player is added to the clan's members list.
*   The clan's `memberCount` is incremented.

---

**Test Case:** Error - Clan is full.
**Input:**
```json
{
  "opId": "join-clan-full-1",
  "clanId": "full-clan-id"
}
```
**Expected Output:** Error: `FAILED_PRECONDITION`

---

**Test Case:** Error - Clan is invite-only.
**Input:**
```json
{
  "opId": "join-clan-invite-only-1",
  "clanId": "invite-only-clan-id"
}
```
**Expected Output:** Error: `FAILED_PRECONDITION`

---

### `inviteToClan`

**Test Case:** Successfully invite a player to a clan.
**Input:**
```json
{
  "opId": "invite-to-clan-success-1",
  "inviteeId": "player-to-invite-uid"
}
```
**Expected Output:** `{ "success": true }`
**Expected DB Changes:** An invitation is created in `/Players/{inviteeId}/clanInvites`.

---

**Test Case:** Error - Inviter does not have permission.
**Input:**
```json
{
  "opId": "invite-to-clan-permission-denied-1",
  "inviteeId": "another-player-uid"
}
```
**Expected Output:** Error: `PERMISSION_DENIED`

---

### `kickClanMember`

**Test Case:** Successfully kick a member from a clan.
**Input:**
```json
{
  "opId": "kick-member-success-1",
  "clanId": "test-clan-id",
  "memberId": "member-to-kick-uid"
}
```
**Expected Output:** `{ "success": true }`
**Expected DB Changes:**
*   The kicked member's `clanId` is removed.
*   The kicked member is removed from the clan's members list.
*   The clan's `memberCount` is decremented.

---

**Test Case:** Error - Kicker does not have permission.
**Input:**
```json
{
  "opId": "kick-member-permission-denied-1",
  "clanId": "test-clan-id",
  "memberId": "another-member-uid"
}
```
**Expected Output:** Error: `PERMISSION_DENIED`
