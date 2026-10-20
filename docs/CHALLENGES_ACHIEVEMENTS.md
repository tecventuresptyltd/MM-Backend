# Challenges and achievements (sandbox)

Achievement points are retired: objectives omit points, claims grant no points, and status returns achievementPoints:0. Historical stored totals remain untouched and completed receipts replay their original result without granting again. Rewards remain exactly 20 gems per daily challenge or achievement.


Current challenge policy: daily challenges and achievements each grant exactly 20 gems, with no coins, mastery XP or spell shards. Existing daily snapshots are normalized lazily before status, progression and claims; completed receipts retain their original result and never grant again. ChallengesConfig supplies modeUnlockRanks (Elimination 5, Police 10, Infected 15), socialUnlockRank (5) and unrankedUnlockRaces (1), with matching defaults for older deployed configuration. Mode locks follow active FirstHour enrollment; nonenrolled accounts retain existing mode access. Social eligibility uses server profile.level, falling back to computed mastery rank. Mode eligibility uses pinnedMasteryRank when finite, otherwise masteryXp-derived rank, with stored masteryRank fallback only when XP is absent. Unclaimed locked achievements are hidden and cannot progress or claim; claimed history remains. First-use car-win objectives require an owned car absent from feature car history; already earned car-win claims are preserved. Daily reconciliation keeps valid progress and claimed entries, replaces ineligible unclaimed assignments deterministically, fills unavailable hard slots with eligible alternatives, and permits fewer objectives when the eligible pool is exhausted. Settlement in a locked mode cannot advance any challenge or achievement. Newly issued claim responses retain xp:0 for compatibility; objectives contain no XP reward field.


Daily chest milestones and challenge swapping have been removed. Only daily challenge and achievement claims grant rewards. Retired callable routes reject `failed-precondition` before configuration loading, receipt replay or writes. The loader overrides legacy deployed milestone/swap settings with an empty milestone list and zero swap limits/cost. Status retains compatibility fields `milestones:[]`, `swapsUsed:0`, `swapCost:0`, `swapsPerDay:0`; badge counts exclude milestones. Existing persisted legacy fields are retained. Earlier publication and verification records below describe historical behavior.

The implementation is gated to `mystic-motors-sandbox`, or `demo-test` with the Firestore emulator configured. All five callables reject production before loading feature data. Race progress and bootstrap additions are skipped outside these environments. No production configuration, rules or networking changes are needed.

## Configuration and scope

Three documents are loaded and validated through `src/challenges/config.ts`, cached for 60 seconds outside emulators:

- `/GameData/v1/config/ChallengesConfig`
- `/GameData/v1/catalogs/ChallengesCatalog`
- `/GameData/v1/catalogs/AchievementsCatalog`

Missing or disabled ChallengesConfig skips race progress and returns `unavailable` from feature endpoints. Malformed enabled configuration fails validation on feature endpoints; normal race settlement logs the failure and continues without challenge processing. Review seed values before publication: five daily objectives (four normal, one hard), milestone thresholds 2/4/5, one swap for 10 gems, normal rewards 500 coins +50 mastery XP, hard rewards 1,000 coins +100 mastery XP +20 spell shards. Milestones pay 500 coins, 10 gems, and one common crate respectively. Achievement rewards and points depend on each entry's tier. These are local catalog values, not hardcoded reward rules.

Objectives support stat, target, sum/max aggregation and exact-match map/mode/position/car/stat filters. An entry with `enabled:false` is excluded. Catalog objectives are copied into each daily assignment so its targets and rewards survive mid-day catalog edits. Swapping is disabled regardless of stored state or deployed configuration.

The reset uses `gameDayIndex` and `dayIndexStartMs` with DailyRewardsConfig.resetOffsetMinutes. Daily login rewards currently use a rolling 24-hour claim timer; their claim time is deliberately unchanged. Unclaimed challenge rewards expire at the absolute daily rollover. Client clocks cannot advance progress or claim windows. The `__testNowMs` hook is accepted only in the demo-test emulator.

Ramp-specific, comeback and Untouchable entries remain disabled because current collected signals do not establish ramp identity, starting place, or a complete zero-hit history. Shield wording follows the existing Shield spell. New-car wins mean first race recorded by this feature for that car, not reconstructed historical usage. Globetrotter uses the ten enabled menu maps with backend IDs 0 through 9; the existing `track_01` default is normalized to 0. No changes were made to prepareRace's existing track selection.

## Storage

