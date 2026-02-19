# 🔮 Spell V2 Progression Guide

> A complete developer reference for understanding the Spell V2 system — from account creation to maxing out spells.

---

## Table of Contents

1. [Overview](#overview)
2. [Spell Unlock Order](#spell-unlock-order)
3. [Default Spells (Starters)](#default-spells-starters)
4. [Spell Levels](#spell-levels)
5. [Spell XP System](#spell-xp-system)
6. [Spell Shards (Currency)](#spell-shards-currency)
7. [Spell Research (Library)](#spell-research-library)
8. [Skip & Speedup](#skip--speedup)
9. [Full Walkthrough Example](#full-walkthrough-example)
10. [Cost Summary Tables](#cost-summary-tables)
11. [Firestore Paths](#firestore-paths)
12. [Cloud Functions Reference](#cloud-functions-reference)

---

## Overview

The Spell V2 system has a clear progression loop:

```
🏁 Race with spells in deck
      │
      ▼
📈 Earn Spell XP (per spell) + Spell Shards (currency)
      │
      ▼
🧱 Hit the XP Cap for current level → isXpCapped = true
      │
      ▼
📚 Start Research in Library (costs Shards + time)
      │
      ▼
⏳ Wait for timer (or skip with gems / use speedup items)
      │
      ▼
✅ Claim → Spell levels up, XP resets to 0
      │
      ▼
🔁 Repeat until Level 5 (max)
```

---

## Spell Unlock Order

Spells are unlocked based on player level. The first 3 are given by default at account creation.

| #  | Spell ID            | Name             | Required Player Level | Status           |
|:--:|---------------------|------------------|-----------------------|------------------|
| 1  | `spell_2382r2jk`    | 🧊 Ice Lock      | —                     | ✅ Default starter |
| 2  | `spell_hg6ddry4`    | ☄️ Meteor Wrath   | —                     | ✅ Default starter |
| 3  | `spell_kdh7hy7r`    | 👻 Phantom Veil   | —                     | ✅ Default starter |
| 4  | `spell_1h69nt0e`    | ⚡ Storm Aura     | **5**                 | Unlockable       |
| 5  | `spell_cez3dcf4`    | 🗡️ Void Blades   | **10**                | Unlockable       |
| 6  | `spell_3tgjmyqv`    | 🚀 Supersonic     | **15**                | Unlockable       |
| 7  | `spell_vcqct6hp`    | 🏎️ Overdrive     | **20**                | Unlockable       |
| 8  | `spell_pbvvrhw7`    | 🐜 Tiny Terror    | **25**                | Unlockable       |
| 9  | `spell_mmt7v0j0`    | 💥 Shockwave      | **30**                | Unlockable       |
| 10 | `spell_cd3res63`    | 🔥 Fireball       | **35**                | Unlockable       |
| 11 | `spell_2dg5get6`    | 🔄 Phase Shift    | **40**                | Unlockable       |
| 12 | `spell_0tk74qn8`    | 🔇 Power Out      | **-1**                | 🔒 Coming soon   |
| 13 | `spell_zdgrp9zk`    | 🌩️ Sky Reaper    | **-1**                | 🔒 Coming soon   |
| 14 | `spell_11pe1m2e`    | 🔴 Crimson Crush  | **-1**                | 🔒 Coming soon   |
| 15 | `spell_f74x59gz`    | 👥 Phantom Mirage | **-1**                | 🔒 Coming soon   |
| 16 | `spell_th5ek2kw`    | 🔨 God Hammer     | **-1**                | 🔒 Coming soon   |

**Summary:** 3 starters + 8 unlockable (levels 5–40) + 5 coming soon = 16 total spells

### How "Coming Soon" Works

Spells with `requiredLevel: -1` are **hidden/disabled**. They exist in the catalog but cannot be unlocked by any player. The Unity client should show them as "Coming Soon" in the spell list.

### How Spell Unlock Works

When a player reaches the required player level, the spell becomes available. The Unity client reads the catalog's `requiredLevel` and compares it to the player's current level. If `playerLevel >= requiredLevel`, the spell is shown as "Unlockable".

The actual unlock uses the **legacy V1 `upgradeSpell` function** which takes a spell from level 0 → 1 using **Spell Tokens**. After that point, the V2 research system takes over for levels 1 → 5.

---

## Default Spells (Starters)

When a new account is created (`initializeUser`), exactly **3 spells** are granted:

### How Starters Are Selected

From `catalogHelpers.ts` → `resolveV2StarterSpellIds()`:

1. Filter spells where `isUnlocked === true` AND `requiredLevel <= 0`
2. Sort by `displayOrder` (ascending)
3. Take the first **3**

Currently, only 3 spells match this filter:
- `spell_2382r2jk` (Ice Lock) — displayOrder: 1
- `spell_hg6ddry4` (Meteor Wrath) — displayOrder: 2
- `spell_kdh7hy7r` (Phantom Veil) — displayOrder: 3

### What Gets Created

From `initializeUser.ts` → `buildDefaultSpells()`:

```
Firestore: /Players/{uid}/Spells/Levels
{
    spells: {
        "spell_2382r2jk": { xp: 0, level: 1, isXpCapped: false },
        "spell_hg6ddry4": { xp: 0, level: 1, isXpCapped: false },
        "spell_kdh7hy7r": { xp: 0, level: 1, isXpCapped: false }
    },
    unlockedAt: {
        "spell_2382r2jk": <timestamp>,
        "spell_hg6ddry4": <timestamp>,
        "spell_kdh7hy7r": <timestamp>
    }
}
```

From `initializeUser.ts` → `buildDefaultSpellDecks()`:

```
Firestore: /Players/{uid}/SpellDecks/Decks
{
    active: 1,
    decks: {
        "1": { name: "Starter", spells: ["spell_2382r2jk", "spell_hg6ddry4", "spell_kdh7hy7r"] },
        "2": { name: "Deck 2", spells: ["", "", ""] },
        "3": { name: "Deck 3", spells: ["", "", ""] },
        "4": { name: "Deck 4", spells: ["", "", ""] },
        "5": { name: "Deck 5", spells: ["", "", ""] }
    }
}
```

**Deck size = 3 spells per deck. 5 deck slots total.**

---

## Spell Levels

| Level | Meaning |
|:-----:|---------|
| **0** | Not owned — cannot use, cannot research |
| **1** | Owned/Unlocked — can use in decks, XP accumulation begins |
| **2** | First upgrade via research |
| **3** | Second upgrade via research |
| **4** | Third upgrade via research |
| **5** | **MAX** — No more XP earned, no more research possible |

Each spell has **5 attribute values** (one per level). For example, Ice Lock:

| Attribute | Lv 1 | Lv 2 | Lv 3 | Lv 4 | Lv 5 |
|-----------|:----:|:----:|:----:|:----:|:----:|
| Targets   | 1    | 1    | 1    | 2    | 2    |
| Range     | 60m  | 70m  | 80m  | 80m  | 90m  |
| Duration  | 1s   | 1s   | 1s   | 1s   | 1s   |

---

## Spell XP System

### How XP Is Earned

XP is earned **per spell** for every spell in the player's **active deck** after each race.

| Source        | XP Amount     | Condition       |
|---------------|:-------------:|-----------------|
| Base per race | **10 XP**     | Always          |
| Win bonus     | **+25 XP**    | 1st place only  |
| Spell cast    | **+5 XP**     | Per spell cast  |

So a 1st place finish = **35 XP** per spell (10 base + 25 win bonus), plus +5 per cast.

### XP Caps Per Level

Each level has a maximum XP cap. Once reached, `isXpCapped` becomes `true` and no more XP is earned for that spell until it levels up.

| Current Level | XP Cap | Meaning |
|:---:|:---:|---|
| 1 | **100 XP** | Need 100 XP before you can research to Level 2 |
| 2 | **250 XP** | Need 250 XP before you can research to Level 3 |
| 3 | **500 XP** | Need 500 XP before you can research to Level 4 |
| 4 | **1,000 XP** | Need 1,000 XP before you can research to Level 5 |
| 5 | — | MAX level, no XP earned at all |

### Important Notes

- **XP cap gating is enforced on the Unity client side**, not the backend. The backend only checks that the spell is owned (level ≥ 1) and you have enough shards.
- **At Level 5 (max), the backend explicitly stops XP accumulation** — `xpAwarded: 0` is returned.
- XP accumulates for **all 3 spells in the active deck simultaneously**.

---

## Spell Shards (Currency)

### How Shards Are Earned

Shards are earned **per race** based on finishing position:

| Position | Shards Earned |
|:--------:|:-------------:|
| 1st      | **10**        |
| 2nd      | **7**         |
| 3rd      | **4**         |
| 4th–8th  | **1**         |

### Shard Booster

If the player has an active **Shard Booster**, shards are multiplied by **2×**.

| Position | Normal | With Shard Booster |
|:--------:|:------:|:------------------:|
| 1st      | 10     | **20**             |
| 2nd      | 7      | **14**             |
| 3rd      | 4      | **8**              |
| 4th–8th  | 1      | **2**              |

### Storage

Shards are stored at: `/Players/{uid}/Economy/Stats` → `spellShards` field.

Shards are a **shared currency** — all spells draw from the same shard balance.

---

## Spell Research (Library)

### Overview

The Library is a **queue-based system** where you place spells for research (leveling up). It works like the Pit Crew for cars.

### Research Cost Table

| Target Level | Shard Cost | Timer Duration | Display |
|:---:|:---:|:---:|---|
| 1 → 2 | **100 shards** | **30 minutes** | "30 minutes" |
| 2 → 3 | **250 shards** | **1 hour** | "1 hour" |
| 3 → 4 | **500 shards** | **2 hours** | "2 hours" |
| 4 → 5 | **1,000 shards** | **4 hours** | "4 hours" |

**Total to max one spell:** 1,850 shards + 7.5 hours of timers

### Research Flow

```
1. Player taps "Research" on a capped spell
       │
       ▼
2. Unity calls startSpellResearchV2({
       opId: "unique-id",
       spellId: "spell_2382r2jk",
       targetLevel: 2
   })
       │
       ▼
3. Backend validates:
   ✅ Spell owned (level ≥ 1)
   ✅ Not at max level (< 5)
   ✅ Enough shards (≥ 100)
   ✅ Library has empty slot
   ✅ Spell not already in queue
       │
       ▼
4. Backend deducts shards, starts timer
   Spell added to Library queue at /Players/{uid}/Queues/Library
       │
       ▼
5. Timer runs... (30 min for Level 2)
       │
       ▼
6. Timer complete → Unity calls claimSpellResearchV2({
       opId: "another-id",
       slotIndex: 0
   })
       │
       ▼
7. Backend grants level up:
   - spell.level = 2
   - spell.xp = 0 (reset!)
   - spell.isXpCapped = false (reset!)
   - Slot cleared from Library queue
```

---

## Skip & Speedup

### Skip with Gems (skipSpellResearchV2)

Instantly complete research by paying gems:

**Formula:** `ceil(remainingMinutes / 60 × gemsPerHour)`, minimum `minGems`

| Config Value | Amount |
|---|---|
| `gemsPerHour` | **25 gems** |
| `minGems` | **5 gems** |

**Examples:**

| Time Remaining | Gem Cost |
|---|:---:|
| 30 min left | ceil(30/60 × 25) = **13 gems** |
| 20 min left | ceil(20/60 × 25) = **9 gems** |
| 5 min left | **5 gems** (minimum) |
| 2 hours left | ceil(120/60 × 25) = **50 gems** |
| 4 hours left | ceil(240/60 × 25) = **100 gems** |

### Speedup Items (useSpeedupV2)

Speedup items from inventory subtract time from the timer without using gems. These are obtained from crates or shop.

---

## Full Walkthrough Example

### 📦 Day 1: Account Created

You just created your account. You receive your 3 starter spells:

```
🧊 Ice Lock        → Level 1, XP: 0/100, isXpCapped: false
☄️ Meteor Wrath    → Level 1, XP: 0/100, isXpCapped: false
👻 Phantom Veil    → Level 1, XP: 0/100, isXpCapped: false

Spell Shards: 0
```

All 3 go into your Starter Deck (Deck 1). You start racing.

---

### 🏁 Racing — Earning XP + Shards

Each race, every spell in your deck earns XP, and you earn Shards.

**You play 5 races with these results:**

| Race | Position | XP per Spell | Shards Earned |
|:----:|:--------:|:------------:|:-------------:|
| 1    | 2nd      | +10          | +7            |
| 2    | 1st      | +35          | +10           |
| 3    | 3rd      | +10          | +4            |
| 4    | 5th      | +10          | +1            |
| 5    | 1st      | +35          | +10           |

**After 5 races:**

```
🧊 Ice Lock        → Level 1, XP: 100/100 ← HIT CAP! isXpCapped: true ✅
☄️ Meteor Wrath    → Level 1, XP: 100/100 ← HIT CAP! isXpCapped: true ✅
👻 Phantom Veil    → Level 1, XP: 100/100 ← HIT CAP! isXpCapped: true ✅

Spell Shards: 32
```

> **Note:** The XP cap at Level 1 is 100 XP. Race 5 gave 35 XP, but since the total (65 + 35 = 100) exactly hits the cap, XP stops at 100. No XP is wasted — it just stays capped.

---

### 💰 Need More Shards

You need **100 shards** to research Level 2, but only have 32. Keep racing!

**You play 10 more races (averaging 3rd place):**

10 races × ~4 shards = ~40 more shards. Total: ~72 shards. Still short.

**5 more races (mix of positions):**

Now you have **105 shards**. Enough!

> During all these races, your spells earned NO XP because they were already capped. The XP stays at 100/100.

---

### 📚 Start Research: Ice Lock (Level 1 → 2)

You tap "Research" on Ice Lock. Unity calls:

```
startSpellResearchV2({
    opId: "op_abc123",
    spellId: "spell_2382r2jk",
    targetLevel: 2
})
```

**Backend response:**

```json
{
    "success": true,
    "slotIndex": 0,
    "completesAt": "2026-02-18T23:30:00Z",
    "shardsPaid": 100,
    "remainingShards": 5
}
```

**Your state now:**

```
Library Queue:
  Slot 0: 🧊 Ice Lock → researching to Level 2, completes in 30 min

🧊 Ice Lock        → Level 1, XP: 100/100 (in Library)
☄️ Meteor Wrath    → Level 1, XP: 100/100, isXpCapped: true
👻 Phantom Veil    → Level 1, XP: 100/100, isXpCapped: true

Spell Shards: 5
```

---

### ⏳ Waiting 30 Minutes...

**Option A — Just wait.** Go race. Your other spells are capped so they won't earn XP, but you'll earn more Shards.

**Option B — Skip.**
With 30 min left: `ceil(30/60 × 25) = 13 gems`

**Option C — Use a Speedup item** from your inventory.

You decide to wait it out.

---

### ✅ Claim Research!

30 minutes pass. You tap "Claim". Unity calls:

```
claimSpellResearchV2({
    opId: "op_def456",
    slotIndex: 0
})
```

**Backend response:**

```json
{
    "success": true,
    "spellId": "spell_2382r2jk",
    "newLevel": 2,
    "previousLevel": 1
}
```

**Your state now:**

```
🧊 Ice Lock        → Level 2, XP: 0/250, isXpCapped: false  ← LEVELED UP! 🎉
☄️ Meteor Wrath    → Level 1, XP: 100/100, isXpCapped: true
👻 Phantom Veil    → Level 1, XP: 100/100, isXpCapped: true

Spell Shards: 5
Library: Empty
```

> **Ice Lock's XP reset to 0!** And the new cap is 250 XP (higher than before).
> The spell's attributes are now using Level 2 values (Range: 70m instead of 60m, etc.)

---

### 🔁 The Cycle Continues

Now you race again. Ice Lock earns XP toward the 250 cap, while Meteor Wrath and Phantom Veil are still capped (waiting for shards to research them too).

You can research Meteor Wrath once you have 100 shards again. You can have **multiple spells in the Library queue** if you have enough slots.

---

### 📊 Full Journey of One Spell

```
Level 1 (start — granted at account creation)
  │  Race → earn 10 XP/race (+25 if 1st place)
  │  Fill XP to 100
  ▼
  📚 Research: pay 100 shards, wait 30 min
  ▼
Level 2
  │  XP reset to 0
  │  Race → fill XP to 250
  ▼
  📚 Research: pay 250 shards, wait 1 hour
  ▼
Level 3
  │  XP reset to 0
  │  Race → fill XP to 500
  ▼
  📚 Research: pay 500 shards, wait 2 hours
  ▼
Level 4
  │  XP reset to 0
  │  Race → fill XP to 1,000
  ▼
  📚 Research: pay 1,000 shards, wait 4 hours
  ▼
Level 5 (MAX) 🎉
  └── No more XP earned. No more research. Fully maxed!
```

---

## Cost Summary Tables

### Total Cost to Max One Spell (Level 1 → 5)

| Resource | Total Required |
|----------|:--------------:|
| Spell Shards | **1,850** |
| Research Time | **7 hours 30 minutes** |
| Spell XP from races | **1,850 XP** |

### Total Cost to Max All 11 Available Spells

| Resource | Total Required |
|----------|:--------------:|
| Spell Shards | **20,350** (1,850 × 11) |
| Research Time | **82.5 hours** (7.5h × 11) |

> Note: Research time can overlap if you have multiple Library slots.

### Races Required (Rough Estimate)

Assuming average finish position of 3rd (earning 4 shards + 10 XP per race):

| Milestone | Races Needed |
|---|:---:|
| Cap XP for Level 1 (100 XP) | ~10 races |
| Earn 100 shards for Level 2 | ~25 races |
| Cap XP for Level 2 (250 XP) | ~25 races |
| Earn 250 shards for Level 3 | ~63 races |
| Cap XP for Level 3 (500 XP) | ~50 races |
| Earn 500 shards for Level 4 | ~125 races |
| Cap XP for Level 4 (1000 XP) | ~100 races |
| Earn 1000 shards for Level 5 | ~250 races |

---

## Firestore Paths

### Player Data

| Path | Contains |
|------|----------|
| `/Players/{uid}/Spells/Levels` | Spell levels, XP, and isXpCapped status |
| `/Players/{uid}/Economy/Stats` | `spellShards` balance |
| `/Players/{uid}/Queues/Library` | Library research queue (active timers) |
| `/Players/{uid}/SpellDecks/Decks` | All 5 deck configurations |
| `/Players/{uid}/Loadouts/Active` | `activeSpellDeck` — which deck is selected |

### Spell Levels Document Structure

```
/Players/{uid}/Spells/Levels
{
    spells: {
        "spell_2382r2jk": {
            level: 2,
            xp: 145,
            isXpCapped: false
        },
        "spell_hg6ddry4": {
            level: 1,
            xp: 100,
            isXpCapped: true
        }
    },
    // Legacy format (fallback read)
    levels: {
        "spell_2382r2jk": 2,
        "spell_hg6ddry4": 1
    },
    unlockedAt: {
        "spell_2382r2jk": <timestamp>,
        "spell_hg6ddry4": <timestamp>
    }
}
```

### Library Queue Document Structure

```
/Players/{uid}/Queues/Library
{
    slots: [
        {
            spellId: "spell_2382r2jk",
            targetLevel: 3,
            startedAt: <timestamp>,
            completesAt: <timestamp>,
            shardsPaid: 250
        }
    ],
    maxSlots: 1
}
```

### Game Config

| Path | Contains |
|------|----------|
| `/GameData/v2/config/SpellEvolutionV2Catalog` | Research costs, XP config, shard rewards |
| `/GameData/v1/Catalogs/SpellsCatalog` | All spell definitions, requiredLevel, attributes |

---

## Cloud Functions Reference

### startSpellResearchV2

**Purpose:** Begin researching a spell to the next level.

```
Request:  { opId: string, spellId: string, targetLevel: number }
Response: { success: true, slotIndex, completesAt, shardsPaid, remainingShards }
```

**Validations:**
- Player owns the spell (level ≥ 1)
- Spell not at max level (< 5)
- Player has enough shards
- Library has available slot
- Spell not already in queue

---

### claimSpellResearchV2

**Purpose:** Claim a completed research and level up the spell.

```
Request:  { opId: string, slotIndex: number }
Response: { success: true, spellId, newLevel, previousLevel }
```

**What it does:**
- Verifies timer has elapsed
- Increments spell level
- Resets XP to 0 and isXpCapped to false
- Clears the Library slot

---

### skipSpellResearchV2

**Purpose:** Skip remaining research time by paying gems.

```
Request:  { opId: string, slotIndex: number }
Response: { success: true, gemsSpent, spellId, newLevel }
```

**Cost formula:** `max(ceil(remainingMinutes / 60 × 25), 5)`

---

### getLibraryStatusV2

**Purpose:** Get current Library queue status (read-only).

```
Request:  (none — uses auth)
Response: { slots: [...], maxSlots: number }
```

Each slot includes: spell ID, target level, time remaining, skip cost.

---

### recordRaceResult (spell XP portion)

**Purpose:** After each race, XP is awarded to all spells in the active deck.

**XP per race:** `xpPerRace (10) + xpPerWin (25 if 1st place)`

**Behavior:**
- If spell is at max level → no XP awarded
- If spell is already XP capped → no XP awarded
- XP is clamped at the cap (never exceeds)
- Returns `spellXpResults[]` with details for Unity to display

---

*Last updated: 2026-02-18*
