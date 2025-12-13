# Cloud Functions v2 - Comprehensive Test Plan

**Date:** 2025-10-16
**Author:** Roo, Senior QA Architect

## 1. Introduction & Goals

This document outlines the testing strategy for the Mystic Motors Cloud Functions v2 backend deployed to the `mystic-motors-sandbox` sandbox. The goal is to ensure the reliability, correctness, and robustness of the entire function suite through a multi-layered testing approach.

This plan is designed to be executed by a developer in Debug mode, providing clear scenarios and validation criteria.

## 2. Test Setup & Environment

### 2.1. Environment
- **Project ID**: `mystic-motors-sandbox`
- **Authentication**: Tests will require authenticated test user credentials (UIDs and tokens).
- **Emulator Suite**: For unit and some integration tests, the Firebase Emulator Suite (Firestore, Functions, Auth) should be used for speed and isolation.

### 2.2. Seed Data Requirements
A seeding script (`tools/seedFirestore.js` can be adapted) must be run before executing the test suite to ensure a consistent state. This script must prepare:

- **Test Users**:
    - `testUser_standard`: A user with moderate currency, a few cars, and no clan.
    - `testUser_wealthy`: A user with abundant coins and gems.
    - `testUser_poor`: A user with zero coins and gems.
    - `testUser_clan_leader`: The leader of a pre-defined clan.
    - `testUser_clan_member`: A member of the pre-defined clan.
- **Game Data**:
    - Pre-defined cars with known prices and upgrade curves (`/GameData/v1/Cars`).
    - Pre-defined crates with known reward pools (`/GameData/v1/Crates`).
    - (Note: XP progression is calculated via runtime formula in `src/shared/xp.ts`, no Firestore catalog required)
- **Clan Data**:
    - A pre-existing clan (`/Clans/{clanId}`) with `testUser_clan_leader` as the leader and `testUser_clan_member` as a member.

---

## 3. Unit Tests

Unit tests should be written using a framework like Mocha or Jest and focus on isolating the logic within individual helper modules and business logic functions.

### 3.1. Core Modules
- **`idempotency.ts`**:
    - **Test Case**: `checkIdempotency` should return the stored result if an `opId` receipt has a "completed" status.
    - **Test Case**: `checkIdempotency` should throw an error if an `opId` receipt has an "in_progress" status.
    - **Test Case**: `checkIdempotency` should proceed without error if no receipt exists for the `opId`.
- **`transactions.ts`**:
    - **Test Case**: `runTransactionWithReceipt` should successfully execute the provided work function and write a "completed" receipt with the correct result.
    - **Test Case**: If the work function throws an error, `runTransactionWithReceipt` should catch it, write a "failed" receipt, and then re-throw the original error.
- **`config.ts`**:
    - **Test Case**: `getActiveGameConfig` should fetch and return the correct, active game configuration.
    - **Test Case**: `getActiveGameConfig` should return a cached result on a second call within the 5-minute cache window.

### 3.2. Function-Specific Logic
- **Economy Functions (`adjustCoins`, `adjustGems`, `grantXP`)**:
    - **Test Case**: Test the core logic of incrementing/decrementing values correctly.
    - **Test Case**: Ensure `grantXP` correctly calculates level-ups using the "Infinite Leveling Power Curve" runtime formula (e.g., verify Level 10 requires 2456 cumulative XP).
- **Race Functions (`startRace`, `recordRaceResult`)**:
    - **Test Case**: Mock the `calculateLastPlacePenalty` and `calculateRewards` helpers to ensure the main functions apply the correct deltas.
- **Garage Functions (`purchaseCar`, `upgradeCar`)**:
    - **Test Case**: Test the validation logic (e.g., checking for ownership, max level, sufficient funds) in isolation.

---

## 4. Integration Tests (End-to-End User Journeys)

These tests will invoke the deployed Cloud Functions directly (or via the emulator) to simulate real user flows and test the interaction between different functions and Firestore documents.

