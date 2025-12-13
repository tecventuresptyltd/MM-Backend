# Mystic Motors Clans & Chat - Final Design

This document is the canonical reference for the Mystic Motors clan + chat backend. It captures the Firestore schema, Cloud Function responsibilities, and validation/permission rules that every client must rely on.

---

## Feature Overview

- Clash-of-Clans style clans without wars: create, search, join, leave, manage members, and update clan presentation.
- Role hierarchy: `leader`, `coLeader`, `member`, with clear promotion/demotion semantics.
- Join flows for every clan type: `anyone can join`, `invite only`, manual invitations, and bookmark lists.
- Server-authoritative chats: multilingual global rooms + per-clan chat with slow mode and history trimming.
- Cost-friendly reads: singleton player social docs and precomputed clan search fields to keep Firestore queries efficient.

---

## Firestore Schema

### `/Clans/{clanId}`

| Field | Type | Description |
| --- | --- | --- |
| `clanId` | string | Document ID mirror. |
| `name` | string | Display name (3-24 characters). |
| `description` | string | Optional 0-500 char message. |
| `type` | `"anyone can join" \| "invite only" \| "closed"` | Controls how players join. |
| `location` | string | Free-form string (UI filter). |
| `language` | string | Lowercase ISO language (e.g. `en`). |
| `badge` | string | Cosmetic/badge identifier provided by the client. |
| `minimumTrophies` | number | Entry requirement. |
| `leaderUid` | string | UID of current leader. |
| `stats` | object | `{ members, trophies, totalWins? }` and is updated transactionally. |
| `status` | string | `"active"` today but reserved for moderation. |
| `search` | object | `{ nameLower, location, language }` for indexed queries. |
| `createdAt` / `updatedAt` | timestamp | Server timestamps. |

#### Subcollections

- `/Members/{uid}` ? `{ uid, role, rolePriority, trophies, joinedAt, displayName, avatarId, level, lastPromotedAt }`
- `/Requests/{uid}` ? `{ uid, displayName, trophies, message?, requestedAt }`
- **Clan chat history now lives in Realtime Database** under `/chat_messages/clans/{clanId}/{messageId}` (global rooms live alongside them under `/chat_messages/global`). See the chat section below for the RTDB schema.

> **Realtime tip:** Attach a Firestore listener to `Clans/{clanId}/Members` (optionally with ordering) to stream roster changes into Unity. Each member lives in its own document, so updates remain fine-grained and cheap.

### Player Social Data (`/Players/{uid}/Social`)

| Doc/Collection | Key Fields |
| --- | --- |
| `Clan` (doc) | `{ clanId, role, joinedAt, lastVisitedClanChatAt, lastVisitedGlobalChatAt, bookmarkedClanIds? }` |
| `ClanInvites` (doc) | `{ invites: { [clanId]: { clanId, clanName, clanBadge, clanType, minimumTrophies, statsMembers, statsTrophies, fromUid, fromRole, fromName, fromAvatarId, message?, createdAt, snapshotRefreshedAt? } }, updatedAt }` |
| `ClanBookmarks` (doc) | `{ bookmarks: { [clanId]: { clanId, name, badge, type, memberCount, totalTrophies, addedAt, lastRefreshedAt } }, bookmarkedClanIds, updatedAt }` |
| `ChatRate` (doc) | `{ rooms: { [roomOrClanKey]: { lastSentAt } }, updatedAt }` |

> The `/Players/{uid}/Social/Clan` singleton is the canonical "Am I in a clan?" flag. Read or listen to it at boot to discover the current clanId and role, then pass that clanId into `getClanDetails` (or call `getMyClanDetails` below) to hydrate the roster.

### `/System/RecommendedClans`

Singleton document that caches the “healthy clan” pool built by a scheduled job. Clients read this once per session, filter locally, and only hydrate the handful of clan IDs they plan to show.

| Field | Type | Description |
| --- | --- | --- |
| `updatedAt` | timestamp | Last rebuild time (set by the cron job). |
| `pool` | array | List of `{ id, minimumTrophies, name, badge, type, members, totalTrophies }` entries (capped at 10 by the current rollout). |
| `poolSize` | number | Convenience count of array entries. |

> The scheduled function `recommendedClansPoolJob` rebuilds this doc every hour by scanning the top clans ordered by `stats.members`, filtering server-side for `status === "active"`, `type === "anyone can join"`, and member counts between 1 and 45 so new clans can still surface. Clients never query `Clans` for “random suggestions”; they only read this doc, filter against local trophies, shuffle, and then hydrate the handful of selected IDs via batched `IN` queries. The pool currently stores up to 10 entries per rebuild.

