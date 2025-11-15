# Function Discovery

This document provides a high-level overview of the cloud functions available in this project, based on the detailed specifications in `FUNCTION_CONTRACTS.md`.

---

## 1. Auth & Device Anchors

These functions handle user authentication, session management, and account linking.

| Function | Purpose | Trigger |
| --- | --- | --- |
| `ensureGuestSession` | Recovers a guest or provisions a new anonymous user via a device anchor. | HTTPS `onCall` |
| `bindEmailPassword` | Upgrades the current guest to email+password credentials. | HTTPS `onCall` |
| `bindGoogle` | Links the guest account to a Google provider. | HTTPS `onCall` |
| `signupEmailPassword` | Creates a brand-new account using email+password. | HTTPS `onCall` |
| `signupGoogle` | Creates or links using a Google ID token. | HTTPS `onCall` |
| `checkEmailExists` | Lightweight existence check used by sign-up flows. | HTTPS `onCall` |
| `initUser` | Idempotent safety-net that materialises the player bootstrap docs plus starter rewards. | HTTPS `onCall` |

---

## 2. Garage

Functions related to player vehicles and customizations.

| Function | Purpose | Trigger |
| --- | --- | --- |
| `purchaseCar` | Purchases a new car SKU, charging coins/gems per catalog rules. | HTTPS `onCall` |
| `upgradeCar` | Applies the next upgrade level to an owned car. | HTTPS `onCall` |
| `purchaseCrateItem` | Buys crate/key SKUs from the garage shop wrapper. | HTTPS `onCall` |
| `grantItem` | Test/admin utility to inject a SKU directly into inventory. | HTTPS `onCall` |
| `equipCosmetic` | Equips a cosmetic SKU onto the active loadout (with idempotency). | HTTPS `onCall` |
| `openCrate` | Opens a crate, consumes keys if required, and grants loot via catalog odds. | HTTPS `onCall` |

---

## 3. Spells

Functions for managing player spells and loadouts.

| Function | Purpose | Trigger |
| --- | --- | --- |
| `upgradeSpell` | Unlocks level 0 â†' 1 or levels up an owned spell, deducting spell tokens and writing an idempotent receipt. | HTTPS `onCall` |
| `setLoadout` | Writes a custom spell deck configuration by slot. | HTTPS `onCall` |
| `equipCosmetics` | Applies spell-focused cosmetics onto the active loadout. | HTTPS `onCall` |
| `setSpellDeck` | Bulk updates a single deck's spell list. | HTTPS `onCall` |
| `selectActiveSpellDeck` | Switches the currently equipped deck. | HTTPS `onCall` |

---

## 4. Race

Functions that manage the race lifecycle, from starting a race to recording results.

| Function | Purpose | Trigger |
| --- | --- | --- |
| `prepareRace` | Deterministically assembles the player + bot roster for matchmaking. | HTTPS `onCall` |
| `startRace` | Initializes a race session and reserves entry fees. | HTTPS `onCall` |
| `generateBotLoadout` | Generates a complete loadout for an AI opponent. | HTTPS `onCall` |
| `recordRaceResult` | Settles a race, applies rewards, and grants catalog loot. | HTTPS `onCall` |

---

## 5. Clans

Functions for creating, joining, and managing clans (all HTTPS `onCall`, region `us-central1`).

**Management & Roles**

| Function | Purpose |
| --- | --- |
| `createClan` | Creates a clan and adds the caller as leader. |
| `updateClanSettings` | Updates clan presentation, type, badge, and requirements. |
| `deleteClan` | Deletes an empty clan (leader-only). |
| `joinClan` | Joins an open clan instantly. |
| `requestToJoinClan` | Creates a join request for invite-only clans. |
| `cancelJoinRequest` | Removes the callerâ€™s pending request. |
| `leaveClan` | Leaves the current clan, handling leadership succession. |
| `acceptJoinRequest` | Officers accept pending requests. |
| `declineJoinRequest` | Officers decline pending requests. |
| `promoteClanMember` | Raises a memberâ€™s rank (never to leader). |
| `demoteClanMember` | Lowers a memberâ€™s rank. |
| `transferClanLeadership` | Leader hands control to another member. |
| `kickClanMember` | Removes a member from the clan. |
| `updateMemberTrophies` | Internal helper that mirrors trophy deltas into clan stats. |