`Players/{uid}/Challenges/Daily` holds `{dayIndex,challenges:[{objective,progress,claimed}],milestonesClaimed,swapsUsed,retiredIds}`. `Players/{uid}/Achievements/Progress` holds `{progress,claimed,points,stats,carsRaced,mapsWon}`. New sandbox accounts get empty state; existing accounts migrate lazily. Status only writes when the day or account-derived progress changes. No scheduled reset job or per-objective documents are used.

Mutations load required configuration before writing anything, then check `Players/{uid}/Receipts/{opId}`, grant rewards, update state and write the completed receipt in one Firestore transaction. There is no new persistent in-progress reservation to strand after a configuration error or process crash. A failed transaction leaves its changes uncommitted and the same opId can retry. Concurrent duplicates read the completed cached result after transaction retry; different-op claims still contend on shared state and cannot double grant. Legacy in-progress reservations remain rejected because an older function instance may still be executing them. Completed receipts replay and failed legacy receipts can retry. Coins, gems and crates use existing reward-bundle/inventory helpers; shards increment Economy/Stats.spellShards in the same transaction. XP uses existing mastery helpers and writes the profile mastery/level progress consistently.

## Callable contract

`getChallengesStatus({})` returns:

```
{
  serverNowMs, resetAtMs, dayIndex,
  challenges: [{id,title,description,iconKey,stat,target,progress,state,hard,unit,rewards,xp}],
  milestones: [{index,target,state,rewards}],
  achievements: [{id,title,description,iconKey,category,tier,target,progress,state,rewards,points}],
  completedCount,dailyCount,swapsUsed,swapCost,swapsPerDay,
  dailyClaimableCount,achievementClaimableCount,achievementPoints
}
```

Challenge/milestone states are `in_progress`, `claimable`, `claimed`; achievement states are `in_progress`, `claimable`, `completed`, `hidden`. Achievement tiers are the strings Bronze/Silver/Gold. Categories are Racing/Spells/Stunts/Collection/Social. Hidden entries mask title and description until completed. Tier chains use `chainId` and expose the next unclaimed tier. Reward lines are `{kind,quantity,skuId?}`; kinds are coins/gems/crate/item/spellShards. The daily badge count includes only daily challenge claims.

- `claimDailyChallenge({challengeId,opId})`
- `claimChallengeMilestone({milestoneIndex,opId})`: retired; always rejects `failed-precondition`
- `swapDailyChallenge({challengeId,opId})`: retired; always rejects `failed-precondition`
- `claimAchievement({achievementId,opId})`

Each returns `{success,status,rewards,coins:{before,after},gems:{before,after},xp}`. `status` is a complete post-action snapshot. Errors include unauthenticated, invalid-argument, not-found, failed-precondition, resource-exhausted, aborted and unavailable. Callable exports are added to `src/callables.ts`, consumed by the existing gameApi gateway; `src/index.ts` intentionally deploys only the gateway rather than individual callable endpoints.

## Race data and trust

Progress is read before writes and committed inside the existing `recordRaceResult` transaction. Its existing participant `cachedResult` lock also covers challenge progress; replaying a race cannot add progress. Rejected races cannot add progress. Responses add `newlyCompletedChallengeIds` and `newlyCompletedAchievementIds` only when challenge processing succeeds. Configuration failures skip the optional feature. If settlement fails after entering challenge processing, the failed transaction is abandoned and normal race settlement is attempted once without challenge reads or writes. Normal race validation and the participant cached-result check remain in force, so fallback cannot bypass validation or double-grant rewards. The skipped race does not later backfill challenge progress; later races retry the feature. A shared database outage can still prevent normal settlement, and normal settlement errors still propagate. `serverRecordRaceResult` currently marks a race as server-sourced and directs clients to normal settlement; it does not independently settle rewards.

