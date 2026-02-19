# 🔮 Spell Research System — Detailed Documentation

> **Environment:** Sandbox (`mystic-motors-sandbox`)
> **Last Updated:** February 2026

---

## 1. Overview

The spell research system allows players to unlock and upgrade spells through the **Library**. Spells are gated by player level — when a player reaches the required level, a spell becomes **available for research**. The player then spends **Spell Shards** and waits a research timer to unlock/upgrade the spell.

### Flow Summary

```
Player Levels Up
  → grantXP returns newlyAvailableSpellIds
  → Unity shows "New spell available!" notification
  → Player opens Library
  → Calls startSpellResearchV2 (deducts shards, starts timer)
  → Timer completes (or player pays gems to skip)
  → Calls claimSpellResearchV2 (spell unlocked/upgraded)
```

---

## 2. Firestore Catalogs (Game-Level)

These documents live under `/GameData/v1/catalogs/` and define the game rules. They are **read-only** at runtime — seeded by admin scripts.

### 2.1 SpellsCatalog

**Path:** `/GameData/v1/catalogs/SpellsCatalog`
**Seeded by:** `seedFirestore.sandbox.ts`

Defines all spells and their level requirements.

```json
{
  "spells": {
    "spell_abc123": {
      "spellId": "spell_abc123",
      "displayName": "Storm Aura",
      "requiredLevel": 5,        // Player level needed to unlock
      "displayOrder": 1,
      "isStarter": false,
      "rarity": "rare"
    },
    "spell_def456": {
      "spellId": "spell_def456",
      "displayName": "Ice Lock",
      "requiredLevel": 0,        // 0 = starter spell (auto-granted)
      "isStarter": true
    }
  }
}
```

**Key Fields:**
| Field | Description |
|---|---|
| `requiredLevel` | Player level needed. `0` = starter (auto-granted). `-1` = coming soon. |
| `isStarter` | If `true`, granted automatically on account creation. |
| `displayOrder` | Sort order in the Library UI. |

---

### 2.2 SpellEvolutionV2Catalog

**Path:** `/GameData/v1/catalogs/SpellEvolutionV2Catalog`
**Seeded by:** `seedV2Catalogs.mjs` (from `SpellEvolutionV2Catalog.json`)

Defines research costs, timers, and XP config.

```json
{
  "version": "v1-research",
  "maxSpellLevel": 5,
  "unlockCost": {
    "shards": 100,
    "durationSeconds": 60,
    "displayDuration": "1 minute",
    "description": "Initial unlock research for level-gated spells"
  },
  "researchCosts": {
    "1": { "targetLevel": 1, "shards": 0, "durationSeconds": 0, "description": "Spell unlocked" },
    "2": { "targetLevel": 2, "shards": 100, "durationSeconds": 1800, "displayDuration": "30 minutes" },
    "3": { "targetLevel": 3, "shards": 250, "durationSeconds": 3600, "displayDuration": "1 hour" },
    "4": { "targetLevel": 4, "shards": 500, "durationSeconds": 7200, "displayDuration": "2 hours" },
    "5": { "targetLevel": 5, "shards": 1000, "durationSeconds": 14400, "displayDuration": "4 hours" }
  },
  "skipCost": {
    "gemsPerHour": 25,
    "minGems": 5
  },
  "spellXpConfig": {
    "xpPerRace": 10,
    "xpPerWin": 25,
    "xpPerSpellCast": 5,
    "xpCapPerLevel": { "1": 100, "2": 250, "3": 500, "4": 1000 }
  },
  "shardRewards": {
    "byPosition": { "1": 10, "2": 7, "3": 4 },
    "defaultShards": 1
  }
}
```

**Key Fields:**
| Field | Description |
|---|---|
| `unlockCost` | Shards + time for initial research (0→1) of level-gated spells |
| `researchCosts` | Shards + time for leveling up spells (1→2, 2→3, etc.) |
| `skipCost` | Gem cost formula to skip research timer |
| `shardRewards` | Shards earned per race based on finishing position |

---

### 2.3 ItemsCatalog (Shard Boosters)

**Path:** `/GameData/v1/catalogs/ItemsCatalog`
**Seeded by:** `seedFirestore.sandbox.ts`

Contains the Shard Booster item with purchasable SKU variants:

```json
{
  "items": {
    "bst_shrd7k9m": {
      "itemId": "bst_shrd7k9m",
      "displayName": "Shard Booster",
      "category": "booster",
      "type": "booster",
      "subType": "shard",
      "purchasable": true,
      "variants": [
        { "skuId": "sku_shrd1h_p3x9",  "displayName": "Shard Booster (1h)",  "gemPrice": 60,  "durationSeconds": 3600 },
        { "skuId": "sku_shrd6h_k7w2",  "displayName": "Shard Booster (6h)",  "gemPrice": 240, "durationSeconds": 21600 },
        { "skuId": "sku_shrd12h_m4v6", "displayName": "Shard Booster (12h)", "gemPrice": 420, "durationSeconds": 43200 },
        { "skuId": "sku_shrd24h_n8t5", "displayName": "Shard Booster (24h)", "gemPrice": 720, "durationSeconds": 86400 }
      ]
    }
  }
}
```

