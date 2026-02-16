# 🏎️ Mystic Motors V2 — Complete Visual Guide

---

## 🎂 The 100-Piece Cake System

```
┌─────────────────────────────────────────────────────────────────┐
│                    TOTAL POWER = 100 PIECES                      │
│                                                                  │
│  Tier 1: [0 ████████████████████ 20]  Street License           │
│  Tier 2: [20 ████████████████████ 40]  Sports License          │
│  Tier 3: [40 ████████████████████ 60]  Super License           │
│  Tier 4: [60 ████████████████████ 80]  Hyper License           │
│  Tier 5: [80 ████████████████████ 100] Mythic License          │
│                                                                  │
│  Each tier gets 20 pieces to grow through stars & levels!       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🚗 Each Tier Has 3 Cars

```
┌─────────────────────────────────────────────────────────────────┐
│ TIER 1 (Street License)                                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  🛡️ TANK (Mitsabi Eon)                                          │
│  ├─ Top Speed:     15% of power (3.0 at max)                   │
│  ├─ Acceleration:  15% of power (3.0 at max)                   │
│  ├─ Handling:      25% of power (5.0 at max) ⭐ STRONG          │
│  ├─ Boost Regen:   25% of power (5.0 at max) ⭐ STRONG          │
│  └─ Boost Power:   20% of power (4.0 at max)                   │
│                                                                  │
│  ⚡ SPEEDSTER (Doge Chaser)                                      │
│  ├─ Top Speed:     30% of power (6.0 at max) ⭐ STRONG          │
│  ├─ Acceleration:  25% of power (5.0 at max) ⭐ STRONG          │
│  ├─ Handling:      15% of power (3.0 at max)                   │
│  ├─ Boost Regen:   10% of power (2.0 at max)                   │
│  └─ Boost Power:   20% of power (4.0 at max)                   │
│                                                                  │
│  ⚖️ SPECIALIST (Nisaro 360X)                                     │
│  ├─ Top Speed:     20% of power (4.0 at max)                   │
│  ├─ Acceleration:  20% of power (4.0 at max)                   │
│  ├─ Handling:      20% of power (4.0 at max)                   │
│  ├─ Boost Regen:   20% of power (4.0 at max)                   │
│  └─ Boost Power:   20% of power (4.0 at max)                   │
│                                                                  │
│  All 3 cars reach 20 total power, but distributed differently!  │
└─────────────────────────────────────────────────────────────────┘
```

---

## ⭐ How Cars Grow (Stars + Levels)

```
┌─────────────────────────────────────────────────────────────────┐
│ TIER 1 TANK PROGRESSION (0 → 20 power)                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Star 0, Level 0 (Just Born)                                    │
│  ├─ Stars give:  20 × 60% × (0/10)   = 0.0                     │
│  ├─ Levels give: 20 × 40% × (0/100)  = 0.0                     │
│  └─ Total Power: 0.0                                            │
│      Top Speed: 0.0 | Handling: 0.0                            │
│                                                                  │
│  Star 3, Level 22 (Early Game)                                  │
│  ├─ Stars give:  20 × 60% × (3/10)   = 3.6                     │
│  ├─ Levels give: 20 × 40% × (22/100) = 1.76                    │
│  └─ Total Power: 5.36                                           │
│      Top Speed: 0.80 | Handling: 1.34                          │
│                                                                  │
│  Star 5, Level 50 (Mid Game)                                    │
│  ├─ Stars give:  20 × 60% × (5/10)   = 6.0                     │
│  ├─ Levels give: 20 × 40% × (50/100) = 4.0                     │
│  └─ Total Power: 10.0                                           │
│      Top Speed: 1.5 | Handling: 2.5                            │
│                                                                  │
│  Star 10, Level 100 (MAXED!)                                    │
│  ├─ Stars give:  20 × 60% × (10/10)   = 12.0                   │
│  ├─ Levels give: 20 × 40% × (100/100) = 8.0                    │
│  └─ Total Power: 20.0 (MAX for Tier 1)                         │
│      Top Speed: 3.0 | Handling: 5.0                            │
│                                                                  │
│  ⚖️ 60% from Stars (evolution) + 40% from Levels (racing)       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📍 Firestore Paths Reference

