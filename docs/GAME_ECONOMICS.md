# Mystic Motors — V2 Game Economics Bible

> **Source of Truth** — All pricing, progression, rewards, and formulas for the Mystic Motors economy.
> Last updated: 2026-02-28

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
| **Coins** | Soft | Races (scales with rank), crates | Car upgrades, shop items |
| **Gems** | Hard | IAP, ads, events | Time skips, boosters, crate purchases |
| **Spell Shards** | Soft | Races (scales with rank), crates | Spell research (leveling spells) |
| **Spell Tokens** | Soft | Mastery rank-ups (1 per rank) | Unlocking new spells |
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

**15 cars** across **5 tiers**, each with **10 levels** (0→9). One car can be upgrading at a time (Pit Crew queue).

### 7.1 The Upgrade Loop

```
Race → Fill XP bar → Pay coins → Wait timer → Claim → Level up (XP resets) → Repeat
```

### 7.2 Upgrade Timers Per Level

| Level | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|-------|--------|--------|--------|--------|--------|
| 0→1 | 1 min | 5 min | 15 min | 30 min | 1 hr |
| 1→2 | 5 min | 15 min | 30 min | 1 hr | 2 hr |
| 2→3 | 10 min | 30 min | 1 hr | 2 hr | 3 hr |
| 3→4 | 15 min | 1 hr | 2 hr | 3 hr | 4 hr |
| 4→5 | 30 min | 2 hr | 3 hr | 4 hr | 6 hr |
| 5→6 | 45 min | 3 hr | 4 hr | 6 hr | 8 hr |
| 6→7 | 1 hr | 4 hr | 6 hr | 8 hr | 12 hr |
| 7→8 | 1.5 hr | 5 hr | 8 hr | 12 hr | 16 hr |
| 8→9 | 2 hr | 6 hr | 10 hr | 16 hr | 24 hr |
| **Total** | **~6 hr** | **~22 hr** | **~35 hr** | **~53 hr** | **~77 hr** |

**Design:** Tier 1 is the hook (near-instant upgrades). Tier 5 has genuine multi-hour waits that create strong skip temptation and return-to-claim loops.

### 7.3 XP Required Per Level

| Level | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|-------|--------|--------|--------|--------|--------|
| 0→1 | 100 | 250 | 500 | 1,000 | 2,000 |
| 1→2 | 150 | 400 | 800 | 1,500 | 3,000 |
| 2→3 | 200 | 550 | 1,100 | 2,000 | 4,000 |
| 3→4 | 300 | 750 | 1,500 | 3,000 | 6,000 |
| 4→5 | 400 | 1,000 | 2,000 | 4,000 | 8,000 |
| 5→6 | 500 | 1,300 | 2,600 | 5,000 | 10,000 |
| 6→7 | 700 | 1,800 | 3,600 | 7,000 | 14,000 |
| 7→8 | 1,000 | 2,500 | 5,000 | 10,000 | 20,000 |
| 8→9 | 1,500 | 3,800 | 7,500 | 15,000 | 30,000 |
| **Total** | **4,850** | **12,350** | **24,600** | **48,500** | **97,000** |

### 7.4 Coin Costs Per Level

Designed so total cost per car ≈ 8-15 races worth of coins at the expected rank.

| Level | Tier 1 | Tier 2 | Tier 3 | Tier 4 | Tier 5 |
|-------|--------|--------|--------|--------|--------|
| 0→1 | 0 | 0 | 0 | 0 | 0 |
| 1→2 | 200 | 800 | 2,000 | 5,000 | 12,000 |
| 2→3 | 400 | 1,200 | 3,000 | 7,500 | 18,000 |
| 3→4 | 600 | 1,600 | 4,000 | 10,000 | 25,000 |
| 4→5 | 800 | 2,000 | 5,000 | 12,500 | 30,000 |
| 5→6 | 1,000 | 2,500 | 6,500 | 15,000 | 38,000 |
| 6→7 | 1,200 | 3,000 | 8,000 | 18,000 | 45,000 |
| 7→8 | 1,500 | 3,500 | 10,000 | 22,000 | 55,000 |
| 8→9 | 2,000 | 4,500 | 12,500 | 28,000 | 70,000 |
| **Total** | **7,700** | **19,100** | **51,000** | **118,000** | **293,000** |