### Chat Rooms (Firestore + Realtime Database)

| Path | Description |
| --- | --- |
| `/Rooms/{roomId}` | Firestore doc that tracks metadata for each global room: `{ roomId, region, type, connectedCount, softCap, hardCap, slowModeSeconds, maxMessages, isArchived, createdAt, updatedAt, lastActivityAt }`. Cloud Functions mutate these fields; clients read them only via the callables. **Dec 2025 update:** Query now filters `isArchived == false` to prevent archived rooms from hiding active rooms. All users currently join `region: "global_general"` for maximum concurrency at launch. |
| `/Players/{uid}/Profile/Profile.assignedChatRoomId` | Sticky pointer set by `assignGlobalChatRoom`. Used by the callable to reuse a preferred room and by ops/debug tooling. |
| `/chat_messages/clans/{clanId}/{messageId}` (Realtime Database) | Dedicated subtree for clan chat streams so they’re easy to inspect. Messages store `{ u, n, m, type, c, cid, cl, av, tr, role, op, ts, clientCreatedAt? }`. |
| `/chat_messages/global/{roomId}/{messageId}` (Realtime Database) | Global chat rooms keyed by `roomId` using the same message payload. `cid` is populated when the sender belongs to a clan so the client can link to their clan card. |
| `/presence/online/{uid}` (Realtime Database) | Presence node set by the client that includes `{ roomId, clanId, lastSeen }`. RTDB security rules check this node to decide whether a user may read `/chat_messages/clans/*` or `/chat_messages/global/*`. |

Messages never live in Firestore now; the callable pushes them straight to RTDB and scheduled jobs (`cleanupChatHistory`) prune old entries (30 days for clans, 24h for global). Presence removal fires an RTDB trigger that decrements `Rooms/{roomId}.connectedCount`, keeping load-balancing accurate without extra Firestore reads.

---

## Cloud Functions

All functions are HTTPS `onCall`, `us-central1`, AppCheck optional. Every request requires auth and, when provided, the `opId` (idempotency token) is validated via `/Players/{uid}/Receipts/{opId}`.

### Clan Management

| Function | Request | Response | Notes |
| --- | --- | --- | --- |
| `createClan` | `{ opId, name, description?, type?, location?, language?, badge?, minimumTrophies? }` | `{ clan, members, membership, requests: [] }` | Creates the clan doc, adds creator as leader, writes `/Social/Clan` doc, posts system message. Response matches `getMyClanDetails` for instant hydration. |
| `updateClanSettings` | `{ opId, clanId, name?, description?, type?, location?, language?, badge?, minimumTrophies? }` | `{ clanId, updated: string[] }` | Officers only; updates search mirror + timestamp. |
| `deleteClan` | `{ opId, clanId }` | `{ clanId, deleted: true }` | Leader-only, clan must be empty aside from leader (kick/transfer first). Recursively deletes clan tree after txn. |

### Membership & Roles

| Function | Request | Response | Validation Highlights |
| --- | --- | --- | --- |
| `joinClan` | `{ opId, clanId }` | `{ clanId }` | “Anyone can join” clans only; checks trophies, capacity, and clears join requests/invites. |
| `requestToJoinClan` | `{ opId, clanId, message? }` | `{ clanId }` | Invite-only clans; prevents duplicates and enforces capacity/trophies. Also posts a `join_request` system message in clan chat. |
| `cancelJoinRequest` | `{ opId, clanId }` | `{ clanId }` | Deletes pending request atomically. |
| `leaveClan` | `{ opId }` | `{ clanId }` | Removes membership, decrements stats, and handles leader succession. If the caller is the last remaining member (leader), the clan is disbanded automatically. Otherwise leadership transfers to the highest-ranked member (prefers co-leaders, oldest promotion). |
| `acceptJoinRequest` | `{ opId, clanId, targetUid }` | `{ clanId }` | Officer+, moves request into membership, updates player social docs, posts system message. |
| `declineJoinRequest` | `{ opId, clanId, targetUid }` | `{ clanId }` | Officer+, simply deletes request. |
| `promoteClanMember` | `{ opId, clanId, targetUid, role? }` | `{ clanId }` | Officer+ with higher priority than target; optional explicit role, otherwise +1 rank (never to leader). |
| `demoteClanMember` | `{ opId, clanId, targetUid, role? }` | `{ clanId }` | Officer+, ensures lowered rank and target not leader. |
| `transferClanLeadership` | `{ opId, clanId, targetUid }` | `{ clanId }` | Leader only -> promotes target to leader, demotes self to coLeader, posts system message. |
| `kickClanMember` | `{ opId, clanId, targetUid }` | `{ clanId }` | Officer+, cannot kick leader, clears member's social docs and invite. |
| `updateMemberTrophies` | `{ opId, trophyDelta }` | `{ opId, updated: boolean }` | Internal helper called by race results; increments clan + member trophies when player currently in a clan. |

