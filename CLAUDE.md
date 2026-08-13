# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Firebase Cloud Functions (2nd gen, TypeScript, Node 20) backend for the Mystic Motors Unity mobile game. Everything is server-authoritative: the client never writes currency, trophies, levels, or inventory directly. `admin-website/` is a separate Next.js admin dashboard that calls these functions.

Two Firebase projects (`.firebaserc` aliases): `sandbox` → `mystic-motors-sandbox`, `prod` → `mystic-motors-prod`. All functions deploy to `us-central1` (`src/shared/region.ts`).

## Commands

```bash
npm run build                # tsc -p tsconfig.json  → lib/
npm test                     # boots firestore+auth emulators, then runs jest
npm run emu:test             # jest only, against already-running emulators (127.0.0.1:6767/6768)
npm run emu:test -- test/race.prepareRace.test.ts    # single test file
npm run emu:test -- -t "trophy delta"                # single test by name
npm run test:v2              # v2 suite only (USE_ITEMID_V2=true, test/v2/)
npm run tools:seed-sandbox   # seed GameData catalogs into sandbox from seeds/Atul-Final-Seeds/
npm run deploy:sandbox       # safe deploy script (bash)
npm run deploy:production    # safe deploy script (bash, owner-only)
```

Tests always run through the emulators — there is no unit-only mode. `test/setup.ts` forces `GCLOUD_PROJECT=demo-test` and the emulator hosts. One-off ops scripts live in `tools/` and are run with `tsx tools/<script>.ts` or `node tools/<script>.mjs`.

On Windows the deploy/seed helpers are `.sh` — use the Bash tool, not PowerShell, for those.

## Deployment rules (non-negotiable)

`.agent/workflows/deploy.md` and `docs/DEPLOYMENT_GUARDRAILS.md` govern this. Summary:

- **Always ask which environment (SANDBOX or PRODUCTION) and get explicit confirmation before proposing any deploy.**
- Never propose raw `firebase deploy` / `gcloud config set project`. Only `npm run deploy:sandbox` or `npm run deploy:production`.
- Production deploy is hard-gated to `tecventurescorp@gmail.com` and requires typing `PRODUCTION`. Production service-account keys and prod seeding are owner-only (`SERVICE_ACCOUNTS.md`).
- A `409 Conflict` from `firebase deploy` is usually transient. Wait 2–3 minutes and verify with `gcloud functions list` before treating it as a failure.

## Architecture

### Function registration

Every deployed function must be re-exported from [src/index.ts](src/index.ts) — that file is the deploy manifest. `src/index.ts` also calls `setGlobalOptions({ region, minInstances })` and `admin.initializeApp()` before any module-level `admin.firestore()` runs, which is why modules can safely do `const db = admin.firestore()` at import time.

Wrap callables with `callableOptions()` from [src/shared/callableOptions.ts](src/shared/callableOptions.ts) rather than passing raw options. It enforces App Check by default and only allocates warm instances (`minInstances: 1`) in production when `warmInProd` is set. Functions intended for the admin dashboard or the dedicated game server pass `enforceAppCheck: false` explicitly.

Trigger types in use: `onCall` (the vast majority), `onSchedule` (leaderboard rebuilds, offer scheduler/safety-net, presence sync, maintenance activation, open-world lobby reaper), and `onTaskDispatched` + Cloud Tasks (`src/upgrades/` timer completion).

### Idempotency + receipts

Mutating callables take a client-supplied `opId` and follow this shape:

1. `checkIdempotency(uid, opId)` — returns the cached result if the op already completed, throws if in progress.
2. `createInProgressReceipt(uid, opId, reason)`.
3. `runTransactionWithReceipt(...)` or `runReadThenWriteWithReceipt(...)` from [src/core/transactions.ts](src/core/transactions.ts), which writes the success receipt inside the same transaction and a failure receipt on throw.

Receipts live at `/Players/{uid}/Receipts/{opId}`. `runReadThenWrite` ([src/core/tx.ts](src/core/tx.ts)) installs a dev-only guard that throws if you call `tx.get` after the read phase — respect the read-then-write split.

### Config / catalog layer

All game balance data lives in Firestore under `/GameData/v1/catalogs/*` and `/GameData/v1/config/*` as singleton documents, seeded from `seeds/Atul-Final-Seeds/*.json` (`gameDataCatalogs.v3.normalized.json` is the consolidated file; the individual JSONs are layered on top). Never hardcode balance values — read them through the cached loaders:

- [src/core/config.ts](src/core/config.ts) / [src/core/catalog.ts](src/core/catalog.ts) — v1/v3 catalogs (cars, spells, items, SKUs, crates, offers, ranks, XP curve, bot config), 60s in-memory TTL.
- [src/core/configV2.ts](src/core/configV2.ts) — v2 catalogs (tiers, evolution, fuel, crate slots, mastery, stat budgets).

Changing a catalog means editing the seed JSON **and** re-seeding the target project; a deploy alone does nothing.

### ID conventions

[src/core/ids.ts](src/core/ids.ts) is the authority. Opaque Crockford base32 suffixes (no I/L/O/U), 6–10 chars. Purchasable variants are `sku_{crt|key|bst|csm}_XXXX`; owned inventory entries are `{crt|key|bst|itm}_XXXX`, with `csm` SKUs mapping to `itm` items (`toItemId`). Use `parseSkuId`/`isItemId`/`ensureItemMatchesSku` instead of string surgery. The runtime is SKU-first: inventory and shop operate on variant-level `skuId`.

