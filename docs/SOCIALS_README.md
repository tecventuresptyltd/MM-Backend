# Mystic Motors Social Data – Listener Cheat Sheet

This note explains every document we create under `/Players/{uid}/Social` so engineers can attach Firestore listeners ahead of time. All IDs are deterministic, even if the document does not exist yet—Firestore will simply return an `exists === false` snapshot until the first write.

## Player Social Documents

| Path | Purpose | Created When |
| --- | --- | --- |
| `/Players/{uid}/Social/Profile` | HUD counters (`friendsCount`, `lastActiveAt`, etc.). | Account bootstrap. |
| `/Players/{uid}/Social/Friends` | Map keyed by friend `uid` with cached `player` summaries (now includes `player.clan.badge`) and `since` timestamps. Backend refreshes each entry when profiles change so `getFriends` is a single read. | First successful friend acceptance. |
| `/Players/{uid}/Social/Requests` | `{ incoming: [], outgoing: [] }` arrays for friend requests (each embeds a `player` snapshot kept in sync server-side, including clan badge data). | First request sent/received. |
| `/Players/{uid}/Social/Blocks` | Map of blocked `uid`s. | First block action. |
| `/Players/{uid}/Social/Clan` | Canonical clan membership (`clanId`, `role`, `joinedAt`, chat timestamps, bookmarkedClanIds?). | First clan join. |
| `/Players/{uid}/Social/ClanInvites` | `{ invites: { [clanId]: { clanName, clanBadge, clanType, minimumTrophies, statsMembers, statsTrophies, fromUid, fromRole, fromName, fromAvatarId, message?, createdAt, snapshotRefreshedAt? } }, updatedAt }` payload for inbound clan invites. | First invite received. |
| `/Players/{uid}/Social/ClanBookmarks` | `{ bookmarks: { [clanId]: { clanId, name, badge, type, memberCount, totalTrophies, addedAt, lastRefreshedAt } }, bookmarkedClanIds, updatedAt }`. | First bookmark. |
| `/Players/{uid}/Social/ChatRate` | Per-room slow-mode state `{ rooms: { [roomIdOrClanKey]: { lastSentAt } }, updatedAt }`. | First chat message via Cloud Function. |

## Notes for Client Engineers

- **Listen early:** Attach listeners to all paths above at app boot. If a document does not exist yet, the listener fires with an empty snapshot and will update automatically when the first Cloud Function writes data.
- **No guessing IDs:** Every doc name is fixed; you never need to poll or derive dynamic names for player-centric data.
- **Clan-specific collections:** Roster (`/Clans/{clanId}/Members`), join requests (`/Clans/{clanId}/Requests`), and chat (`/Clans/{clanId}/Chat`) remain collections by design. Use collection listeners with ordering (e.g., `orderBy("rolePriority", "desc")`) for live rosters.
- **Friends snapshots:** `setUsername`, `setAvatar`, race rewards, and XP grants refresh the cached friend/request snapshots so `getFriends` and `getFriendRequests` rarely need extra reads.
- **Scheduled leaderboards (social & clan):**
  - *Social metrics:* `src/Socials/leaderboardJob.ts` contains an `onSchedule` handler that snapshots player leaderboards into `/Leaderboards_v1/{metric}`. To activate later, import it in `src/index.ts` (e.g., `import { leaderboards as socialLeaderboards } from "./Socials/leaderboardJob.js";`) and export `export const refreshSocialLeaderboards = socialLeaderboards.refreshAll;`, then deploy `firebase deploy --only functions:mm-sandbox-refreshSocialLeaderboards`.
  - *Clan leaderboard cache:* `src/clan/leaderboardJob.ts` keeps the top 100 clans in `/Leaderboards/Clans`. To enable, import `{ clanLeaderboardJob }` in `src/index.ts`, export `export const refreshClanLeaderboardJob = clanLeaderboardJob.refresh;`, and deploy that function so clients can read the cached doc instead of querying `Clans` directly.
- **Receipts & operations:** Idempotency receipts live under `/Players/{uid}/Receipts/{opId}`; same pattern applies—fixed ID equals the operation ID.

Keep this file alongside the clan README so Unity/LiveOps engineers always know which documents exist and when they appear.*** End Patch
## Clan Bookmark Refresh Flow

- `bookmarkClan` writes `{ clanId, name, badge, type, memberCount, totalTrophies, addedAt, lastRefreshedAt }` under `/Players/{uid}/Social/ClanBookmarks`. The document name is deterministic (`ClanBookmarks`), so you can listen to it during boot.
- The UI should always use that cached dictionary when showing the Bookmarks tab. If the cached entry is younger than your freshness window (e.g. 30 minutes), no extra work is required.
- When an entry is stale (missing `lastRefreshedAt` or older than the freshness window), batch up to 20 IDs and call `refreshBookmarkedClans`. The callable reads those `/Clans/{clanId}` docs, writes updated snapshots back into `/Social/ClanBookmarks`, and returns the refreshed objects for immediate display.

### Unity example (listener + refresh)

```csharp
const int BookmarkFreshMinutes = 30;
ListenerRegistration bookmarksListener;

void ListenForBookmarks(string uid)
{
    var db = FirebaseFirestore.DefaultInstance;
    var doc = db.Collection("Players").Document(uid).Collection("Social").Document("ClanBookmarks");

    bookmarksListener = doc.Listen(snapshot =>
    {
        if (!snapshot.Exists)
        {
            PlayerClanBookmarksHolder.Instance.ApplyServerRefresh(Array.Empty<IDictionary<string, object>>());
            return;
        }

        var data = snapshot.ToDictionary();
        PlayerClanBookmarksHolder.Instance.LoadFromDictionary(data); // caches bookmarks map locally
    });
}

async Task RefreshStaleBookmarksAsync()
{
    var cached = PlayerClanBookmarksHolder.Instance.bookmarks; // Dictionary<string, ClanBookmark>
    var staleIds = new List<string>();
    var now = DateTime.UtcNow;

    foreach (var entry in cached.Values)
    {
        var lastRefresh = entry.lastRefreshedAt?.ToUniversalTime();
        var isStale = lastRefresh == null || now - lastRefresh.Value > TimeSpan.FromMinutes(BookmarkFreshMinutes);
        if (isStale)
        {
            staleIds.Add(entry.clanId);
            if (staleIds.Count == 20) break;
        }
    }

    if (staleIds.Count == 0) return;

    var payload = new Dictionary<string, object> { ["clanIds"] = staleIds };
    var response = await Cf.CallFunctionAsync(cfEndpoints.RefreshBookmarkedClans, payload);
    var refreshed = response["bookmarks"] as IList<object>;
    PlayerClanBookmarksHolder.Instance.ApplyServerRefresh(refreshed);
}
```

Because the callable also updates the bookmark document, your listener reflects the new values immediately and future reads remain cheap.
\nKeep this file alongside the clan README so Unity/LiveOps engineers always know which documents exist and when they appear.