### 4.1. Full Race Loop
- **Scenario**: A standard user completes a race and gets 1st place.
- **Steps**:
    1. **Setup**: `testUser_standard` has 1000 trophies, 5000 coins, 1000 XP.
    2. **Invoke `startRace`**: Simulate the start of a race.
        - **Validation**: Check that trophies are pre-deducted and a `/Races/{raceId}/Participants/{uid}` document is created with the correct `preDeductedAmount`.
    3. **Invoke `recordRaceResult`** with `position: 1`.
        - **Validation**:
            - The pre-deducted trophies are reverted.
            - The final trophy, coin, and XP rewards are granted correctly.
            - The player's final stats in `/Players/{uid}/Economy/Stats` are accurate.

### 4.2. New User Joins a Clan
- **Scenario**: A new user without a clan joins an existing clan.
- **Steps**:
    1. **Setup**: `testUser_standard` has no `clanId` in their social profile. A clan exists with `testUser_clan_leader`.
    2. **Invoke `joinClan`** for `testUser_standard` to join the clan.
        - **Validation**:
            - The `clanId` is correctly added to the user's social profile.
            - A new member document is created at `/Clans/{clanId}/Members/{uid}`.
            - The `memberCount` on the main clan document is atomically incremented.

### 4.3. Car Purchase & Upgrade
- **Scenario**: A wealthy user buys a new car and upgrades it once.
- **Steps**:
    1. **Setup**: `testUser_wealthy` has sufficient coins for the purchase and upgrade. They do not own the target car.
    2. **Invoke `purchaseCar`**.
        - **Validation**:
            - The user's coin balance is debited by the correct amount.
            - A new car document is created in the user's garage (`/Players/{uid}/Garage/{carId}`).
    3. **Invoke `upgradeCar`** on the newly purchased car.
        - **Validation**:
            - The user's coin balance is debited by the correct upgrade cost.
            - The `level` of the car document is incremented to 2.

---

## 5. Edge Case & Validation Tests

These tests target specific failure modes, invalid inputs, and concurrency issues.

### 5.1. Insufficient Funds
- **Scenario**: A poor user attempts to purchase an expensive car.
- **Test Case**: Invoke `purchaseCar` with `testUser_poor`.
    - **Validation**: The function must fail with a specific "insufficient_funds" error, and no state change (no coin deduction, no car creation) should occur.
- **Scenario**: A user tries to upgrade a car without enough coins.
- **Test Case**: Invoke `upgradeCar` for a user who cannot afford it.
    - **Validation**: The function must fail with an "insufficient_funds" error.

### 5.2. Idempotency Replays
- **Scenario**: The client sends the same `purchaseCar` request twice due to a network issue.
- **Test Case**:
    1. Invoke `purchaseCar` with a unique `opId`. It should succeed.
    2. Immediately invoke `purchaseCar` again with the *exact same* `opId`.
    - **Validation**: The second call should return the original successful result without processing the logic again. The user should only be charged once and receive only one car.

### 5.3. Invalid Inputs
- **Test Case**: Invoke `adjustCoins` with a `null` or `0` amount.
    - **Validation**: The function should throw an "invalid-argument" error.
- **Test Case**: Invoke `joinClan` for a user who is already in a clan.
    - **Validation**: The function should fail with a "failed-precondition" error (or similar), indicating the user is already in a clan.
- **Test Case**: Invoke `upgradeCar` for a car the user does not own.
    - **Validation**: The function must fail with a clear error.

### 5.4. Race Condition Scenarios
- **Scenario**: Two users try to join the last spot in a clan simultaneously.
- **Test Case**:
    1. **Setup**: Create a clan that is one member away from being full.
    2. **Execution**: Concurrently invoke `joinClan` from two different test users for the same clan.
    - **Validation**:
        - Only one user's request should succeed.
        - The other user's request must fail.
        - The clan's final `memberCount` must be correct (not incremented twice). This will require inspecting the Firestore transaction behavior.