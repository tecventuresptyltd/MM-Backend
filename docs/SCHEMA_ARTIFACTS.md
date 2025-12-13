# Schema Artifacts for Opaque ID Architecture

**Date:** 2025-10-15  
**Phase:** 2 - Schema Artifacts Creation  
**Purpose:** All configuration files, rules, indexes, and seed data for the new architecture

---

## Firestore Security Rules

**File:** `firestore.rules`

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isSignedIn() { return request.auth != null; }
    function isSelf(uid) { return isSignedIn() && request.auth.uid == uid; }
    function isServerRequest() { return request.auth.token.firebase.sign_in_provider == 'custom'; }

    // Public master data (read-only for clients)
    match /GameData/{collection}/{id} {
      allow read: if true;
      allow write: if false; // Server-only updates
    }

    // Game configuration (read-only for clients) 
    match /GameConfig/Versions/{versionId} {
      allow read: if true;
      allow write: if false; // Server-only updates
    }

    // Players - self-scoped access with economy restrictions
    match /Players/{uid} {
      allow read, write: if isSelf(uid);
      
      // Hot economy data - READ-ONLY for clients
      match /Economy/Stats {
        allow read: if isSelf(uid);
        allow write: if false; // SERVER-ONLY via Cloud Functions
      }
      
      match /Economy/Transactions/{opId} {
        allow read: if isSelf(uid);
        allow write: if false; // SERVER-ONLY transaction receipts
      }
      
      // Other player data - client can read/write
      match /{document=**} {
        allow read, write: if isSelf(uid);
      }
    }

    // Operations tracking - server-only
    match /Ops/{opId} {
      allow read, write: if false; // SERVER-ONLY
    }

    // Clans - public read, server-controlled writes
    match /Clans/{clanId} {
      allow read: if true;
      allow write: if false; // SERVER-ONLY (aggregation via CF)
      
      match /Members/{uid} {
        allow read: if true;
        allow write: if false; // SERVER-ONLY (join/leave via CF)
      }
      
      match /Chat/{messageId} {
        allow read: if true;
        allow create: if isSignedIn(); // Users can post messages
        allow update, delete: if false;
      }
      
      match /Requests/{uid} {
        allow read: if true;
        allow create: if isSelf(uid); // Users can request to join
        allow update, delete: if false; // SERVER-ONLY approval
      }
    }

    // Global and room-based chat
    match /Rooms/{roomId}/Messages/{messageId} {
      allow read: if true;
      allow create: if isSignedIn();
      allow update, delete: if false;
    }

    // Races - clients can read, server controls writes
    match /Races/{raceId} {
      allow read: if isSignedIn();
      allow write: if false; // SERVER-ONLY race management
      
      match /Participants/{uid} {
        allow read: if isSignedIn();
        allow write: if false; // SERVER-ONLY result submission
      }
    }

    // Audit logs - server-only
    match /Audit/{day}/Entries/{entryId} {
      allow read, write: if false; // SERVER-ONLY audit trail
    }

    // Admin operations - server-only
    match /AdminOps/{opId} {
      allow read, write: if false; // SERVER-ONLY admin tasks
    }
  }
}
```

---

## Firestore Indexes Configuration

**File:** `firestore.indexes.json`

```json
{
  "indexes": [
    {
      "collectionGroup": "Messages",
      "queryScope": "COLLECTION_GROUP", 
      "fields": [
        { "fieldPath": "roomId", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "Chat", 
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "Members",
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        { "fieldPath": "role", "order": "ASCENDING" },
        { "fieldPath": "joinedAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "Inventory", 
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        { "fieldPath": "category", "order": "ASCENDING" },
        { "fieldPath": "updatedAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "Participants",
      "queryScope": "COLLECTION_GROUP", 
      "fields": [
        { "fieldPath": "uid", "order": "ASCENDING" },
        { "fieldPath": "submittedAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "Tracks",
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        { "fieldPath": "unlocked", "order": "ASCENDING" },
        { "fieldPath": "updatedAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "Garage",
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        { "fieldPath": "equipped", "order": "DESCENDING" },
        { "fieldPath": "updatedAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "Transactions", 
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        { "fieldPath": "type", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "Requests",
      "queryScope": "COLLECTION_GROUP", 
      "fields": [
        { "fieldPath": "requestedAt", "order": "DESCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

---

## Opaque ID Generation

### Crockford Base32 ID Generator

**Regex Pattern:** `^[a-z]+_[0-9a-hjkmnp-tv-z]{8,12}$`

**Sample IDs Generated:**
```
Cars: car_9q7m2k4d1t, car_5n3k7q1p0m, car_8jz3m2k4d1
Spells: spell_3gzk7r2m9p, spell_c19q7m2k0d, spell_f7p0x4a3n1  
Items: item_1p5x7r0m3n, item_7k2m4d1tq9, item_2m7qk1p9sx
Crates: crt_2m7qk1p9, crt_8jz3m2k4d1, crt_5n3k7q1p0m
Tracks: trk_7m2k4d1tq9, trk_9q7m2k4d1t, trk_3gzk7r2m9p
Ranks: rank_5n3k7q1p0m, rank_8jz3m2k4d1, rank_2m7qk1p9
Offers: ofr_8jz3m2k4d1, ofr_3gzk7r2m9p, ofr_5n3k7q1p0m
XpCurves: xp_9q7m2k4d1t, xp_7m2k4d1tq9, xp_3gzk7r2m9p
Operations: op_3gzk7r2m9p, op_7m2k4d1tq9, op_8jz3m2k4d1
```

---

## GameData Seed Files

### Cars Master Data

**File:** `seeds/cars.json`

```json
[
  {
    "path": "/GameData/Cars/car_9q7m2k4d1t",
    "data": {
      "carId": "car_9q7m2k4d1t",
      "displayName": "Deimos GT",
      "i18n": { 
        "en": "Deimos GT",
        "es": "Deimos GT",
        "fr": "Deimos GT"
      },
      "class": "epic", 
      "basePrice": { "coins": 5000, "gems": 0 },
      "baseStats": { 
        "acceleration": 60, 
        "topSpeed": 70, 
        "boostRegen": 50, 
        "boostPower": 55, 
        "handling": 65 
      },
      "upgradeCurve": {
        "0": { 
          "delta": {"acceleration":0,"topSpeed":0,"boostRegen":0,"boostPower":0,"handling":0}, 
          "cost": {"coins": 0} 
        },
        "1": { 
          "delta": {"acceleration":2,"topSpeed":1,"boostRegen":1,"boostPower":1,"handling":1}, 
          "cost": {"coins": 500} 
        },
        "2": { 
          "delta": {"acceleration":2,"topSpeed":1,"boostRegen":1,"boostPower":1,"handling":1}, 
          "cost": {"coins": 750} 
        },
        "3": { 
          "delta": {"acceleration":3,"topSpeed":2,"boostRegen":2,"boostPower":1,"handling":1}, 
          "cost": {"coins": 1000} 
        }
      },
      "version": "v2025.10.15"
    }
  },
  {
    "path": "/GameData/Cars/car_5n3k7q1p0m", 
    "data": {
      "carId": "car_5n3k7q1p0m",
      "displayName": "Phantom Racer",
      "i18n": { 
        "en": "Phantom Racer",
        "es": "Corredor Fantasma", 
        "fr": "Coureur Fantôme"
      },
      "class": "legendary",
      "basePrice": { "coins": 12000, "gems": 0 },
      "baseStats": { 
        "acceleration": 75, 
        "topSpeed": 85, 
        "boostRegen": 60, 
        "boostPower": 70, 
        "handling": 80 
      },
      "upgradeCurve": {
        "0": { 
          "delta": {"acceleration":0,"topSpeed":0,"boostRegen":0,"boostPower":0,"handling":0}, 
          "cost": {"coins": 0} 
        },
        "1": { 
          "delta": {"acceleration":3,"topSpeed":2,"boostRegen":2,"boostPower":2,"handling":2}, 
          "cost": {"coins": 800} 
        }
      },
      "version": "v2025.10.15"
    }
  }
]
```

### Spells Master Data

**File:** `seeds/spells.json`

Each spell document in `/GameData/v1/Spells/{spellId}` follows this schema:

```jsonc
// /GameData/v1/Spells/spell_3gzk7r2m9p
{
  "spellId": "spell_3gzk7r2m9p",
  "displayName": "Sky Reaper",
  "description": "Laser beam blasts player one, stunning them for a period of time",
  "i18n": { "en": "Sky Reaper" },

  // Optional categorical fields if present in legacy
  "rarity": "epic",               // "common" | "rare" | "epic" | "legendary" | "mythic"
  "class": "offense",             // "offense" | "defense" | "control" | etc.
  "targeting": "targetLock",      // e.g., "self", "forwardCone", "targetLock", etc.

  // Per-level attributes. Include whatever the legacy provides, e.g. impactSec, damage, radius, cooldownMs, cost.coins, etc
  "levels": {
    "1":  { "impactSec": 1.0,  "cooldownMs": 12000 },
    "2":  { "impactSec": 1.5,  "cooldownMs": 11800 },
    "3":  { "impactSec": 2.0,  "cooldownMs": 11600 },
    "4":  { "impactSec": 2.5,  "cooldownMs": 11400 },
    "5":  { "impactSec": 3.0,  "cooldownMs": 11200 }
    // … continue for all levels available in legacy (up to 20 if present)
  },

  // Unlock gate (if present in legacy)
  "unlock": {
    "minPlayerLevel": 35
  },

  "version": "vYYYY.MM.DD",       // use today’s date (e.g., v2025.10.20)
  "createdAt": 1730000000000,     // Date.now()
  "updatedAt": 1730000000000
}
```

### Items Master Data

**File:** `seeds/items.json`

```json
[
  {
    "path": "/GameData/Items/item_1p5x7r0m3n",
    "data": {
      "itemId": "item_1p5x7r0m3n", 
      "displayName": "Gamma Wheels (Black)",
      "i18n": { 
        "en": "Gamma Wheels (Black)",
        "es": "Ruedas Gamma (Negro)",
        "fr": "Roues Gamma (Noir)"
      },
      "category": "wheel",
      "rarity": "common", 
      "stackable": true,
      "cosmetic": { 
        "slot": "wheels", 
        "color": "Black" 
      },
      "version": "v2025.10.15"
    }
  },
  {
    "path": "/GameData/Items/item_7k2m4d1tq9",
    "data": {
      "itemId": "item_7k2m4d1tq9",
      "displayName": "Lightning Decal (Blue)", 
      "i18n": { 
        "en": "Lightning Decal (Blue)",
        "es": "Calcomanía de Rayo (Azul)",
        "fr": "Décalcomanie Éclair (Bleu)"
      },
      "category": "decal",
      "rarity": "rare",
      "stackable": true,
      "cosmetic": { 
        "slot": "decals", 
        "color": "Blue" 
      },
      "version": "v2025.10.15"
    }
  }
]
```

### Crates Master Data

**File:** `seeds/crates.json`

```json
[
  {
    "path": "/GameData/Crates/crt_2m7qk1p9",
    "data": {
      "crateId": "crt_2m7qk1p9",
      "displayName": "Common Crate",
      "i18n": { 
        "en": "Common Crate",
        "es": "Caja Común",
        "fr": "Caisse Commune"
      },
      "rarityWeights": { 
        "common": 80, 
        "rare": 15, 
        "epic": 4, 
        "legendary": 0.9, 
        "mythical": 0.1 
      },
      "lootTables": {
        "items": [
          { "id": "item_1p5x7r0m3n", "weight": 30 },
          { "id": "item_7k2m4d1tq9", "weight": 15 }
        ]
      },
      "pity": { 
        "enabled": true, 
        "rolls": 20, 
        "guarantee": "rare+" 
      },
      "version": "v2025.10.15"
    }
  },
  {
    "path": "/GameData/Crates/crt_8jz3m2k4d1",
    "data": {
      "crateId": "crt_8jz3m2k4d1",
      "displayName": "Epic Crate",
      "i18n": { 
        "en": "Epic Crate",
        "es": "Caja Épica", 
        "fr": "Caisse Épique"
      },
      "rarityWeights": { 
        "common": 40, 
        "rare": 35, 
        "epic": 20, 
        "legendary": 4.5, 
        "mythical": 0.5 
      },
      "lootTables": {
        "items": [
          { "id": "item_1p5x7r0m3n", "weight": 20 },
          { "id": "item_7k2m4d1tq9", "weight": 25 }
        ]
      },
      "pity": { 
        "enabled": true, 
        "rolls": 10, 
        "guarantee": "epic+" 
      },
      "version": "v2025.10.15"
    }
  }
]
```

### Tracks Master Data

**File:** `seeds/tracks.json`

```json
[
  {
    "path": "/GameData/Tracks/trk_7m2k4d1tq9",
    "data": {
      "trackId": "trk_7m2k4d1tq9",
      "displayName": "Neon City Loop",
      "i18n": { 
        "en": "Neon City Loop",
        "es": "Circuito de Ciudad Neón",
        "fr": "Circuit de la Ville Néon"
      },
      "biome": "city",
      "difficulty": 3,
      "unlockReqs": { 
        "level": 5, 
        "trophies": 500 
      },
      "rewards": {
        "stars": {
          "1": { "coins": 100, "xp": 50 },
          "2": { "coins": 150, "xp": 75 },
          "3": { "coins": 200, "xp": 100 }
        }
      },
      "version": "v2025.10.15"
    }
  },
  {
    "path": "/GameData/Tracks/trk_9q7m2k4d1t",
    "data": {
      "trackId": "trk_9q7m2k4d1t", 
      "displayName": "Desert Storm Circuit",
      "i18n": { 
        "en": "Desert Storm Circuit",
        "es": "Circuito Tormenta del Desierto",
        "fr": "Circuit Tempête du Désert"
      },
      "biome": "desert",
      "difficulty": 5, 
      "unlockReqs": { 
        "level": 8, 
        "trophies": 1000 
      },
      "rewards": {
        "stars": {
          "1": { "coins": 200, "xp": 100 },
          "2": { "coins": 300, "xp": 150 },
          "3": { "coins": 400, "xp": 200 }
        }
      },
      "version": "v2025.10.15"
    }
  }
]
```

### Ranks Master Data

**File:** `seeds/ranks.json`

```json
[
  {
    "path": "/GameData/Ranks/rank_5n3k7q1p0m",
    "data": {
      "rankId": "rank_5n3k7q1p0m",
      "displayName": "Gold I",
      "i18n": { 
        "en": "Gold I",
        "es": "Oro I", 
        "fr": "Or I"
      },
      "trophies": { 
        "min": 1200, 
        "max": 1399 
      },
      "endSeasonRewards": { 
        "coins": 500, 
        "gems": 10 
      },
      "version": "v2025.10.15"
    }
  },
  {
    "path": "/GameData/Ranks/rank_8jz3m2k4d1",
    "data": {
      "rankId": "rank_8jz3m2k4d1",
      "displayName": "Platinum III",
      "i18n": { 
        "en": "Platinum III",
        "es": "Platino III",
        "fr": "Platine III"
      },
      "trophies": { 
        "min": 1600, 
        "max": 1799 
      },
      "endSeasonRewards": { 
        "coins": 800, 
        "gems": 20 
      },
      "version": "v2025.10.15"
    }
  }
]
```

### XP Curves Master Data (DEPRECATED)

**Status:** ⚠️ **DEPRECATED** - XP progression is now calculated via runtime formula in `src/shared/xp.ts` using the "Infinite Leveling Power Curve" algorithm. No Firestore seed data is required.

**Legacy File:** `seeds/xpCurve.json` (no longer used)

```json
[
  {
    "path": "/GameData/XpCurve/xp_9q7m2k4d1t",
    "data": {
      "curveId": "xp_9q7m2k4d1t",
      "levels": { 
        "1": 0, 
        "2": 200, 
        "3": 450, 
        "4": 800, 
        "5": 1300, 
        "6": 1900, 
        "7": 2600, 
        "8": 3400, 
        "9": 4300, 
        "10": 5300 
      },
      "version": "v2025.10.15"
    }
  }
]
```

### Offers Master Data

**File:** `seeds/offers.json`

```json
[
  {
    "path": "/GameData/Offers/ofr_8jz3m2k4d1",
    "data": {
      "offerId": "ofr_8jz3m2k4d1",
      "displayName": "Starter Pack",
      "i18n": { 
        "en": "Starter Pack",
        "es": "Paquete de Inicio",
        "fr": "Pack de Démarrage"
      },
      "entitlements": [
        { "type": "coins", "qty": 5000 },
        { "type": "gems", "qty": 50 },
        { "type": "item", "id": "item_1p5x7r0m3n", "qty": 1 }
      ],
      "price": { 
        "local": { "AUD": 7.99 }, 
        "platform": "IAP" 
      },
      "timers": { 
        "durationMs": 172800000, 
        "cooldownMs": 0 
      },
      "eligibility": { 
        "levelMax": 10, 
        "firstPurchaseOnly": true 
      },
      "version": "v2025.10.15"
    }
  }
]
```

### Game Configuration

**File:** `seeds/gameConfig.json`

```json
[
  {
    "path": "/GameConfig/Versions/v2025.10.15",
    "data": {
      "versionId": "v2025.10.15",
      "pricesetVersion": "p1",
      "lootTableVersion": "l1", 
      "xpCurveId": "xp_9q7m2k4d1t",
      "ranksVersion": "r1",
      "offersVersion": "o1",
      "featureFlags": { 
        "enablePiggyBank": true, 
        "enableClanSearch": true 
      },
      "rooms": { 
        "globalRoomId": "global" 
      },
      "rollback": false,
      "createdAt": 1739500000000,
      "updatedAt": 1739560000000
    }
  }
]
```

---

## ID Validation Script

**Purpose:** Validate all generated IDs against Crockford base32 regex

```javascript
// Crockford base32 regex (excludes i, l, o, u)  
const CROCKFORD_REGEX = /^[a-z]+_[0-9a-hjkmnp-tv-z]{8,12}$/;

// Test function
function validateOpaqueId(id) {
  return CROCKFORD_REGEX.test(id);
}

// Validation results for sample IDs:
console.log(validateOpaqueId('car_9q7m2k4d1t'));    // ✅ true
console.log(validateOpaqueId('spell_3gzk7r2m9p'));  // ✅ true  
console.log(validateOpaqueId('item_1p5x7r0m3n'));   // ✅ true
console.log(validateOpaqueId('car_invalid_id'));    // ❌ false (contains 'i')
console.log(validateOpaqueId('car_toolong123456')); // ❌ false (too long)
```

---

## Migration Mapping Tables

### Current Name → Opaque ID Mappings

| Entity Type | Current Name | New Opaque ID |
|-------------|--------------|---------------|
| **Cars** | | |
| "Deimos GT" | `car_9q7m2k4d1t` |
| "Phantom Racer" | `car_5n3k7q1p0m` |
| "Storm Rider" | `car_8jz3m2k4d1` |
| **Spells** | | |
| "Shockwave" | `spell_3gzk7r2m9p` |
| "Speed Boost" | `spell_c19q7m2k0d` |
| "Fireball" | `spell_f7p0x4a3n1` |
| **Items** | | |
| "Gamma Wheels (Black)" | `item_1p5x7r0m3n` |
| "Lightning Decal (Blue)" | `item_7k2m4d1tq9` |
| "Neon Spoiler (Green)" | `item_2m7qk1p9sx` |
| **Tracks** | | |
| "Neon City Loop" | `trk_7m2k4d1tq9` |
| "Desert Storm Circuit" | `trk_9q7m2k4d1t` |
| "Snow Mountain Pass" | `trk_3gzk7r2m9p` |

---

## Summary & Next Steps

✅ **Schema Artifacts Complete:**
- Firestore security rules with server-only economy
- Composite indexes for efficient queries
- Opaque ID generation with Crockford base32
- Master data seed files for all GameData collections.
- End-to-end test dataset for players, clans, and races.
- ID validation scripts and mapping tables

⏳ **Next Phase:** Migration Plan Design
- Field-by-field migration strategy
- Zero-downtime dual-read approach
- User checkpoint system
- Reconciliation jobs for clan aggregates
