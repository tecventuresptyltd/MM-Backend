# Mystic Motors — V2 Transformation Summary

> **Purpose:** A comprehensive overview of every system redesigned, added, or rebalanced in the V2 backend overhaul — and the player psychology each change targets.

---

## Executive Summary

The V2 transformation was a ground-up rebuild of the game's progression, monetisation, and retention architecture. The goal: turn a shallow "race and forget" loop into a deep, multi-layered engagement engine that gives players reasons to return every hour, every day, for 200+ hours.

### Before V2 (Legacy Problems)

| Problem | Impact |
|---------|--------|
| **Flat progression** — cars upgraded with a simple coin payment, no timers, no gating | Players maxed content in days, then churned |
| **No return-to-claim loop** — nothing to come back for between sessions | D1/D7 retention cratered |
| **Spell system was cosmetic** — spells upgraded with flat tokens, no strategic depth | No engagement beyond "equip and forget" |
| **No anti-smurf protection** — rewards identical at every rank | High-skill players tanked rank to farm easy wins |
| **Single progression axis** — only Player Level mattered | No sense of long-term investment or mastery |
| **No soft monetisation** — only hard IAP (gems for items) | Low conversion, whale-dependent |
| **No idle economy** — game only generated value while actively playing | No push notification hooks, no FOMO |
| **Mastery system was a skeleton** — typed but never implemented | Content gating was impossible |

### After V2

Every system below was designed, implemented, seeded, and deployed to address these problems.

---

## 1. The Three-Queue Engagement Engine

**Retention mechanism:** At any point, the player has **up to 3 parallel timers ticking** — creating constant reasons to return.

| Queue | System | Timer Range | Creates |
|-------|--------|-------------|---------|
| **Pit Crew** | Car upgrades | 1 min → 24 hr | "My car will be ready in 2 hours" |
| **Library** | Spell research | 30 min → 12 hr | "My spell levels up tonight" |
| **Crate Bay** | Crate opening | 1 hr → 24 hr | "I have a Legendary crate opening tomorrow" |

**Why this works:**
- **Loss aversion** — an idle queue slot feels like wasted potential
- **Session scheduling** — timers naturally align with breakfast/lunch/dinner/bedtime check-ins
- **Push notification hooks** — every completed timer is a reason to send a notification
- **Multiple daily sessions** — players open the app 3-5× per day to claim and re-queue