```
┌─────────────────────────────────────────────────────────────────┐
│ GAME CONFIGURATION (Read-Only, Cached by Unity)                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ /GameData/v1/config/CarStatsBudgetConfig                        │
│ ├─ globalStatCap: 100                                           │
│ ├─ tierCount: 5                                                 │
│ ├─ maxStarLevel: 10                                             │
│ ├─ maxCarLevel: 100                                             │
│ ├─ starWeight: 0.6 (60%)                                        │
│ ├─ levelWeight: 0.4 (40%)                                       │
│ └─ archetypeProfiles:                                           │
│     ├─ tank: { topSpeed: 0.15, handling: 0.25, ... }           │
│     ├─ speedster: { topSpeed: 0.30, acceleration: 0.25, ... }  │
│     └─ specialist: { all stats: 0.20 }                          │
│                                                                  │
│ /GameData/v1/catalogs/TiersCatalog                              │
│ └─ tiers:                                                        │
│     ├─ tier_1:                                                   │
│     │   ├─ order: 1                                             │
│     │   ├─ displayName: "Street License"                        │
│     │   ├─ masteryRequired: 0                                   │
│     │   ├─ coinsRequired: 0                                     │
│     │   └─ bundledCars:                                         │
│     │       ├─ { carId: "car_h4ayzwf31g", archetype: "tank" }   │
│     │       ├─ { carId: "car_1wp1gr2p", archetype: "speedster" }│
│     │       └─ { carId: "car_4bbp20vv", archetype: "specialist"}│
│     ├─ tier_2: { ... }                                          │
│     └─ ...                                                       │
│                                                                  │
│ /GameData/v1/catalogs/CarEvolutionV2Catalog                     │
│ ├─ maxStarLevel: 10                                             │
│ ├─ levelsPerStar: 10                                            │
│ ├─ xpCaps:                                                       │
│ │   ├─ "0": 1000    (Star 0 → 1)                               │
│ │   ├─ "1": 2500    (Star 1 → 2)                               │
│ │   └─ ...                                                       │
│ ├─ evolutionCosts:                                              │
│ │   ├─ "0": { coins: 5000, durationSeconds: 3600 }             │
│ │   └─ ...                                                       │
│ └─ skipCost: { gemsPerHour: 50, minGems: 10 }                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ PLAYER DATA (Read/Write)                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ /Players/{uid}/Garage/Cars                                      │
│ └─ cars:                                                         │
│     └─ car_h4ayzwf31g:                                          │
│         ├─ carId: "car_h4ayzwf31g"                              │
│         ├─ starLevel: 5          (0-10)                         │
│         ├─ carLevel: 50          (0-100, auto-calculated)       │
│         ├─ xp: 17500             (current XP)                   │
│         ├─ isXpCapped: false     (true = needs evolution)       │
│         └─ updatedAt: timestamp                                 │
│                                                                  │
│ /Players/{uid}/Licenses/Tiers                                   │
│ └─ licenses:                                                     │
│     ├─ tier_1: true                                             │
│     ├─ tier_2: true                                             │
│     └─ ...                                                       │
│                                                                  │
│ /Players/{uid}/Queues/PitCrew                                   │
│ └─ slots: [                                                      │
│     {                                                            │
│       carId: "car_h4ayzwf31g",                                  │
│       fromStar: 5,                                              │
│       toStar: 6,                                                │
│       startedAt: timestamp,                                     │
│       completesAt: timestamp + 24 hours                         │
│     }                                                            │
│   ]                                                              │
│                                                                  │
│ /Players/{uid}/Economy/Stats                                    │
│ ├─ coins: 500000                                                │
│ └─ gems: 1200                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Complete Player Journey

```
┌─────────────────────────────────────────────────────────────────┐
│ 1️⃣ NEW PLAYER                                                   │
├─────────────────────────────────────────────────────────────────┤
│ Backend grants:                                                  │
│ ✅ Tier 1 License                                                │
│ ✅ 3 cars (Tank, Speedster, Specialist)                          │
│ ✅ All at Star 0, Level 0, XP 0                                  │
│                                                                  │
│ Firestore:                                                       │
│ /Players/{uid}/Licenses/Tiers/licenses.tier_1 = true            │
│ /Players/{uid}/Garage/Cars/cars.car_h4ayzwf31g = {              │
│   starLevel: 0, carLevel: 0, xp: 0, isXpCapped: false           │
│ }                                                                │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2️⃣ PLAYER RACES                                                 │
├─────────────────────────────────────────────────────────────────┤
│ Unity → prepareRace({ carId: "car_h4ayzwf31g" })                │
│                                                                  │
│ Backend:                                                         │
│ 1. Reads /Players/{uid}/Garage/Cars                             │
│    → starLevel: 0, carLevel: 0                                  │
│                                                                  │
│ 2. Reads /GameData/v1/catalogs/TiersCatalog                     │
│    → tier: 1, archetype: "tank"                                 │
│                                                                  │
│ 3. Reads /GameData/v1/config/CarStatsBudgetConfig               │
│    → globalStatCap: 100, starWeight: 0.6, ...                   │
│                                                                  │
│ 4. Calculates stats:                                            │
│    totalBudget = 0 + 0 + 0 = 0                                  │
│    topSpeed = 0 × 0.15 = 0                                      │
│                                                                  │
│ 5. Returns to Unity:                                            │
│    { carStats: { topSpeed: 0, acceleration: 0, ... } }          │
│                                                                  │
│ Unity → recordRaceResult({ raceId, finishOrder })               │
│                                                                  │
│ Backend awards XP:                                               │
│ /Players/{uid}/Garage/Cars/cars.car_h4ayzwf31g.xp += 500        │
│ /Players/{uid}/Garage/Cars/cars.car_h4ayzwf31g.carLevel = 5     │
│                                                                  │
│ Formula: carLevel = (starLevel × 10) + floor(xp / (xpCap / 10)) │
│          carLevel = (0 × 10) + floor(500 / (1000 / 10))         │
│          carLevel = 0 + floor(500 / 100) = 5                    │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3️⃣ XP CAP REACHED                                               │
├─────────────────────────────────────────────────────────────────┤
│ After many races:                                                │
│ /Players/{uid}/Garage/Cars/cars.car_h4ayzwf31g.xp = 1000        │
│                                                                  │
│ Backend detects: xp >= xpCap (1000 >= 1000)                     │
│ /Players/{uid}/Garage/Cars/cars.car_h4ayzwf31g.isXpCapped = true│
│                                                                  │
│ Unity shows: "EVOLVE" button (car cannot earn more XP)          │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4️⃣ EVOLUTION (Star 0 → Star 1)                                  │
├─────────────────────────────────────────────────────────────────┤
│ Unity → startCarEvolutionV2({ carId, opId })                    │
│                                                                  │
│ Backend:                                                         │
│ ✅ Checks: isXpCapped = true                                     │
│ ✅ Checks: coins >= 5000                                         │
│ ✅ Checks: Pit Crew slot available                               │
│                                                                  │
│ Deducts coins:                                                   │
│ /Players/{uid}/Economy/Stats/coins -= 5000                      │
│                                                                  │
│ Adds to Pit Crew queue:                                         │
│ /Players/{uid}/Queues/PitCrew/slots[0] = {                      │
│   carId: "car_h4ayzwf31g",                                      │
│   fromStar: 0,                                                  │
│   toStar: 1,                                                    │
│   startedAt: now,                                               │
│   completesAt: now + 1 hour                                     │
│ }                                                                │
│                                                                  │
│ Player waits 1 hour OR pays 50 gems to skip                     │
│                                                                  │
│ Unity → claimCarEvolutionV2({ carId, opId })                    │
│                                                                  │
│ Backend:                                                         │
│ /Players/{uid}/Garage/Cars/cars.car_h4ayzwf31g.starLevel = 1    │
│ /Players/{uid}/Garage/Cars/cars.car_h4ayzwf31g.xp = 0           │
│ /Players/{uid}/Garage/Cars/cars.car_h4ayzwf31g.carLevel = 10    │
│ /Players/{uid}/Garage/Cars/cars.car_h4ayzwf31g.isXpCapped = false│
│ /Players/{uid}/Queues/PitCrew/slots[0] = null                   │
│                                                                  │
│ New carLevel = (1 × 10) + 0 = 10 (jumped from 10 to 10!)       │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5️⃣ STATS CALCULATION (Garage UI)                                │
├─────────────────────────────────────────────────────────────────┤
│ Unity needs to show stats in garage                             │
│                                                                  │
│ Step 1: Fetch player's car data                                 │
│ /Players/{uid}/Garage/Cars                                      │
│ → starLevel: 1, carLevel: 10                                    │
│                                                                  │
│ Step 2: Look up tier & archetype (cached)                       │
│ /GameData/v1/catalogs/TiersCatalog                              │
│ → tier: 1, archetype: "tank"                                    │
│                                                                  │
│ Step 3: Calculate stats (cached config)                         │
│ /GameData/v1/config/CarStatsBudgetConfig                        │
│                                                                  │
│ Formula:                                                         │
│ budgetPerTier = 100 ÷ 5 = 20                                    │
│ tierFloor = (1 - 1) × 20 = 0                                    │
│ starContribution = 20 × 0.6 × (1 ÷ 10) = 1.2                    │
│ levelContribution = 20 × 0.4 × (10 ÷ 100) = 0.8                 │
│ totalBudget = 0 + 1.2 + 0.8 = 2.0                               │
│                                                                  │
│ topSpeed = 2.0 × 0.15 = 0.30                                    │
│ acceleration = 2.0 × 0.15 = 0.30                                │
│ handling = 2.0 × 0.25 = 0.50                                    │
│ boostRegen = 2.0 × 0.25 = 0.50                                  │
│ boostPower = 2.0 × 0.20 = 0.40                                  │
│                                                                  │
│ Unity displays:                                                  │
│ Top Speed: 0.30 ████░░░░░░ (1.5% of max)                        │
│ Handling:  0.50 ████░░░░░░ (2.5% of max)                        │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6️⃣ TIER PROGRESSION                                             │
├─────────────────────────────────────────────────────────────────┤
│ Player reaches:                                                  │
│ - Mastery Rank 5                                                │
│ - 100,000 coins                                                 │
│                                                                  │
│ Unity → purchaseTierLicenseV2({ tierId: "tier_2", opId })       │
│                                                                  │
│ Backend:                                                         │
│ ✅ Checks: masteryRank >= 5                                      │
│ ✅ Checks: coins >= 100,000                                      │
│                                                                  │
│ Grants:                                                          │
│ /Players/{uid}/Economy/Stats/coins -= 100000                    │
│ /Players/{uid}/Licenses/Tiers/licenses.tier_2 = true            │
│ /Players/{uid}/Garage/Cars/cars.car_3n27817s = {                │
│   starLevel: 0, carLevel: 0, xp: 0, isXpCapped: false           │
│ }                                                                │
│ (+ 2 more Tier 2 cars)                                          │
│                                                                  │
│ Player now has 6 cars total (3 Tier 1 + 3 Tier 2)              │
│                                                                  │
│ Tier 2 cars start at 20 power (Tier 1 max!)                    │
│ tierFloor = (2 - 1) × 20 = 20                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📊 Stat Calculation Formula (Visual)