### 2.4 ItemSkusCatalog (SKU Lookup)

**Path:** `/GameData/v1/catalogs/ItemSkusCatalog`
**Seeded by:** `seedFirestore.sandbox.ts`

Flat lookup table for all SKUs. Contains the same shard booster SKUs:

```json
{
  "skus": {
    "sku_shrd1h_p3x9": {
      "skuId": "sku_shrd1h_p3x9",
      "itemId": "bst_shrd7k9m",
      "displayName": "Shard Booster (1h)",
      "category": "booster",
      "type": "booster",
      "subType": "shard",
      "purchasable": { "currency": "gems", "amount": 60 },
      "gemPrice": 60,
      "durationSeconds": 3600
    }
    // ... same pattern for 6h, 12h, 24h
  }
}
```

### 2.5 ItemsIndex (Family Lookup)

**Path:** `/GameData/v1/catalogs/ItemsIndex`
**Seeded by:** `seedFirestore.sandbox.ts`

Maps items to their SKU families:

```json
{
  "index": {
    "family_bst_shrd7k9m": [
      "sku_shrd1h_p3x9",
      "sku_shrd6h_k7w2",
      "sku_shrd12h_m4v6",
      "sku_shrd24h_n8t5"
    ]
  }
}
```

### 2.6 BoostersCatalog

**Path:** `/GameData/v1/catalogs/BoostersCatalog`
**Seeded by:** `seedV2Catalogs.mjs`

Standalone booster definitions used by the booster activation system.

---

## 3. Player-Level Firestore Documents

These documents live under `/Players/{uid}/` and contain the **player's personal data**. They are created/updated by Cloud Functions.

### 3.1 Profile/Profile

**Path:** `/Players/{uid}/Profile/Profile`

Player's core profile data including level info.

```json
{
  "displayName": "PlayerOne",
  "level": 5,
  "xp": 1250,
  "librarySlots": 2,
  "updatedAt": "2026-02-19T..."
}
```

**Relevant Fields:**
| Field | Description |
|---|---|
| `level` | Current player level (determines spell availability) |
| `xp` | Total XP accumulated |
| `librarySlots` | Number of research slots the player currently has |

---

### 3.2 Economy/Stats

**Path:** `/Players/{uid}/Economy/Stats`

Player's currency balances.

```json
{
  "coins": 15000,
  "gems": 500,
  "spellShards": 350,
  "spellTokens": 2,
  "updatedAt": "2026-02-19T..."
}
```

**Relevant Fields:**
| Field | Description |
|---|---|
| `spellShards` | Currency used for spell research. Deducted when starting research. |
| `gems` | Premium currency used to skip research timers or buy boosters. |

---

### 3.3 Spells/Levels

**Path:** `/Players/{uid}/Spells/Levels`

All spells the player owns and their current levels.

```json
{
  "spells": {
    "spell_abc123": {
      "level": 3,
      "xp": 150,
      "isXpCapped": false
    },
    "spell_def456": {
      "level": 1,
      "xp": 0,
      "isXpCapped": false
    }
  },
  "unlockedAt": {
    "spell_abc123": "2026-02-15T...",
    "spell_def456": "2026-02-01T..."
  },
  "updatedAt": "2026-02-19T..."
}
```

**What happens during research:**

| Action | Change |
|---|---|
| **Unlock (0→1)** | Creates `spells.{spellId}: { level: 1, xp: 0, isXpCapped: false }` and sets `unlockedAt.{spellId}` |
| **Level up (1→2, etc.)** | Updates `spells.{spellId}.level` to new level, resets `xp` to 0 |

---

### 3.4 Queues/Library

**Path:** `/Players/{uid}/Queues/Library`

The research queue. Contains active research slots.

```json
{
  "slots": [
    {
      "spellId": "spell_abc123",
      "startedAt": "2026-02-19T10:00:00Z",
      "completesAt": "2026-02-19T10:30:00Z",
      "targetLevel": 3,
      "shardsPaid": 250
    }
  ],
  "maxSlots": 2,
  "updatedAt": "2026-02-19T..."
}
```

**Lifecycle:**
1. `startSpellResearchV2` → **adds** entry to `slots[]`
2. Timer runs (client-side countdown)
3. `claimSpellResearchV2` → **removes** entry from `slots[]`, updates `Spells/Levels`

---

### 3.5 SpellDecks/Decks

**Path:** `/Players/{uid}/SpellDecks/Decks`

Active spell loadout per car. Created during initialization, updated when player changes equipped spells.

---

## 4. Cloud Functions

### 4.1 `startSpellResearchV2`

**File:** `src/spellsV2/researchV2.ts`

**Input:**
```json
{ "spellId": "spell_abc123" }
```

