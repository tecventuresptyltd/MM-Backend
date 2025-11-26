from pathlib import Path
path = Path('docs/FUNCTION_CONTRACTS.md')
text = path.read_text()
old = """### getGlobalLeaderboard

**Purpose:** Returns the cached leaderboard snapshot (trophies, careerCoins, or totalWins) in a single read, including the caller's personal rank/value even if they are outside the top 100.

**Input:**
`json
{
  \"metric\": \"trophies\",           // Optional; defaults to \"trophies\"
  \"type\": 1,                      // Legacy alias: 1=trophies, 2=careerCoins, 3=totalWins
  \"limit\": 50,                 // Optional; 1-100 (default 50)
  \"pageToken\": \"base64cursor\"     // Optional pagination cursor issued by a previous call
}
`

**Output:**
`json
{
  \"myRank\": 3,
  \"leaderboardType\": 1,
  \"players\": [
    {
      \"avatarId\": 10,
      \"displayName\": \"mystic\",
      \"level\": 25,
      \"rank\": 1,
      \"stat\": 5,
      \"uid\": \"gAWy13PNRtRMrWEL06nSnqvYPS3w1\",
      \"clan\": {
        \"clanId\": \"clan_abc123\",
        \"name\": \"Mystic Racers\",
        \"badge\": \"badge_cobra\"
      }
    },
    {
      \"avatarId\": 4,
      \"displayName\": \"Kraken\",
      \"level\": 1,
      \"rank\": 2,
      \"stat\": 0,
      \"uid\": \"096IZ0NijQ0u60RTNw6AiyVbhwy2\",
      \"clan\": null
    }
  ]
}
`

**Errors:** UNAUTHENTICATED, INVALID_ARGUMENT, FAILED_PRECONDITION (leaderboard still warming up)

**Notes:** The response now follows a simplified format with callerRank (the authenticated user's position), leaderboardType (legacy metric type), and players[] array. Each player entry includes their stats, rank, and clan information ({ clanId, name, badge }). This callable currently reads every /Players/{uid}/Profile/Profile document on demand, sorts all players by the requested metric, and slices the result in memory before returning it. That means each request scales with your player count—great for development/debugging, but expensive at scale. When you're ready for production you should reintroduce a scheduled snapshot (or another caching strategy) to avoid scanning millions of documents per call.

---

### searchPlayer
"""
new = """### getGlobalLeaderboard

**Purpose:** Returns the cached leaderboard snapshot (trophies, careerCoins, or totalWins) from /Leaderboards_v1/{metric}. The snapshot is rebuilt every five minutes by the scheduled job (or on demand via efreshGlobalLeaderboardNow), so the callable is always a single Firestore read regardless of player count.

**Input:**
`json
{
  \"metric\": \"trophies\",
  \"type\": 1
}
`

**Output:**
`json
{
  \"myRank\": 3,
  \"leaderboardType\": 1,
  \"players\": [
    { \"uid\": \"uid1\", \"displayName\": \"Mystic\", \"avatarId\": 10, \"level\": 25, \"rank\": 1, \"stat\": 5421, \"clan\": { \"clanId\": \"clan_abc\", \"name\": \"Mystic Racers\", \"badge\": \"badge_cobra\" } },
    { \"uid\": \"uid2\", \"displayName\": \"Kraken\", \"avatarId\": 4, \"level\": 21, \"rank\": 2, \"stat\": 5300, \"clan\": null }
  ],
  \"updatedAt\": 1740002400000
}
`

**Errors:** UNAUTHENTICATED, INVALID_ARGUMENT, FAILED_PRECONDITION

**Notes:** players[] contains at most 100 rows (sorted by stat). myRank is populated when the caller is inside the cached top-100 slice; otherwise it is 
ull. To show an exact rank for players outside the cache, call getMyLeaderboardRank below, which runs an inexpensive COUNT aggregate.

---

### getMyLeaderboardRank

**Purpose:** Returns the caller's exact rank and stat for the requested metric using a Firestore COUNT aggregate (only one document read, no matter how many players exist). Ideal for “My Rank” UI without scanning live data.

**Input:**
`json
{
  \"metric\": \"trophies\",
  \"type\": 1
}
`

**Output:**
`json
{
  \"metric\": \"trophies\",
  \"leaderboardType\": 1,
  \"value\": 5421,
  \"rank\": 23456
}
`

**Errors:** UNAUTHENTICATED, INVALID_ARGUMENT, FAILED_PRECONDITION

**Notes:** The callable loads the caller's stat from /Players/{uid}/Profile/Profile, then runs collectionGroup(\"Profile\").where(metricField, \">\", value).count() to determine how many players are ahead. The count query is billed as a single document read, keeping per-request cost minimal even with millions of players.

---

### searchPlayer
"""
if old not in text:
    raise SystemExit('old block not found')
text = text.replace(old, new)
path.write_text(text)
