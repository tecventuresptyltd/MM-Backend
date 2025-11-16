# Mystic Motors Social Data – Listener Cheat Sheet

This note explains every document we create under `/Players/{uid}/Social` so engineers can attach Firestore listeners ahead of time. All IDs are deterministic, even if the document does not exist yet—Firestore will simply return an `exists === false` snapshot until the first write.

## Player Social Documents

| Path | Purpose | Created When |
| --- | --- | --- |
| `/Players/{uid}/Social/Profile` | HUD counters (`friendsCount`, `lastActiveAt`, etc.). | Account bootstrap. |
| `/Players/{uid}/Social/Friends` | Map keyed by friend `uid` with cached summaries and `since` timestamps. | First successful friend acceptance. |
| `/Players/{uid}/Social/Requests` | `{ incoming: [], outgoing: [] }` arrays for friend requests. | First request sent/received. |
| `/Players/{uid}/Social/Blocks` | Map of blocked `uid`s. | First block action. |
| `/Players/{uid}/Social/Clan` | Canonical clan membership (`clanId`, `role`, `joinedAt`, chat timestamps, bookmarkedClanIds?). | First clan join. |
| `/Players/{uid}/Social/ClanInvites` | `{ invites: { [clanId]: {...} }, updatedAt }` payload for inbound clan invites. | First invite received. |
| `/Players/{uid}/Social/ClanBookmarks` | `{ bookmarks: { [clanId]: {...} }, bookmarkedClanIds, updatedAt }`. | First bookmark. |
| `/Players/{uid}/Social/ChatRate` | Per-room slow-mode state `{ rooms: { [roomIdOrClanKey]: { lastSentAt } }, updatedAt }`. | First chat message via Cloud Function. |

## Notes for Client Engineers

- **Listen early:** Attach listeners to all paths above at app boot. If a document does not exist yet, the listener fires with an empty snapshot and will update automatically when the first Cloud Function writes data.
- **No guessing IDs:** Every doc name is fixed; you never need to poll or derive dynamic names for player-centric data.
- **Clan-specific collections:** Roster (`/Clans/{clanId}/Members`), join requests (`/Clans/{clanId}/Requests`), and chat (`/Clans/{clanId}/Chat`) remain collections by design. Use collection listeners with ordering (e.g., `orderBy("rolePriority", "desc")`) for live rosters.
- **Receipts & operations:** Idempotency receipts live under `/Players/{uid}/Receipts/{opId}`; same pattern applies—fixed ID equals the operation ID.

Keep this file alongside the clan README so Unity/LiveOps engineers always know which documents exist and when they appear.*** End Patch
