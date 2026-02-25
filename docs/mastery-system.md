# Mastery System Documentation

> **Last Updated**: February 25, 2026  
> **Status**: Live on Sandbox  

---

## Overview

**Mastery Rank is the new Player Level.**

The old `level` field (driven by `exp` XP) has been replaced by the **Mastery System**. Mastery rank is a global account-level progression that is earned across all races, based on Car XP and Spell XP earned. It gates spell unlocks and tier purchases.

---

## Key Concepts

| Old System | New System |
|---|---|
| `profile.level` (player level) | `profile.masteryRank` |
| `profile.exp` (XP from race) | `profile.masteryXp` (cumulative mastery XP) |
| `expProgress / expProgressDisplay` | Now reflect mastery progress |
| Spells unlocked at player level X | Spells unlocked at mastery rank X |
| Tiers unlocked at player level X | Tiers unlocked at mastery rank X |

---

## How Mastery XP is Earned

Mastery XP is calculated **only** in `recordRaceResult` after every race.

### Formula:

```
Mastery XP Gained = round(
    (Car XP Awarded × carWeight) + (Spell XP Awarded × spellWeight)
)
```

### Weights (from `MasteryConfig`):
- `carWeight = 1.0` — 100% of car XP counts
- `spellWeight = 0.33` — 33% of spell XP counts

### Car XP Calculation:

Car XP is based on finishing position and trophy rank:

```
Car XP = EXP_CAP[trophyRank][finishPlace] × boosterMultiplier
```

Base ranges from **100** (Unranked) to **208** (Hypersonic), multiplied by:

| Place | Multiplier |
|---|---|
| 1st | × 1.20 |
| 2nd | × 1.14 |
| 3rd | × 1.09 |
| 4th | × 1.03 |
| 5th | × 0.97 |
| 6th | × 0.91 |
| 7th | × 0.86 |
| 8th | × 0.80 |

**Car XP = 0** if the car is XP-capped (needs star evolution) or at max star level.

### Spell XP Calculation:

Each spell in the active deck (3 spells) earns XP per race:

```
Spell XP per spell = xpPerRace (10) + xpPerWin (25 if 1st place)
```

| Result | Spell XP per spell |
|---|---|
| Loss (any place) | 10 XP |
| Win (1st place) | 35 XP (10 + 25) |

Max spell XP per race with 3 spells: **105 XP**

**Spell XP = 0** if the spell is XP-capped (needs research level-up) or at max level (5).

### Example Calculation (1st place, Unranked):

```
Car XP       = round(100 × 1.2) = 120
Spell XP     = 3 spells × 35  = 105

Mastery XP   = (120 × 1.0) + (105 × 0.33)
             = 120 + 34.65
             = round(154.65)
             = 155 MP ✅
```

### Example Calculation (8th place, Unranked):

```
Car XP       = round(100 × 0.8) = 80
Spell XP     = 3 spells × 10   = 30

Mastery XP   = (80 × 1.0) + (30 × 0.33)
             = 80 + 9.9
             = round(89.9)
             = 90 MP
```

---

## Mastery Ranks (1–50)

Ranks are determined by cumulative mastery XP vs. thresholds in `MasteryConfig.json`.

### Key Milestones:

| Rank | Total MP Required | Notable Gate |
|---|---|---|
| 0 | 0 | Starting rank |
| 1 | 2,000 | |
| 2 | 5,000 | |
| 3 | 10,000 | |
| 4 | 18,000 | |
| **5** | **30,000** | 🔓 **Tier 2** · Spell: Storm Aura |
| **10** | **115,000** | 🔓 **Tier 3** · Spell: Void Blades |
| **15** | **215,000** | Spell: Supersonic |
| **20** | **310,000** | 🔓 **Tier 4** · Spell: Overdrive |
| **25** | **480,000** | Spell: Tiny Terror |
| **30** | **680,000** | 🔓 **Tier 5** · Spell: Shockwave |
| **35** | **900,000** | Spell: Fireball |
| **40** | **1,170,000** | 🔓 **Tier 6** · Spell: Phase Shift |
| **50** | **1,924,000** | Max Rank |

> Full thresholds are in `seeds/Atul-Final-Seeds/MasteryConfig.json`

---

## What is Stored in Firestore Profile

After every race (if mastery XP changed), `Players/{uid}/Profile/Profile` is updated:

```
masteryXp           → cumulative total mastery XP
masteryRank         → current mastery rank (0–50)
level               → same as masteryRank (backward compat)
expProgress         → mastery XP earned within current rank
expToNextLevel      → total XP range for current → next rank
expProgressDisplay  → human readable string e.g. "225 / 2000"
exp                 → raw XP from races (kept for backward compat)
```