### 7.5 Gem Cost to Skip All Upgrades (per car)

| Tier | Total Timer | Approx Skip Cost | Real $ |
|------|------------|-------------------|--------|
| 1 | ~6 hr | ~120 gems | ~$1.20 |
| 2 | ~22 hr | ~360 gems | ~$3.60 |
| 3 | ~35 hr | ~540 gems | ~$5.40 |
| 4 | ~53 hr | ~780 gems | ~$7.80 |
| 5 | ~77 hr | ~1,050 gems | ~$10.50 |

### 7.6 Races to Max One Car

| Tier | Total XP | Races (@ ~150 XP) | Days (10/day) |
|------|----------|-------------------|---------------|
| 1 | 4,850 | 33 | 3.3 |
| 2 | 12,350 | 83 | 8.3 |
| 3 | 24,600 | 164 | 16.4 |
| 4 | 48,500 | 324 | 32.4 |
| 5 | 97,000 | 647 | 64.7 |

### 7.7 Tier Assignment

Cars are assigned to tiers by base price:

| Base Price Range | Tier |
|------------------|------|
| 0 (starter) | 1 |
| 1 – 19,999 | 2 |
| 20,000 – 99,999 | 3 |
| 100,000 – 499,999 | 4 |
| 500,000+ | 5 |

---

## 8. Spell Progression

**16 spells**, each with **5 levels**. One spell can be researching at a time (Library queue).

### 8.1 The Research Loop

```
Equip spell in deck → Race to earn Spell XP → Hit XP cap → Pay shards → Wait timer → Claim → Level up → Repeat
```

### 8.2 Spell XP Caps (per level, before research can start)

| Level | XP Cap |
|-------|--------|
| 1 | 100 |
| 2 | 250 |
| 3 | 500 |
| 4 | 1,000 |

Level 5 = max (no further XP gain).

### 8.3 Research Costs & Timers

| To Level | Shards | Timer | Display |
|----------|--------|-------|---------|
| 2 | 50 | 30 min | "30 Minutes" |
| 3 | 200 | 2 hr | "2 Hours" |
| 4 | 750 | 6 hr | "6 Hours" |
| 5 | 2,000 | 12 hr | "12 Hours" |
| **Total/spell** | **3,000** | **~20.5 hr** | |

### 8.4 Skip Cost

Base rate: **20 gems/hour**, min 5 gems. Uses the dynamic skip formula.

### 8.5 Full Roster Progression

| Milestone | Total Shards | Gameplay Hours |
|-----------|-------------|----------------|
| Max 1 spell | 3,000 | ~10 hr |
| Max 4 spells (1 deck) | 12,000 | ~40 hr |
| Max 8 spells (2 decks) | 24,000 | ~80 hr |
| Max 13 spells | 39,000 | ~130 hr |
| Max ALL 16 spells | 48,000 | ~160 hr |

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

### 9.3 Crate Item Probabilities (What's inside)

When a crate opens, it rolls for items from its specific reward pool. Higher rarity crates have better rewards and higher chances for time skips / boosters.

| Reward Type | Common | Rare | Exotic | Legendary | Mythical |
|-------------|--------|------|--------|-----------|----------|
| **Coins** | 23.0% (500) | 21.0% (1,000) | 22.0% (2k) | 20.2% (5k) | 19.3% (10k) |
| **Gems** | 7.6% (5) | 10.1% (10) | 15.0% (20) | 15.1% (50) | 16.1% (100) |
| **XP Booster** | 15.3% (1hr) | 21.0% (1-6h) | 20.0% (6-12h) | 18.1% (12-24h) | 12.9% (24hr) |
| **Shard Booster** | 11.5% (1hr) | 8.4% (1hr) | 8.0% (6hr) | 8.0% (12hr) | 10.7% (24hr) |
| **Coin Booster** | 15.3% (1hr) | 21.0% (1-6h) | 20.0% (6-12h) | 18.1% (12-24h) | 12.9% (24hr) |
| **Time Skip** | 26.9% (5-15m)| 18.4% (15-30m)| 18.0% (30-1h) | 18.1% (3-8h) | 19.3% (8-24h) |
| **Cosmetics** | 3 items | 3 items | 3 items | 3 items | 3 items |

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

