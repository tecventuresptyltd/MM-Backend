# Backend consolidation — `gameApi`

*What we changed, why, and what it saves.*

---

## The problem

Firebase charges for **containers that stay switched on**, not for functions.

To avoid players waiting 15–20 seconds for a function to wake up, 34 of our functions
were set to "always warm". Each one held its own container running 24 hours a day.

```
34 always-on containers  =  $303.86 / month
```

That was roughly **two-thirds of a ~$522/month Google Cloud bill**, spent on idle time.

Worse, warmth is priced per function. We had 162 player-facing functions but could
only afford to keep 34 warm. **The other 128 stayed slow** — not because they had to
be, but because making them fast cost too much.

## The waste nobody noticed

When Firebase deploys, it puts a **complete copy of the whole codebase** into every
container. So the container for `prepareRace` already had all 162 functions loaded in
memory. So did the container for `openCrate`. All 34 were identical inside.

Firebase then labelled each one:

```
Container 1  →  all 162 functions loaded  →  "answer only prepareRace"
Container 2  →  all 162 functions loaded  →  "answer only openCrate"
Container 3  →  all 162 functions loaded  →  "answer only checkSession"
             ... 34 identical containers
```

**We were paying 34 times for the same thing**, each copy restricted to one entry point.

## What we did

Added one function, `gameApi`, that reads the incoming URL and runs the right function
itself:

```
/gameApi/prepareRace    →  runs prepareRace
/gameApi/openCrate      →  runs openCrate
/gameApi/checkSession   →  runs checkSession
   ... all 162
```

Its container has the same 162 functions loaded that every other container always had.
The difference is that **nothing restricts it to one**, so 2 containers now do the work
that 34 were doing.

**No game logic was changed.** Firebase already builds a small web server around each
function; we wrote one server and pointed them all into it. Sign-in, App Check and error
handling are untouched, because the same Firebase code still runs them.

It also **stays on Firebase**. No new platform, no Docker, no virtual machine. It
deploys with the same `npm run deploy:sandbox` command as everything else.

## What it costs

One container with 1 CPU and 512 MB, left running all month: **$9.86**.

That is the only number that matters.

| | Containers | Cost / month |
|---|---|---|
| **Before** | 34 | **$303.86** |
| **After** | 2 | **$19.71** |
| **Saving** | | **$284.15 / month · $3,410 / year** |

Sandbox went the same way: **$44.35 → $19.71**, once the three functions that hardcoded
their own warm setting were changed to match the rest.

### And every function is warm now

The saving is only half the point. Before, we rationed speed — 34 functions were fast
because that was the budget. Now **all 162 are warm**, and it costs 94% less.

| | Speed change |
|---|---|
| The 34 that were already warm | No change — already fast |
| The other 128 that were cold | **Much faster** — no more 15–20s wake-up |

The work itself — reading the database, calculating rewards — takes exactly as long as
before. Warmth removes the wake-up delay, not the work.

## What happens when more players arrive

`gameApi` handles **80 requests at the same instant per container**, with a minimum of 2:

```
2 containers × 80 = 160 simultaneous requests
```

Past that, Google starts more containers within seconds, and shuts them down again when
traffic drops. This is exactly how the existing functions already behave — nothing about
scaling changed.

**"Thousands of players" is not "thousands of simultaneous requests."** A player races
for two minutes, then sends one result. Between actions they send nothing. A few thousand
active players usually means only tens of requests at any given instant, so 160 is a lot
of headroom.

### What growth actually costs

| | |
|---|---|
| The 2 always-on containers | **$19.71/month, fixed** — this is the number that replaced $303.86 |
| Extra containers during busy periods | Billed **per second**, only while they exist |
| Quiet hours | Back to 2 containers |

A container that spins up for 30 seconds during a spike costs a fraction of a cent. Even
one running non-stop for a whole extra month adds only about $10.

The expensive part was never the busy periods — it was the **34 containers sitting idle
at 3am**. That is what this fixes, and it is now fixed at 2.