**Invites, Bookmarks, and Discovery**

| Function | Purpose |
| --- | --- |
| `inviteToClan` | Sends an invite to another player. |
| `acceptClanInvite` | Accepts a stored invite and joins the clan. |
| `declineClanInvite` | Clears a stored invite without joining. |
| `bookmarkClan` / `unbookmarkClan` | Adds/removes clan bookmarks under `/Players/{uid}/Social`. |
| `getBookmarkedClans` | Returns the callerâ€™s bookmark list with live hydration. |
| `getClanDetails` | Fetches clan summary, roster, and (for officers) pending requests. |
| `searchClans` | Searches by name/tag with trophy/capacity filters. |
| `getClanLeaderboard` | Returns top clans ordered by `stats.trophies`. |

**Chat**

| Function | Purpose |
| --- | --- |
| `sendGlobalChatMessage` | Posts to a global language room (`/Rooms/{roomId}`) with profile/clan snapshot metadata. |
| `getGlobalChatMessages` | Reads the latest (up to 25) global messages for a room. |
| `sendClanChatMessage` | Posts to the caller's clan chat (`/Clans/{clanId}/Chat`) with profile/clan snapshot metadata. |
| `getClanChatMessages` | Reads the caller's clan chat history (up to 25 messages). |

## 6. Economy

Functions related to in-game currency and purchases.

| Function | Purpose | Trigger |
| --- | --- | --- |
| `exchangeGemsForCoins` | Converts gems to coins at the server-authoritative rate. | HTTPS `onCall` |
| `purchaseShopSku` | Generic shop entry point that debits currency and grants any SKU. | HTTPS `onCall` |
| `activateBooster` | Consumes a booster SKU and updates active booster timers. | HTTPS `onCall` |
| `purchaseOffer` | Grants the SKUs defined in a catalog offer bundle. | HTTPS `onCall` |
| `claimRankUpReward` | Claims the one-time reward for reaching a new rank tier. | HTTPS `onCall` |
| `getLeaderboard` | Retrieves a paginated leaderboard (trophies, wins, etc.). | HTTPS `onCall` |

---

## 7. Player Profile & Progression

These functions manage player preferences, starter rewards, and profile metadata.

| Function | Purpose | Trigger |
| --- | --- | --- |
| `checkUsernameAvailable` | Validates that a requested username is free before reservation. | HTTPS `onCall` |
| `setUsername` | Reserves a username and updates the player's profile display name. | HTTPS `onCall` |
| `setAgeYears` | Stores the derived birth year and 13+ compliance flag. | HTTPS `onCall` |
| `getPlayerAge` | Reads the stored birth year and returns the computed age. | HTTPS `onCall` |
| `setAvatar` | Updates the avatar ID on the profile singleton. | HTTPS `onCall` |
| `setSubscriptionFlag` | Toggles social subscription flags (YouTube, Discord, etc.). | HTTPS `onCall` |
| `claimStarterOffer` | One-time grant of the starter crate/key bundle with idempotency. | HTTPS `onCall` |

---

## 8. Referrals

| Function | Purpose | Trigger |
| --- | --- | --- |
| `referralGetMyReferralCode` | Returns (or lazily provisions) the caller's immutable referral code. | HTTPS `onCall` |
| `referralClaimReferralCode` | Validates and redeems an inviter's code, awarding both inviter and invitee. | HTTPS `onCall` |
| `referralDebugLookup` | Admin-only lookup into `/ReferralCodes/{code}` for debugging/BI tooling. | HTTPS `onCall` |

Referral functions rely on `/ReferralCodes/{code}` (server-only registry), `/Players/{uid}/Referrals/Progress`, and `/Players/{uid}/Referrals/Events/{eventId}` for analytics and retries. Each mutation writes an idempotency receipt with `kind: "referral-claim"` or `"referral-reward"` and publishes a best-effort `REFERRAL_METRICS_TOPIC` event when configured.

