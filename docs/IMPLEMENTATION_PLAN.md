
# Master Plan & Comprehensive Function Review

**Date:** 2025-10-16  
**Purpose:** This document provides a final, comprehensive overview of all planned Cloud Functions, cross-referenced against the legacy system and the target architecture. It serves as the definitive blueprint for implementation.

---

## 1. Core Principles (Recap)

- **Schema is Law**: All functions will read from and write to the micro-document schema defined in `ARCHITECTURE_SUMMARY.md`. No deviations.
- **Server-Authoritative**: All state changes are managed by Cloud Functions.
- **Idempotent**: All mutations use an `opId` and write a transaction receipt.

---

## 2. Comprehensive Function List & Review

This section details every planned function, its mapping from the legacy system, its inputs and outputs, and a high-level description of its transformation logic to fit the new schema.

### **Domain: Core Helpers (Foundation)**
- **`checkIdempotency`**: Checks for existing transaction receipt.
- **`runTransactionWithReceipt`**: Wraps Firestore transactions.
- **`getActiveGameConfig`**: Loads and caches game configuration.
- **`audit`**: Logs operations to the `/Audit` collection.

### **Domain: Economy**

| Function | Legacy Source | Inputs | Outputs | Transformation Logic |
| :--- | :--- | :--- | :--- | :--- |
| **`adjustCoins`** | `buyCoins` | `uid`, `opId`, `amount` | `coinsBefore`, `coinsAfter` | Reads `/Players/{uid}/Economy/Stats`, increments `coins`, writes receipt. |
| **`adjustGems`** | `buyBooster` | `uid`, `opId`, `amount` | `gemsBefore`, `gemsAfter` | Reads `/Players/{uid}/Economy/Stats`, increments `gems`, writes receipt. |
| **`grantXP`** | `finishRace` | `uid`, `opId`, `amount` | `xpBefore`, `xpAfter`, `levelAfter` | Uses the "Infinite Leveling Power Curve" runtime formula ($C(L) = K \cdot ((L - 1 + s)^p - s^p)$, $K=50$, $p=1.7$, $s=1$), updates `exp` (cumulative lifetime XP), `level`, and XP progress fields, grants spell tokens on level-up. |
| **`exchangeGemsForCoins`** | `buyCoins` | `uid`, `opId`, `gemAmount` | `coinsGained`, `gemsSpent` | Reads `/Players/{uid}/Economy/Stats` & `/GameData/Economy/GemConversionCurve`, atomically adjusts balances. |
| **`purchaseBooster`** | `buyBooster` | `uid`, `opId`, `boosterId` | `success` | Reads `/GameData/Boosters`, calls `adjustGems`, creates/updates `/Players/{uid}/Inventory/{boosterId}`. |
| **`activateBooster`** | `activateBooster` | `uid`, `opId`, `boosterId` | `endTime` | Reads `/Players/{uid}/Inventory/{boosterId}` & `/Players/{uid}/Progression/Stats`, decrements inventory, updates `active...EndTime`. |
| **`getPlayerBoosters`** | `getBoosterData` | `uid` | `activeBoosters`, `inventory` | Read-only. Reads `/Players/{uid}/Progression/Stats` and `/Players/{uid}/Inventory`. |

### **Domain: Race & Rewards**

| Function | Legacy Source | Inputs | Outputs | Transformation Logic |
| :--- | :--- | :--- | :--- | :--- |
| **`startRace`** | `startRace` | `uid`, `opId`, `raceId`, `lobbyTrophies` | `preDeductedAmount` | Calculates last-place penalty, calls `adjustTrophies` (internal), creates `/Races/{raceId}/Participants/{uid}`. |
| **`recordRaceResult`** | `finishRace` | `uid`, `opId`, `raceId`, `position` | `rewards` | Reads `/Races/{raceId}/Participants/{uid}`, calculates final trophy delta, calls `adjustTrophies`, `adjustCoins`, `grantXP`. |
| **`openCrate`** | `openCrate` | `uid`, `opId`, `crateId` | `rewards` | Reads `/GameData/Crates`, `/Players/{uid}/Inventory`, decrements crate/key, grants items to inventory. |

### **Domain: Garage & Inventory**

