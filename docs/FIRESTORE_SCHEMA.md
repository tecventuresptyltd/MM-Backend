# Firestore Schema Documentation (Read-Cost Optimized)

This document provides a detailed breakdown of the Firestore database structure for Mystic Motors, optimized for minimizing read costs and aligning with server-authoritative Cloud Functions v2.

**Source of Truth:** This document is the canonical reference for the Firestore schema. All Cloud Functions and client-side code must adhere to this structure.

## Design Principles

The schema is designed with the following principles to ensure performance, scalability, and security:

1.  **Minimize Read Counts:** Consolidate frequently accessed, related data into singleton documents. The goal is to achieve 1â€“3 reads for common gameplay flows like application boot, HUD updates, and garage/deck management.
2.  **Server-Authoritative Writes:** All economy, progression, and clan-related writes are executed exclusively by Cloud Functions v2 (in `us-central1`). Clients never directly modify sensitive data like currency balances, trophies, or levels. This is enforced via Firestore Security Rules.
3.  **Opaque & Consistent IDs:** All document IDs are lowercase and use the format `{prefix}_{crockford-base32}` (no i/l/o/u) to prevent collisions and ambiguity. Player references use their Firebase Auth UID. Catalog objects follow strict prefixes: cosmetic items retain `item_*`, crates use `crt_*`, keys use `key_*`, boosters use `bst_*`, and every purchasable variant uses `sku_*`.
4.  **Master vs. Player Data:**
    *   **/GameData/\*\***: Contains master data identical for all players (e.g., spell stats, car definitions). This data is public-readable but write-protected.
    *   **/Players/{uid}/\*\***: Contains player-specific state only.
5.  **Security Posture:**
    *   Clients can read their own player state (`/Players/{uid}`).
    *   Writes to sensitive paths are denied and must go through a Cloud Function.
    *   `/GameData/**` is public-read, server-write only.
6.  **Document Size:** Consolidated documents are kept under a soft limit of ~128KB to avoid performance issues, with headroom for growth.

---

## Schema Tree