---

## Race Result Response (`recordRaceResult`)

### Old Response (removed):
```json
{
  "xpProgress": {
    "xpGained": 120,
    "totalXp": 1320,
    "boosterXp": 0,
    "expProgress": 198,
    "xpToNextLevel": 315,
    "levelBefore": 5,
    "levelAfter": 6
  },
  "mastery": {
    "xpGained": 155,
    "totalXp": 225,
    "rankBefore": 0,
    "rankAfter": 0,
    "rankUp": false
  }
}
```

### New Response (unified):
```json
{
  "xpProgress": {
    "xpGained": 155,        // mastery XP earned this race
    "totalXp": 225,         // cumulative mastery XP
    "expProgress": 225,     // XP earned within current rank
    "xpToNextLevel": 2000,  // total XP needed to complete current rank
    "levelBefore": 0,       // mastery rank before race
    "levelAfter": 0,        // mastery rank after race
    "levelUp": false        // true if rank increased
  }
}
```

> The `mastery` object is gone. `xpProgress` IS the mastery progress.

---

## XP Booster Effect

If the player has an active XP booster (`profile.boosters.exp.activeUntil > now`):

- Car XP is **doubled** (boosterMultiplier = 2)
- This doubles the car contribution to mastery XP
- Spell XP is **NOT** affected by the XP booster
- The `rewards.boosterXp` field shows the extra XP from the booster

---

## Spell Unlock via Mastery

Spells with `requiredLevel > 0` in `SpellsCatalog.json` can only be unlocked (via `startSpellResearchV2`) once the player's `masteryRank >= requiredLevel`.

> **Note**: `requiredLevel` in the SpellsCatalog is now treated as `requiredMasteryRank`.

### Current Spell Gates:

| Spell | Required Mastery Rank |
|---|---|
| Ice Lock, Meteor Wrath, Phantom Veil | 0 (starter, always available) |
| Storm Aura | 5 |
| Void Blades | 10 |
| Supersonic | 15 |
| Overdrive | 20 |
| Tiny Terror | 25 |
| Shockwave | 30 |
| Fireball | 35 |
| Phase Shift | 40 |
| Crimson Crush, God Hammer, Phantom Mirage, Power Out, Sky Reaper | -1 (not available) |

---

## Spell XP Caps (from `SpellEvolutionV2Catalog`)

To level up a spell via research, the spell must first reach its XP cap:

| Spell Level | XP Cap | Races to Cap (win) | Research Cost |
|---|---|---|---|
| Level 1 | 100 XP | ~3 wins | Free |
| Level 2 | 250 XP | ~8 wins | 100 shards + 30 min |
| Level 3 | 500 XP | ~15 wins | 250 shards + 1 hour |
| Level 4 | 1,000 XP | ~29 wins | 500 shards + 2 hours |
| Level 5 | MAX (no cap) | — | 1000 shards + 4 hours |

---

## Spell Tokens on Rank Up

When mastery rank increases, the player earns **1 spell token per rank gained**.  
These are stored in `Economy/Stats.spellTokens`.

---

## Relevant Files

| File | Purpose |
|---|---|
| `seeds/Atul-Final-Seeds/MasteryConfig.json` | Rank thresholds, weights, maxRank |
| `seeds/Atul-Final-Seeds/SpellEvolutionV2Catalog.json` | Spell XP caps, research costs |
| `seeds/Atul-Final-Seeds/SpellsCatalog.json` | Spell requiredLevel (= mastery rank gate) |
| `src/race/index.ts` | `recordRaceResult` — mastery XP calculation & writes |
| `src/core/configV2.ts` | `getMasteryRank()`, `getMasteryProgress()`, `getMasteryConfig()` |
| `src/spellsV2/researchV2.ts` | Spell unlock mastery rank check |
| `src/garageV2/tiersV2.ts` | Tier purchase mastery rank check |
| `tools/seedV2Catalogs.mjs` | Seeds MasteryConfig + all V2 configs to sandbox/prod |

---

## ⚠️ Known Issues / Outstanding Items

1. **Starter spell unlock bug** (`researchV2.ts` line 136):  
   Spells with `requiredLevel: 0` are currently blocked by the V2 unlock check (`requiredMasteryRank <= 0` throws). This means starter spells cannot be unlocked via V2 research flow. Needs a dedicated fix.

2. **`expProgress` / `expProgressDisplay` in Firestore** are only updated if `masteryXpGained > 0`. A player's first race always earns XP so this is fine in practice.
