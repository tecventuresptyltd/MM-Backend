# Mystic Motors — V2 Game Economics Bible

> **Source of Truth** — All pricing, progression, rewards, and formulas for the Mystic Motors economy.
> Last updated: 2026-03-25
>
> **Design Model**: All costs derived from `cost = target_races × avg_earnings_at_expected_rank`. Mastery gates derived from "3 cars at 70% per tier" rule.

---

## Table of Contents

1. [Currencies](#1-currencies)
2. [Gem Pricing & IAP](#2-gem-pricing--iap)
3. [Time Skip Pricing](#3-time-skip-pricing)
4. [Dynamic Skip Formula](#4-dynamic-skip-formula)
5. [Boosters](#5-boosters)
6. [Race Rewards](#6-race-rewards)
7. [Car Progression](#7-car-progression)
8. [Spell Progression](#8-spell-progression)
9. [Crate System](#9-crate-system)
10. [Mastery & Tier Gating](#10-mastery--tier-gating)
11. [Unified Player Timeline](#11-unified-player-timeline)
12. [Design Principles](#12-design-principles)

---

## 1. Currencies

| Currency | Type | Earned From | Spent On |
|----------|------|-------------|----------|
| **Coins** | Soft | Races (scales with rank), crates | Car upgrades, tier unlocks, shop items |
| **Gems** | Hard | IAP, ads, events | Time skips, boosters, crate purchases |
| **Spell Shards** | Soft | Races (scales with rank), crates | Spell research (leveling spells) |
| **Mastery XP** | Non-tradeable | Races (derived from car XP + spell XP) | Mastery rank progression, tier gating |

### Mastery XP Formula

```
masteryXP = (carXpAwarded × 1.0) + (spellXpAwarded × 0.33)
```

Average per race: ~157 MP (at ~150 car XP + ~20 spell XP).

---

## 2. Gem Pricing & IAP

**Anchor: 1 gem ≈ $0.01 USD** at base rate. Larger packs provide bonus value (up to +100%).

| Pack | Price (USD) | Gems | $/Gem | Bonus |
|------|-------------|------|-------|-------|
| Handful | $0.99 | 80 | $0.012 | — |
| Pouch | $4.99 | 500 | $0.010 | +25% |
| Chest | $9.99 | 1,200 | $0.008 | +50% |
| Vault | $19.99 | 2,800 | $0.007 | +75% |
| Treasury | $49.99 | 7,500 | $0.007 | +88% |
| Hoard | $99.99 | 16,000 | $0.006 | +100% |

---

## 3. Time Skip Pricing

Purchasable in the shop. Applied to any active queue (car upgrade, spell research, or crate opening).

| Duration | Gems | Effective Rate (gems/hr) |
|----------|------|--------------------------|
| 5 min | 5 | 60 (min floor) |
| 15 min | 8 | 32 |
| 30 min | 12 | 24 |
| 1 hour | 20 | **20 (base rate)** |
| 3 hours | 50 | 16.7 |
| 8 hours | 120 | 15 |
| 24 hours | 300 | 12.5 |
| 3 days | 700 | 9.7 |
| 7 days | 1,400 | 8.3 |

Longer durations get volume discounts (up to ~58% off the base rate).

---

## 4. Dynamic Skip Formula

Used for the **"Finish Now"** button on any active timer. Gives a continuous gem cost for any arbitrary remaining time.

```
gemsToSkip = max(5, ⌈20 × (remainingHours ^ 0.85)⌉)
```

Where `remainingHours = remainingSeconds / 3600`.

**Properties:**
- **Anchor:** 1 hour remaining = exactly 20 gems
- **Exponent 0.85** creates the volume discount curve
- **Floor of 5 gems** for anything under ~15 minutes — creates impulse "just finish it" purchases
- **Always rounds up** (ceiling) — no fractional gem prices

**Example:** 12h 13m 22s remaining → `20 × 12.222^0.85` = **189 gems**

---

## 5. Boosters

2× multiplier on the specified reward type for all races during the duration. Stacking: one booster per type active at a time, different types can run simultaneously (e.g. Coin 2× + XP 2× together).

| Booster | 6 hr | 12 hr | 24 hr | 7 days |
|---------|------|-------|-------|--------|
| **Coin 2×** | 80 | 130 | 200 | 1,000 |
| **Shard 2×** | 80 | 130 | 200 | 1,000 |
| **XP 2×** | 60 | 100 | 160 | 800 |

XP boosters priced ~20% cheaper (XP has lower direct monetizable value).

7-day packs include a ~30-43% volume discount vs. 7 × daily price. Boosters are intentionally priced **below raw gem value** (60-80% of theoretical value) to make them feel like the best deal in the shop, driving habitual purchasing.

---

## 6. Race Rewards

### 6.1 Coin Rewards

Coins scale with **trophy rank** and **finish position**. Higher ranks earn dramatically more.

Coin formula uses `COIN_CAPS_BY_RANK` with difficulty modifiers (0.85–1.15×):

| Rank | 1st | 2nd | 3rd | 4th | 8th |
|------|------|------|------|------|------|
| Unranked | 2,000 | 1,500 | 1,200 | 900 | 900 |
| Bronze III | 2,800 | 2,100 | 1,700 | 1,300 | 1,300 |
| Silver III | 3,900 | 2,900 | 2,300 | 1,800 | 1,800 |
| Gold III | 5,400 | 4,100 | 3,200 | 2,400 | 2,400 |
| Platinum III | 7,500 | 5,600 | 4,500 | 3,400 | 3,400 |
| Diamond III | 10,500 | 7,900 | 6,300 | 4,700 | 4,700 |
| Master III | 14,800 | 11,100 | 8,900 | 6,600 | 6,600 |
| Champion III | 20,900 | 15,700 | 12,500 | 9,400 | 9,400 |
| Hypersonic III | 41,300 | 31,000 | 24,800 | 18,600 | 18,600 |

**UNRANKED mode:** 70% of normal rewards.
**ELIMINATION mode:** Reduced 5th-8th rewards (8th gets 30% of 1st).

### 6.2 XP Rewards (Player & Car)

XP scales with rank. Position multipliers: `[1.2, 1.14, 1.09, 1.03, 0.97, 0.91, 0.86, 0.80]`

| Rank | 1st | 4th | 8th |
|------|-----|-----|-----|
| Unranked | 120 | 103 | 80 |
| Silver III | 152 | 131 | 101 |
| Gold III | 175 | 151 | 116 |
| Platinum III | 199 | 171 | 132 |
| Diamond III | 222 | 191 | 148 |
| Champion III | 246 | 212 | 164 |
| Hypersonic III | 250 | 215 | 166 |

Car XP mirrors player XP (same amount awarded to the car used in the race).

### 6.3 Spell Shard Rewards

> [!IMPORTANT]
> Shards scale with trophy rank (same as XP) to **prevent smurfing**. Playing at your true rank and placing 6th earns more than smurfing 2+ ranks below and placing 1st.

**Formula:** `shards = round(shardBase(rank) × positionMult[place])`

`shardBase` interpolates linearly from **5** (Unranked) to **25** (Hypersonic III).
Position multipliers: same as XP `[1.2, 1.14, 1.09, 1.03, 0.97, 0.91, 0.86, 0.80]`

| Rank | 1st | 2nd | 3rd | 4th | 6th | 8th |
|------|-----|-----|-----|-----|-----|-----|
| Unranked | 6 | 6 | 5 | 5 | 5 | 4 |
| Bronze III | 8 | 8 | 8 | 7 | 6 | 6 |
| Silver III | 11 | 10 | 10 | 9 | 8 | 7 |
| Gold III | 14 | 14 | 13 | 12 | 11 | 10 |
| Platinum III | 17 | 16 | 15 | 14 | 13 | 11 |
| Diamond III | 19 | 18 | 17 | 16 | 15 | 13 |
| Master III | 22 | 21 | 20 | 19 | 16 | 14 |
| Champion III | 25 | 24 | 23 | 22 | 19 | 17 |
| Hypersonic III | **30** | 29 | 27 | 26 | 23 | **20** |

**Anti-smurf proof:** Bronze III 1st (8) < Gold III 6th (11). No incentive to tank.

**ELIMINATION mode:** Uses reduced position multipliers for 5th-8th: `[1.2, 1.14, 1.09, 1.03, 0.84, 0.72, 0.54, 0.36]`

### 6.4 Spell XP Rewards

Flat (not rank-scaled), awarded to each spell in the active deck:

| Event | Spell XP |
|-------|----------|
| Per race | 10 |
| Win bonus (1st place) | +25 |
| Per spell cast | +5 |

---

## 7. Car Progression

**15 cars** across **5 tiers** (3 per tier: Tank, Speedster, Specialist), each with **10 levels** (0→9). One car can be upgrading at a time (Pit Crew queue).

### 7.1 The Upgrade Loop

```
Race → Fill XP bar → Pay coins → Wait timer → Claim → Level up (XP resets) → Repeat
```

**Free Skip Window**: Timers ≤ 5 minutes are free to skip instantly (GoW-style). Configured via `freeSkipThresholdSeconds: 300` in CarEvolutionV2Catalog.

### 7.2 Upgrade Timers Per Level

| Level | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|-------|--------|--------|--------|--------|--------|
| 0→1 | 0m ⚡ | 15m | 1h | 2h | 4h |
| 1→2 | 0m ⚡ | 30m | 2h | 4h | 8h |
| 2→3 | 5m ⚡ | 45m | 3h | 6h | 12h |
| 3→4 | 10m | 1h | 4h | 8h | 16h |
| 4→5 | 15m | 1.5h | 5h | 10h | 20h |
| 5→6 | 20m | 2h | 6h | 12h | 24h |
| 6→7 | 25m | 3h | 8h | 16h | 32h |
| 7→8 | 30m | 4h | 10h | 20h | 40h |
| 8→9 | 30m | 5h | 12h | 24h | 48h |
| **Total** | **2.3h** | **24h** | **63h** | **126h** | **252h** |

⚡ = Free skip (≤ 5 min). T1 first 3 levels are instant. T5 caps at 48h.

**Starter Speed-Up Crate**: New players receive a "Racer's Welcome Pack" with ~6.5h of speed-ups (10×5m, 5×15m, 3×1h, 1×3h) covering all T1 + early T2 timers.

### 7.3 XP Required Per Level

Derived: `xp = target_races × xp_base_at_rank × level_weight`

| Level | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|-------|--------|--------|--------|--------|--------|
| 0→1 | 150 | 400 | 950 | 1,900 | 3,500 |
| 1→2 | 150 | 500 | 1,200 | 2,400 | 4,400 |
| 2→3 | 200 | 600 | 1,400 | 2,900 | 5,300 |
| 3→4 | 250 | 700 | 1,700 | 3,400 | 6,200 |
| 4→5 | 250 | 800 | 1,900 | 3,900 | 7,100 |
| 5→6 | 350 | 1,000 | 2,400 | 4,800 | 8,800 |
| 6→7 | 400 | 1,200 | 2,800 | 5,800 | 10,500 |
| 7→8 | 450 | 1,400 | 3,300 | 6,700 | 12,500 |
| 8→9 | 500 | 1,600 | 3,800 | 7,700 | 14,000 |
| **Total** | **2,700** | **8,200** | **19,450** | **39,500** | **72,300** |

### 7.4 Coin Costs Per Level

Derived: `cost = (level_weight / 52.5) × target_races × avg_coins_at_rank × 0.75`

| Level | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|-------|--------|--------|--------|--------|--------|
| 0→1 | 1,100 | 4,500 | 17,000 | 59,000 | 189,000 |
| 1→2 | 1,600 | 6,700 | 25,500 | 89,000 | 284,000 |
| 2→3 | 2,100 | 8,900 | 34,500 | 118,000 | 378,000 |
| 3→4 | 3,200 | 13,500 | 51,500 | 178,000 | 567,000 |
| 4→5 | 4,300 | 18,000 | 68,500 | 237,000 | 756,000 |
| 5→6 | 5,400 | 22,500 | 85,500 | 296,000 | 945,000 |
| 6→7 | 6,400 | 26,500 | 103,000 | 355,000 | 1,135,000 |
| 7→8 | 8,600 | 35,500 | 137,000 | 474,000 | 1,510,000 |
| 8→9 | 10,500 | 44,500 | 171,000 | 592,000 | 1,890,000 |
| **Total** | **43,200** | **180,600** | **693,500** | **2,398,000** | **7,654,000** |

### 7.5 Races to Max One Car (target)

| Tier | Target Races | Expected Rank | Avg Coins/Race | Days (10/day) |
|------|-------------|---------------|----------------|---------------|
| 1 | **30** | Bronze II | 1,875 | 3 |
| 2 | **80** | Silver III | 2,925 | 8 |
| 3 | **160** | Platinum III | 5,625 | 16 |
| 4 | **280** | Master III | 11,100 | 28 |
| 5 | **450** | Ascendant III | 22,050 | 45 |

### 7.6 Stat Diversification

All 3 cars in a tier have equal total stat budgets but distribute across 5 stats differently:

| Stat | Tank | Speedster | Specialist |
|------|------|-----------|------------|
| Top Speed | 15% | **30%** | 20% |
| Acceleration | 15% | **25%** | 20% |
| Handling | **25%** | 15% | 20% |
| Boost Regen | **25%** | 10% | 20% |
| Boost Power | 20% | 20% | 20% |

Handling range: 35 (low) → 75 (high). All other stat ranges unchanged.

---

## 8. Spell Progression

**16 spells**, each with **5 levels**. One spell can be researching at a time (Library queue). **Mastery-gated** — later levels require a minimum mastery rank.

### 8.1 The Research Loop

```
Equip spell in deck → Race to earn Spell XP → Hit XP cap → Check mastery gate → Pay shards → Wait timer → Claim → Level up → Repeat
```

### 8.2 Spell XP Caps (per level, before research can start)

| Level | XP Cap |
|-------|--------|
| 1 | 50 |
| 2 | 150 |
| 3 | 350 |
| 4 | 700 |

Level 5 = max (no further XP gain).

### 8.3 Research Costs, Timers & Mastery Gates

| To Level | Shards | Timer | Mastery Gate |
|----------|--------|-------|-------------|
| 2 | 30 | 30 min | None |
| 3 | 150 | 2 hr | **Rank 3** |
| 4 | 550 | 6 hr | **Rank 8** |
| 5 | 1,400 | 12 hr | **Rank 25** |
| **Total/spell** | **2,130** | **~20.5 hr** | |

**Non-starter unlock**: 30 shards + 30 min timer.

### 8.4 Skip Cost

Base rate: **20 gems/hour**, min 5 gems. Free skip under 5 minutes (`freeSkipThresholdSeconds: 300`).

### 8.5 Full Roster Progression

| Milestone | Total Shards | Races (~10 shards avg/race) |
|-----------|-------------|-----------------------------|
| Max 1 spell | 2,130 | ~213 |
| Max 4 spells (1 deck) | 8,520 | ~852 |
| Max 8 spells (2 decks) | 17,040 | ~1,704 |
| Max ALL 16 spells | 34,080 | ~3,408 |

---

## 9. Crate System

Cosmetic-only rewards. One crate can be opening at a time (Crate queue).

### 9.1 Open Timers (earned from races)

| Rarity | Open Timer | Design Intent |
|--------|-----------|---------------|
| Common | 1 hr | Extend session or quick return |
| Rare | 3 hr | Morning→afternoon, afternoon→evening |
| Exotic | 8 hr | Overnight or work-day |
| Legendary | 12 hr | Half-day commitment |
| Mythical | 24 hr | Next day — maximum anticipation |

### 9.2 Crate Drop Rates (from races)

| Rarity | Weight | Probability |
|--------|--------|-------------|
| No reward | 27.9 | 37.2% |
| Common | 20 | 26.7% |
| Rare | 7.5 | 10.0% |
| Exotic | 5 | 6.7% |
| Legendary | 2.5 | 3.3% |
| Mythical | 1.5 | 2.0% |

Most earned crates are Common or Rare → optimal for the return loop.

### 9.3 Multi-Slot Utility Rewards (Castle Clash Style)

Each crate awards **3 cosmetic items** of its rarity PLUS **1-3 utility items** via a 3-slot system:

| Slot | Behaviour | Activation Chance (Common → Mythical) |
|------|-----------|--------------------------------------|
| **Slot 1** (Guaranteed) | Always fires. Rolls from crate's own rarity pool. | 100% |
| **Slot 2** (Bonus) | Probabilistic. Rolls from a mixed rarity distribution. | 25% → 65% |
| **Slot 3** (Jackpot) | Low probability. Rolls from a shifted-down rarity distribution. | 3% → 20% |

#### Expected Items Per Crate

| Crate | 1 item | 2 items | 3 items | **Avg** |
|-------|--------|---------|---------|---------|
| Common | 75% | 22% | 3% | **1.28** |
| Rare | 63% | 31% | 6% | **1.41** |
| Exotic | 50% | 40% | 10% | **1.55** |
| Legendary | 38% | 47% | 15% | **1.70** |
| Mythical | 28% | 52% | 20% | **1.85** |

#### Utility Item Pools (booster durations scale with rarity)

| Tier | Time Skips | Boosters | Coins |
|------|-----------|----------|-------|
| **Common** | 5m, 15m | 1hr (Coin/XP/Shard) | 0.25× rank |
| **Rare** | 15m, 1hr | 1hr + 6hr | 0.50× rank |
| **Exotic** | 1hr, 3hr, 8hr | 6hr + 12hr | 1.0× rank |
| **Legendary** | 3hr, 8hr, 24hr | 12hr, 24hr, rare 7d | 2.0× rank |
| **Mythical** | 8hr, 24hr, 3d, 7d | 24hr + 7d | 4.0× rank |

#### Guaranteed Base Rewards (Clash Royale Style)

Every crate always awards:

**Rank-Scaled Coins:**
```
crateCoins = floor(COIN_CAPS_BY_RANK[rank][0] × tierMultiplier × (0.8 + random(0.4)))
```
Multipliers: Common=0.25×, Rare=0.50×, Exotic=1.0×, Legendary=2.0×, Mythical=4.0×

**Rank-Scaled Spell Shards:**
```
crateShards = floor(shardBase(rank) × tierMultiplier × (0.8 + random(0.4)))
shardBase = 5 + (20 × rankIndex/totalRanks)
```
Multipliers: Common=0.4×, Rare=0.8×, Exotic=1.5×, Legendary=2.5×, Mythical=4.0×

Shards scale ~5× across ranks (vs coins' ~20×) — intentionally slower so crates don't shortcut spell progression.

| Tier | Unranked Shards | Hypersonic III Shards |
|------|----------------|---------------------|
| Common | 1-2 | 4-6 |
| Rare | 3-5 | 8-12 |
| Exotic | 6-9 | 15-22 |
| Legendary | 10-15 | 25-37 |
| Mythical | 16-24 | 40-60 |

Coins scale with the player's trophy rank so rewards remain proportional to earning capacity.

### 9.4 Crate Shop Prices (buy outright, instant open)

| Rarity | Skip Cost | Shop Price | Real $ |
|--------|-----------|------------|--------|
| Common | 20 gems | **50 gems** | ~$0.50 |
| Rare | 50 gems | **150 gems** | ~$1.50 |
| Exotic | 120 gems | **400 gems** | ~$4.00 |
| Legendary | 200 gems | **1,000 gems** | ~$10.00 |
| Mythical | 300 gems | **2,500 gems** | ~$25.00 |

Shop price is always **2.5-8×** the skip value because buying outright skips both earning AND waiting.

---

## 10. Mastery & Tier Gating

Mastery is the **master clock** of the game. It cannot be skipped with gems. It ensures a minimum play time before content unlocks.

**Design rule**: Getting 3 cars to 70% (level 7) in a tier naturally earns enough mastery XP to unlock the next tier. Players progress **laterally within a tier** before **vertically to the next**.

### 10.1 Mastery Rank Thresholds

50 ranks total. Tier gates at ranks 5, 10, 20, 30.

| Rank | Threshold | Gate | Derivation |
|------|-----------|------|------------|
| 1 | 700 | — | |
| 3 | 3,100 | — | Spell L3 gate |
| **5** | **5,500** | **Tier 2** | 3×T1 cars to L7 = 47 races |
| 8 | 15,500 | — | Spell L4 gate |
| **10** | **22,000** | **Tier 3** | +3×T2 cars to L7 = 126 races |
| 15 | 41,500 | — | |
| **20** | **61,000** | **Tier 4** | +3×T3 cars to L7 = 250 races |
| 25 | 100,000 | — | Spell L5 gate |
| **30** | **140,000** | **Tier 5** | +3×T4 cars to L7 = 438 races |
| 35 | 210,000 | — | |
| 40 | 315,000 | — | |
| 45 | 472,000 | — | |
| 50 | 709,000 | — | Prestige |

Ranks 31-50 are **post-endgame prestige** — no content gates.

### 10.2 Tier Unlock Costs

Each tier requires mastery rank + coin payment (= 25 races at expected rank):

| Tier | Mastery Rank | Coin Cost | Expected Rank |
|------|-------------|-----------|---------------|
| 2 (Sports) | 5 | 47,000 | Bronze II |
| 3 (Super) | 10 | 73,000 | Silver III |
| 4 (Hyper) | 20 | 141,000 | Platinum III |
| 5 (Mythic) | 30 | 278,000 | Master III |

### 10.3 Time to Reach Each Gate

Based on 10 races/day, ~30 min/day:

| Gate | Races | Days | Profile |
|------|-------|------|---------|
| Tier 2 (Rank 5) | 60 | 6 | Hook |
| Tier 3 (Rank 10) | 190 | 19 | Engaged |
| Tier 4 (Rank 20) | 630 | 63 | Invested |
| Tier 5 (Rank 30) | 1,130 | 113 | Endgame |

---

## 11. Unified Player Timeline

The three parallel queues (Car, Spell, Crate) create a constant return-to-claim loop. At any point the player has **up to 3 timers ticking**.

### 11.1 The Three Queues

| Queue | What's Upgrading | Timer Range | Resource Cost |
|-------|-----------------|-------------|---------------|
| Pit Crew | Car level (1 car) | 0m–48h | Coins |
| Library | Spell level (1 spell) | 30m–12h | Shards |
| Crate Bay | Crate opening (1 crate) | 1h–24h | Free (earned) |

### 11.2 Full Progression Timeline (Regular F2P, 10 races/day)

| Day | Mastery | Cars | Spells | Player Feel |
|-----|---------|------|--------|-------------|
| **5** | T1 70% | 3 T1 cars to L7 | 1 spell at L2 | **Hooked** |
| **6** | **Tier 2 unlocked** | Starting T2 | 1 spell at L2 | **Progressing** |
| **19** | **Tier 3 unlocked** | T2 started | 2 spells at L2-3 | **Engaged** |
| **52** | T3 70% | 3 T3 cars to L7 | Deck at L3 | **Invested** |
| **63** | **Tier 4 unlocked** | Starting T4 | Deck at L3-4 | **Dedicated** |
| **113** | **Tier 5 unlocked** | T4 progressing | 4-5 spells at L4 | **Endgame** |
| **189** | T5 70% | 3 T5 cars to L7 | Most spells L4-5 | **Veteran** |
| **249** | Rank 50 | **All 15 cars maxed** | All maxed | **Completionist** |

### 11.3 Time to Full Completion by Profile

| Profile | Races/Day | Days to T5 MAXED | Total Races |
|---------|-----------|-----------------|-------------|
| Casual | 5 | ~509 days (~17 months) | ~2,545 |
| Regular F2P | 10 | ~249 days (~8.3 months) | ~2,490 |
| Hardcore | 20 | ~120 days (~4 months) | ~2,400 |

---

## 12. Design Principles

### 12.1 Core Rules

1. **Time skips are always the cheapest way to accelerate.** Buying items outright is always more expensive. Boosters fall between — they add value but require playing.
2. **Mastery cannot be skipped.** It's the only non-monetizable gate, ensuring minimum play time.
3. **Rewards scale with rank.** Higher-rank players earn more coins, XP, and shards. No incentive to smurf.
4. **Loss aversion drives returns.** Idle queue slots feel like wasted potential. Players are motivated to keep all 3 queues active.
5. **Late-game gets exponentially harder.** Spell level 5 costs 4× level 4 in shards. Tier 5 cars take 2× the XP of Tier 4.

### 12.2 Monetization Psychology

| Mechanism | How It Works |
|-----------|-------------|
| **Impulse skips** | 5-gem floor for short timers ("just finish it") |
| **Volume discount** | Longer time skips cost less per hour (rewards bulk purchases) |
| **Booster value** | Priced below theoretical gem value (feels like a deal) |
| **Crate FOMO** | 24h Mythical timer creates maximum anticipation + skip temptation |
| **Queue pressure** | 3 parallel timers = always something to skip |

### 12.3 Anti-Exploit Design

| Risk | Mitigation |
|------|-----------|
| **Smurfing for rewards** | Rank-scaled shards/coins/XP — higher rank always nets more |
| **Elimination farming** | Reduced 5th-8th multipliers (8th gets 30% of 1st) |
| **Unranked farming** | UNRANKED mode gives only 70% of normal rewards |
| **Gem-to-progress conversion** | Mastery cannot be skipped — gems can't buy tier access |