### What Changed in Code
- Built `startCarEvolutionV2`, `claimCarEvolutionV2`, `skipCarEvolutionV2` in [evolutionV2.ts](file:///Users/christianwbrown/Mystic%20Motors%20Code/MM-Backend/src/garageV2/evolutionV2.ts)
- Built `startSpellResearchV2`, `claimSpellResearchV2`, `skipSpellResearchV2` in [researchV2.ts](file:///Users/christianwbrown/Mystic%20Motors%20Code/MM-Backend/src/spellsV2/researchV2.ts)
- Built `startCrateUnlockV2`, `claimCrateRewardV2`, `skipCrateUnlockV2` in [slotsV2.ts](file:///Users/christianwbrown/Mystic%20Motors%20Code/MM-Backend/src/cratesV2/slotsV2.ts)
- Each system uses **idempotent `opId` pattern** to prevent double-claims on retry

---

## 2. Car Progression Overhaul

**Retention mechanism:** Cars are no longer instantly maxable. Each car is a multi-week investment.

### Before → After

| Aspect | Legacy | V2 |
|--------|--------|-----|
| Levels per car | Instant coin purchase | **10 levels** with XP + timer + coin cost |
| Time to max | Minutes | **3 days (T1) → 65 days (T5)** |
| Upgrade feel | Transactional | Investment + anticipation |
| Stat system | Flat bonuses | **Dynamic 5-stat budget** (TopSpeed, Accel, Handling, BoostRegen, BoostPower) via archetype profiles |

### The V2 Car Loop

```
Race → Earn Car XP → Fill XP bar → Pay coins → Start upgrade timer → Wait/Skip → Claim → Level up → Repeat
```

### Tier System (15 cars across 5 tiers)

| Tier | Cars | Total XP | Total Timer | Total Coins | Days to Max (10 races/day) |
|------|------|----------|-------------|-------------|---------------------------|
| 1 | 1 | 4,850 | ~6 hr | 7,700 | ~3.3 |
| 2 | 2 | 12,350 | ~22 hr | 19,100 | ~8.3 |
| 3 | 2 | 24,600 | ~35 hr | 51,000 | ~16.4 |
| 4 | 3 | 48,500 | ~53 hr | 118,000 | ~32.4 |
| 5 | 7 | 97,000 | ~77 hr | 293,000 | **~64.7** |

**Retention impact:** A Tier 5 car alone provides 2+ months of daily engagement. Seven Tier 5 cars = over a year of content.

### What Changed in Code
- Created `CarsCatalog.json` with per-car, per-level XP/timer/coin/stat data for all 15 cars
- Built `rebalanceEconomy.py` to regenerate level arrays from tier parameters
- Implemented `CarStatsBudgetConfig` with archetype profiles (Tank, Speedster, Specialist)
- `recordRaceResult` now awards Car XP (1:1 with Player XP) and caps at per-level thresholds

---

## 3. Spell Research System

**Retention mechanism:** Spells require XP grinding *and* timed research *and* shard currency. Triple-gate prevents rushing.

### The Research Loop

```
Equip spell → Race to earn Spell XP → Hit XP cap → Pay Spell Shards → Wait timer → Claim → Level up
```

### Exponential Shard Curve

| To Level | Shards | Timer | Cumulative |
|----------|--------|-------|-----------|
| 2 | 50 | 30 min | 50 |
| 3 | 200 | 2 hr | 250 |
| 4 | 750 | 6 hr | 1,000 |
| 5 | **2,000** | 12 hr | **3,000** |

**Design intent:** Level 2 is near-free (hook). Level 5 costs **40× more** than level 2 (endgame grind). 16 spells × 3,000 shards = 48,000 total shards → ~160 hours of gameplay.

### What Changed in Code
- Updated `SpellEvolutionV2Catalog.json` with the new shard/timer values
- Built Spell XP tracking into `recordRaceResult` (10 XP/race + 25 win bonus, applied to all 3 equipped spells)
- XP cap gating prevents research until the player has actually *used* the spell in races

---

## 4. Mastery System (The Non-Skippable Gate)

**Retention mechanism:** Mastery is the **only system gems cannot accelerate**. It ensures minimum play time before content unlocks, preventing pay-to-win perception.

### Before → After

| Aspect | Legacy | V2 |
|--------|--------|-----|
| Progression gate | Player Level (could be boosted) | **Mastery Rank** (unskippable) |
| Content unlock | Arbitrary level numbers | **Tier gates** at Ranks 5/10/20/30 |
| XP source | Single (Player XP) | **Dual-input** (Car XP × 1.0 + Spell XP × 0.33) |

### Mastery XP Formula

```
masteryXP = (carXpAwarded × 1.0) + (spellXpAwarded × 0.33)
```

Average per race: ~157 Mastery Points.

### Tier Gates

| Gate | Rank | Mastery XP | Gameplay Hours | Calendar Days (10/day) |
|------|------|-----------|----------------|----------------------|
| Tier 2 | 5 | 30,000 | ~10 hr | ~19 days |
| Tier 3 | 10 | 115,000 | ~37 hr | ~73 days |
| Tier 4 | 20 | 310,000 | ~99 hr | ~198 days |
| Tier 5 | 30 | **550,000** | **~175 hr** | ~350 days |

### Why This Matters for Retention

- **Whale protection:** Spending $500 on gems still won't unlock Tier 5. Players must play ~175 hours of actual races.
- **Content drip:** New tiers feel like expansion packs unlocking over months
- **Prestige ranks (31-50):** Post-endgame bragging rights keep hardcore players engaged
- **1 Spell Token per rank-up:** Creates anticipation — "2 more ranks until I can unlock Thunderstrike"

### What Changed in Code
- Created `MasteryConfig.json` with 50 rank thresholds
- Built `getMasteryRank()` and `getMasteryProgress()` in [configV2.ts](file:///Users/christianwbrown/Mystic%20Motors%20Code/MM-Backend/src/core/configV2.ts)
- `recordRaceResult` now computes and writes `masteryXp` using the weighted formula
- `purchaseTierLicenseV2` checks `masteryRank >= tier.requirements.masteryRank` before allowing purchase

---

## 5. Rank-Scaled Rewards (Anti-Smurf System)

**Retention mechanism:** Playing at your true rank is *always* more rewarding than tanking. Eliminates the incentive to derank.

### How It Works

All three reward types now scale with the player's trophy rank:

| Reward | Scaling Method |
|--------|---------------|
| **Coins** | `COIN_CAPS_BY_RANK` — Unranked: 2k/race → Hypersonic III: 41k/race |
| **XP** | `EXP_CAPS_BY_RANK` — Unranked: 100/race → Hypersonic III: 250/race |
| **Spell Shards** | `shardBase(rank)` — Unranked: 5 base → Hypersonic III: 25 base |

### Anti-Smurf Proof

A Bronze III player placing 1st gets **8 shards**.
A Gold III player placing 6th gets **11 shards**.

→ No mathematical incentive to tank your rank.

### Additional Deterrents

| Mode | Penalty |
|------|---------|
| UNRANKED | 70% of normal rewards |
| ELIMINATION (5th-8th) | Reduced position multipliers (8th = 30% of 1st) |

### What Changed in Code
- Rewrote shard calculation in `recordRaceResult` to use `shardBase = 5 + (20 × (rank / 50))` × position multipliers
- Removed the old flat `byPosition` lookup from `SpellEvolutionV2Catalog.json`

---

## 6. Dynamic Gem Skip Formula

**Monetisation mechanism:** Every timer in the game now has a "Finish Now" button with psychologically-optimised pricing.

### The Formula

```
gemsToSkip = max(5, ⌈20 × (remainingHours ^ 0.85)⌉)
```

### Why This Design

| Property | Psychological Effect |
|----------|---------------------|
| **5-gem floor** | "Just finish it" impulse purchases for short timers |
| **0.85 exponent** | Volume discount — longer waits cost less per hour, encouraging patience OR bulk purchases |
| **20 gems/hr anchor** | Mental math: "1 hour = 20 cents" feels trivial |
| **Continuous curve** | No awkward price jumps — every second has a natural price |

### Example Skip Costs

| Remaining | Gems | Real $ |
|-----------|------|--------|
| 5 min | 5 | $0.05 |
| 30 min | 12 | $0.12 |
| 1 hour | 20 | $0.20 |
| 8 hours | 120 | $1.20 |
| 24 hours | 300 | $3.00 |

### What Changed in Code
- Replaced the old `hours × gemsPerHour` linear formula with `Math.pow(remainingHours, 0.85)` in [configV2.ts](file:///Users/christianwbrown/Mystic%20Motors%20Code/MM-Backend/src/core/configV2.ts)
- Applied universally to car upgrades, spell research, AND crate unlocking

---

## 7. Crate Reward System

**Retention mechanism:** Crates create the "open a present" dopamine loop + cosmetic collection drive.

### Post-Race Drop Rates

| Rarity | Probability | Timer |
|--------|-------------|-------|
| No drop | 37.2% | — |
| Common | 26.7% | 1 hr |
| Rare | 10.0% | 3 hr |
| Exotic | 6.7% | 8 hr |
| Legendary | 3.3% | 12 hr |
| Mythical | 2.0% | 24 hr |

### What's Inside (per rarity)

Each crate awards **3 cosmetic items** plus rolls from a reward pool containing coins, gems, boosters, and time skips.

Higher rarity crates give:
- **More currency** (Common: 500 coins → Mythical: 10,000 coins)
- **Better boosters** (Common: 1hr → Mythical: 24hr)
- **Longer time skips** (Common: 5-15min → Mythical: 8-24hr)
- **More gems** (Common: 5 → Mythical: 100)

### Slot Pressure

- Players have **limited crate slots** (default 4, purchasable with gems)
- If all slots are full, the crate converts to fallback currency (coins + shards) — creating urgency to open crates before the next race

### What Changed in Code
- Built full V2 crate slot system with `CrateSlotsConfig.json` and `CrateRewardsConfig.json`
- Integrated crate drops into `recordRaceResult` post-race flow
- Each crate rarity has distinct weighted reward pools with boosters, time skips, and currency

---

## 8. Fuel System

**Retention mechanism:** Rate-limits the number of races per session. Creates natural session breaks and monetisation touchpoints.

### Design

| Parameter | Value |
|-----------|-------|
| Max fuel bars | 5 |
| Cost per race | 1 bar |
| Regen rate | 1 bar per 15 min |
| Full recharge from empty | 1 hour 15 min |
| Gem refuel cost | Configurable |
| Ad refuel | +3 bars |
| Fuel Cell item | +5 bars (full refill) |

### Why It Works

- **Prevents burnout** — players can't grind 50 races straight and burn out
- **Natural session length** — 5 races ≈ 15 min, aligning with mobile session norms
- **Return loop** — "I'll have fuel again in 30 min" creates a natural check-back point
- **Monetisation** — gem refuels and ad watches create revenue without being aggressive
- **Fuel Cells from crates** — connects the crate system to the fuel system

### What Changed in Code
- Built per-car fuel tracking in `Garage/Cars.{carId}.fuelBars`
- `getCarFuelStatusV2` computes current bars via time-based regen
- `refuelWithAdV2` and `useFuelCellV2` provide non-gem refuel options
- Fuel check integrated into `prepareRace` — no fuel = no race

---

## 9. Booster Economy

**Monetisation mechanism:** Boosters are priced to be the best perceived deal in the shop, driving habitual purchasing.

### 2× Multiplier Boosters

| Type | 6 hr | 12 hr | 24 hr | 7 days |
|------|------|-------|-------|--------|
| Coin 2× | 80 | 130 | 200 | 1,000 |
| Shard 2× | 80 | 130 | 200 | 1,000 |
| XP 2× | 60 | 100 | 160 | 800 |

### Pricing Psychology

- Priced at **60-80% of theoretical gem value** — always feels like a deal
- 7-day packs include 30-43% volume discount vs. daily price
- XP boosters 20% cheaper (lower monetisable value)
- Different booster types **stack** — driving combo purchases ("Coin 2× + Shard 2× = double everything!")

### What Changed in Code
- `BoostersCatalog.json` updated with all durations and prices
- `activateBooster` function handles activation, duration tracking, and expiry
- `recordRaceResult` checks `hasCoinBooster`, `hasExpBooster`, `hasShardBooster` and applies 2× multipliers

---

## 10. ELO Trophy System & Multi-Mode Support

**Engagement mechanism:** Competitive ranking with real stakes creates emotional investment.

### Trophy Settlement Pattern

```
prepareRace() → Pre-deduct worst-case loss from trophies
  ↓
startRace() → Lock race state
  ↓
recordRaceResult() → Calculate actual ELO delta → Settle (refund/deduct difference)
```

**Why pre-deduct:** Prevents trophy exploits from force-quit or network disconnect. Players can't dodge losses.

### Three Game Modes

| Mode | Trophies | Rewards | Purpose |
|------|----------|---------|---------|
| **RANKED** | Full ELO | 100% | Main competitive mode |
| **ELIMINATION** | Separate track | Reduced 5th-8th | High-stakes variant |
| **UNRANKED** | No change | 70% | Practice / casual play |

### 28-Tier Rank System

From "Unranked" (0 trophies) to "Hypersonic III" (7,000+ trophies). Each rank tier provides:
- Visible prestige
- Higher coin/XP/shard caps
- Access to ranked leaderboards

### What Changed in Code
- Full ELO calculation in [economy.ts](file:///Users/christianwbrown/Mystic%20Motors%20Code/MM-Backend/src/race/economy.ts)
- Gamemode-aware trophy fields and reward configs
- Trophy sync to clans, friends, and global leaderboards

---

## 11. Unified Player Timeline

The V2 economy is designed so all systems converge on a natural player lifecycle:

| Phase | Hours | What Happens | Player Emotion |
|-------|-------|-------------|----------------|
| **Tutorial** | 0-2 | First car, first spells, learn mechanics | Curiosity |
| **Hook** | 2-10 | Tier 1 cars max fast, spells start leveling, first crate opens | **Excitement** |
| **Engagement** | 10-37 | Tier 2-3 unlocks, deck building matters, ranked climbing | **Investment** |
| **Mid-Game** | 37-99 | Tier 3-4, multiple cars and spells, competitive ranked | **Dedication** |
| **Late-Game** | 99-175 | Tier 4-5, long upgrade timers, mastery grinding | **Commitment** |
| **Endgame** | 175-250 | Tier 5 cars, all spells near max, prestige ranks | **Completionist** |
| **Post-Game** | 250+ | Collection, prestige, leaderboard climbing | **Pride** |

### Key Design Principles

1. **Nothing is instant after hour 10.** Every upgrade has a meaningful wait time.
2. **Three timers always ticking.** The player always has a reason to come back.
3. **Mastery is the hard gate.** Gems accelerate but cannot leapfrog.
4. **Higher ranks = faster progression.** Climbing rank *feels good* beyond just prestige.
5. **Exponential curves everywhere.** Early levels are cheap, late levels are expensive. This creates a "sunk cost" feeling that reduces churn.

---

## 12. Comprehensive Change Log

### New V2 Cloud Functions (17 functions)

| Function | System | Purpose |
|----------|--------|---------|
| `startCarEvolutionV2` | Pit Crew | Queue a car upgrade |
| `claimCarEvolutionV2` | Pit Crew | Claim finished upgrade |
| `skipCarEvolutionV2` | Pit Crew | Gem-skip upgrade timer |
| `getPitCrewStatusV2` | Pit Crew | Read queue status |
| `startSpellResearchV2` | Library | Queue spell research |
| `claimSpellResearchV2` | Library | Claim finished research |
| `skipSpellResearchV2` | Library | Gem-skip research timer |
| `getLibraryStatusV2` | Library | Read queue status |
| `setSpellDeckV2` | Spells | Set 3-spell deck |
| `selectActiveSpellDeckV2` | Spells | Switch active deck |
| `startCrateUnlockV2` | Crates | Begin crate opening |
| `claimCrateRewardV2` | Crates | Claim opened crate |
| `skipCrateUnlockV2` | Crates | Gem-skip crate timer |
| `getCrateSlotsStatusV2` | Crates | Read slot status |
| `purchaseTierLicenseV2` | Tiers | Buy tier access |
| `getCarFuelStatusV2` | Fuel | Read fuel bars |
| `useSpeedupV2` | Speedups | Apply time skip item |

### Modified Functions

| Function | What Changed |
|----------|-------------|
| `recordRaceResult` | Car XP, Spell XP, Mastery XP, rank-scaled shards, crate drops, booster multipliers |
| `calculateSkipCost` | Dynamic `^0.85` exponent formula (was linear) |

### New/Updated Seed Files

| File | Change |
|------|--------|
| `CarsCatalog.json` | Full 15-car, 10-level, 5-tier progression data |
| `SpellEvolutionV2Catalog.json` | 50/200/750/2000 shard costs |
| `MasteryConfig.json` | 50 rank thresholds, Rank 30 = 550k |
| `CrateRewardsConfig.json` | 5-tier reward pools with boosters/skips |
| `CrateSlotsConfig.json` | Slot limits, unlock timers, fallback rewards |
| `CarStatsBudgetConfig.json` | Archetype profiles and stat distribution |
| `FuelConfig.json` | Regen rate, max bars, refuel costs |
| `PlayerSlotsConfig.json` | Purchasable Pit Crew/Library slots |
| `TiersCatalog.json` | Tier requirements and license costs |
| `SpeedUpsCatalog.json` | Time skip items and durations |

### Source of Truth Document

All formulas, numbers, and design rationale are documented in [GAME_ECONOMICS.md](file:///Users/christianwbrown/Mystic%20Motors%20Code/MM-Backend/docs/GAME_ECONOMICS.md).

---

## 13. Expected Impact on Key Metrics

| Metric | Mechanism | Expected Effect |
|--------|-----------|----------------|
| **D1 Retention** | Crate timer (1hr) + Tier 1 instant upgrades | Players return same day to claim |
| **D7 Retention** | Tier 2 unlock at ~10hr + multiple upgrade timers | Week-long engagement loop established |
| **D30 Retention** | Tier 3 unlock at ~37hr + spell research grind | Monthly milestone creates loyalty |
| **Session Count** | 3 parallel timers = 3-5 check-ins/day | +60-100% daily sessions |
| **Session Length** | Fuel system caps at 5 races (~15 min) | Focused sessions, less burnout |
| **ARPU** | Skip temptation + booster deals + crate purchases | More touchpoints for micro-transactions |
| **Uninstall Rate** | Sunk cost (invested time in cars/spells/mastery) | Players less likely to abandon progress |
| **Competitive Integrity** | Anti-smurf scaling + ELO pre-deduction | Fair matches → less frustration |
