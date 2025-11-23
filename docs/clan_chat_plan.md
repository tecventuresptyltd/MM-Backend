Here is the standalone technical specification for the **Clan Chat System**. This document is self-contained and provides all necessary context for an AI or developer to implement the feature from scratch, without needing reference to other chat systems.

-----

# Technical Spec: Mystic Motors Clan Chat System

**Version:** 1.0
**Status:** Approved for Implementation
**Scope:** Persistent, private chat for Clan members (Max 50 users per room).

## 1\. Executive Summary

The Clan Chat system is a **Hybrid Architecture** designed to support private, persistent communication for in-game clans.

  * **Firestore:** Acts as the **Source of Truth** for clan membership and player profiles.
  * **Realtime Database (RTDB):** Acts as the **Message Transport Layer** to minimize bandwidth costs and latency.

**Key Features:**

  * **History:** Users receive the last **200 messages** upon joining to preserve context.
  * **Transitioning:** The client dynamically switches chat channels when the user's Firestore profile updates (e.g., joining/leaving a clan).
  * **Data Retention:** Messages are retained for **30 days** to support low-activity clans.

-----

## 2\. Database Schema

### A. Firestore (Membership State)

*Managed by existing Cloud Functions. Read-only for Chat Client logic.*

**Document:** `/Players/{uid}/Social/Profile`
This document is the definitive record of which clan a player belongs to. The client monitors this document to know which RTDB channel to subscribe to.

```json
{
  // ... other profile fields ...
  "clanId": "clan_h4ayzw",    // The ID of the clan the user is currently in (or null)
  "clanRole": "member",       // Used for UI decoration
  "displayName": "RacerX",
  "avatarId": 3
}
```

**Document:** `/Clans/{clanId}`
Contains shared clan metadata (Badge, Name) used for header rendering.

### B. Realtime Database (Message Stream)

*Direct Client Read/Write via SDK.*

**Path:** `/chat_messages/{clanId}/{messageId}`

  * **Bucket Strategy:** Messages are grouped directly under the `clanId`.
  * **Optimization:** Keys are single characters to minimize bandwidth usage (High-frequency data).

<!-- end list -->

```json
{
  "u": "uid_555",          // User UID
  "n": "RacerX",           // Display Name
  "m": "Welcome everyone!", // Message Text
  "op": "opId-guid",       // opId to match client optimistic entry
  "c": "badge_solar",      // Clan Badge ID (for UI rendering)
  "ts": 1739950000000      // Server Timestamp (Critical for sorting)
}
```

**Path:** `/presence/online/{uid}`
*Purpose: Security validation. The client mirrors its clan status here so RTDB Security Rules can verify read access.*

```json
{
  "clanId": "clan_h4ayzw", // Must match the chat channel being accessed
  "lastSeen": 1739950000000
}
```

-----

## 3\. Client-Side Implementation Strategy

### Step 1: Connection & Security Handshake

When the application boots (or connection is established):

1.  Read `clanId` from Firestore `/Players/{uid}/Social/Profile`.
2.  Connect to Realtime Database.
3.  **Write Presence:** Write to `/presence/online/{uid}` using `onDisconnect().remove()`.
      * *Crucial:* This node **must** contain the `clanId`. The Security Rules (Section 5) check this node to prevent unauthorized access to private clan channels.

### Step 2: The "Recent History" Listener

Unlike ephemeral chats, clan members need context. We download the most recent activity.

```javascript
// Logic: Listen to the specific clan channel, capped at 200 items.
const clanId = userProfile.clanId; // from Firestore

if (clanId) {
  const q = query(
    ref(db, `chat_messages/${clanId}`),
    orderByChild("ts"),
    limitToLast(200) // <--- Optimization: Caps bandwidth at 200 messages
  );

  onChildAdded(q, (snapshot) => {
    const msg = snapshot.val();
    renderMessage(msg);
  });
}
```

### Step 3: Handling Clan Transitions (Join/Leave)

The user might join or leave a clan while the app is running. The client must handle this purely by reacting to Firestore changes.

**Logic Flow:**

1.  Set up a Firestore `onSnapshot` listener for `/Players/{uid}/Social/Profile`.
2.  **IF** `clanId` changes (e.g., `clan_A` -\> `clan_B`):
      * **Unsubscribe** (calling `.off()`) from `chat_messages/clan_A`.
      * **Update Presence:** Write `{ clanId: "clan_B" }` to RTDB `/presence/online/{uid}` (to authorize access to the new room).
      * **Subscribe** to `chat_messages/clan_B` using `limitToLast(200)`.
      * *UI Action:* Clear current chat view and render new stream.