| Stat | Source | Validation |
|---|---|---|
| Race/win/place/mode | Existing race document and recordRaceResult settlement | Same existing finish-order and mode validation |
| Map | Persisted prepareRace trackId | Normalize numeric IDs; only configured maps count toward Globetrotter |
| Car/new-car win | Participant carId from prepareRace loadout | Feature-owned bounded car history; old participants without a car cannot count |
| Police escape | Settlement's POLICE timeRatio win | Existing server elapsed-time clamp |
| Elimination wins | Settlement mode + place | Never taken from client stats |
| Friend races | Social/Friends intersected with stored lobby participant IDs | Client friend counters ignored |
| Clan points | Positive ranked trophy delta while Clan/State has a clanId | Client point counters ignored |
| Cars owned/maxed | Garage/Cars plus CarEvolutionV2Catalog.maxStarLevel | Refreshed on status and every claim; no client counts |
| Nitro uses/wall hits | Optional client raceStats | Finite nonnegative integer, per-stat config maximum |
| Drift metres | Optional client raceStats | Config maximum, server elapsed seconds, configured metres/second and prepared car speed cap |
| Maximum speed | Optional client raceStats | Config maximum and prepared catalog top speed including boost |
| Spell casts/hits/blocks | Optional client raceStats | Finite nonnegative integer and config maximum; unavailable sources omitted by client |
| Spell types used | Optional client string array | Bounded strings; unique type count cannot exceed accepted cast count |

Prepared car speed uses the same resolved catalog/tuning values already sent to the client, persisted only in sandbox. Old races without this snapshot cannot earn speed/distance objectives. Invalid or clamped numeric fields are logged with uid/raceId/stat. Absent, negative, fractional count and non-finite values cannot satisfy a zero-condition objective. Reward progression uses only known counters, never arbitrary client object keys.

Client telemetry remains untrusted. Bounds limit magnitude, not authenticity. The existing multiplayer finish-order path still accepts a client-supplied finish order; this implementation does not harden or expand that protocol. Historical lifetime event stats are not backfilled; server garage ownership is current and other counters start when this feature is enabled.

## Verification and sandbox publication

Build: `npm run build`.

Local test command: `npx firebase emulators:exec --project demo-test --config firebase.test.json --only firestore,auth "npm run emu:test -- test/challenges.test.ts test/challenges.receipts.test.ts --silent"`.

The suite covers deterministic reset, reward and receipt idempotency, target binding, concurrent claims and same-op swaps, insufficient funds/limits, milestone currency and actual inventory crate grants, account achievements, stat clamps/omissions, actual race settlement retry compatibility, invalid races, map normalization and production gating. Failure tests cover malformed/unavailable challenge configuration, corrupt challenge state, rollback after queued challenge writes, fallback reward idempotency, normal race validation, recovery on a later race, action configuration failure/retry and concurrent atomic receipts.

The seeder's new `--only` option is sandbox-only and rejects missing/unknown paths. This dry-run selects exactly the feature documents and does not read credentials or write cloud data:

```
npm run tools:seed-sandbox -- --dry-run --only /GameData/v1/config/ChallengesConfig,/GameData/v1/catalogs/ChallengesCatalog,/GameData/v1/catalogs/AchievementsCatalog
```

After sandbox publication is authorized, remove `--dry-run` to seed only those three documents. Use `npm run deploy:sandbox -- functions:mm-sandbox:gameApi`; the `mm-sandbox` codebase selector is required. On Windows the existing script runs through Git Bash (`npm_config_script_shell` can select its bash executable). Do not use the production scripts. Local edits and emulator verification alone do not make the feature live.


## Verified live sandbox smoke

After the scoped seed and gameApi deployment, `tools/verifyChallengesSandbox.cjs` verified the deployed gateway using an authenticated temporary sandbox user and an Admin-minted App Check token. It passed deterministic status/reset, gem swap/limit/replay, challenge reward/replay/double-claim rejection, milestone crate inventory/replay, and account achievement points/replay/double-claim rejection. The temporary auth user and exact player document subtree were deleted and their absence verified. The saved result is `tools/data/challenges-sandbox-verification.json`; it contains no credentials. The harness never edits existing users or catalogs. This is backend HTTP verification, not a device gameplay test.

## Failure-isolation regression verification (2026-10-09)

The challenge and atomic-receipt suites passed all 30 emulator tests, including injected configuration/read/write failures, rollback, retry, and duplicate-reward protection. Race start passed all three tests. Race preparation passed both tests when rerun with a 60-second timeout for emulator setup. The TypeScript build passed.

The subsequent release review updated the two obsolete AI-difficulty assertions against the verified active prepareRace contract; all seven AI tests now pass. Expanded backend coverage and the remaining initialization regression failures are recorded in [CHALLENGES_RELEASE_VERIFICATION.md](CHALLENGES_RELEASE_VERIFICATION.md). The full backend test suite is not certified clean.

These safeguards change backend request processing only, with no new Unity frame updates or rendering work. They do not guarantee availability during shared infrastructure outages. On fallback, normal race rewards are retained but that race's challenge progression is skipped.