### Firestore shape

`docs/FIRESTORE_SCHEMA.md` is the canonical reference. The model is deliberately singleton-heavy to cut client read counts — per-player state is a handful of docs, not one doc per entity:

```
/Players/{uid}/Profile/Profile, /Economy/Stats, /Garage/Cars, /Spells/Levels,
               /SpellDecks/Decks, /Loadouts/Active, /Inventory/{skuId} (+ _summary),
               /Receipts/{opId}, /Referrals/Progress
/GameData/v1/catalogs/*, /GameData/v1/config/*
/Clans/{clanId}/{Members,Requests,Chat}
/GlobalLeaderboard/{metric}, /ClanLeaderboard/snapshot
```

Realtime Database carries the latency-sensitive/ephemeral state: `/lobbies/{lobbyId}`, `/openWorldLobbies/{shardId}`, `/chat_messages/{streamId}`, `/presence/online/{uid}`. Rules in `database.rules.json`; Firestore rules are split into `firestore.prod.rules` / `firestore.sandbox.rules`.

### V1 / V2 parallel systems

`garageV2/`, `spellsV2/`, `cratesV2/`, `speedups/`, `upgrades/` implement the newer timer/slot-based game design (tier licenses, pit-crew evolution, fuel, spell research, crate unlock slots) alongside the original `garage/`, `spells/`, `crates/`. Both sets are live and exported. Types split the same way: `src/shared/types.ts` vs `src/shared/typesV2.ts`. When touching a feature, check which generation the caller belongs to before editing.

### Race pipeline

`prepareRace` ([src/race/prepareRace.ts](src/race/prepareRace.ts)) is the heavyweight entry point: it resolves the player's car stats from catalog slider values via `resolveCarStats` ([src/race/lib/stats.ts](src/race/lib/stats.ts)) and the `CarTuningConfig` ranges, generates trophy-scaled bots (seeded RNG in `lib/random.ts`, so results are reproducible in tests), and precomputes trophy deltas from `src/race/economy.ts`. `recordRaceResult` settles the outcome. Game mode (`src/shared/gamemode.ts`) decides which trophy fields move and whether clan trophies sync.

Multiplayer runs on external dedicated servers: `lobbyService.ts` (RTDB lobbies) → `dedicatedServer.ts` (provisioning, heartbeat, and `serverRecordRaceResult`, which the game server calls with a service-account token and no App Check). `openWorldLobby.ts` is the free-roam shard registry — servers register shards, clients only pick one; occupancy is a transactional RTDB counter that self-heals from server heartbeats. Server address per environment comes from `MM_SERVER_ADDRESS` in `.env.mystic-motors-{prod,sandbox}`.

### User bootstrap

Every auth entry point (`ensureGuestSession`, `signup*`, `bind*`, `initUser`) funnels into `initializeUserIfNeeded` in [src/shared/initializeUser.ts](src/shared/initializeUser.ts), which writes the full starter state (starter car, starter spell deck, starter inventory, economy stats) from the catalogs. New player-state documents must be added there or they will be missing for every new account.

### Cross-cutting guards

- `assertNotInMaintenance(uid)` ([src/shared/maintenanceCheck.ts](src/shared/maintenanceCheck.ts)) — uses server time only; `isGameAdmin` players bypass.
- `src/shared/appVersion.ts` — minimum client version gate.
- `src/shared/profanity.ts` + `profanityList.json` — masks chat, requests, clan names; rejects profane usernames.
- `src/shared/adminAuth.ts` — admin-dashboard callables.

## Conventions

- Throw `HttpsError` with a meaningful code (`unauthenticated`, `invalid-argument`, `failed-precondition`, `not-found`, `resource-exhausted`) — the Unity client branches on these.
- Double quotes (eslint `quotes: ["error", "double"]`), `strict: true`, `isolatedModules: true`.
- `module: NodeNext` with no `"type": "module"` in package.json, so output is CommonJS and both `./foo` and `./foo.js` import specifiers work; the codebase mixes them. Jest strips the `.js` suffix via `moduleNameMapper`.
- `src/legacy/**` is excluded from the build; don't add to it.

## Known rough edges

- `firebase.test.json` points at `firestore.rules`, which does not exist in the repo (only `firestore.prod.rules` / `firestore.sandbox.rules`). If `npm test` fails to boot the emulator, that's why.
- `tools:normalize-v3` and `tools:validate-v3` in package.json reference `../tools/*.ts` and `../tsconfig.tools.json` — stale paths from when this code lived under a `functions/` subdirectory. Those scripts and files no longer exist.
- Service-account JSON keys are committed at the repo root and several `tools/` scripts `require()` them by filename; those scripts only work from the repo root.
- `docs/` is large and partly historical (`ARCHITECTURE_SUMMARY.md`, `MIGRATION_PLAN.md` describe a migration that has already happened). `docs/FIRESTORE_SCHEMA.md`, `docs/FUNCTION_CONTRACTS.md`, and `docs/RELEASE_NOTES.md` are the ones kept current; `docs/INDEX.md` is the changelog-style entry point.