**Logic:**
1. Load SpellEvolutionV2Catalog, PlayerSlotsConfig, SpellsCatalog
2. Check if spell is owned:
   - **Not owned (level < 1):** Check player level ≥ spell's `requiredLevel` → use `unlockCost`
   - **Owned:** Use `researchCosts[targetLevel]`
3. Check library has available slot
4. Deduct `spellShards` from Economy/Stats
5. Add entry to `Queues/Library` with `completesAt` timestamp

**Writes:**
- `Economy/Stats` → decrement `spellShards`
- `Queues/Library` → add slot entry

---

### 4.2 `claimSpellResearchV2`

**File:** `src/spellsV2/researchV2.ts`

**Input:**
```json
{ "spellId": "spell_abc123" }
```

**Logic:**
1. Find the spell's slot in `Queues/Library`
2. Check `completesAt` ≤ now
3. Remove slot from queue
4. Update spell level:
   - **Unlock (targetLevel = 1, not yet owned):** Create new entry in `Spells/Levels` + set `unlockedAt`
   - **Level up:** Update existing entry's `level`

**Writes:**
- `Queues/Library` → remove slot entry
- `Spells/Levels` → create or update spell entry

---

### 4.3 `skipSpellResearchV2`

**File:** `src/spellsV2/researchV2.ts`

**Input:**
```json
{ "spellId": "spell_abc123" }
```

**Logic:**
1. Calculate gem cost: `max(minGems, ceil(remainingHours × gemsPerHour))`
2. Deduct gems from Economy/Stats
3. Set `completesAt` to now (research completes immediately)
4. Player then calls `claimSpellResearchV2`

**Writes:**
- `Economy/Stats` → decrement `gems`
- `Queues/Library` → update `completesAt` to now

---

### 4.4 `grantXP`

**File:** `src/economy/xp.ts`

**Relevant behavior:** When a player levels up, this function identifies spells that just became available for research:

```json
// Response includes:
{
  "leveledUp": true,
  "levelBefore": 4,
  "levelAfter": 5,
  "newlyAvailableSpellIds": ["spell_abc123"],
  "grantedSpellIds": []
}
```

**Note:** Spells are NOT auto-granted — only `newlyAvailableSpellIds` is returned so Unity can show a notification.

---

## 5. How Players Earn Spell Shards

| Source | Amount |
|---|---|
| Race finish — 1st place | 10 shards |
| Race finish — 2nd place | 7 shards |
| Race finish — 3rd place | 4 shards |
| Race finish — other | 1 shard |
| Shard Booster (active) | Multiplier on race rewards |
| Crate rewards | Variable |

---

## 6. Research Cost Summary

| Target Level | Shards | Duration | Description |
|---|---|---|---|
| 1 (unlock) | 100 | 1 minute | Initial unlock for level-gated spells |
| 2 | 100 | 30 minutes | First upgrade |
| 3 | 250 | 1 hour | — |
| 4 | 500 | 2 hours | — |
| 5 (max) | 1,000 | 4 hours | — |

**Skip Cost:** `max(5 gems, ⌈remainingHours × 25 gems⌉)`

---

## 7. Seeder Responsibilities

| Seeder | Catalogs | Command |
|---|---|---|
| `seedFirestore.sandbox.ts` | ItemsCatalog, ItemsIndex, ItemSkusCatalog, CratesCatalog, OffersCatalog, SpellsCatalog, CarsCatalog, RanksCatalog, GemPacksCatalog + configs | `npx ts-node tools/seedFirestore.sandbox.ts` |
| `seedV2Catalogs.mjs` | CarEvolutionV2Catalog, SpellEvolutionV2Catalog, TiersCatalog + FuelConfig, CrateSlotsConfig, PlayerSlotsConfig, CarStatsBudgetConfig | `node tools/seedV2Catalogs.mjs sandbox` |

**Important:** CarEvolutionV2Catalog and SpellEvolutionV2Catalog were removed from `gameDataCatalogs.v3.normalized.json` to prevent seeder clashes. They are now only managed by `seedV2Catalogs.mjs`.

---

## 8. Firestore Document Map (Quick Reference)

```
/GameData/v1/
├── catalogs/
│   ├── SpellsCatalog              ← Spell definitions + requiredLevel
│   ├── SpellEvolutionV2Catalog    ← Research costs, unlockCost, skip costs
│   ├── ItemsCatalog               ← Shard Booster items (bst_shrd7k9m)
│   ├── ItemSkusCatalog            ← SKU flat lookup (sku_shrd1h_p3x9, etc.)
│   ├── ItemsIndex                 ← Family → SKU mapping
│   └── BoostersCatalog            ← Booster activation definitions
│
/Players/{uid}/
├── Profile/Profile                ← level, xp, librarySlots
├── Economy/Stats                  ← coins, gems, spellShards
├── Spells/Levels                  ← spells.{id}.level, unlockedAt.{id}
├── Queues/Library                 ← slots[] (active research queue)
└── SpellDecks/Decks               ← Equipped spell loadout
```