```
┌─────────────────────────────────────────────────────────────────┐
│ FORMULA: How to Calculate Total Power                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. budgetPerTier = globalStatCap ÷ tierCount                   │
│                   = 100 ÷ 5 = 20                                │
│                                                                  │
│  2. tierFloor = (tierOrder - 1) × budgetPerTier                 │
│               = (1 - 1) × 20 = 0  (Tier 1 starts at 0)         │
│               = (2 - 1) × 20 = 20 (Tier 2 starts at 20)        │
│               = (5 - 1) × 20 = 80 (Tier 5 starts at 80)        │
│                                                                  │
│  3. starProgress = starLevel ÷ maxStarLevel                     │
│                  = 5 ÷ 10 = 0.5 (50% progress)                  │
│                                                                  │
│  4. levelProgress = carLevel ÷ maxCarLevel                      │
│                   = 50 ÷ 100 = 0.5 (50% progress)               │
│                                                                  │
│  5. starContribution = budgetPerTier × starWeight × starProgress│
│                      = 20 × 0.6 × 0.5 = 6.0                     │
│                                                                  │
│  6. levelContribution = budgetPerTier × levelWeight × levelProg │
│                       = 20 × 0.4 × 0.5 = 4.0                    │
│                                                                  │
│  7. totalBudget = tierFloor + starContribution + levelContrib   │
│                 = 0 + 6.0 + 4.0 = 10.0                          │
│                                                                  │
│  8. Distribute across stats using archetype profile:            │
│     topSpeed = totalBudget × archetypeProfile.topSpeed          │
│              = 10.0 × 0.15 = 1.5 (for tank)                     │
│                                                                  │
│  9. Repeat for all 5 stats                                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🎯 Key Takeaways

```
┌─────────────────────────────────────────────────────────────────┐
│ ✅ WHAT YOU NEED TO REMEMBER                                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ 1. Total power = 100 (the whole cake)                           │
│                                                                  │
│ 2. Each tier gets 20 pieces (100 ÷ 5)                           │
│                                                                  │
│ 3. Each tier has 3 cars (tank, speedster, specialist)           │
│    - All reach 20 power, but distributed differently            │
│                                                                  │
│ 4. Stars contribute 60%, Levels contribute 40%                  │
│    - Stars are harder (cost coins + time)                       │
│    - Levels are automatic (just race)                           │
│                                                                  │
│ 5. Unity needs 3 Firestore documents:                           │
│    - /Players/{uid}/Garage/Cars (star level, car level)         │
│    - /GameData/v1/catalogs/TiersCatalog (tier, archetype)       │
│    - /GameData/v1/config/CarStatsBudgetConfig (formula)         │
│                                                                  │
│ 6. Stats are calculated dynamically (no hardcoded values!)      │
│    - Change one config → entire game rebalances                 │
│                                                                  │
│ 7. Higher tiers start with more power                           │
│    - Tier 1 starts at 0, Tier 5 starts at 80                   │
│    - Smooth progression curve                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔧 For Game Designers

```
┌─────────────────────────────────────────────────────────────────┐
│ HOW TO CHANGE GAME BALANCE                                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│ Want all cars 20% stronger?                                     │
│ → Change globalStatCap from 100 → 120                           │
│                                                                  │
│ Want stars to matter more?                                      │
│ → Change starWeight from 0.6 → 0.7                              │
│ → Change levelWeight from 0.4 → 0.3                             │
│                                                                  │
│ Want speedsters to be even faster?                              │
│ → Change speedster.topSpeed from 0.30 → 0.35                    │
│ → Reduce another stat to keep total = 1.0                       │
│                                                                  │
│ Want evolution to cost less?                                    │
│ → Edit CarEvolutionV2Catalog.evolutionCosts                     │
│                                                                  │
│ All changes in CarStatsBudgetConfig.json!                       │
│ Run: node tools/seedV2Catalogs.mjs sandbox                      │
│ Unity auto-updates on next launch!                              │
└─────────────────────────────────────────────────────────────────┘
```