### Invites, Bookmarks, and Lookups

| Function | Request | Response | Notes |
| --- | --- | --- | --- |
| `inviteToClan` | `{ opId, clanId, targetUid, message? }` | `{ clanId }` | Any member can invite; writes invite snapshot (name, badge, type, member counts, etc.) under target's `/Social/ClanInvites`. |
| `acceptClanInvite` | `{ opId, clanId }` | `{ clanId }` | Converts invite to membership after validating capacity/trophies. |
| `declineClanInvite` | `{ opId, clanId }` | `{ clanId }` | Removes stored invite. |
| `refreshClanInvites` | `{ clanIds?: string[] }` | `{ invites: [...] }` | Re-reads the specified (or all) invited clans to refresh their cached badge/type/member stats inside `/Social/ClanInvites`. |
| `bookmarkClan` | `{ opId, clanId }` | `{ clanId }` | Stores a cached snapshot (`name`, `badge`, `type`, `memberCount`, `totalTrophies`, timestamps) under `/Social/ClanBookmarks`. |
| `unbookmarkClan` | `{ opId, clanId }` | `{ clanId }` | Removes bookmark snapshot + ID. |
| `getBookmarkedClans` | `{}` | `{ bookmarks: BookmarkSnapshot[] }` | Returns cached bookmark entries sorted by `addedAt`. No live clan reads happen here. |
| `refreshBookmarkedClans` | `{ clanIds: string[] }` | `{ bookmarks: BookmarkSnapshot[] }` | Batch refresh for stale entries: reads the requested clans, updates cached fields + `lastRefreshedAt`, and returns the updated snapshots. |
| `getRecommendedClansPool` | `{}` | `{ updatedAt: number\|null, pool: [{ id, minimumTrophies }] }` | Authenticated callable that proxies the `/System/RecommendedClans` singleton so clients can cache the pool and filter/shuffle locally. |

`BookmarkSnapshot` objects contain `{ clanId, name, badge, type, memberCount, totalTrophies, addedAt, lastRefreshedAt }`. Clients render the Bookmarks UI directly from these cached fields and only call `refreshBookmarkedClans` for entries whose `lastRefreshedAt` exceeds a freshness window (e.g., older than 30 minutes) or when the user explicitly requests a manual refresh.

**Recommended clans flow:**  
1. Scheduled job `recommendedClansPoolJob` rebuilds `/System/RecommendedClans` every hour by querying active “anyone can join” clans with 1–45 members and writing `{ id, minimumTrophies, ... }` entries.  
2. Unity calls `getRecommendedClansPool` once per Join tab session (1 read via callable) and caches the payload for ~30 minutes. On a cold deploy (no pool doc yet) the callable automatically rebuilds the cache before responding, so the first call may take a moment but subsequent calls are cached.  
3. Locally filter by the player’s trophies (`req <= playerTrophies`), shuffle the filtered list, and pick ~20 IDs.  
4. Hydrate those IDs with 1–2 `IN` queries against `/Clans` (FireStore’s limit is 30 IDs per query) to display cards.  
5. If the cache expires, simply re-call the function; the server-side document keeps reads predictable and avoids hammering the live `Clans` collection.

| `getClanDetails` | `{ clanId }` | `{ clan, members, membership, requests? }` | Returns roster sorted by `rolePriority` + trophies, includes pending requests when caller is officer+. Member rows mirror the `/Clans/{clanId}/Members/{uid}` docs, which the backend keeps in sync whenever players update their profile. |
| `getMyClanDetails` | `{}` | `{ clan, members, membership, requests? }` | Convenience wrapper that reads `/Players/{uid}/Social/Clan.clanId` to hydrate the caller's own clan without passing an ID. |
| `searchClans` | `{ query?, location?, language?, type?, limit?, minMembers?, maxMembers?, minTrophies?, requireOpenSpots? }` | `{ clans: ClanSummary[] }` | Supports case-insensitive name filtering plus location/language/trophy filters. |
| `getClanLeaderboard` | `{ limit?, location? }` | `{ clans: { clanId, name, badge, type, members, totalTrophies }[] }` | Reads the cached `/ClanLeaderboard/snapshot` document (built by the scheduled job). Supports location filtering by post-processing the cached array so the callable is always a single read. |

