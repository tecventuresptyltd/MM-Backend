#!/usr/bin/env python3
"""
Rebalance CarsCatalog.json with approved V2 economics plan.
Updates: XP requirements, upgrade timers, and coin costs per tier.
Preserves: displayName, class, basePrice, unlock, ability, version, i18n, carId, stats.
"""
import json
import math

INPUT_FILE = "seeds/Atul-Final-Seeds/CarsCatalog.json"
OUTPUT_FILE = "seeds/Atul-Final-Seeds/CarsCatalog.json"

# ─── APPROVED XP REQUIREMENTS PER LEVEL (from implementation_plan.md) ───
XP_BY_TIER = {
    1: [100, 150, 200, 300, 400, 500, 700, 1000, 1500, 0],
    2: [250, 400, 550, 750, 1000, 1300, 1800, 2500, 3800, 0],
    3: [500, 800, 1100, 1500, 2000, 2600, 3600, 5000, 7500, 0],
    4: [1000, 1500, 2000, 3000, 4000, 5000, 7000, 10000, 15000, 0],
    5: [2000, 3000, 4000, 6000, 8000, 10000, 14000, 20000, 30000, 0],
}

# ─── APPROVED UPGRADE TIMERS IN SECONDS (from implementation_plan.md) ───
TIMERS_BY_TIER = {
    1: [60, 300, 600, 900, 1800, 2700, 3600, 5400, 7200, 0],
    2: [300, 900, 1800, 3600, 7200, 10800, 14400, 18000, 21600, 0],
    3: [900, 1800, 3600, 7200, 10800, 14400, 21600, 28800, 36000, 0],
    4: [1800, 3600, 7200, 10800, 14400, 21600, 28800, 43200, 57600, 0],
    5: [3600, 7200, 10800, 14400, 21600, 28800, 43200, 57600, 86400, 0],
}

# ─── APPROVED COIN COSTS PER LEVEL (from implementation_plan.md) ───
COINS_BY_TIER = {
    1: [0, 200, 400, 600, 800, 1000, 1200, 1500, 2000, 0],
    2: [0, 800, 1200, 1600, 2000, 2500, 3000, 3500, 4500, 0],
    3: [0, 2000, 3000, 4000, 5000, 6500, 8000, 10000, 12500, 0],
    4: [0, 5000, 7500, 10000, 12500, 15000, 18000, 22000, 28000, 0],
    5: [0, 12000, 18000, 25000, 30000, 38000, 45000, 55000, 70000, 0],
}

# ─── STAT CURVES PER TIER (smoothly interpolate from 1.0 to max) ───
# These define the top-speed / accel / handling / boostRegen / boostPower progression
# Each tier has a max stat multiplier that gets reached at level 9
STAT_MAX_BY_TIER = {
    1: {"topSpeed": 1.5, "acceleration": 1.5, "handling": 1.4, "boostRegen": 1.4, "boostPower": 1.5},
    2: {"topSpeed": 1.7, "acceleration": 1.7, "handling": 1.5, "boostRegen": 1.5, "boostPower": 1.7},
    3: {"topSpeed": 1.9, "acceleration": 1.9, "handling": 1.7, "boostRegen": 1.7, "boostPower": 1.9},
    4: {"topSpeed": 2.1, "acceleration": 2.1, "handling": 1.9, "boostRegen": 1.9, "boostPower": 2.1},
    5: {"topSpeed": 2.3, "acceleration": 2.3, "handling": 2.0, "boostRegen": 2.0, "boostPower": 2.3},
}

# Base car rating at level 0, add 10 per level
BASE_RATING_BY_TIER = {1: 100, 2: 150, 3: 200, 4: 300, 5: 450}
RATING_PER_LEVEL = 10


def get_tier(base_price: int) -> int:
    """Determine tier from car base price."""
    if base_price == 0:
        return 1
    if base_price < 20_000:
        return 2
    if base_price < 100_000:
        return 3
    if base_price < 500_000:
        return 4
    return 5


def lerp(start: float, end: float, t: float) -> float:
    """Linear interpolation."""
    return round(start + (end - start) * t, 2)


def build_levels(tier: int) -> dict:
    """Build the full 10-level structure for a car of the given tier."""
    levels = {}
    xps = XP_BY_TIER[tier]
    timers = TIMERS_BY_TIER[tier]
    coins = COINS_BY_TIER[tier]
    stat_max = STAT_MAX_BY_TIER[tier]
    base_rating = BASE_RATING_BY_TIER[tier]

    for lvl in range(10):
        t = lvl / 9.0  # 0.0 to 1.0

        levels[str(lvl)] = {
            "xpToNext": xps[lvl],
            "upgradeTimerSeconds": timers[lvl],
            "priceCoins": coins[lvl],
            "carRating": base_rating + (RATING_PER_LEVEL * lvl),
            "topSpeed": lerp(1.0, stat_max["topSpeed"], t),
            "acceleration": lerp(1.0, stat_max["acceleration"], t),
            "handling": lerp(1.0, stat_max["handling"], t),
            "boostRegen": lerp(1.0, stat_max["boostRegen"], t),
            "boostPower": lerp(1.0, stat_max["boostPower"], t),
        }

    return levels


def main():
    with open(INPUT_FILE, "r") as f:
        data = json.load(f)

    car_count = 0
    tier_counts = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}

    for car_id, car in data["cars"].items():
        base_price = car.get("basePrice", 0)
        tier = get_tier(base_price)
        tier_counts[tier] += 1

        # Rebuild levels with approved economics
        car["levels"] = build_levels(tier)
        car_count += 1

    # Update version stamp
    data["version"] = "v4-rebalanced-economy"
    data["updatedAt"] = 1709164800000  # 2025-02-28

    with open(OUTPUT_FILE, "w") as f:
        json.dump(data, f, indent=2)

    print(f"✅ Rebalanced {car_count} cars across tiers: {dict(tier_counts)}")

    # Print summary
    for tier in range(1, 6):
        xps = XP_BY_TIER[tier]
        timers = TIMERS_BY_TIER[tier]
        coins = COINS_BY_TIER[tier]
        total_xp = sum(xps)
        total_timer_h = sum(timers) / 3600
        total_coins = sum(coins)
        print(f"  Tier {tier}: XP={total_xp:,} | Timer={total_timer_h:.1f}h | Coins={total_coins:,}")


if __name__ == "__main__":
    main()