### 10.1 Mastery Rank Thresholds

50 ranks total. Tier gates at ranks 5, 10, 20, 30.

| Rank | Threshold | Gate |
|------|-----------|------|
| 1 | 2,000 | — |
| 2 | 5,000 | — |
| 3 | 10,000 | — |
| 4 | 18,000 | — |
| **5** | **30,000** | **Tier 2** |
| 6 | 42,000 | — |
| 7 | 56,000 | — |
| 8 | 72,000 | — |
| 9 | 92,000 | — |
| **10** | **115,000** | **Tier 3** |
| 15 | 215,000 | — |
| **20** | **310,000** | **Tier 4** |
| 25 | 480,000 | — |
| **30** | **550,000** | **Tier 5** |
| 35 | 900,000 | — |
| 40 | 1,170,000 | — |
| 45 | 1,504,000 | — |
| 50 | 1,924,000 | — |

Ranks 31-50 are **post-endgame prestige** — no content gates, pure bragging rights.

### 10.2 Time to Reach Each Gate

Based on 10 races/day, ~157 mastery XP/race, ~30 min/day:

| Gate | Races | Days | Gameplay Hours |
|------|-------|------|----------------|
| Tier 2 (Rank 5) | 191 | 19 | **~10 hr** |
| Tier 3 (Rank 10) | 732 | 73 | **~37 hr** |
| Tier 4 (Rank 20) | 1,975 | 198 | **~99 hr** |
| Tier 5 (Rank 30) | 3,503 | 350 | **~175 hr** |

### 10.3 Spell Tokens

Players earn **1 spell token per mastery rank-up**. Spell tokens unlock new spells.

---

## 11. Unified Player Timeline

The three parallel queues (Car, Spell, Crate) create a constant return-to-claim loop. At any point the player has **up to 3 timers ticking**.

### 11.1 The Three Queues

| Queue | What's Upgrading | Timer Range | Resource Cost |
|-------|-----------------|-------------|---------------|
| Pit Crew | Car level (1 car) | 1 min – 24 hr | Coins |
| Library | Spell level (1 spell) | 30 min – 12 hr | Shards |
| Crate Bay | Crate opening (1 crate) | 1 hr – 24 hr | Free (earned) |

### 11.2 Full Progression Timeline

Active player profile: 10 races/day, ~30 min/day, ~3 min/race.

| Gameplay Hours | Mastery | Cars | Spells | Player Feel |
|---------------|---------|------|--------|-------------|
| **~10 hr** | Tier 2 unlocked | 3 T1 cars maxed | 1-2 spells at Lv 3 | **Hooked** |
| **~37 hr** | Tier 3 unlocked | T1+T2 maxed (6 cars) | 1 deck at Lv 4 | **Engaged** |
| **~80 hr** | Mid Tier 3-4 | 9 cars maxed | 2 decks at Lv 4-5 | **Invested** |
| **~99 hr** | Tier 4 unlocked | 9 cars + T4 started | ~8 spells at Lv 4 | **Dedicated** |
| **~135 hr** | Rank ~25 | 12 cars maxed | ~10 spells at Lv 4-5 | **Veteran** |
| **~175 hr** | Tier 5 unlocked | 12+ cars maxed | ~13 spells at Lv 5 | **Endgame** |
| **~200 hr** | Post-T5 | **1-2 T5 cars near max** | Most spells maxed | **Completionist** |
| **~250 hr** | Rank 35+ | All 15 cars maxed | All 16 spells maxed | **Prestige** |

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
