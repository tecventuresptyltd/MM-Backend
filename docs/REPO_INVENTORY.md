# Repository Inventory & Current State Analysis

**Date:** 2025-10-15  
**Purpose:** Comprehensive analysis of current Firestore implementation to guide migration to opaque ID, server-authoritative architecture.

---

## Current Firestore Collection Structure

### Players Collection (`/players/{uid}`)
```
/players/{uid}                          // Main document (minimal)
├── /profileData/profileData            // JSON blob: ProfileData
├── /garageData/garageData              // JSON blob: GarageData  
├── /socialData/socialData              // JSON blob: SocialData
├── /mapData/mapData                    // JSON blob: MapData
├── /referralData/referralData          // JSON blob: ReferralData
├── /dailyRewardsData/dailyRewardsData  // JSON blob: DailyRewardsData
├── /offersData/offersData              // JSON blob: OffersData
└── /boosterData/boosterData            // JSON blob: BoosterData
```

### Other Collections
```
/clans/{clanId}                         // JSON blob: ClanData
/global_chat/main/messages/{messageId}  // Individual message docs
/CratesDistributionData/CratesDistributionData // JSON blob: crate config
```

### Realtime Database (Status)
```
/users/{uid}/lastSeen                   // Timestamp for online status
/users/{uid}/username                   // Username uniqueness check
```

---

## Current Data Structures Analysis

### ProfileData (Current)
```csharp
public class ProfileData {
    public string username;                    // Human-readable name
    public string userId;                      // Firebase UID
    public int careerEarning;                  // Client-calculated total
    public int totalRace;                      // Client-calculated count
    public int totalWin;                       // Client-calculated count
    public int playerCoins;                    // CLIENT-SIDE ECONOMY ❌
    public int playerGem;                      // CLIENT-SIDE ECONOMY ❌
    public int playerExperience;               // Client-calculated XP
    public int playerLevel;                    // Derived from XP
    public List<Spell> spellDeck;             // Name-based spell references
    public Avatar avatar;                      // Complex object
    public string selectedCar;                 // Name-based car reference
    public int trophyLevel;                    // Current trophies
    public int trophyHighestLevel;            // Peak trophies
    public List<string> friendRequestsSent;   // Friend management
    public string referralCode;               // Referral system
    // ... other fields
}
```

### GarageData (Current)
```csharp
public class GarageData {
    public CrateData crateData;              // CLIENT-SIDE ECONOMY ❌
    public KeyData keyData;                  // CLIENT-SIDE ECONOMY ❌
    public CarCosmaticData carCosmeticData;  // Name-based cosmetic refs
    public List<GarageItem> garageItemsData; // Inventory with name-based IDs
    public List<Car> carsData;               // Car ownership/upgrades
}
```

### SocialData (Current)
```csharp
public class SocialData {
    public string username;                  // Duplicated from ProfileData
    public string userId;                    // Duplicated from ProfileData
    public int playerLevel;                  // Duplicated from ProfileData
    public int trophyLevel;                  // Duplicated from ProfileData
    public Avatar avatar;                    // Duplicated from ProfileData
    public string clanName;                  // Human-readable clan name
    public List<Friend> friends;             // Friend list
    public List<Friend> friendRequests;     // Friend requests
}
```

---

## Anti-Patterns Identified

### 🚨 Critical Issues

1. **Client-Side Economy Control**
   - `UpdatePlayerCoins()`, `UpdatePlayerGem()` called from client
   - Crate opening logic partially on client
   - No server validation of economy transactions
   - **Risk:** Cheating, duplication, inconsistent state

2. **JSON Blob Storage**
   - Entire player data serialized as JSON strings
   - Cannot query individual fields efficiently
   - Forces full document reads/writes
   - **Impact:** Poor performance, high costs, inefficient listeners

3. **Name-Based Identifiers**
   - Cars referenced by `carName` string
   - Spells referenced by `spellName` string  
   - Cosmetics referenced by `itemName + "_" + color`
   - **Problem:** Localization impossible, refactoring difficult

4. **Duplicated Data**
   - Username stored in ProfileData, SocialData, and Friend objects
   - Trophy/level data replicated across structures
   - **Issue:** Data consistency problems

5. **Large "God" Documents**
   - All player data in single transaction updates
   - Hot path includes unnecessary data
   - **Result:** Contention, slow writes, high bandwidth

6. **No Idempotency**
   - Operations can be replayed causing duplication
   - No operation tracking (`opId`)
   - **Risk:** Double-spending, inconsistent state

### 🔶 Performance Issues

1. **Inefficient Queries**
   - Cannot filter/sort on individual fields (JSON blobs)
   - Must download entire documents for simple operations
   - No compound indexes possible

2. **Poor Listener Efficiency**
   - Listeners trigger on any field change within blob
   - Unnecessary data transfer
   - Cannot subscribe to specific data subsets

3. **Clan Aggregation Problems**
   - Clan trophy totals calculated on read
   - No delta-based updates
   - **Scale Issue:** O(n) calculation per clan view

---

## Mapping to New Schema

### Current → Target Architecture

| Current Structure | Target Structure | Notes |
|---|---|---|
| `/players/{uid}/profileData/profileData` | `/Players/{uid}/Economy/Stats` | Split into hot/cold data |
| | `/Players/{uid}/Social/Profile` | |
| | `/Players/{uid}/Daily/Status` | |
| `/players/{uid}/garageData/garageData` | `/Players/{uid}/Garage/{carId}` | Per-car documents |
| | `/Players/{uid}/Inventory/{itemId}` | Per-item documents |
| | `/Players/{uid}/Loadouts/{slotId}` | Separate loadouts |
| `/players/{uid}/socialData/socialData` | `/Players/{uid}/Social/Profile` | De-duplicated |
| `/players/{uid}/mapData/mapData` | `/Players/{uid}/Progress/Tracks/{trackId}` | Per-track progress |
| `/clans/{clanId}` | `/Clans/{clanId}` | Delta-aggregated stats |
| | `/Clans/{clanId}/Members/{uid}` | Per-member docs |
| | `/Clans/{clanId}/Chat/{messageId}` | Proper chat structure |