3.  **IF** `clanId` becomes `null` (User left clan):
      * Unsubscribe from RTDB.
      * Update Presence to `{ clanId: null }`.
      * Show "Join a Clan" UI.

### Step 4: Sending Messages

Write directly to the RTDB stream.

  * **Path:** `/chat_messages/{clanId}`
  * **Method:** `push()`
  * **Payload:** Must include `ts: serverTimestamp()` and the user's current display name/badge from their cached profile.

-----

## 4\. Backend Logic (Maintenance)

### Scheduled Function: `cleanupClanChatHistory`

**Trigger:** Scheduled Cron (Every 24 Hours).
**Goal:** Prune old message history to keep storage costs low, while retaining enough context for low-activity clans.

**Logic:**

1.  Calculate `cutoffTime = Date.now() - (30 * 24 * 60 * 60 * 1000)`. (30 Days).
2.  Query RTDB `/chat_messages`.
3.  Iterate through all clan buckets.
4.  Identify message nodes where `ts < cutoffTime`.
5.  Execute a multi-path update to delete these expired messages.

*Note: We use a 30-day window (vs. 24 hours for global) because clan activity can be sporadic, and members expect to see messages from a few days ago.*

-----

## 5\. Security Rules (Realtime Database)

*File: `database.rules.json`*

These rules strictly enforce that a user can only read the chat logs of the clan listed in their own presence node. This prevents users from "spying" on other clans by guessing IDs.

```json
{
  "rules": {
    "chat_messages": {
      "$clanId": {
        // Indexing required for the time-based ordering
        ".indexOn": ["ts"],
        
        // READ PERMISSION:
        // 1. User must be authenticated.
        // 2. The 'clanId' in the user's presence node must match this channel ID.
        ".read": "auth != null && root.child('presence/online').child(auth.uid).child('clanId').val() === $clanId",
        
        // WRITE PERMISSION:
        // Authenticated users can write, with basic schema validation
        "$msgId": {
          ".write": "auth != null",
          ".validate": "newData.hasChildren(['u', 'n', 'm', 'ts']) && newData.child('m').val().length < 256"
        }
      }
    },
    "presence": {
      "online": {
        "$uid": {
          // Users can only write to their own presence node
          ".write": "auth.uid === $uid",
          ".read": "auth != null"
        }
      }
    }
  }
}
```

-----

## 6\. Unity Client Implementation (Example)

```csharp
using Firebase.Database;

DatabaseReference clanChatListener;
DatabaseReference presenceRef;

async Task StartClanChatAsync(string uid, string clanId)
{
    // 1) Mirror presence so RTDB rules allow access
    presenceRef = FirebaseDatabase.DefaultInstance
        .GetReference("presence/online")
        .Child(uid);
    await presenceRef.SetValueAsync(new { clanId, lastSeen = ServerValue.Timestamp });
    presenceRef.OnDisconnectRemoveValue();

    // 2) Listen for the latest messages
    clanChatListener = FirebaseDatabase.DefaultInstance
        .GetReference($"chat_messages/{clanId}")
        .OrderByChild("ts")
        .LimitToLast(200);

    clanChatListener.ChildAdded += (sender, args) =>
    {
        var data = args.Snapshot.GetValue<Dictionary<string, object>>();
        // data["u"], data["n"], data["m"], etc.
        RenderMessage(data);
    };
}

async Task StopClanChatAsync()
{
    clanChatListener?.OnDisconnect();
    clanChatListener = null;
    await presenceRef?.RemoveValueAsync();
}

async Task SendClanChatMessageAsync(string clanId, string text, PlayerProfile profile)
{
    var payload = new Dictionary<string, object>
    {
        ["u"] = profile.uid,
        ["n"] = profile.displayName,
        ["m"] = text,
        ["type"] = "text",
        ["av"] = profile.avatarId,
        ["tr"] = profile.trophies,
        ["c"] = profile.clanBadge,
        ["cl"] = profile.clanName,
        ["clientCreatedAt"] = DateTime.UtcNow.ToString("o")
    };

    await FirebaseDatabase.DefaultInstance
        .GetReference($"chat_messages/{clanId}")
        .Push()
        .SetValueAsync(payload);
}
```

Only keep the listener alive while the chat UI is visible; otherwise call `StopClanChatAsync()` to save reads.
