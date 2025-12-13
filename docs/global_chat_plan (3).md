# Mystic Motors Global Chat Plan (RTDB Implementation)

**Last Updated:** December 13, 2025  
**Status:** Implemented + Bug Fixes Applied (ready for QA + live clients)

**Recent Changes (Dec 2025):**
- Fixed critical "ghost room" bug where archived rooms prevented users from joining active rooms
- Merged all regions into `global_general` for maximum concurrency at launch
- Optimized query ordering for faster warmup room discovery

This note documents the final design for global chat after the RTDB migration. It replaces the earlier brainstorm and should be treated as the source of truth for engineering + Unity implementation.

---

## 1. Overview

Mystic Motors now uses a hybrid architecture:

1. **Firestore (`Rooms` collection + player profile fields):** Handles room assignment, load balancing, sticky routing, and authoritative user counts.
2. **Realtime Database (`/chat_messages` + `/presence/online`):** Streams chat data with near-zero read cost, enforces read scopes via presence, and supports system message fan-out.
3. **Cloud Functions v2:** Provide the assign/send/get workflows, enforce slow mode and opId idempotency, and prune stale history.

Clients never query `/Clans` or `/Rooms` directly for chat ??? the callable APIs hide the heavy reads and keep the Firestore bill predictable.

---

## 2. Room Assignment (`assignGlobalChatRoom`)

Callable Path: `assignGlobalChatRoom`

1. The client calls this once per session (or when opening the Global Chat tab).
2. The function runs a Firestore transaction:
   - Reads `/Players/{uid}/Profile/Profile` to check an existing `assignedChatRoomId`.
   - If the stored room is active, not archived, and below `hardCap`, reuse it and increment `connectedCount`.
   - Otherwise, query `Rooms` for the `global_general` region (all users are merged into a single pool for launch).
     - **Query filters:** `type == "global"`, `region == "global_general"`, `isArchived == false`
     - **Query ordering:** `connectedCount ASC` (finds warmup rooms faster)
   - Priority order:
     1. **Warm-up rooms** (< 20 users) so empty rooms fill up first (picks emptiest).
     2. **Healthy rooms** (< `softCap`, default 80) preferring the fullest one (packs players tightly).
     3. **Overflow** (anything < `hardCap`, default 100) (picks emptiest for load distribution).
   - If no room matches, create a new doc (`roomId = global_general_{shortid}`) with sensible defaults: `{ region: "global_general", type: "global", slowModeSeconds: 3, maxMessages: 200, connectedCount: 1, isArchived: false }`.
   - The transaction updates both the room doc and the player profile (`assignedChatRoomId`).
3. Returns `{ roomId, region, connectedCount, softCap, hardCap }` for client telemetry/logging.

Sticky assignment keeps conversations intact. When the Unity client reconnects, it reuses the room id and increments the counter again. The counter is decremented by the RTDB trigger described below.

---

## 3. Data Schema

### Firestore

**`/Rooms/{roomId}`**
| Field | Type | Notes |
| --- | --- | --- |
| `roomId` | string | Mirrors the document ID (`region_suffix`). |
| `region` | string | Currently hardcoded to `"global_general"` for all users (launch strategy). |
| `type` | string | Always `"global"` for this flow (reserved for future `"system"`). |
| `connectedCount` | number | Incremented on assignment; decremented via trigger. |
| `softCap` | number | Preferred occupancy (default 80). |
| `hardCap` | number | Absolute ceiling (default 100). |
| `slowModeSeconds` | number | Per-user delay enforced by `sendGlobalChatMessage`. |
| `maxMessages` | number | Used by `cleanupChatHistory` for pruning. |
| `isArchived` | boolean | When true, assignments skip this room. |
| `createdAt`, `updatedAt`, `lastActivityAt` | timestamps | Set by Cloud Functions only. |

**`/Players/{uid}/Profile/Profile.assignedChatRoomId`**
Tracks the last assigned room so the server can reopen the same bucket and unity can attach to the correct RTDB path on boot.

### Realtime Database

/chat_messages/clans/{clanId}/{messageId}
/chat_messages/global/{roomId}/{messageId}
  u   => author uid
  n   => display name snapshot
  m   => text (<= 256 chars)
  type => "text" | "system"
  c   => clan badge snapshot (nullable)
  cid => clanId snapshot (nullable; filled for global when sender has a clan)
  cl  => clan name snapshot (nullable)
  av  => avatar id snapshot
  tr  => trophy snapshot
  role => clan role (only for clan chats)
  op  => opId for optimistic UI reconciliation
  ts  => server timestamp
  clientCreatedAt => optional ISO8601 string from client