| Function | Legacy Source | Inputs | Outputs | Transformation Logic |
| :--- | :--- | :--- | :--- | :--- |
| **`purchaseCar`** | `N/A` (client-side) | `uid`, `opId`, `carId` | `success` | Reads `/GameData/Cars`, calls `adjustCoins`, creates `/Players/{uid}/Garage/{carId}`. |
| **`upgradeCar`** | `N/A` (client-side) | `uid`, `opId`, `carId` | `levelAfter` | Reads `/GameData/Cars`, `/Players/{uid}/Garage/{carId}`, calls `adjustCoins`, updates `level`. |
| **`equipCosmetic`** | `N/A` (client-side) | `uid`, `opId`, `carId`, `itemId`, `slot` | `success` | Reads `/Players/{uid}/Inventory/{itemId}`, updates `/Players/{uid}/Garage/{carId}` with equipped item. |

### **Domain: Clan System**

| Function | Legacy Source | Inputs | Outputs | Transformation Logic |
| :--- | :--- | :--- | :--- | :--- |
| **`createClan`** | `createClan` | `uid`, `opId`, `name`, etc. | `clanId` | Creates `/Clans/{clanId}` & `/Clans/{clanId}/Members/{uid}`, updates `/Players/{uid}/Social/Profile`. |
| **`joinClan`** | `joinClan` | `uid`, `opId`, `clanId` | `success` | Creates `/Clans/{clanId}/Members/{uid}`, updates `/Clans/{clanId}` stats, updates `/Players/{uid}/Social/Profile`. |
| **`leaveClan`** | `leaveClan` | `uid`, `opId` | `success` | Deletes `/Clans/{clanId}/Members/{uid}`, updates `/Clans/{clanId}` stats, clears player profile. |
| **`updateMemberTrophies`** | `finishRace` | `uid`, `opId`, `trophyDelta` | `success` | Updates `/Players/{uid}/Economy/Stats`, updates `/Clans/{clanId}/Members/{uid}`, updates `/Clans/{clanId}` stats. |
| *(...and all other clan functions)* | `kickMember`, etc. | `...` | `...` | All follow the pattern of modifying `/Clans` subcollections and atomically updating the root `/Clans/{clanId}` document. |

---

## 3. Review of Potential Function Gaps

Based on a final cross-reference of the legacy discovery and the new architecture, the current plan has successfully mapped every piece of legacy server-side logic to a new, schema-compliant function contract.

**Identified Gaps & Resolutions:**

1.  **Gap**: The legacy `updateUserScore` function has no clear equivalent in the new architecture or game loops.
    *   **Resolution**: This function is deemed obsolete and will **not** be migrated. Its purpose appears to have been for a generic leaderboard system that is now superseded by the more specific trophy and earnings leaderboards.

2.  **Gap**: The legacy system had a large number of client-side economy operations (e.g., direct `UpdatePlayerCoins` calls).
    *   **Resolution**: These are not function gaps, but security holes. They have all been replaced by server-authoritative functions like `adjustCoins`, `recordRaceResult`, etc. The new Firestore rules will prevent these direct writes.

3.  **Gap**: The legacy `getLeaderboard` function was inefficient, reading all player documents.
    *   **Resolution**: The new `getLeaderboard` function contract will be implemented using a query on an indexed `trophies` field in `/Players/{uid}/Economy/Stats`, making it highly performant. This is a planned improvement, not a gap.

**Conclusion**: The current set of function contracts is comprehensive and covers all necessary game functionality discovered in the legacy system, while successfully adapting it to the new, secure, and scalable architecture. There are no outstanding functional gaps that require new planning.

---

This consolidated plan is now ready. I will await your final approval before proceeding with the implementation of the `race` functions.

<ask_followup_question>
<question>I have completed the comprehensive review and consolidated all planning into this Master Plan. Are you satisfied that all functions and potential gaps have been addressed, and am I clear to proceed with the implementation as outlined?</question>
<follow_up>
<suggest>Yes, this is the comprehensive plan I was looking for. Please proceed with implementation.</suggest>
<suggest>I have one more question about the clan functions.</suggest>
</follow_up>
</ask_followup_question>