The maximum is not set explicitly, so it uses Firebase's default of 100 containers —
about 8,000 simultaneous requests. Raising it is a one-line change if we ever need it.

## Where this stands

| | Warm containers | Cost / month |
|---|---|---|
| **Sandbox** | 2 — `gameApi` only | **$19.71** ✅ |
| **Production** | 35 | **$303.86** |
| **Unity client** | switch added, pointed at sandbox, not yet tested in a build | |

Sandbox is already on the new system. Production is still on the old one.

## Deploying to production is TWO steps, not one

This is the part that is easy to get wrong.

**Deploying `gameApi` does not switch anything off.** It *adds* a function. The 34 old
warm functions keep their own containers running at the same time, so the bill briefly
goes **up**, not down:

```
Step 1 — deploy gameApi to production
    34 old functions   ->  34 containers
    gameApi            ->   2 containers
                           ------------------
                           36 containers   =  ~$324 / month   (more than today)
```

The saving only arrives when the old ones are switched off:

```
Step 2 — set the 34 old functions to cold
    34 old functions   ->   0 containers
    gameApi            ->   2 containers
                           ------------------
                            2 containers   =   $19.71 / month  ✅
```

Sandbox is already at $19.71 because **both** steps were done there.

### Why we have not done step 2 in production

Those 34 functions are the rollback. While the live game still calls them, they must
stay warm — if anything goes wrong with `gameApi`, the client switches back and traffic
lands on functions that are already warm and serving.

Step 2 does not delete anything. The 34 stay deployed and still work; they just stop
holding a container when nobody calls them, which is fine, because by then nobody does.

### Full order

1. ~~Deploy `gameApi` to sandbox~~ ✅ done
2. ~~Switch the sandbox warm functions off~~ ✅ done — sandbox is at $19.71
3. Test the full game loop in sandbox  ← **we are here**
4. Deploy `gameApi` to production — bill goes up to ~$324 temporarily
5. Ship the Unity client pointing at production `gameApi`, watch it
6. **Set the 34 old functions to cold** ← the $284/month lands here

## What this does not fix

This addresses about **$304 of a ~$522 bill**. The rest is database reads and log
storage, which consolidation does not touch. Worth looking at separately — though this
change will trim some of it for free, since a config cache that currently exists 34
times over will exist once.

One unrelated item worth raising: the **Google for Startups Cloud Program** awards
credits from $2,000 to $200,000. It is an application form, not an engineering project,
and could be worth more than every optimisation here combined.

## Files changed

**Backend**

| File | |
|---|---|
| `src/server/gameApi.ts` | the deployed function |
| `src/server/app.ts` | the router |
| `src/server/registry.ts` | finds the 162 functions |
| `src/index.ts` | +4 lines to register it |
| `src/race/lobbyService.ts` | `createLobby` / `joinLobby` now warm in production only |
| `src/upgrades/upgradeTaskHandler.ts` | `completeUpgradeTask` now warm in production only |
| `tools/copyBuildAssets.mjs` | copies `profanityList.json` into the build — without it the function crashes on startup |
| `tools/compareConsolidated.mjs` | sends the same request to both backends and compares the replies |
| `package.json` | express as a direct dependency |

**Unity** — 4 existing files, 44 lines, no new files

| File | |
|---|---|
| `FirebaseFunctionCaller.cs` | the switch that picks which backend to call |
| `FirebaseConstants.cs` | the two `gameApi` addresses |
| `BackendHealth.cs` | 1 line |
| `Manager.Firebase.cs` | 2 lines |

The switch lives in `FirebaseConstants.GameApiURL`:

| Value | Behaviour |
|---|---|
| `""` | Original per-function URLs — the rollback |
| `SandboxGameApiURL` | Sandbox `gameApi` |
| `ProductionGameApiURL` | Production `gameApi` |

## Not yet verified

- **The Unity project has not been compiled.** The edits are four one-line substitutions,
  but confirm it builds before relying on it.
- **The backend test suite has not been run.** It needs Java installed for the Firestore
  emulator, which was not available on the machine that made these changes.
