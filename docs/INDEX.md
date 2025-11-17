# Project Documentation Index

This document is the central hub for all technical and architectural documentation for the Mystic Motors v2 backend.
*   **2025-10-19:** Deployed the new device-anchored guest account and binding flows to the sandbox environment.

### Recent Changes
*   **2025-11-13:** Shipped the Social v3 stack (friends/requests/search/leaderboards/presence). See the new sections in [**Firestore Schema**](./FIRESTORE_SCHEMA.md#playersuid-socialprofile-singleton) and [**Function Contracts**](./FUNCTION_CONTRACTS.md#social--leaderboards).
*   **2025-11-12:** Completed the SKU-first migration for legacy runtime suites. `garage.test.ts`, `profile.test.ts`, `purchaseCrateItem.legacy.test.ts`, `spells.test.ts`, `auth.ensureGuestSession.test.ts`, and the v3 runtime flow tests now consume the consolidated v3 catalogs via shared helpers (`pickCosmeticSkus`, `findPurchasableCrate`, `withDeterministicRng`). All inline mini catalogs were removed; determinism and receipt assertions cover every mutating callable.
*   **2025-11-10:** SKU-first runtime enabled by default (`USE_UNIFIED_SKUS=true`). Inventory, shop, offers, and crates now operate on variant-level `skuId`s with additive v3 catalog artifacts and receipts. New tooling: `npm run tools:validate-v3-skus`, `npm run tools:migrate-crates-to-sku`, `npm run tools:migrate-offers-to-sku`, plus the v3 runtime test suite (`functions/test/v3/runtime.v3.test.ts`).
*   **2025-11-05:** Introduced opaque `itemId` catalogs and aggregated v2 GameData seed (`backend-sandbox/seeds/gameDataCatalogs.v2.json`). Run `npm run tools:build-v2:write` then `npm run seed:gameDataV2` to publish the side-by-side docs.
*   **2025-10-27:** Unified the shop pipeline (`purchaseShopSku`) and booster activation (`activateBooster`). Added `/Players/{uid}/Boosters/Active`, refreshed contracts/schema docs, and shipped new tests (`purchaseShopSku.test.ts`, `activateBooster.test.ts`, `purchaseCrateItem.legacy.test.ts`). Seed the updated catalog via `npm run seed:file -- backend-sandbox/seeds/gameDataCatalogs.fixed.json`.
*   **2025-10-28:** Finalized the unified ItemSkus/Crates catalog shape (purchasable pricing, rarity pools) and migrated all runtime tests to the new schema. Added `catalogs.unified.schema.test.ts` to guard the seeds.
*   **2025-10-19:** Implemented device-anchored guest accounts and binding flows. See the new "Auth + Device Anchors" section in [**Function Contracts**](./FUNCTION_CONTRACTS.md).
*   **2025-10-20:** Implemented direct sign-up functions (`signupEmailPassword` and `signupGoogle`). See the new "Direct Sign-Up" section in [**Function Contracts**](./FUNCTION_CONTRACTS.md).
*   **2025-10-20:** Implemented spell token economy. See the "Spells" and "Economy" sections in [**Function Contracts**](./FUNCTION_CONTRACTS.md) and the "Players" section in [**Firestore Schema**](./FIRESTORE_SCHEMA.md).
*   **2025-10-20:** Implemented player profile functions (username, age, avatar, subscriptions, welcome offer). See the "Player Profile" section in [**Function Contracts**](./FUNCTION_CONTRACTS.md) and the "Players" and "Usernames" sections in [**Firestore Schema**](./FIRESTORE_SCHEMA.md).
*   **2025-10-21:** Refactored player data model to split stats between `Profile` and `Economy` subcollections. Updated `onAuthCreate`, `initUser`, `setUsername`, `setAvatar`, `upgradeSpell`, `grantXP`, and `recordRaceResult` to reflect the new schema. Added new functions for managing loadouts and spell decks. See [**Firestore Schema**](./FIRESTORE_SCHEMA.md) and [**Function Contracts**](./FUNCTION_CONTRACTS.md) for details.
*   **2025-10-21:** Stabilized `profile` and `auth.binding` test suites with emulator cleanup helpers and robust seeding.
*   **2025-10-21:** Hardened signup functions with transactional email reservation and added `checkEmailExists` function. See [**Function Contracts**](./FUNCTION_CONTRACTS.md#checkEmailExists) and new `AccountsEmails` and `AccountsProviders` collections in [**Firestore Schema**](./FIRESTORE_SCHEMA.md#accountsemails).
*   **2025-10-21:** Guest init schema correction; region normalization to us-central1; tests added; migration script.
*   **2025-10-22:** Updated player initialization to include default starter car (Deimos - car_h4ayzwf31g) in Garage, 5 starter spells in SpellDecks/1, and unlocked spells in Spells subcollection. New players now start with a complete, playable configuration. See updated schema in [**Firestore Schema**](./FIRESTORE_SCHEMA.md).
*   **2025-10-23:** Schema Revision (read-cost optimization). Consolidated master spells, player spell levels, spell decks, garage cars, and active loadout into singleton documents to dramatically reduce client read counts. Moved HUD-specific fields into a dedicated `Profile/Profile` document. See the fully updated [**Firestore Schema**](./FIRESTORE_SCHEMA.md) for details.
*   **2025-10-23:** Aligned all seeds and Cloud Functions to FIRESTORE_SCHEMA.md (singleton SpellStats, consolidated Spells/Levels, Decks, Cars, Loadout; Profile/Economy field boundaries enforced; spellToken-based upgrades; level-up grants spellTokens).
*   **2025-10-25:** Added CarTuningConfig (global) and refactored CarsCatalog to store slider values (`topSpeed`, `acceleration`, `handling`, `boostRegen`, `boostPower`). Cloud Functions compute authoritative real stats via the tuning ranges.
*   **2025-10-26:** Catalog-driven starter rewards and crate opening overhaul. Player init, `claimStarterOffer`, and `openCrate` now resolve SKUs from GameData, maintain per-SKU inventory summaries, and persist receipts. See [**Firestore Schema**](./FIRESTORE_SCHEMA.md#playersuidinventory), [**Function Contracts**](./FUNCTION_CONTRACTS.md#claimstarteroffer), and tests in `initializeUser.test.ts`, `profile.test.ts`, `garage.test.ts`, and `catalogs.seed.test.ts`.

## Architecture

**Note:** All Cloud Functions are deployed in `us-central1`.

*   [**Architecture Summary**](./ARCHITECTURE_SUMMARY.md): High-level overview of the system architecture.
*   [**Backend Logic**](./BACKEND_LOGIC.md): A living document detailing the implementation logic for the v2 Cloud Functions backend.
*   [**Function Contracts**](./FUNCTION_CONTRACTS.md): Detailed contracts for each Cloud Function.
*   [**Schema Artifacts**](./SCHEMA_ARTIFACTS.md): Descriptions and definitions of data schemas.
*   [**Firestore Schema**](./FIRESTORE_SCHEMA.md): Detailed documentation of the Firestore database structure.
    - Car Tuning Config (Global) and CarsCatalog (value vs real)

## Cloud Functions

*   **Direct Sign-Up:**
    *   `signupEmailPassword`: Creates a new user account with an email and password.
    *   `signupGoogle`: Creates a new user account using a Google ID token.
    *   [**Source Code**](../backend-sandbox/functions/src/auth/signupEmailPassword.ts)
    *   [**Test Suite**](../backend-sandbox/functions/test/auth.signup.test.ts)
*   **Shop & Boosters:**
    *   `purchaseShopSku`: Unified gem purchase callable.  
        [Source](../backend-sandbox/functions/src/shop/purchaseShopSku.ts) · [Tests](../backend-sandbox/functions/test/purchaseShopSku.test.ts) · [Legacy wrapper test](../backend-sandbox/functions/test/purchaseCrateItem.legacy.test.ts)
    *   `activateBooster`: Consumes booster SKUs and extends timers under `/Players/{uid}/Boosters/Active`.  
        [Source](../backend-sandbox/functions/src/shop/activateBooster.ts) · [Tests](../backend-sandbox/functions/test/activateBooster.test.ts)

## Discovery & Planning

*   [**Function Discovery**](./FUNCTION_DISCOVERY.md): A complete inventory of all functions discovered in the legacy backend.
*   [**Function Gap Analysis**](./FUNCTION_GAP_ANALYSIS.md): An analysis of discrepancies between legacy functions and the new architecture.
*   [**Implementation Plan**](./IMPLEMENTATION_PLAN.md): The definitive blueprint for the implementation of all Cloud Functions.
*   [**Repo Inventory**](./REPO_INVENTORY.md): An inventory of all repositories related to the project.

## Deployment

*   [**New Sandbox Setup**](./NEW_SANDBOX_SETUP.md): A step-by-step guide on how the new `mystic-motors-sandbox` Firebase project was created and configured.
*   [**Sandbox Deploy**](./SANDBOX_DEPLOY.md): Exact commands for deploying the Cloud Functions v2 backend to the sandbox environment.
*   [**Deployment Guardrails**](./DEPLOYMENT_GUARDRAILS.md): Best practices to follow during deployment to ensure stability.
*   [**Deployment Instructions**](./DEPLOYMENT_INSTRUCTIONS.md): Step-by-step guide for building and deploying Cloud Functions.

## Migration

*   [**Migration Plan**](./MIGRATION_PLAN.md): The overall plan for migrating from the legacy system.
*   [**Modeling Decisions**](./migration/MODELING_DECISIONS.md): Key decisions made during the data modeling phase of the legacy migration.

## Testing & Validation

*   [**Test Plan**](./TEST_PLAN.md): A comprehensive testing strategy for the Cloud Functions v2 backend.
*   [**Validation Checklist**](./VALIDATION_CHECKLIST.md): A checklist to validate the implementation against requirements.
-   Quick start: `npm run test` (within `backend-sandbox/functions`) launches Firestore/Auth emulators and runs Jest suites in band. Use `npm run emu:test` only when emulators are already running.

## Handoff

*   [**Copilot Handoff Prompt**](./COPILOT_HANDOFF_PROMPT.md): Prompt for handing off the project to the Copilot.
*   [**Seeding Handoff Prompt**](./SEEDING_HANDOFF_PROMPT.md): Prompt for seeding the Firestore database.

## Legacy Backend (Read-Only)

The `/legacy-firebase-backend` directory contains the original source code and is preserved for historical context only. **Do not add new documentation or code there.** All active documentation now lives in this `/docs` directory.
- **[AUDIT_GAMEDATA.md](AUDIT_GAMEDATA.md)**: An audit of the GameData collections, comparing the legacy data with the sandbox environment.
- **[AUDIT_CRATES.md](AUDIT_CRATES.md)**: A document outlining the crate distributions generated by the `buildCrateDistributions.js` tool.
- **[AUDIT_FUNCTIONS_COVERAGE.md](AUDIT_FUNCTIONS_COVERAGE.md)**: An audit of the Cloud Functions coverage, comparing the legacy functions with the new contracts.
- **[buildCrateDistributions.js](../backend-sandbox/tools/buildCrateDistributions.js)**: A tool for generating the `crates.json` seed file from the legacy item data.
- **[verifySeeds.js](../backend-sandbox/tools/verifySeeds.js)**: A tool for validating the integrity of the seed data.
## GameData Catalogs

The v2 backend uses a consolidated, singleton-based approach for all master game data. Instead of storing each car, spell, or item as a separate document, we group them into "catalogs." This design dramatically reduces the number of reads required by the client, improving application startup time and reducing Firebase costs.

**Key Benefits:**
- **Reduced Read Costs:** Clients fetch all game data in a handful of reads, rather than hundreds or thousands.
- **Improved Performance:** Faster data access leads to a snappier user experience.
- **Simplified Client Logic:** Clients can cache the catalogs in memory for O(1) lookups.

**Catalogs:**
- `/GameData/v1/CarsCatalog`
- `/GameData/v1/SpellsCatalog`
- `/GameData/v1/ItemsCatalog`
- `/GameData/v1/ItemSkusCatalog`
- `/GameData/v1/CratesCatalog`
- `/GameData/v1/OffersCatalog`
- `/GameData/v1/RanksCatalog`
- `/GameData/v1/XpCurve`

For more details, see the [**Firestore Schema**](./FIRESTORE_SCHEMA.md#gamedata-master-data) documentation.

**Seeding scripts (`backend-sandbox/functions`):**
- `npm run seed:gamedata` — writes `/GameData/v1/catalogs/*` singletons (cars, spells, items, etc.)
- `npm run seed:testplayer` — provisions `test_user_001` with canonical player documents and inventory summary

### Seed Files
- `backend-sandbox/seeds/gameDataCatalogs.fixed.json` — canonical consolidated catalogs (Cars, Spells, Items, ItemSkus, Crates, Offers, Ranks, XpCurve):
  - Car and Spell IDs use `prefix_{crockford-base32}` (no embedded names).
  - Cars include levels `0..20` with `priceCoins` sourced from `legacy-firebase-backend/json-files/Car_Progressions.json` and stats from `docs/migration/car_curve_config.json`.
  - ItemSkus include `displayName` derived from the base Item display name plus variant color.
  - Crate entries now carry gem `costs` (crate/key) and matching SKUs so purchasing can be performed server-side.
- Legacy per-document player seeds now live under `backend-sandbox/seeds/archive/players_*.json` for profile, economy, garage, inventory, decks, etc.

To (re)seed catalogs to the sandbox project:
```
cd backend-sandbox
export GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/mystic-motors-sandbox-2831a79c5ae0.json"
export PROJECT_ID="mystic-motors-sandbox"
node tools/seedFirestore.mjs seeds/gameDataCatalogs.fixed.json

To regenerate the fixed catalogs after conversion scripts:
```
npm run fix:catalogs
```
```

## Social Runbook

* **Schema:** `/Players/{uid}/Social/*`, `/Leaderboards_v1/{metric}` (optional cache), `/Usernames/{displayNameLower}`, plus the RTDB presence paths documented in [**FIRESTORE_SCHEMA.md**](./FIRESTORE_SCHEMA.md#playersuid-socialprofile-singleton).
* **Contracts:** See [**FUNCTION_CONTRACTS.md**](./FUNCTION_CONTRACTS.md#social--leaderboards) for callable payloads/idempotency and [**FUNCTION_DISCOVERY.md**](./FUNCTION_DISCOVERY.md#11-social--leaderboards) for the quick index.
* **Jobs:** `socialPresenceMirrorLastSeen` mirrors `/presence/lastSeen` into `/Players/{uid}/Social/Profile`. The leaderboard callable currently scans all players on demand (dev mode) — reintroduce a scheduled cache before going to production.
* **APIs:** Use `getFriendRequests` (incoming only) / `getFriends` for list views; both read the cached snapshots stored under `/Social` and only hydrate live profiles if a snapshot is missing. Use `viewPlayerProfile` when drilling into a player card.
* **Verification:** `USE_UNIFIED_SKUS=true USE_ITEMID_V2=false npm test -- socials.v3.test.ts` exercises leaderboard/search/friends/profile flows against the emulators.

## Data Migration & Seeding

This section documents the tools and processes for migrating legacy data to the new `/GameData/v1/` schema and seeding it into Firestore.

**Status:** ✅ Complete

### Key Documents
-   [**Audit of Tools Runtime**](./AUDIT_TOOLS_RUNTIME.md): A detailed summary of the audit and changes made to the conversion and seeding tools.
-   [**Test User Creation and Seeding Guide**](./TEST_USER_GUIDE.md): A guide for creating and populating test users.
-   [**Migration Plan**](./MIGRATION_PLAN.md): The overall plan for migrating from the legacy system.
-   [**Modeling Decisions**](./migration/MODELING_DECISIONS.md): Key decisions made during the data modeling phase of the legacy migration.

### Summary of the Process
The data migration and seeding process is broken down into the following steps:
1.  **Conversion**: Legacy data is converted from its original format to the new schema using a set of conversion scripts.
2.  **Seeding**: The converted data is then seeded into the Firestore database using a dedicated seeding script.

All tools are written in TypeScript and compiled to JavaScript before execution to ensure a stable and predictable runtime environment.

### Commands
To rerun the entire conversion and seeding process, please refer to the commands in the [**Audit of Tools Runtime**](./AUDIT_TOOLS_RUNTIME.md) document.

- Unified GameData seed (includes booster SKUs): `npm run seed:file -- backend-sandbox/seeds/gameDataCatalogs.fixed.json`
- V3 SKU validator: `npm run tools:validate-v3-skus`
- Crate drop migration (writes `functions/seeds/v3/CratesCatalog.sku.json`): `npm run tools:migrate-crates-to-sku`
- Offer entitlement migration (writes `functions/seeds/v3/OffersCatalog.sku.json`): `npm run tools:migrate-offers-to-sku`
- Seed additive v3 catalogs into Firestore: `npm run seed:v3:all`
- ItemId v2 catalogs (opaque IDs, aggregating Items/Crates/Offers/Spells/Cars): `npm run seed:gameDataV2`
✅ **Tests stabilized**: callable wrapper now uses single-object `{ data, auth, app }`; functions throw `HttpsError` codes; Auth user seeded in tests; email index path normalized to `/AccountsEmails/{email}`; running tests under `firebase emulators:exec`.
- Spells: `npm run convert:spells` → writes `seeds/spells.json` from `legacy-firebase-backend/json-files/DefaultSpellDeck.json`
*   **Race:**
    *   `race.prepareRace`: Single-call race bootstrap returning player + bots payload with minimal reads.
    *   [Source](../backend-sandbox/functions/src/race/prepareRace.ts) · [Test](../backend-sandbox/functions/test/race.prepareRace.test.ts)