```

Global chats live under `/chat_messages/global`, clan chats under `/chat_messages/clans`. Security rules look at `/presence/online/{uid}` to decide if the client is allowed to read a particular branch.

```
/presence/online/{uid}
  roomId: "global_xx"
  clanId: "clan_abc"
  lastSeen: 1739900000000
```

Clients must keep this presence node up to date (with `onDisconnect().remove()`) before attaching listeners.

---

## 4. Backend Functions & Triggers

| Name | Type | Purpose |
| --- | --- | --- |
| `assignGlobalChatRoom` | Callable | Sticky room assignment + load balancing (see Section 2). |
| `sendGlobalChatMessage` | Callable | Requires `opId` + `roomId`, validates slow mode, reads player profile/clan snapshot, and pushes to `/chat_messages/global/{roomId}` with that metadata (including the clanId snapshot). |
| `getGlobalChatMessages` | Callable | Fetches the last N RTDB entries (`min(request.limit, 25)`), sorts them oldest?newest, and records `lastVisitedGlobalChatAt`. Primarily for clients that can??Tt stream. |
| `cleanupChatHistory` | Scheduled | Runs every 24h, trimming clan channels to 30 days and global rooms to 24h. |
| `onPresenceOffline` | RTDB Trigger | Fires when `/presence/online/{uid}` is deleted (disconnect). Reads `assignedChatRoomId` and decrements `Rooms/{roomId}.connectedCount` in a transaction (clamped >= 0). |

All sensitive writes still flow through Cloud Functions; RTDB rules deny direct writes to `/chat_messages`.

---

## 5. Unity Client Flow

1. **Boot / Open Chat**
   ```csharp
   var assignPayload = new Dictionary<string, object>
   {
       { "region", PlayerLocale.CurrentRegion } // NOTE: Currently ignored, all users join global_general
   };
   var assignResult = await Cf.CallFunctionAsync(cfEndpoints.AssignGlobalChatRoom, assignPayload);
   var roomId = assignResult["roomId"].ToString();
   ```
2. **Presence**
   ```csharp
   var presenceRef = FirebaseDatabase.DefaultInstance
       .RootReference.Child("presence").Child("online").Child(CurrentUser.Uid);

   var presenceBody = new Dictionary<string, object>
   {
       { "roomId", roomId },
       { "clanId", PlayerClanHolder.Instance.CurrentClanId ?? string.Empty },
       { "lastSeen", ServerTime.NowMillis }
   };

   presenceRef.OnDisconnect().RemoveValue();
   await presenceRef.SetValueAsync(presenceBody);
   ```
3. **Zero-history listener**
   ```csharp
   var since = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
   var query = FirebaseDatabase.DefaultInstance
       .RootReference.Child("chat_messages").Child(roomId)
       .OrderByChild("ts")
       .StartAt(since - 100); // 100ms buffer to avoid missing first messages

   roomListener = query.Listen(snapshot =>
   {
       foreach (var child in snapshot.Children)
       {
           var msg = child.Value as IDictionary;
           GlobalChatCache.AddOrUpdate(child.Key, msg);
       }
       GlobalChatUI.Refresh();
   });
   ```
4. **Sending a message**
   ```csharp
   var payload = new Dictionary<string, object>
   {
       { "opId", Guid.NewGuid().ToString() },
       { "roomId", roomId },
       { "text", inputField.text },
       { "clientCreatedAt", DateTime.UtcNow.ToString("o") }
   };
   await Cf.CallFunctionAsync(cfEndpoints.SendGlobalChatMessage, payload);
   ```
5. **Refreshing cached backlog** (optional): if the UI needs to hydrate 25 latest lines on boot, call `getGlobalChatMessages` once before attaching the listener.

Because `assignGlobalChatRoom` increments the room counter, Unity should avoid spamming it. Cache the `{ roomId, updatedAt }` pair for ~30 minutes (or until the app is backgrounded) and reuse the same assignment unless the callable returns `permission-denied` or `failed-precondition`.

---

## 6. Cost & Reliability Notes

- The only Firestore reads on a typical join-tab open are the single callable invocation (`assignGlobalChatRoom`) and occasional `getGlobalChatMessages`. After that, the RTDB listener is basically free.
- Presence gating means unauthorized clients cannot snoop other clans or rooms; `.read` checks both `roomId` and `clanId`.
- Slow mode + opId ensures spammers can??Tt flood the room or duplicate entries when their client retries.
- `cleanupChatHistory` plus `maxMessages` keep RTDB storage bounded so there is no unbounded cost growth.
- Room counters never drift because each assignment increments via transaction and every disconnect triggers a decrement. Even in crash scenarios the `onDisconnect().remove()` + trigger cleanup handles it.

If additional room orchestration is needed (regional shards, manual moderation), extend the `Rooms` doc with new flags and the assignment callable will respect them automatically.
