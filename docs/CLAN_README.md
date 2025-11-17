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
| `description` | string | Optional 0-140 char message. |
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
- `/Chat/{messageId}` ? `{ clanId, authorUid?, authorDisplayName, type, text?, payload?, createdAt }`

> **Realtime tip:** Attach a Firestore listener to `Clans/{clanId}/Members` (optionally with ordering) to stream roster changes into Unity. Each member lives in its own document, so updates remain fine-grained and cheap.

### Player Social Data (`/Players/{uid}/Social`)

| Doc/Collection | Key Fields |
| --- | --- |
| `Clan` (doc) | `{ clanId, role, joinedAt, lastVisitedClanChatAt, lastVisitedGlobalChatAt, bookmarkedClanIds? }` |
| `ClanInvites` (doc) | `{ invites: { [clanId]: { clanId, clanName, fromUid, fromRole, message?, createdAt } }, updatedAt }` |
| `ClanBookmarks` (doc) | `{ bookmarks: { [clanId]: { clanId, clanName, addedAt } }, bookmarkedClanIds, updatedAt }` |
| `ChatRate` (doc) | `{ rooms: { [roomOrClanKey]: { lastSentAt } }, updatedAt }` |

> The `/Players/{uid}/Social/Clan` singleton is the canonical "Am I in a clan?" flag. Read or listen to it at boot to discover the current clanId and role, then pass that clanId into `getClanDetails` (or call `getMyClanDetails` below) to hydrate the roster.

### Chat Rooms

```
/Rooms/{roomId}
  /Messages/{messageId}
```

| Field | Description |
| --- | --- |
| `roomId` | e.g. `global_en`, `global_hi`. |
| `type` | `"global"` or `"system"`. |
| `language` / `location?` | Used for UI filtering. |
| `slowModeSeconds` | Minimum delay between messages per user. |
| `maxMessages` | Soft cap for history trimming. |
| `Messages` docs | `{ roomId, authorUid, authorDisplayName, authorAvatarId, authorTrophies, authorClanName?, authorClanBadge?, type, text, clientCreatedAt?, createdAt, deleted, deletedReason }`. |

The backend trims both global and clan chat history to a server-configured threshold (currently 100 messages) so collections stay bounded.

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
| `requestToJoinClan` | `{ opId, clanId, message? }` | `{ clanId }` | Invite-only clans; prevents duplicates and enforces capacity/trophies. |
| `cancelJoinRequest` | `{ opId, clanId }` | `{ clanId }` | Deletes pending request atomically. |
| `leaveClan` | `{ opId }` | `{ clanId }` | Removes membership, decrements stats, handles leader succession (promotes highest priority member). |
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
| `inviteToClan` | `{ opId, clanId, targetUid, message? }` | `{ clanId }` | Officer+, writes invite blob under target's `/Social/ClanInvites`. |
| `acceptClanInvite` | `{ opId, clanId }` | `{ clanId }` | Converts invite to membership after validating capacity/trophies. |
| `declineClanInvite` | `{ opId, clanId }` | `{ clanId }` | Removes stored invite. |
| `bookmarkClan` | `{ opId, clanId }` | `{ clanId }` | Stores snapshot in `/Social/ClanBookmarks` + array helper for quick UI rendering. |
| `unbookmarkClan` | `{ opId, clanId }` | `{ clanId }` | Removes bookmark snapshot + ID. |
| `getBookmarkedClans` | `{}` | `{ clans: ClanSummary[] }` | Hydrates live data when available, otherwise falls back to cached bookmark metadata. |
| `getClanDetails` | `{ clanId }` | `{ clan, members, membership, requests? }` | Returns roster sorted by `rolePriority` + trophies, includes pending requests when caller is officer+. Member rows mirror the `/Clans/{clanId}/Members/{uid}` docs, which the backend keeps in sync whenever players update their profile. |
| `getMyClanDetails` | `{}` | `{ clan, members, membership, requests? }` | Convenience wrapper that reads `/Players/{uid}/Social/Clan.clanId` to hydrate the caller's own clan without passing an ID. |
| `searchClans` | `{ query?, location?, language?, type?, limit?, minMembers?, maxMembers?, minTrophies?, requireOpenSpots? }` | `{ clans: ClanSummary[] }` | Supports case-insensitive name filtering plus location/language/trophy filters. |
| `getClanLeaderboard` | `{ limit?, location? }` | `{ clans: ClanSummary[] }` | Ordered by `stats.trophies`, supports location filter. |

`ClanSummary` objects mirror the Firestore doc: `{ clanId, name, description, type, location, language, badge, minimumTrophies, stats }`.

`members[]` entries return `{ uid, displayName, avatarId, level, role, trophies, joinedAt }` so the client can render live rosters without additional lookups.

### Chat

| Function | Request | Response | Notes |
| --- | --- | --- | --- |
| `sendGlobalChatMessage` | `{ opId, roomId, text, clientCreatedAt? }` | `{ roomId, messageId }` | Enforces slow mode, trims to backend-configured history, stamps display name, avatarId, trophies, and clan snapshot for every message. |
| `getGlobalChatMessages` | `{ roomId, limit? }` | `{ roomId, messages: Message[] }` | Returns up to 25 most recent global messages, newest-last, reflecting the stored metadata. |
| `sendClanChatMessage` | `{ opId, clanId?, text, clientCreatedAt? }` | `{ clanId, messageId }` | Requires current membership, enforces clan slow mode, logs profile + clan snapshot, updates `lastVisitedClanChatAt`. |
| `getClanChatMessages` | `{ limit? }` | `{ clanId, messages: Message[] }` | Requires membership; returns up to 25 most recent clan messages. |

`Message` objects contain `{ messageId, roomId?, clanId?, authorUid, authorDisplayName, authorAvatarId, authorTrophies, authorClanName?, authorClanBadge?, type, text, clientCreatedAt?, createdAt, deleted, deletedReason }`.

Moderation helpers (`moderateChatMessage`) are optional future work but should follow the same schema if added.

---

## Validation & Error Semantics

- **Auth**: Every callable throws `unauthenticated` if no Firebase Auth context.
- **Idempotency**: All mutation endpoints with `opId` cache receipts; repeated `opId` returns previous result immediately.
- **Role checks**: `leader` > `coLeader` > `member`. Promotions/demotions require strictly higher-ranking caller.
- **Eligibility**: `minimumTrophies` is checked against cached player trophies; there is no hard member cap, so availability is driven only by clan status.
- **Slow mode**: Chat endpoints compare `Date.now()` to stored `lastSentAt`. Violations throw `resource-exhausted`.
- **Error Codes**: Use `invalid-argument`, `failed-precondition`, `permission-denied`, `already-exists`, and `not-found` per scenario so the Unity client can localize copy.

Keep this document synced whenever schema or callable contracts evolve. It is the source-of-truth for gameplay, QA, and LiveOps.