---

## 9. Core & Game Systems

Core functions for user initialization and game maintenance.

| Function | Purpose | Trigger |
| --- | --- | --- |
| (no auth trigger) | Initialization occurs via callables (`ensureGuestSession`, `signup*`) and `initUser`. | â€” |
| `getMaintenanceStatus` | Retrieves the current maintenance status of the game. | HTTPS `onCall` |
| `claimMaintenanceReward` | Allows a player to claim a reward after a maintenance period. | HTTPS `onCall` |
| `healthcheck` | A simple health check endpoint. | HTTPS Request |

---

## 10. Catalog Readers (non-suffixed)

The functions below load master data from the canonical catalog documents under `/GameData/v1/catalogs/*`. A validator (`npm run tools:verify-loader-paths`) enforces that no `.v2`/`.v3` fallbacks remain.

| Function | Catalog documents read |
| --- | --- |
| `activateBooster` | `/GameData/v1/catalogs/ItemsCatalog`, `/GameData/v1/catalogs/ItemSkusCatalog` |
| `claimStarterOffer` | `/GameData/v1/catalogs/CratesCatalog`, `/GameData/v1/catalogs/ItemSkusCatalog`, `/GameData/v1/catalogs/SpellsCatalog` |
| `initializeUserIfNeeded` | `/GameData/v1/catalogs/ItemSkusCatalog`, `/GameData/v1/catalogs/CratesCatalog`, `/GameData/v1/catalogs/SpellsCatalog` |
| `openCrate` | `/GameData/v1/catalogs/CratesCatalog`, `/GameData/v1/catalogs/ItemsCatalog`, `/GameData/v1/catalogs/ItemSkusCatalog` |
| `prepareRace` | `/GameData/v1/catalogs/CarsCatalog`, `/GameData/v1/catalogs/ItemSkusCatalog`, `/GameData/v1/catalogs/SpellsCatalog`, `/GameData/v1/catalogs/RanksCatalog`, `/GameData/v1/catalogs/OffersCatalog`, `/GameData/v1/catalogs/CratesCatalog` |
| `purchaseOffer` | `/GameData/v1/catalogs/OffersCatalog`, `/GameData/v1/catalogs/ItemSkusCatalog` |
| `purchaseShopSku` | `/GameData/v1/catalogs/ItemSkusCatalog` |
| `purchaseCrateItem` | `/GameData/v1/catalogs/CratesCatalog`, `/GameData/v1/catalogs/ItemSkusCatalog` |
| `referralClaim` | `/GameData/v1/catalogs/ItemSkusCatalog`, `/GameData/v1/catalogs/OffersCatalog` |

---

## 11. Social & Leaderboards

| Function | Purpose | Trigger |
| --- | --- | --- |
| `getGlobalLeaderboard` | Scans every player profile, sorts by metric, and returns a paginated top list (expensive, dev-only). | HTTPS `onCall` |
| `searchPlayers` / `searchPlayer` | Uses `/Usernames/{displayNameLower}` for prefix (â‰¤2 chars) and exact searches. | HTTPS `onCall` |
| `sendFriendRequest` | Idempotently writes to both players' `/Social/Requests`, sets badges, logs receipt. | HTTPS `onCall` |
| `acceptFriendRequest` | Converts a pending request into mutual `/Social/Friends` entries and bumps counts. | HTTPS `onCall` |
| `rejectFriendRequest` | Removes an incoming request without creating a friendship. | HTTPS `onCall` |
| `cancelFriendRequest` | Lets the sender withdraw their pending outgoing request. | HTTPS `onCall` |
| `getFriendRequests` | Returns the callerâ€™s incoming requests with live player summaries. | HTTPS `onCall` |
| `getFriends` | Returns the caller's confirmed friends with live player summaries. | HTTPS `onCall` |
| `viewPlayerProfile` | Returns the public summary + stats + social metadata for any `uid`. | HTTPS `onCall` |
| `socialPresenceMirrorLastSeen` | Scheduled job mirroring RTDB `/presence/lastSeen` into `/Players/{uid}/Social/Profile`. | Cloud Scheduler |




