import json
import math

INPUT_FILE = "seeds/Atul-Final-Seeds/CarsCatalog.json"
OUTPUT_FILE = "seeds/Atul-Final-Seeds/CarsCatalog.json"

# Progression configuration
# Level 0 to 9 -> 10 levels total
# XP scales up, timer scales up per level.
LEVELS = 10

# Base XP array (for street class, scales per tier)
# 0 -> 1 requires 1000 XP
# 1 -> 2 requires 1500 XP
# ...
# 9 is maxed, requires 0 XP
BASE_XP_REQS = [1000, 1500, 2000, 3000, 4000, 5000, 7000, 10000, 15000, 0]

# Base Timer array in seconds
# 0 -> 1 requires 1 hour (3600)
# ...
BASE_TIMERS = [3600, 7200, 10800, 14400, 21600, 28800, 43200, 57600, 72000, 0]

# Tier Multipliers (simulating the old tierScaling)
TIER_MULT = {
    1: {"xp": 0.20, "timer": 0.01},
    2: {"xp": 0.50, "timer": 0.15},
    3: {"xp": 1.00, "timer": 1.00},
    4: {"xp": 2.00, "timer": 2.50},
    5: {"xp": 4.00, "timer": 4.00},
}

# Determine Tier based on Base Price roughly
def get_tier(base_price):
    if base_price == 0: return 1
    if base_price < 20000: return 2
    if base_price < 100000: return 3
    if base_price < 500000: return 4
    return 5

# Abilities
GUARDIAN = {"id": "guardianShield", "duration": 7, "cooldown": 20}
PHANTOM = {"id": "phantomDash", "speedMultiplier": 1.3, "duration": 5, "cooldown": 15}
ARCANEOUS = {"id": "spellReduction", "cooldownReduction": 2, "duration": 10, "cooldown": 5}

def get_ability(car_class, car_name):
    # Determine ability by logic or name (Assuming all 15 cars split evenly into these archetypes)
    # The prompt noted Guardian (Tank), Phantom (Speed), Arcaneous (Strategist).
    # Currently CarsCatalog has "street", "sport", "super", etc. We need to derive class/archetype.
    # We will use simple heuristics or cycle if not defined.
    # 'tank' -> Guardian, 'speedster' -> Phantom, 'specialist' -> Arcaneous
    name_lower = car_name.lower()
    if "tank" in name_lower or "eon" in name_lower or "apex" in name_lower or "mp3" in name_lower:
        return GUARDIAN
    elif "speed" in name_lower or "chaser" in name_lower or "surya" in name_lower or "camara" in name_lower:
        return PHANTOM
    else:
        return ARCANEOUS

def build_10_levels(old_levels, tier):
    new_levels = {}
    
    xp_mult = TIER_MULT[tier]["xp"]
    timer_mult = TIER_MULT[tier]["timer"]
    
    # We need to squash 20 old levels into 10 new levels.
    # Let's take every 2nd old level's stats (0, 2, 4, 6... 18) and make it 0..9
    
    for new_lvl in range(LEVELS):
        old_lvl = min(new_lvl * 2, 20) # cap at 20
        old_data = old_levels.get(str(old_lvl), old_levels.get("20", {}))
        
        xp = math.floor(BASE_XP_REQS[new_lvl] * xp_mult)
        timer = math.floor(BASE_TIMERS[new_lvl] * timer_mult)
        
        # Max level exception
        if new_lvl == LEVELS - 1:
            xp = 0
            timer = 0
            
        new_levels[str(new_lvl)] = {
            "xpToNext": xp,
            "upgradeTimerSeconds": max(0, timer),
            "priceCoins": old_data.get("priceCoins", 0),
            "carRating": old_data.get("carRating", 100),
            "topSpeed": old_data.get("topSpeed", 1.0),
            "acceleration": old_data.get("acceleration", 1.0),
            "handling": old_data.get("handling", 1.0),
            "boostRegen": old_data.get("boostRegen", 1.0),
            "boostPower": old_data.get("boostPower", 1.0)
        }
    return new_levels

def main():
    with open(INPUT_FILE, "r") as f:
        data = json.load(f)
        
    for car_id, car in data["cars"].items():
        base_price = car.get("basePrice", 0)
        tier = get_tier(base_price)
        
        car["ability"] = get_ability(car.get("class", ""), car.get("displayName", ""))
        
        if "levels" in car:
            car["levels"] = build_10_levels(car["levels"], tier)
            
    with open(OUTPUT_FILE, "w") as f:
        json.dump(data, f, indent=2)
        
    print(f"Migrated {len(data['cars'])} cars to 10-level system in {OUTPUT_FILE}")

if __name__ == "__main__":
    main()