---

## Client-Side Economy Operations (Must Migrate to Server)

### Direct Economy Modifications
```csharp
// These ALL need server-side Cloud Functions:
FirestoreManager.UpdatePlayerCoins(int coins)
FirestoreManager.UpdatePlayerGem(int playerGem) 
FirestoreManager.UpdatePlayerExperience(int playerExperience)
FirestoreManager.UpdateTrophyLevel(int trophyLevel, int highestLevel)

// Garage operations that affect economy:
GarageData.SetWheel(string itemName, string itemColor)    // Equip/unequip items
GarageData.SetDecals(string itemName, string itemColor)
GarageData.SetSpoilers(string itemName, string itemColor)
GarageData.SetUnderglow(string itemName, string itemColor)
GarageData.SetBoost(string itemName, string itemColor)

// Crate system:
FirestoreCrateOpeningData.OpenCrateServerSide()           // Partially server-side
```

### Race Results & Rewards
```csharp
// Race completion - needs server validation:
FirestoreManager.UpdateCareerEarning(int careerEarning)
FirestoreManager.UpdateTotalRace(int totalRace)
FirestoreManager.UpdateTotalWin(int totalWin)
```

### Social Operations
```csharp
// Friend system - needs proper transactions:
FirestoreFriendRequestListener.AcceptFriendRequest()
FirestoreFriendRequestListener.RejectFriendRequest() 
FirestoreManager.AddFriendRequest()
```

---

## Name-Based ID Inventory (Requires Opaque Mapping)

### Cars
```csharp
public class Car {
    public string carName;        // → car_xxxxxxxxxxxx
    public string selectedCar;    // → car_xxxxxxxxxxxx  
}
```

### Spells  
```csharp
public class Spell {
    public string spellName;      // → spell_xxxxxxxxxxxx
    public string id;             // Currently name-based
}
```

### Cosmetic Items
```csharp
public class GarageItem {
    public string itemName;       // → item_xxxxxxxxxxxx
}

public class CarCosmaticData {
    public string wheels;         // → item_xxxxxxxxxxxx
    public string decals;         // → item_xxxxxxxxxxxx  
    public string spoilers;       // → item_xxxxxxxxxxxx
    public string underglow;      // → item_xxxxxxxxxxxx
    public string boost;          // → item_xxxxxxxxxxxx
}
```

### Maps/Tracks
```csharp
public class LevelData {
    public string levelName;      // → trk_xxxxxxxxxxxx
}
```

### Other Entities Needing Opaque IDs
- Crate types → `crt_xxxxxxxxxxxx`
- Rank tiers → `rank_xxxxxxxxxxxx`  
- Offers → `ofr_xxxxxxxxxxxx`
- ~~XP curves → `xp_xxxxxxxxxxxx`~~ (DEPRECATED - now calculated via runtime formula)

---

## Function Call Sites Analysis

### Cloud Functions (Already Server-Side ✅)
```csharp
FirestoreCrateOpeningData.CallOpenCrateFunction()         // openCrate CF
FirestoreCrateOpeningData.CallGetEndRaceRewardFunction()  // getEndRaceRewards CF
```

### Client Operations (Need Server Functions ❌)
```csharp
// All FirestoreManager update methods
// All economy-related operations
// Race result submissions
// Trophy updates
// Clan join/leave operations
// Friend system operations
```

---

## Performance Hotspots

### Always-On Listeners
```csharp
// These run continuously - need optimization:
FirestoreManager.MainPlayer                               // Full player data
FirestoreFriendRequestListener.StartListening()          // Social updates  
FirestoreGlobalChatManager.SubscribeToGlobalMessages()   // Chat messages
FirestoreReferralManager.ListenForReferralsLive()        // Referral updates
```

### Transaction Boundaries
```csharp
// Current: Single massive transaction for all player data
FirestoreManager.UpdatePlayerDataTransaction(FirestorePlayer player)

// Target: Small, focused transactions per operation
// - Economy ops: Stats + single Transaction record
// - Garage ops: Single car/item + optional Stats update
// - Social ops: Profile update only
```

---

## Migration Strategy Implications

### High-Priority Migrations
1. **Economy Operations** → Server functions with `opId` tracking
2. **Master Data Extraction** → `/GameData/**` collections  
3. **Player Data Decomposition** → Small hot documents
4. **Clan Aggregation** → Delta-based trophy calculation

### Medium-Priority Migrations  
1. **Social System Cleanup** → Deduplicated friend management
2. **Chat System** → Proper message structure
3. **Inventory System** → Per-item documents

### Low-Priority Migrations
1. **Status System** → Keep in Realtime Database
2. **Analytics Data** → `/Audit/**` append-only logs

---

## Next Steps

✅ **Phase 1 Complete** - Repository analysis finished  
⏳ **Phase 2 Starting** - Schema artifacts creation  
- Generate opaque IDs for all master data
- Create firestore.rules with economy restrictions
- Build seed data for `/GameData/**` collections
- Design firestore.indexes.json for optimal queries

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Client economy bypass | HIGH | Server-only writes via CF |
| Data loss during migration | HIGH | Dual-read/write period |
| Performance regression | MEDIUM | Focused listeners, caching |
| Clan trophy inconsistency | MEDIUM | Delta updates + reconciliation |
| Downtime during cutover | LOW | Gradual rollout per user |