```
/AccountsEmails/{normalizedEmail}
/AccountsProviders/{uid}
/AccountsDeviceAnchors/{anchorId}
/ReferralCodes/{referralCode}
/Clans/{clanId}
  /Chat/{messageId}
  /Members/{uid}
  /Requests/{uid}
/GameConfig/active
/GameData/v1
  /catalogs/CarsCatalog (singleton)
  /catalogs/SpellsCatalog (singleton)
  /catalogs/ItemsCatalog (singleton)
  /catalogs/ItemSkusCatalog (singleton)
  /catalogs/CratesCatalog (singleton)
  /catalogs/OffersCatalog (singleton)
  /catalogs/RanksCatalog (singleton)
  /catalogs/XpCurve (singleton)
  /config/CarTuningConfig (singleton)
  /config/BotConfig (singleton)
  /config/BotNames (singleton)
  /config/ReferralConfig.v1 (singleton)
/Players/{uid}
  /Profile/Profile (singleton)
  /Economy/Stats (singleton)
  /Loadouts/Active (singleton)
  /Garage/Cars (singleton)
  /Spells/Levels (singleton)
  /SpellDecks/Decks (singleton)
  /Inventory/{skuId} (per-SKU quantity ledger)
  /Inventory/_summary (singleton; category/rarity/subType totals)
  /Receipts/{opId}
  /Referrals/Progress (singleton)
  /Referrals/Events/{eventId}
/Races/{raceId}
  /Participants/{uid}
/Rooms/{roomId}
/System/RecommendedClans (singleton)
/GlobalLeaderboard/{metric} (singleton docs per metric)
/ClanLeaderboard/snapshot (singleton)

Realtime Database (RTDB):
```
/chat_messages/{streamId}/{messageId}
/presence/online/{uid}
/presence/lastSeen/{uid}
```
`streamId` is either a clanId or a global roomId. `/presence/lastSeen` is a maintenance feed mirrored into Firestore (`Players/{uid}/Social/Profile.lastActiveAt`) by the scheduled job in `src/Socials/presence.ts`.

### `/Rooms/{roomId}`

Firestore doc that tracks global chat rooms and their load-balancing metadata. Fields:

* `roomId` *(string)* – mirror of the doc ID (`{region}_{random}`).
* `region` *(string)* – normalized lowercase string. **Currently hardcoded to `"global_general"` for all users (launch strategy for maximum concurrency).**
* `type` *(string)* – `"global"` today, reserved for `"system"` rooms later.
* `connectedCount` *(number)* – incremented by `assignGlobalChatRoom`, decremented by the RTDB trigger when `/presence/online/{uid}` is removed.
* `softCap` *(number)* – preferred occupancy (default 80). Assignment prioritizes rooms below this threshold.
* `hardCap` *(number)* – absolute maximum (default 100). Rooms at this limit are skipped.
* `slowModeSeconds` *(number)* – per-user delay enforced by `sendGlobalChatMessage`.
* `maxMessages` *(number)* – used by the scheduled cleanup job when trimming RTDB history.
* `isArchived` *(boolean)* – prevents new assignments when moderators retire a room. **Critical: Query now filters `isArchived == false` to prevent archived rooms from hiding active rooms (Dec 2025 bug fix).**
* `createdAt`, `updatedAt`, `lastActivityAt` *(timestamp)* – set by Cloud Functions.

**Important Note (Dec 2025):** The `assignedChatRoomId` field has been **removed** from `/Players/{uid}/Profile/Profile`. Room assignments are now session-based only. The RTDB `/presence/online/{uid}` node is the **single source of truth** for which room a user is currently in.

**🛑 CRITICAL Client Requirement:** Client MUST write `roomId` to `/presence/online/{uid}` after calling `assignGlobalChatRoom`. Example:
```javascript
const presencePayload = {
  roomId: assignedRoomId,  // REQUIRED - from assignGlobalChatRoom response
  clanId: userClanId,
  lastSeen: serverTimestamp()
};
```
If `roomId` is missing from presence, the disconnect trigger cannot decrement the room's `connectedCount`, causing room counts to drift.

Messages for both global and clan chat live exclusively in RTDB (`/chat_messages/{streamId}/{messageId}`); there is no `Messages` subcollection under `/Rooms`.

### `/Clans` domain

#### `/Clans/{clanId}`

Main clan document keyed by a generated `clan_*` ID. Fields:

* `clanId` *(string)* â€” mirror of the document ID for convenience.
* `name` *(string)* â€” 3â€“24 characters, trimmed.
* `description` *(string)* — optional, ≤ 500 characters.
* `type` *(string)* â€” `"anyone can join"`, `"invite only"`, or `"closed"`.
* `location` *(string)* â€” free-form string used for filtering (defaults to `"GLOBAL"` if blank).
* `language` *(string)* â€” lowercase ISO language (e.g. `en`).
* `badge` *(string)* â€” cosmetic/badge identifier provided by the client UI.
* `minimumTrophies` *(number)* â€” required trophies to join/request.
* `leaderUid` *(string)* â€” current leaderâ€™s UID for quick lookups.
* `stats` *(map)* â€” `{ members, trophies, totalWins? }`, updated transactionally alongside member docs.
* `status` *(string)* â€” `"active"` now but reserved for moderation.
* `search` *(map)* â€” `{ nameLower, location, language }` to power Firestore queries.
* `createdAt` / `updatedAt` *(timestamp)* â€” server timestamps.

##### Subcollections

* `/Members/{uid}` - `{ uid, role, rolePriority, trophies, joinedAt, displayName, avatarId, level, lastPromotedAt }`.
* `/Requests/{uid}` - `{ uid, displayName, trophies, message?, requestedAt }`.
* Clan chat history now lives exclusively in Realtime Database (`/chat_messages/{clanId}/{messageId}`) so the Firestore tree stays compact.

#### Player-side clan metadata

Under `/Players/{uid}/Social`:

* `Clan` *(doc)* – `{ clanId, role, joinedAt, lastVisitedClanChatAt, lastVisitedGlobalChatAt, bookmarkedClanIds? }`.
* `ClanInvites` *(doc)* - `{ invites: { [clanId]: { clanId, clanName, clanBadge, clanType, minimumTrophies, statsMembers, statsTrophies, fromUid, fromRole, fromName, fromAvatarId, message?, createdAt, snapshotRefreshedAt? } }, updatedAt }`.
* `ClanBookmarks` *(doc)* - `{ bookmarks: { [clanId]: { clanId, name, badge, type, memberCount, totalTrophies, addedAt, lastRefreshedAt } }, bookmarkedClanIds, updatedAt }`.
* `ChatRate` *(doc)* - `{ rooms: { [roomIdOrClanKey]: { lastSentAt } }, updatedAt }` used by slow mode.

> Listen to `/Players/{uid}/Social/Clan` at startup; it is the canonical pointer indicating whether the user currently belongs to a clan and what role they hold.

`ClanBookmarks` deliberately caches the presentation data needed by the UI so `getBookmarkedClans` is always a single read. When entries grow stale (check `lastRefreshedAt` client-side), call `refreshBookmarkedClans` with the relevant `clanIds`; that callable reads `/Clans/{clanId}` in batch, writes updated snapshots back into `bookmarks`, and returns the refreshed payload for immediate UI use.

### `/System/RecommendedClans`

Singleton doc used for the "smart pool" join flow. A scheduled job rebuilds it hourly so clients never have to run an expensive "random clan" query.

* `updatedAt` *(timestamp)* - server timestamp of the last rebuild.
* `poolSize` *(number)* - number of entries currently stored.
* `pool` *(array)* - list of `{ id, minimumTrophies, name, badge, type, members, totalTrophies }` where each entry mirrors the lightweight clan card data (current limit: 10 entries).

### `/GlobalLeaderboard/{metric}` and `/ClanLeaderboard/snapshot`

Two cached leaderboard families keep read costs predictable:

* `/GlobalLeaderboard/{metric}` (one doc per metric such as `trophies`, `careerCoins`, `totalWins`) holds the top 100 player rows built by the scheduled job in `src/Socials/leaderboardJob.ts`. Fields:
  * `metric` *(string)* ? matches the document ID.
  * `updatedAt` *(number)* ? epoch ms when the cache was rebuilt.
  * `top100` *(array)* ? list of `{ rank, value, uid, snapshot }` where `snapshot` mirrors the player summary returned to the client (display name, avatar, level, clan badge).
* `/ClanLeaderboard/snapshot` stores the clan leaderboard snapshot generated by `src/clan/leaderboardJob.ts`. Fields:
  * `limit` *(number)* ? number of entries stored (currently 100).
  * `updatedAt` *(number)* ? epoch ms of the latest rebuild.
  * `top` *(array)* ? list of `{ clanId, name, badge, type, members, totalTrophies, location? }`.

Both collections are write-only for Cloud Functions. Clients read these cached docs through the callables (`getGlobalLeaderboard`, `getClanLeaderboard`) or via the on-demand manual refresh callables added for QA. Keeping precomputed leaderboards in single documents avoids scanning hundreds of clan/player docs whenever the UI opens the leaderboard screens.

### Realtime Database - Chat Streams

### `/Races/{raceId}`

Server-authoritative record for each race session kicked off via `startRace`.

* `status` *(string)* — `"pending"` when created by `startRace`, flips to `"settled"` once `recordRaceResult` finishes. Old/abandoned races may eventually be marked `"expired"`.
* `lobbySnapshot` *(array)* — immutable copy of the ratings sent by the client, preserved as `{ rating: number, participantId?: string }` so the economy helpers can reference the original lobby even if the client disconnects.
* `createdAt`, `updatedAt` *(timestamp)* — server timestamps from the start/settle transactions.
* `seed?`, `laps?`, or other metadata may be stored in future expansions, but today only the fields above are required.

#### `/Races/{raceId}/Participants/{uid}`

One document per human participant; bots do not get entries.

* `playerIndex` *(number)* — index inside `lobbySnapshot[]` for this player. Used to align finish orders with the stored ratings.
* `preDeductedTrophies` *(number)* — negative offset applied during `startRace`. `recordRaceResult` reads this and adds it back when settling.
* `createdAt` *(timestamp)* — mirrors the race document’s timestamp so support tooling can estimate age.

`recordRaceResult` queries both the race doc and the participant doc inside a transaction. If either is missing or if `status !== "pending"`, the callable aborts with `failed-precondition`.

* `/chat_messages/clans/{clanId}/{messageId}` captures every clan chat feed. Each node contains:
  * `u` - author UID (or `null` for system events)
  * `n` - display name snapshot
  * `m` - text (optional when `type === "system"`)
  * `type` - `"text"` or `"system"`
  * `c` - clan badge snapshot
  * `cid` - clanId snapshot (helps link to rosters when surfaced elsewhere)
  * `cl` - clan name snapshot
  * `av` - avatar ID snapshot
  * `tr` - trophies snapshot
  * `role` - clan role snapshot
  * `payload` - optional JSON blob for system events
  * `clientCreatedAt` - optional ISO8601 from the client
  * `op` - `opId` from the callable payload (used to reconcile optimistic placeholders)
  * `ts` - RTDB server timestamp (indexed so clients can `startAt()` for zero-history listeners)
* `/chat_messages/global/{roomId}/{messageId}` mirrors the same payload for global rooms; `cid` is populated when the sender currently belongs to a clan so the client can jump to clan cards.
* `/presence/online/{uid}` stores `{ roomId, clanId, lastSeen }`. Clients must set it before attaching listeners and register `onDisconnect().remove()` so the entry disappears on crash/app close. RTDB rules only allow `/chat_messages/clans/*` or `/chat_messages/global/*` reads when this node matches the requested stream.
* `/presence/lastSeen/{uid}` can be touched periodically by the client; the scheduled `presence.mirrorLastSeen` function copies the freshest values into `/Players/{uid}/Social/Profile.lastActiveAt` for HUD surfaces.

Global chat rooms themselves live in Firestore `/Rooms/{roomId}` (see earlier section). Clients never listen to those documents directly; they call `assignGlobalChatRoom`, cache the returned room id, and hydrate messages from RTDB.
---

## Core Collections

### `/GameData` (Master Data)

Contains all master game data, versioned for easy updates. This data is considered public and is readable by all clients. All collections under `/GameData/v1` follow a singleton document pattern, where each document is a "catalog" containing all data for a specific domain (e.g., cars, spells).

*   **Rationale for Consolidation:** Storing game data in singleton catalog documents is highly efficient for read costs. Clients can fetch all definitions for cars, spells, or items in a single read operation upon application boot, rather than performing N reads for N items. This significantly improves startup performance and reduces Firebase costs. The map-based structure (keyed by ID) allows for O(1) lookups on the client.
*   **Guardrails & Best Practices:**
    *   **Size Limit:** Each catalog document should be kept under a soft limit of **750 KB** to ensure fast loads.
    *   **Sharding:** If a catalog approaches 1 MiB, consider sharding it into multiple documents (e.g., `CarsCatalog_A-M`, `CarsCatalog_N-Z`).
    *   **Localization (i18n):** Keep `i18n` blocks minimal (e.g., only `en`). For extensive localization, move strings to a dedicated `/GameData/v1/Strings/{lang}` collection to keep the primary catalogs lean.

#### `/GameData/v1/config/CarTuningConfig` (Singleton)

Defines how display slider values map to real physics stats for cars. Holds separate ranges for players and bots.

*   **Document ID:** `CarTuningConfig`
*   **Value Scale:** Continuous 1.00 â†' 16.00 (step 0.25), stored as a number.
*   **Mapping:** `real = min + ((value - 1) / (16 - 1)) * (max - min)`, clamped to `[min, max]`.

Example: `/GameData/v1/config/CarTuningConfig`
```json
{
  "valueScale": { "min": 1, "max": 16, "step": 0.25 },
  "player": {
    "topSpeed":     { "min": 150, "max": 350 },
    "acceleration": { "min": 5,   "max": 10  },
    "handling":     { "min": 30,  "max": 45  },
    "boostRegen":   { "min": 10,  "max": 4   },
    "boostPower":   { "min": 10,  "max": 25  }
  },
  "bot": {
    "topSpeed":     { "min": 140, "max": 340 },
    "acceleration": { "min": 4.5, "max": 9.5 },
    "handling":     { "min": 28,  "max": 44  },
    "boostRegen":   { "min": 11,  "max": 5   },
    "boostPower":   { "min": 8,   "max": 22  }
  },
  "notes": "player ranges are authoritative; bot ranges tune AI difficulty",
  "updatedAt": 0
}
```
Notes:
- Units: topSpeed km/h; acceleration m/s^2; handling deg/s or normalized index; boostRegen seconds (lower is better); boostPower unitless or km/h additive.
- UI may invert meaning while the stored real value remains physically meaningful.

#### `/GameData/v1/config/ReferralConfig.v1` (Singleton)

Authoritative settings for the referral program. This document is read by Cloud Functions when generating codes and awarding inviter/invitee rewards.

Key fields:

* `codeLength` â€“ integer between 6 and 10; determines referral code length.
* `alphabet` â€“ uppercase Crockford Base32 string (no I/L/O/U); used when generating codes.
* `maxClaimPerInvitee` â€“ positive integer, typically 1.
* `maxClaimsPerInviter` â€“ positive integer soft cap; business logic can enforce downstream.
* `inviteeRewards` â€“ array of `{ skuId, qty }` entries granted to the player who claims a code.
* `inviterRewards` â€“ array of `{ threshold, rewards: [{ skuId, qty }] }` awarded when an inviter reaches `threshold` successful claims.
* `blockSelfReferral` / `blockCircularReferral` â€“ booleans toggling extra guardrails.

All referenced `skuId` values must exist in the v3 catalogs (validated via `tools/validate_referral_config.ts`).

#### `/GameData/v1/catalogs/CarsCatalog` (Singleton)

Consolidates all car definitions, stats, and upgrade paths into a single document.

*   **Document ID:** `CarsCatalog`

ID and level rules
- Car IDs follow `car_{crockford-base32}` â€” no embedded names. Example: `car_h4ayzwf31g`.
- Levels include a base `"0"` plus 20 upgrades up to `"20"`.
- `priceCoins` for levels `1..20` is sourced from `legacy-firebase-backend/json-files/Car_Progressions.json` for the carâ€™s `displayName`.
- Updated: per-level stats are split into display slider values and computed real physics values. Legacy fields (`speed`, `accel`, `handling`, any `*Multiplier`) are deprecated and must not be used by Cloud Functions.

Per-level fields (authoritative):
- Display sliders: `topSpeed`, `acceleration`, `handling`, `boostRegen`, `boostPower` (1..16, step 0.25)
- Real stats are derived at read-time by mapping the slider value through `CarTuningConfig.player` or `.bot` ranges depending on context.
- Cost: `priceCoins` (unchanged naming for backward compatibility)

Why store both value & real:
- Value enables predictable upgrade curves and a clean UI slider model.
- Real values are computed server-side (e.g., in Cloud Functions) using the slider values and the tuning ranges to guarantee deterministic physics and economy effects.

#### `/GameData/v1/config/BotConfig` (Singleton)

Configuration for AI bot generation and difficulty.

Example: `/GameData/v1/config/BotConfig`
```json
{
  "difficulty": {
    "referenceTrophies": 7500,
    "clampToBounds": true,
    "maxSpeed": { "min": 60, "max": 120 },
    "accel":    { "min": 5,  "max": 10 },
    "boostTime":{ "min": 0.8,"max": 3.0 },
    "boostFreq":{ "min": 2,  "max": 10 },
    "boostCd":  { "min": 6,  "max": 1.5 }
  },
  "carUnlockThresholds": [
    { "carId": "car_1", "trophies": 0 },
    { "carId": "car_2", "trophies": 1400 }
  ],
  "cosmeticRarityWeights": {
    "0-999": { "common": 85, "rare": 14, "epic": 1, "legendary": 0 }
  },
  "spellLevelBands": [
    { "minTrophies": 0, "maxTrophies": 999, "minLevel": 1, "maxLevel": 2 },
    { "minTrophies": 1000, "maxTrophies": 2499, "minLevel": 2, "maxLevel": 3 },
    { "minTrophies": 2500, "maxTrophies": 4999, "minLevel": 4, "maxLevel": 5 },
    { "minTrophies": 5000, "maxTrophies": 99999, "minLevel": 5, "maxLevel": 5 }
  ],
  "updatedAt": 0
}
```

#### `/GameData/v1/config/BotNames` (Singleton)

Lightweight pool of bot handles used by `prepareRace`. Seeded from `BotNamesConfig.json`.

*   **Document ID:** `BotNames`
*   **Fields:**
    * `names` *(array<string>)* — deduplicated list of bot usernames (1–32 chars, ASCII, stored lowercase/pascal as provided).
    * `updatedAt` *(number | timestamp? optional)* — maintained by the seeder for auditing.

Clients never read this doc directly; the callable fetches it via `getBotNamesConfig()` and caches the array for 60 s. Empty/malformed entries are removed when loaded so the generation loop always operates on trimmed strings.

**Example: `/GameData/v1/catalogs/CarsCatalog`**
```jsonc
{
  "cars": {
    "car_h4ayzwf31g": {
      "carId": "car_h4ayzwf31g",
      "displayName": "Mitsabi Eon",
      "class": "starter",
      "basePrice": 0,
      "unlock": { "type": "starter" },
      "levels": {
        "0": {
          "priceCoins": 0,
          "topSpeed": 8.0,
          "acceleration": 8.0,
          "handling": 8.0,
          "boostRegen": 8.0,
          "boostPower": 8.0
        },
        "1": {
          "priceCoins": 100,
          "topSpeed": 8.25,
          "acceleration": 8.25,
          "handling": 8.0,
          "boostRegen": 8.0,
          "boostPower": 8.0
        }
        // â€¦ up to "20"
      },
      "growthModel": { "price": "linear", "stat": "topSpeed", "configKey": "starter" },
      "i18n": { "en": "Mitsabi Eon" },
      "version": "v2025.10.24"
    }
  },
  "updatedAt": 1762566860531
}
```

#### Other Catalogs

The following catalogs follow the same singleton structure as `CarsCatalog`, containing a map of items keyed by their ID.

*   `/GameData/v1/catalogs/SpellsCatalog` â€” Spell IDs follow `spell_{crockford-base32}` (no embedded names).
*   `/GameData/v1/catalogs/ItemsCatalog` â€” Item master records (display name, rarity, stackability, sub-type). Each item exposes its collectible variants through a `variants[]` array where every entry carries a unique `skuId`.
*   `/GameData/v1/catalogs/ItemSkusCatalog` â€” Legacy mirror of SKU metadata. New work relies on the `variants[]` embedded in `ItemsCatalog`; this document is retained for back-compat tooling.
*   `/GameData/v1/catalogs/CratesCatalog`
*   `/GameData/v1/catalogs/OffersCatalog`

#### `/GameData/v1/catalogs/ItemSkusCatalog` (Singleton)

Stores every grantable SKU keyed by `skuId`. SKU entries carry the display metadata used by clients as well as categorisation that backend flows rely on when updating inventory summaries.

* **Document ID:** `ItemSkusCatalog`
* **Structure:**
  * `version` â€” semantic or date-based string used by seed tooling.
  * `defaults` â€” map of well-known SKU IDs (e.g., `starterCrateSkuId`, `starterKeySkuId`, `welcomeBundleSkuId`). Cloud Functions read from this block instead of hard-coding strings.
  * `skus` â€” record keyed by `skuId` where each entry describes a purchasable or grantable SKU.
    * `itemId` â€” canonical item identifier from `ItemsCatalog` (when applicable).
    * `displayName` â€” localized display string (English stored inline; additional locales live in `/GameData/v1/Strings`).
    * `category` â€” high-level grouping (`crate`, `key`, `booster`, `cosmetic`, `currency`, etc.). Inventory summaries mirror these keys.
    * `subType` *(optional)* â€” finer classification (e.g., boosters use `coin` or `xp`; cosmetics use slot names).
    * `rarity` â€” `common`, `rare`, `epic`, `legendary`, etc.
    * `stackable` â€” boolean; crates/keys/boosters default to `true`, one-off cosmetics default to `false`.
    * `purchasable` *(optional)* â€” canonical pricing object `{ "currency": "gems" | "coins", "amount": number }`. The unified shop reads this block; legacy code derives `price` maps from it.
    * `durationSeconds` *(optional)* â€” length of time for booster effects.
    * `variant`, `tags`, `metadata` *(optional)* â€” free-form helpers for UI and tooling.

> **Legacy price compatibility:** Older call sites still expect a `{ gems, coins }` map under `price`. The runtime converter in `core/config.ts` derives that map automatically from `purchasable`. Seeds should only author the `purchasable` object going forward.

**Example:**
```jsonc
{
  "version": "v1",
  "defaults": {
    "starterCrateSkuId": "sku_2xw1r4bah7",
    "starterKeySkuId": "sku_rjwe5tdtc4"
  },
  "skus": {
    "sku_2xw1r4bah7": {
      "itemId": "item_crate_common_starter",
      "category": "crate",
      "rarity": "common",
      "stackable": true,
      "purchasable": { "currency": "gems", "amount": 50 },
      "displayName": "Common Starter Crate"
    },
    "sku_rjwe5tdtc4": {
      "itemId": "item_key_common",
      "category": "key",
      "rarity": "common",
      "stackable": true,
      "purchasable": { "currency": "gems", "amount": 50 },
      "displayName": "Common Key"
    },
    "sku_tpt3379j8p": {
      "itemId": "item_booster_coin_daily",
      "category": "booster",
      "subType": "coin",
      "durationSeconds": 86400,
      "rarity": "special",
      "stackable": true,
      "purchasable": { "currency": "gems", "amount": 960 },
      "displayName": "Coin Booster (1 Day)"
    }
  }
}
```

> **Note:** Boosters are represented as standard SKUs with `category: "booster"` (and `subType` + `durationSeconds`) so that the unified shop callable can price every purchasable item from a single catalog. The legacy `/GameData/v1/catalogs/BoostersCatalog` document is superseded by this structure.

#### `/GameData/v1/catalogs/CratesCatalog` (Singleton)

Defines crate loot tables. Each record describes which SKU is granted when the crate is in inventory, which key SKU unlocks it, and the weighted pools used when rolling rewards.

* **Document ID:** `CratesCatalog`
* **Structure:**
  * `version` â€” semantic/date string for change tracking.
  * `defaults` â€” optional crate references (`starterCrateId`, `starterCrateSkuId`, `starterKeySkuId`, etc.) consumed by Cloud Functions in lieu of hard-coded strings.
  * `crates` â€” record keyed by `crateId` with:
    * `crateSkuId` â€” inventory SKU for the unopened crate (authoritative).
    * `keySkuId` â€” SKU consumed when the crate is opened.
    * `rarityWeights` â€” `{ [rarity]: weight }` map that drives loot rarity selection (weights may be fractional).
    * `poolsByRarity` â€” `{ [rarity]: [skuId, ...] }` map of reward SKUs available at each rarity tier.
    * `displayName`, `rarity`, `tags`, `metadata` *(optional)* â€” presentation helpers.

**Example (excerpt):**
```jsonc
{
  "version": "v4-unified",
  "defaults": {
    "starterCrateId": "crt_ayvncyt0",
    "starterCrateSkuId": "sku_zz3twgp0wx",
    "starterKeySkuId": "sku_rjwe5tdtc4"
  },
  "crates": {
    "crt_ayvncyt0": {
      "crateSkuId": "sku_zz3twgp0wx",
      "keySkuId": "sku_rjwe5tdtc4",
      "displayName": "Common Crate",
      "rarity": "common",
      "rarityWeights": {
        "common": 80,
        "rare": 15,
        "exotic": 4,
        "legendary": 0.9,
        "mythical": 0.1
      },
      "poolsByRarity": {
        "common": [
          "sku_0qm2sx36",
          "sku_0ych5eww",
          "sku_0yqtcmwc",
          "sku_267afz7c",
          "sku_381epphy"
          // â€¦ 63 additional SKUs (68 total)
        ],
        "rare": [
          "sku_000809gq",
          "sku_06wm8e79",
          "sku_0bysr2mb",
          "sku_0s49vjyp",
          "sku_1rms3ck4"
          // â€¦ 65 additional SKUs (70 total)
        ],
        "exotic": [
          "sku_0afa8651",
          "sku_0bffczz3",
          "sku_0fv7y19a",
          "sku_0mq3fa08",
          "sku_127h9wjp"
          // â€¦ 85 additional SKUs (90 total)
        ],
        "legendary": [
          "sku_000t1a9z",
          "sku_00sbym3s",
          "sku_01c9e0jk",
          "sku_01z9rj4n",
          "sku_029nt7zk"
          // â€¦ 81 additional SKUs (86 total)
        ],
        "mythical": [
          "sku_0gzfm1j3",
          "sku_0vrp765j",
          "sku_1ezhssps",
          "sku_1p8g9csw",
          "sku_2nq7we3x"
          // â€¦ 53 additional SKUs (58 total)
        ]
      }
    }
  }
}
```

#### `/GameData/v1/catalogs/GemPacksCatalog` (Singleton)

Defines the real-money Gem packs that the IAP system recognizes. Each entry is keyed by an `iap_{crockford}` identifier (Crockford Base32, lowercase) so store receipts can be mapped deterministically.

* **Document ID:** `GemPacksCatalog`
* **Structure:**
  * `packs` — record keyed by `iapId`.
    * `iapId` — e.g., `iap_h72k9z3m`.
    * `displayName` — UI label ("Sack of Gems").
    * `gemAmount` — integer amount that will be granted.
    * `priceUsd` — numeric price for reference/analytics.
    * `bonusLabel` — optional badge such as `"+10%"`.
* `productId` — store-facing identifier (`com.tecventures.mysticmotors.gems.sack`).
    * `sortOrder` — integer indicating the UI ordering (lowest pack = 1, highest = 7).

**Example:**
```jsonc
{
  "version": "iap.v1",
  "packs": {
    "iap_h72k9z3m": {
      "iapId": "iap_h72k9z3m",
      "displayName": "Sack of Gems",
      "gemAmount": 100,
      "priceUsd": 0.99,
      "bonusLabel": null,
      "productId": "com.tecventures.mysticmotors.gems.sack",
      "sortOrder": 1
    },
    "iap_q4n5w8v2": {
      "iapId": "iap_q4n5w8v2",
      "displayName": "Bag of Gems",
      "gemAmount": 550,
      "priceUsd": 4.99,
      "bonusLabel": "+10%",
      "productId": "com.tecventures.mysticmotors.gems.bag",
      "sortOrder": 2
    }
  }
}
```

> **Note:** All live crates must supply `rarityWeights` and `poolsByRarity`. Legacy `{ loot, costs }` fields are ignored in the unified schema.

#### `/GameData/v1/catalogs/RanksCatalog` (Singleton)

Consolidates rank definitions. Unlike other catalogs, this is stored as an array, as ranks are ordered.

*   **Document ID:** `RanksCatalog`

Content rules
- Ranks are ordered and keyed as an array.
- Trophy thresholds follow 250â€‘point steps from 0 up to 7000 (per current UI), mapping tiers Bronze â†' Silver â†' Gold â†' Platinum â†' Diamond â†' Master â†' Champion â†' Ascendant â†' Hypersonic.
- Reward objects may include `gems` (numeric) and an `inventory` array of `{ "skuId": string, "quantity": number }` entries that reference `ItemSkusCatalog`.

**Example: `/GameData/v1/catalogs/RanksCatalog`**
```jsonc
// /GameData/v1/catalogs/RanksCatalog
{
  "ranks": [
    {
      "rankId": "rank_bronze_1",
      "displayName": "Bronze I",
      "minMmr": 250,
      "rewards": {
        "gems": 100,
        "inventory": [{ "skuId": "sku_rjwe5tdtc4", "quantity": 1 }]
      }
    },
    {
      "rankId": "rank_bronze_2",
      "displayName": "Bronze II",
      "minMmr": 500,
      "rewards": {
        "inventory": [{ "skuId": "sku_zz3twgp0wx", "quantity": 1 }]
      }
    }
  ],
  "updatedAt": 0
}
```

#### `/GameData/v1/catalogs/XpCurve` (DEPRECATED)

**Note:** XP progression is now calculated via runtime formula in `src/shared/xp.ts` using the "Infinite Leveling Power Curve" algorithm: $C(L) = K \cdot ((L - 1 + s)^p - s^p)$ with parameters $K=50.0$, $p=1.7$, $s=1.0$. No Firestore catalog lookup is required.

This catalog entry is **no longer used** and may be removed in future schema versions.


### `/Players/{uid}` (Player Data)

Contains all data specific to a single player, identified by their Firebase Auth `uid`.

**Identity fields on `/Players/{uid}` (root doc):**
* `email` (string|null) — canonical email for the account, if any.
* `authProviders` (string[]) — linked providers (e.g., `anonymous`, `password`, `google`, `apple`).
* `isGuest` (boolean) — true if the account has not been upgraded.
* `emailVerification.lastSentAt` (timestamp|null) — last time a verification email was sent by the backend (for UI display; source of truth for verification is the Auth `emailVerified` flag).
* `passwordReset.lastSentAt` (timestamp|null) — last time a password reset email was sent by the backend.

#### `/Players/{uid}/Profile/Profile` (Singleton)

A consolidated document containing all UI-facing fields for the player's profile and HUD.

*   **Rationale:** Provides a single, efficient listener target for the main menu HUD, top bar, and other persistent UI elements.
*   **Document ID:** `Profile`

**Example: `/Players/{uid}/Profile/Profile`**
```json
{
  "displayName": "Racer",
  "avatarId": 3,
  "exp": 1200,
  "level": 7,
  "trophies": 1320,
  "highestTrophies": 1500,
  "careerCoins": 250000,
  "totalWins": 42,
  "totalRaces": 123,
  "dailyStreak": 4,
  "dailyCooldownUntil": 1739980000000,
  "referralCode": "AB12CD34",
  "referredBy": null,
  "referralStats": {
    "sent": 0,
    "receivedCredit": false,
    "rewards": {
      "sentCount": 0,
      "receivedCount": 0
    }
  },
  "boosters": {
    "coin": { "activeUntil": 1739948400000, "stackedCount": 1 },
    "exp": { "activeUntil": 0, "stackedCount": 0 }
  },
  "updatedAt": 1739942400000
}
```

Booster timers are surfaced through this document via the `boosters` map. Each entry is keyed by booster `subType` (for example `coin` or `exp`) and includes `activeUntil` (epoch milliseconds) and `stackedCount`, allowing the HUD to reflect stacked activations without additional reads.

**Note (Dec 2025):** The `assignedChatRoomId` field has been **removed** from this document. Room assignments are now session-based only. Client manages `roomId` in session/memory storage and passes it via the `currentRoomId` parameter to `assignGlobalChatRoom`. The RTDB `/presence/online/{uid}` node is the single source of truth for which room a user is currently in.

Referral metadata lives alongside other HUD fields:

* `referralCode` is generated exactly once per UID at bootstrap and never changes.
* `referredBy` captures the immutable inviter code the player redeemed (null if never claimed).
* `referralStats` tracks totals for successful invites (`sent`), whether the invitee reward was granted, and how many rewards have been issued (`rewards.sentCount` / `rewards.receivedCount`). These counters are server-maintained and surfaced read-only to clients.

#### `/Players/{uid}/Economy/Stats` (Singleton)

Stores the player's private, server-managed currency balances.

*   **Rationale:** Isolates sensitive economic data. This document is **not** directly readable or writable by clients; all modifications are performed by Cloud Functions. `level` and `trophies` were moved to `Profile/Profile` for HUD efficiency.
*   **Document ID:** `Stats`

**Example: `/Players/{uid}/Economy/Stats`**
```json
{
  "coins": 1000,
  "gems": 25,
  "spellTokens": 11,
  "createdAt": 1739856000000,
  "updatedAt": 1739942400000
}
```

#### `/Players/{uid}/Spells/Levels` (Singleton)

Consolidates all of a player's spell levels and unlock timestamps into one document.

*   **Rationale:** The deck screen and upgrade UIs need all spell levels at once. This consolidation reduces reads from N (one per spell) to 1.
*   **Document ID:** `Levels`

**Example: `/Players/{uid}/Spells/Levels`**
```json
{
  "levels": {
    "spell_q4jj8d9kq4": 2,
    "spell_6g70t7d7zd": 1,
    "spell_ex5vyryddz": 1,
    "spell_zeeft14rj5": 1,
    "spell_hdtzmnnjnh": 1
  },
  "unlockedAt": {
    "spell_q4jj8d9kq4": 1739856000000
  },
  "updatedAt": 1739942400000
}
```

* `levels.{spellId}` is `0` when the spell is locked; the `upgradeSpell` callable moves it to `1` (unlock) or higher and records the same timestamp under `unlockedAt.{spellId}` when performing the initial unlock.
* Spells without a persisted entry are treated as level 0 by Cloud Functions and may be unlocked provided the catalog requirements are met.

#### `/Players/{uid}/SpellDecks/Decks` (Singleton)

Consolidates all 5 of the player's spell decks and the active deck pointer.

*   **Rationale:** Allows for management of all decks in a single read/write operation, simplifying client-side logic.
*   **Document ID:** `Decks`

**Example: `/Players/{uid}/SpellDecks/Decks`**
```json
{
  "active": 1,
  "decks": {
    "1": { "name": "Primary", "spells": ["spell_q4jj8d9kq4","spell_6g70t7d7zd","spell_ex5vyryddz","spell_zeeft14rj5","spell_hdtzmnnjnh"] },
    "2": { "name": "Alt", "spells": ["spell_q4jj8d9kq4","spell_6g70t7d7zd","","",""] },
    "3": {},
    "4": {},
    "5": {}
  },
  "updatedAt": 1739942400000
}
```

#### `/Players/{uid}/Garage/Cars` (Singleton)

Consolidates all of a player's owned cars and their upgrade levels. A historical `tuning` map was present but is no longer required; omit it for new writes.

*   **Rationale:** The garage UI needs to display all owned cars simultaneously. This reduces reads from N (one per car) to 1.
*   **Document ID:** `Cars`

**Example: `/Players/{uid}/Garage/Cars`**
```json
{
  "cars": {
    "car_h4ayzwf31g": { "upgradeLevel": 0 },
    "car_9q7m2k4d1t": { "upgradeLevel": 3 }
  },
  "updatedAt": 1739942400000
}
```

#### `/Players/{uid}/Loadouts/Active` (Singleton)

A consolidated document for the player's active loadout, including car, spell deck, and cosmetics.

*   **Rationale:** Provides a single source of truth for the HUD and race pre-flight screens, ensuring consistency with a single read.
*   **Document ID:** `Active`

**Example: `/Players/{uid}/Loadouts/Active`**
```json
{
  "carId": "car_h4ayzwf31g",
  "activeSpellDeck": 1,
  "cosmetics": {
    "wheelsSkuId": "sku_x",
    "decalSkuId": "sku_y",
    "spoilerSkuId": "sku_z",
    "underglowSkuId": null,
    "boostSkuId": "sku_b"
  },
  "updatedAt": 1739942400000
}
```

#### `/Players/{uid}/Inventory` (SKU-first)

The v3 inventory model treats each SKU as the unit of record. All consumables, cosmetics, crates, keys, and boosters live under per-SKU documents, while `_summary` keeps lightweight roll-ups for HUD counters.

* **`{skuId}` (per-SKU ledger):**
  * `skuId` â€” canonical identifier, always `sku_{crockford}`.
  * `quantity` / `qty` â€” the authoritative stack count.
  * `createdAt` / `updatedAt` â€” server timestamps managed by Cloud Functions.
  * Optional metadata such as the first grant `receiptId` can be stored alongside the counts when needed.

  **Example: `/Players/{uid}/Inventory/sku_zz3twgp0wx`**
  ```json
  {
    "skuId": "sku_zz3twgp0wx",
    "quantity": 2,
    "qty": 2,
    "createdAt": 1739856000000,
    "updatedAt": 1739942400000
  }
  ```

* **`_summary` (singleton):** Pre-computed totals keyed by catalog metadata. Powers the HUD counters without scanning every SKU and lets the client show rarity/category subtotals instantly.

**Example: `/Players/{uid}/Inventory/_summary`**
```json
{
  "totalsByCategory": { "crate": 3, "key": 2, "cosmetic": 5, "booster": 1 },
  "totalsByRarity": { "common": 7, "rare": 3, "special": 1 },
  "totalsBySubType": { "wheels": 4, "coin": 1 },
  "updatedAt": 1739942400000
}
```

Inventory summary keys mirror the `category`, `rarity`, and `subType` metadata defined for each SKU. Grant/consume flows (`initializeUser`, `claimStarterOffer`, `openCrate`, `purchaseOffer`, etc.) mutate the relevant per-SKU documents and call `updateInventorySummary` to keep `_summary` in sync inside the same transaction using the cached catalog loaders, so no additional Firestore reads are required. Each operation records an idempotency receipt under `/Players/{uid}/Receipts/{opId}` so retries can safely return the prior result.

> **Why split between per-SKU docs and `_summary`?**  
> * Individual SKU documents provide a single source of truth that lines up with receipts and catalog metadata.  
> * `_summary` lets the client display totals instantly without scanning every entry.  
> * Legacy aggregate `Items` / `Cosmetics` documents have been retired; new features must interact exclusively with the per-SKU documents.

#### `/Players/{uid}/Offers/Active` (Singleton)

Stores all offer slots currently visible to the player. The document is created lazily by `getDailyOffers` and mutated by the purchase, XP, and flash-sale flows.

* `starter` *(optional)* — starter offer slot.
  * `offerId` — catalog identifier (e.g., `offer_3jaky2p2`).
  * `expiresAt` — epoch milliseconds when the starter slot disappears.
* `daily` — state for the ladder-driven daily slot.
  * `offerId` — catalog ID or `null` if Tier 0 RNG rolled “no offer”.
  * `tier` — `0` (base RNG pool) through `4` (Treasure tier). Tiers ≥ 1 map directly to the fixed IDs listed in `OfferLadderIndex`.
  * `expiresAt` — epoch ms; once `Date.now() >= expiresAt`, `getDailyOffers` regenerates the ladder state.
  * `isPurchased` — set to `true` by `purchaseOffer` when the current daily offer is bought so the next regen steps up instead of down.
  * `generatedAt` — epoch ms when this daily entry was produced. Prevents duplicate generation within the same 24‑hour window.
* `special` — array of ad‑hoc limited-time slots.
  * Each element includes `offerId`, `triggerType` (`"level_up" | "flash_missing_key" | "flash_missing_crate"`), and `expiresAt` epoch ms.
  * Flash sales (15 min) and level-up offers (24 h) are both stored here; expired entries are pruned before new ones are pushed.
* `updatedAt` — epoch ms mirroring the last mutation (useful for cache-busting on the client).

**Example:**
```jsonc
{
  "starter": { "offerId": "offer_3jaky2p2", "expiresAt": 1762051200000 },
  "daily": {
    "offerId": "offer_bwebp6s4",
    "tier": 1,
    "expiresAt": 1762137600000,
    "isPurchased": false,
    "generatedAt": 1762051200000
  },
  "special": [
    { "offerId": "offer_3vv3me0e", "triggerType": "level_up", "expiresAt": 1762137600000 },
    { "offerId": "offer_zqcpwsbz", "triggerType": "flash_missing_key", "expiresAt": 1762052100000 }
  ],
  "updatedAt": 1762051200000
}
```

#### `/Players/{uid}/Offers/History` (Singleton)

Cooldown metadata that throttles how frequently flash sales can reappear and (optionally) keeps Tier 0 RNG from repeating the same offer ID.

* `lastTriggerAt` — map of `triggerType → epochMillis`. `maybeTriggerFlashSales` reads/updates it to enforce the 72‑hour cooldown for `"flash_missing_key"` and `"flash_missing_crate"`.
* `lastDailyOfferId` *(optional)* — when populated, the ladder RNG can skip rolling the same Tier 0 ID twice consecutively.
* `updatedAt` — server timestamp written whenever the helper touches the document.

**Example:**
```jsonc
{
  "lastTriggerAt": {
    "flash_missing_key": 1762047600000,
    "flash_missing_crate": 0
  },
  "lastDailyOfferId": "offer_kn1k91mn",
  "updatedAt": 1762047601000
}
```

#### `/Players/{uid}/Boosters/Active`

Singleton document tracking the playerâ€™s active time-based boosters. Coin and XP timers are stored independently so both effects can run in parallel.

* **Document ID:** `Active`
* **Location:** `/Players/{uid}/Boosters/Active`
* **Fields:**
  * `coin`, `xp` â€“ objects with:
    * `activeUntil` (epoch ms) â€“ when the booster expires; â‰¤ `Date.now()` means inactive.
    * `lastActivatedAt` (epoch ms) â€“ when the booster was most recently extended.
    * `totalSecondsAccumulated` (number) â€“ lifetime seconds awarded for audit/UX.
  * `updatedAt` (epoch ms) â€“ last time either booster slot changed.

**Example:**
```json
{
  "coin": {
    "activeUntil": 1740002400000,
    "lastActivatedAt": 1739916000000,
    "totalSecondsAccumulated": 86400
  },
  "xp": {
    "activeUntil": 0,
    "lastActivatedAt": 0,
    "totalSecondsAccumulated": 0
  },
  "updatedAt": 1739916000000
}
```

> Cloud Functions mutate this document during booster activation; clients never write timers directly. Storing timers in their own singleton keeps HUD reads cheap and avoids churning the broader profile/economy documents.

#### `/Players/{uid}/Receipts/{opId}` (Idempotency Ledger)

Records the outcome of idempotent operations initiated by the client. Each document is keyed by the supplied `opId` and stores metadata about the call.

*   **Document ID:** `{opId}`

**Example: `/Players/{uid}/Receipts/op_claim_starter`**
```json
{
  "status": "completed",
  "function": "claimStarterOffer",
  "result": { "grants": [{ "skuId": "sku_crate_common_starter", "quantity": 1 }] },
  "createdAt": 1739942300000,
  "completedAt": 1739942301000
}
```

#### `/Players/{uid}/Referrals/Progress` (Singleton)

Compact progress document tracking how many successful referrals the player has driven and which inviter thresholds have already been rewarded.

* **Document ID:** `Progress`
* **Fields:**
  * `sentTotal` (number) â€“ count of successful invitees tied to this player's code.
  * `awardedThresholds` (number[]) â€“ sorted list of inviter thresholds already paid; used to prevent double-awards.
  * `lastUpdatedAt` (timestamp) â€“ server timestamp written with the most recent mutation.

The document is mutated exclusively by Cloud Functions during referral claims. Clients read it to show inviter progress (e.g., â€œ3/5 invites completeâ€).

#### `/Players/{uid}/Referrals/Events/{eventId}` (Sub-Collection)

Append-only event log for auditability and analytics. Each event captures the action (`claim`, `reward-sent`, `reward-received`), tying together both parties for dispute resolution.

* **Document ID:** `{eventId}` â€” UUID or ULID generated server-side.

#### `/Players/{uid}/Social/Profile` (Singleton)

Extends the player's public card with social metadata that powers the Friends/Requests/Profile screens.

* **Document ID:** `Profile`
* **Fields**
  * `friendsCount` *(number)* â€” authoritative counter incremented/decremented alongside `/Social/Friends`.
  * `hasFriendRequests` *(boolean)* â€” badge boolean that the UI can poll in a single read.
  * `referralCode` *(string|null)* â€” immutable referral code mirror so social/profile views do not need to read the root profile.
  * `lastActiveAt` *(number|null)* â€” ms epoch copied from RTDB presence by the scheduled mirror job.
  * `updatedAt` *(timestamp)* â€” server timestamp written by every social mutation.

```json
{
  "friendsCount": 12,
  "hasFriendRequests": true,
  "referralCode": "AB12CD34",
  "lastActiveAt": 1731529200000,
  "updatedAt": { ".sv": "timestamp" }
}
```

#### `/Players/{uid}/Social/Friends` (Singleton Map)

Compact map keyed by friend `uid`. Each entry carries the `since` timestamp, optional `lastInteractedAt`, and a cached `player` summary (displayName, avatarId, level, trophies, clan). Clan snapshots now always include the clan `badge` so the UI can render the correct emblem without extra reads. Backend functions refresh the `player` snapshot whenever a profile changes, so `getFriends` can render the list with a single read (it only rehydrates missing entries). If the map approaches the 128 KB soft limit, shard deterministically (e.g., `/Social/FriendsA-M`, `/Social/FriendsN-Z`).

```json
{
  "friends": {
    "friendUid": {
      "since": 1731529200000,
      "lastInteractedAt": 1733600000000,
      "player": {
        "uid": "friendUid",
        "displayName": "NIGHTFOX",
        "avatarId": 4,
        "level": 19,
        "trophies": 3120,
        "clan": { "clanId": "clan_123", "name": "Night Riders", "badge": "badge_cobra" }
      }
    }
  },
  "updatedAt": { ".sv": "timestamp" }
}
```

#### `/Players/{uid}/Social/Requests` (Singleton)

Holds outstanding friend requests in two bounded arrays. Incoming entries embed a `player` summary so the target can render the sender immediately; outgoing entries include the caller’s summary for parity. Mutations occur alongside `/Social/Profile` updates, and the backend refreshes these snapshots whenever a profile changes, so `getFriendRequests` usually reads a single document (rehydrates only if a snapshot is missing). Player summaries carry the full clan chip, including `badge`, to keep UI displays consistent. Arrays remain bounded (≈100 entries) to avoid oversized docs.

```json
{
  "incoming": [
    {
      "requestId": "01H...",
      "fromUid": "friendUid",
      "sentAt": 1731529200000,
      "message": "GG",
      "player": {
        "uid": "friendUid",
        "displayName": "NIGHTFOX",
        "avatarId": 4,
        "level": 19,
        "trophies": 3120,
        "clan": { "clanId": "clan_123", "name": "Night Riders", "badge": "badge_cobra" }
      }
    }
  ],
  "outgoing": [
    {
      "requestId": "01H...",
      "toUid": "friendUid",
      "sentAt": 1731529200000,
      "message": "GG"
    }
  ],
  "updatedAt": { ".sv": "timestamp" }
}
```

Arrays are truncated server-side (â‰¤100 entries) to avoid oversized docs; pagination for UI views happens via callable reads.

#### `/Players/{uid}/Social/Blocks` (Singleton)

Optional sparse map `{ [blockedUid]: true }` used to prevent unsolicited requests or spam. Missing documents are treated as empty maps by the Cloud Functions. Writes remain server-only per the social guardrails.
* **Fields:**
  * `type` â€“ one of `claim`, `reward-sent`, `reward-received`.
  * `opId` â€“ idempotent operation ID associated with the event.
  * `referralCode` â€“ code involved in the action (inviter's code for rewards, code used by invitee for claims).
  * `otherUid` â€“ optional, Firebase UID of the counterpart player.
  * `awarded` â€“ optional array of `{ skuId, qty }` describing granted rewards.
  * `createdAt` â€“ millisecond timestamp written by the server.
  * `deviceHash` / `ipHash` â€“ optional salted hashes recorded for anti-abuse analytics.

Events are emitted for both parties during a claim: the invitee records `claim` + `reward-received`, while the inviter records `reward-sent` whenever a threshold reward is paid.

### Account Management Collections

These collections are managed exclusively by Cloud Functions for account linking and uniqueness guarantees. They are not client-readable.

#### `/AccountsEmails/{normalizedEmail}`

Ensures email address uniqueness.

*   **Document ID:** `normalizedEmail`

**Example: `/AccountsEmails/racer@example.com`**
```json
{
  "uid": "someFirebaseUid",
  "createdAt": 1739856000000
}
```

#### `/AccountsProviders/{uid}`

Tracks linked authentication providers for a given user.

*   **Document ID:** `uid`

**Example: `/AccountsProviders/someFirebaseUid`**
```json
{
  "providers": ["anonymous", "password", "google"],
  "lastLinkedAt": 1739942400000,
  "details": {
    "password": { "email": "racer@example.com" },
    "google": { "email": "racer@example.com" },
    "apple": { "sub": "apple-subject", "email": "racer@example.com" }
  }
}
```

#### `/AccountsDeviceAnchors/{anchorId}`

Maps opaque device anchor tokens to the owning `uid` for guest recovery flows. Anchors are authoritative only for guest accounts. If an anchor points to a full (non-guest) account, it is treated as vacant and will be reassigned to a guest on the next `ensureGuestSession` call. Full accounts retain non-authoritative references to seen anchors in `Players/{uid}.knownDeviceAnchors`.

*   **Document ID:** `anchorId`

**Example: `/AccountsDeviceAnchors/a3b4c5d6e7f809112233445566778899`**
```json
{
  "uid": "someFirebaseUid",
  "platform": "ios",
  "appVersion": "1.0.0",
  "createdAt": 1739942400000,
  "lastSeenAt": 1739943400000
}
```

---

## Removed Legacy Collections

*   **`mapData` / Star Systems:** All collections and fields related to `mapData` and star-based progression have been **REMOVED** from the player data structure.

---

## Client Read & Listener Strategy

### Boot Sequence

1.  **Read Once (Cache Forever):**
    *   `/GameConfig/active`
    *   `/GameData/v1/CarsCatalog`
    *   `/GameData/v1/SpellsCatalog`
    *   `/GameData/v1/ItemsCatalog`
    *   (and other catalogs as needed)
2.  **Attach Persistent Listeners:**
    *   `/Players/{uid}/Profile/Profile` (for HUD)
    *   `/Players/{uid}/Loadouts/Active` (for active car/cosmetics)

### On-Demand Reads & Listeners

*   **Garage:** Read `/Players/{uid}/Garage/Cars` once when the garage screen is opened.
*   **Deck Management:** Attach a listener to `/Players/{uid}/SpellDecks/Decks` while the deck UI is open.
*   **Race Pre-flight:** Read `/Players/{uid}/SpellDecks/Decks` and `/Players/{uid}/Spells/Levels` once during race setup.

---

## Security & Cloud Function Notes

*   **/GameData/\*\***: Public read, server-write only.
*   **/Players/{uid}/\*\***:
    *   A user can read their own documents (`allow read: if request.auth.uid == uid;`).
    *   Client writes to economy and progression paths (e.g., `Economy/Stats`, `Profile/Profile.trophies`) are **denied**.
    *   All mutations are performed by Cloud Functions v2 (in `us-central1`) which perform transactional updates with `opId` for idempotency.