`ClanSummary` objects mirror the Firestore doc: `{ clanId, name, description, type, location, language, badge, minimumTrophies, stats }`.

`members[]` entries return `{ uid, displayName, avatarId, level, role, trophies, joinedAt }` so the client can render live rosters without additional lookups.

### Manual Leaderboard Refresh (QA helper)

Two callables exist purely for testing/QA so you can seed leaderboard caches without waiting for the five-minute cron jobs:

| Function | Request | Response | Notes |
| --- | --- | --- | --- |
| `refreshGlobalLeaderboardNow` | `{}` | `{ ok: true, metrics: 3 }` | Runs the same routine as `leaderboards.refreshAll` and overwrites every `/GlobalLeaderboard/{metric}` doc. Requires auth but no special claims so testers can call it from Unity or `firebase functions:shell` (e.g., `await refreshGlobalLeaderboardNow({ data: {} })`). |
| `refreshClanLeaderboardNow` | `{}` | `{ ok: true, processed: 100 }` | Invokes `refreshClanLeaderboard` once and rewrites `/ClanLeaderboard/snapshot`. Keep usage limited to QA�?"the scheduled job still handles production refreshes every six hours. |

After calling either function, the cached docs exist immediately and the scheduled jobs continue to update them every six hours.

### Chat

| Function | Request | Response | Notes |
| --- | --- | --- | --- |
| `sendGlobalChatMessage` | `{ opId, roomId, text, clientCreatedAt? }` | `{ roomId, messageId }` | Enforces slow mode, trims to backend-configured history, stamps display name, avatarId, trophies, and clan snapshot for every message. |
| `getGlobalChatMessages` | `{ roomId, limit? }` | `{ roomId, messages: Message[] }` | Returns up to 25 most recent global messages, newest-last, reflecting the stored metadata. |
| `sendClanChatMessage` | `{ opId, clanId?, text, clientCreatedAt? }` | `{ clanId, messageId }` | Requires current membership, enforces clan slow mode, writes directly to RTDB (`/chat_messages/clans/{clanId}`) with the author’s display name, avatar, trophies, badge, and role snapshot. |
| `getClanChatMessages` | `{ limit? }` | `{ clanId, messages: Message[] }` | Reads the latest RTDB messages (default 25) for callers that can’t maintain a listener. |
| `cleanupClanChatHistory` | `schedule` | n/a | Scheduled job (every 24h) that prunes RTDB messages older than 30 days. |

`Message` objects contain `{ messageId, roomId?, clanId?, authorUid, authorDisplayName, authorAvatarId, authorTrophies, authorClanName?, authorClanBadge?, type, text, clientCreatedAt?, createdAt, deleted, deletedReason }`.

**Chat transport:**
- Call ssignGlobalChatRoom when opening the global tab and cache the { roomId, updatedAt } pair for ~30 minutes to avoid redundant assignments.
- Write /presence/online/{uid} with { roomId, clanId, lastSeen } and register onDisconnect().remove() before attaching listeners. RTDB rules only allow reads when this node matches the requested stream.
- Listen to /chat_messages/global/{roomId} or /chat_messages/clans/{clanId} with orderByChild(\"ts\").startAt(Date.now()) for zero-history streaming.
- Post messages exclusively through the Cloud Functions (never client push) so slow mode, opId idempotency, and profile snapshots remain authoritative.
- System events (join/leave/kick/promote) appear as 	ype: \"system\" rows in the clan stream immediately after their Firestore transactions succeed.

---

## Validation & Error Semantics

- **Auth**: Every callable throws `unauthenticated` if no Firebase Auth context.
- **Idempotency**: All mutation endpoints with `opId` cache receipts; repeated `opId` returns previous result immediately.
- **Role checks**: `leader` > `coLeader` > `member`. Promotions/demotions require strictly higher-ranking caller.
- **Eligibility**: `minimumTrophies` is checked against cached player trophies; there is no hard member cap, so availability is driven only by clan status.
- **Slow mode**: Chat endpoints compare `Date.now()` to stored `lastSentAt`. Violations throw `resource-exhausted`.
- **Error Codes**: Use `invalid-argument`, `failed-precondition`, `permission-denied`, `already-exists`, and `not-found` per scenario so the Unity client can localize copy.

Keep this document synced whenever schema or callable contracts evolve. It is the source-of-truth for gameplay, QA, and LiveOps.






