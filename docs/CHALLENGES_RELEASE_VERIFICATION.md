# Challenge backend release verification � 2026-10-09

Reviewed all pending backend feature files: challenge definitions/loading, daily and achievement state, action receipts/rewards, race preparation/settlement hooks, callable gateway registration, new-player initialization, all three seed documents, manifest, selective seeder and sandbox verification harness. This review executed local demo-test emulators and dry runs only; no deployments, cloud seeding or live verification harness execution.

## Changes from this review

- Updated two obsolete AI helper tests after tracing the active prepareRace branches: legacy bot real stats are zero placeholders, then prepareRace adds aiLevel/performanceRanges; the car-relative branch uses resolveCarStats. No gameplay logic changed.
- Added integration assertions for valid AI level/ranges and the persisted boosted challenge speed cap returned by prepareRace.
- Added a challenge bootstrap regression confirming initial documents and preservation of existing achievement points on repeat initialization.

## Verification

`npm run build` passed, including asset copy. `git diff --check` passed.

The challenge-only seeder dry run selected exactly ChallengesConfig, ChallengesCatalog and AchievementsCatalog (three documents), and wrote nothing.

Expanded command:

```
npx firebase emulators:exec --project demo-test --config ./firebase.test.json --only firestore,auth "npm run emu:test -- --runTestsByPath test/challenges.test.ts test/challenges.receipts.test.ts test/race.startRace.test.ts test/race.prepareRace.test.ts test/race.aiDifficulty.test.ts test/initializeUser.test.ts test/v2/initializeUser.v2.test.ts test/auth.init.test.ts --testTimeout=60000"
```

Result: 46 passed / 6 failed tests across 8 suites (5 passed / 3 failed).

| Suite | Result |
| --- | --- |
| challenges.test.ts | 26 passed |
| challenges.receipts.test.ts | 5 passed |
| race.startRace.test.ts | 3 passed |
| race.prepareRace.test.ts | 2 passed |
| race.aiDifficulty.test.ts | 7 passed |
| auth.init.test.ts | 3 passed, 3 failed |
| initializeUser.test.ts | 2 failed |
| v2/initializeUser.v2.test.ts | 1 failed |

Challenge coverage includes bootstrap preservation, deterministic daily/reset, completed milestone counts, currency/XP and crate reward paths, duplicate and concurrent claims, same-op receipt replay, input binding, swap cost/limits/insufficient funds, account achievement refresh, race stat validation, absent zero-condition telemetry, settlement retries, numeric maps, invalid races, production gating and fault isolation/rollback/recovery for configuration, state and reward errors.

## Remaining broader regression failures

Auth initialization expects profile level 1 but gets 0; repeated initialization expects 1000 coins but gets 11000; starter deck expects 5 slots but gets 3. Direct initialization likewise expects profile level 1 but gets 0, and expects a starter inventory quantity 1 but gets undefined. The itemId-mode initialization suite expects a starter count 1 but gets 0. These expectations and the initialization paths other than the new challenge documents were left unchanged.

Full backend test-suite cleanliness is not certified. Device gameplay verification is outside this backend review.


Baseline check: temporary copies of the HEAD initializeUser implementation and auth wrapper were imported by isolated copies of the failing tests. The direct and itemId suites reproduced the same three failures; the separately rerun auth suite reproduced the same three failures (three other auth tests passed). All six broader failures therefore reproduce without the pending challenge initialization hooks. Temporary modules/tests were removed after verification; existing source and seed files were never replaced.