*   **/AccountsEmails/\*\***, **/AccountsProviders/\*\***, and **/AccountsDeviceAnchors/\*\***: Not client-writable or readable. Managed by Cloud Functions only.
*   Refer to `docs/FUNCTION_CONTRACTS.md` for detailed function specifications and `docs/INDEX.md` for a full document inventory.

---

## Migration Notes (For Developers)

*   **Move Fields:** `level`, `trophies`, `dailyStreak`, and `dailyCooldownUntil` must be moved from their legacy locations into the `/Players/{uid}/Profile/Profile` singleton.
*   **Consolidate Documents:**
    *   Legacy per-spell documents under `/Players/{uid}/Spells/{spellId}` must be consolidated into the `/Players/{uid}/Spells/Levels` singleton.
    *   Legacy per-deck documents must be consolidated into `/Players/{uid}/SpellDecks/Decks`.
    *   Legacy per-car documents must be consolidated into `/Players/{uid}/Garage/Cars`.
*   **Remove Legacy Data:** Delete any `mapData` or star-related fields/collections from player documents.
*   *Note: Migration scripts will be developed under `tools/` in separate tasks.*

---

## Validation Checklist

*   [ ] GameData is consolidated into singleton catalogs (e.g., `/GameData/v1/CarsCatalog`, `/GameData/v1/SpellsCatalog`).
*   [ ] Player spell levels are in `/Players/{uid}/Spells/Levels` (singleton).
*   [ ] All five decks consolidated in `/Players/{uid}/SpellDecks/Decks` (singleton).
*   [ ] Garage cars consolidated in `/Players/{uid}/Garage/Cars` (singleton).
*   [ ] Active loadout in `/Players/{uid}/Loadouts/Active`.

### `/Usernames/{displayNameLower}` (Username Registry & Search)

Stores the lowercase username reservation along with the owning `uid`. The `searchPlayer` callable uses range queries on this collection to power prefix searches (â‰¤2 characters) and direct lookups for longer, exact names.

* **Document ID:** `displayNameLower`
* **Fields:**
  * `uid` *(string)* â€” player identifier owning the name.
  * (additional metadata may be added later, e.g., `reservedAt`)

**Prefix search:** When the user types one or two characters, the callable executes:

```
where(docId >= prefix)
where(docId < prefix + "~")
limit(10)
```

to fetch up to 10 matching usernames, then hydrates their `/Players/{uid}/Profile/Profile` data.

**Exact search:** For longer queries, the callable reads `/Usernames/{displayNameLower}` directly and returns the single player if it exists.

> Note: A sharded `/SearchIndex` is still in the backlog for production scale, but the current development build relies solely on `/Usernames`.

### Realtime Database Presence

Realtime presence is stored outside Firestore to avoid write amplification:

* `/presence/online/{uid}` *(boolean)* â€” toggled by the client connect/disconnect hooks. Values are `true` while connected, removed (or set `false`) on disconnect.
* `/presence/lastSeen/{uid}` *(number)* â€” ms epoch maintained by the client via `onDisconnect`. This is the source of truth for â€œlast onlineâ€.

A scheduled Cloud Function (`socialPresenceMirrorLastSeen`) runs every ~10 minutes, reads `/presence/lastSeen`, and patches `/Players/{uid}/Social/Profile.lastActiveAt` for the small set of players that changed recently. This keeps Firestore as the durable store for profile views while leveraging RTDB for millisecond-accurate presence and typing indicators.
*   [ ] Profile/Profile includes HUD fields: `displayName, avatarId, exp, level, trophies, highestTrophies, careerCoins, totalWins, totalRaces, dailyStreak, dailyCooldownUntil`.
*   [ ] Economy/Stats keeps balances: `coins, gems, spellTokens` (no `level`/`trophies` here).
*   [ ] Inventory per-SKU + optional `_summary` rollup noted.
*   [ ] No `mapData` anywhere.
*   [ ] Notes on listeners and boot sequence included.
*   [ ] Security & CF notes present.

## Contracts Alignment (TODO)

*   Review `FUNCTION_CONTRACTS.md` to ensure all field names (`activeSpellDeck`, `spellTokens`, etc.) are perfectly aligned with this schema. Any discrepancies should be flagged and resolved.
