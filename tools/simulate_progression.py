#!/usr/bin/env python3
"""
Mystic Motors — Race-by-Race Progression Simulator
====================================================
Simulates individual races with real ELO trophy math, smart car rotation,
fuel management, upgrade timers, and mastery-gated progression.

Key assumptions from user:
- Players ALWAYS swap to a car that can earn XP (not capped, not mid-upgrade)
- Car XP per race = Player XP per race (same value from calculateExp)
- Trophy system uses ELO with baseK breakpoints and soft ceiling
- Skill variance: good players place above expected, bad below
"""
import json, math, os, random

SEEDS = 'seeds/Atul-Final-Seeds'
def load(f):
    with open(os.path.join(SEEDS, f)) as fh: return json.load(fh)

cars_cat = load('CarsCatalog.json')
tiers_cat = load('TiersCatalog.json')
evo_cat = load('CarEvolutionV2Catalog.json')
spell_cat = load('SpellEvolutionV2Catalog.json')
mastery_cat = load('MasteryConfig.json')
crate_slots = load('CrateSlotsConfig.json')
ranks_cat = load('RanksCatalog.json')

FREE_SKIP = evo_cat['skipCost']['freeSkipThresholdSeconds']
GEMS_PER_HR = evo_cat['skipCost']['gemsPerHour']
MIN_GEMS = evo_cat['skipCost']['minGems']

# ============================================================================
# EXACT FORMULAS FROM economy.ts
# ============================================================================
RANK_T = [(r['minMmr'], r['displayName']) for r in ranks_cat['ranks']]
RANK_LABELS = [n for _, n in RANK_T]

def rank_for(t):
    l = 'Unranked'
    for m, n in RANK_T:
        if t >= m: l = n
    return l

def rank_idx(label):
    try: return RANK_LABELS.index(label)
    except: return 0

COIN_CAPS = {
    'Unranked': [2000,1500,1200,900,900,900,900,900],
    'Bronze I': [2200,1650,1300,1000,1000,1000,1000,1000],
    'Bronze II': [2500,1900,1500,1100,1100,1100,1100,1100],
    'Bronze III': [2800,2100,1700,1300,1300,1300,1300,1300],
    'Silver I': [3100,2300,1900,1400,1400,1400,1400,1400],
    'Silver II': [3500,2600,2100,1600,1600,1600,1600,1600],
    'Silver III': [3900,2900,2300,1800,1800,1800,1800,1800],
    'Gold I': [4300,3200,2600,1900,1900,1900,1900,1900],
    'Gold II': [4800,3600,2900,2200,2200,2200,2200,2200],
    'Gold III': [5400,4100,3200,2400,2400,2400,2400,2400],
    'Platinum I': [6000,4500,3600,2700,2700,2700,2700,2700],
    'Platinum II': [6700,5000,4000,3000,3000,3000,3000,3000],
    'Platinum III': [7500,5600,4500,3400,3400,3400,3400,3400],
    'Diamond I': [8400,6300,5000,3800,3800,3800,3800,3800],
    'Diamond II': [9400,7100,5600,4200,4200,4200,4200,4200],
    'Diamond III': [10500,7900,6300,4700,4700,4700,4700,4700],
    'Master I': [11800,8900,7100,5300,5300,5300,5300,5300],
    'Master II': [13200,9900,7900,5900,5900,5900,5900,5900],
    'Master III': [14800,11100,8900,6600,6600,6600,6600,6600],
    'Champion I': [16600,12400,10000,7500,7500,7500,7500,7500],
    'Champion II': [18600,14000,11200,8400,8400,8400,8400,8400],
    'Champion III': [20900,15700,12500,9400,9400,9400,9400,9400],
    'Ascendant I': [23400,17600,14000,10500,10500,10500,10500,10500],
    'Ascendant II': [26200,19700,15700,11800,11800,11800,11800,11800],
    'Ascendant III': [29400,22100,17600,13200,13200,13200,13200,13200],
    'Hypersonic I': [32900,24700,19700,14800,14800,14800,14800,14800],
    'Hypersonic II': [36900,27700,22100,16600,16600,16600,16600,16600],
    'Hypersonic III': [41300,31000,24800,18600,18600,18600,18600,18600],
}

# XP formula: expBase(rank) * placementMult. Car XP = same value.
EXP_MULTS = [1.2, 1.142857, 1.085714, 1.028571, 0.971429, 0.914286, 0.857143, 0.8]
def exp_base(label):
    idx = rank_idx(label)
    steps = max(1, len(RANK_LABELS) - 1)
    return 100 + (208 - 100) * (idx / steps)

# Shard formula: shardBase(rankIdx) * placementMult
SHARD_MULTS = [1.2, 1.14, 1.09, 1.03, 0.97, 0.91, 0.86, 0.80]
def shard_base(label):
    idx = rank_idx(label)
    return 5 + (20 * max(1, idx) / 50)

# Trophy ELO: baseK breakpoints, soft ceiling damping
def base_k(rating):
    for bound, val in [(2000,48),(4000,40),(6000,32),(7000,24),(8000,12),(9000,10),(10000,8)]:
        if rating < bound: return val
    return 6

def soft_damping(rating):
    return math.exp(-max(0, rating - 7000) / 2000)

# Simplified ELO delta for 8-player lobby (all at ~same rating)
# place 1→4 = win vs opponents, place 5-8 = lose vs opponents
def trophy_delta(rating, place):
    k = base_k(rating)
    h = soft_damping(rating)
    # In balanced lobby: S_ij for opponents ranked above you = 1 (you beat them)
    # Expected score E ≈ 0.5 in balanced lobby
    # Weighted sum across 7 opponents gives approx: K * H * (score - 0.5)
    # Score: place 1 → beats 7/7 = 1.0, place 4 → beats 4/7 ≈ 0.57, place 5 ≈ 0.43, place 8 → 0/7 = 0.0
    score = (8 - place) / 7  # 1st=1.0, 8th=0.0
    delta = k * h * (score - 0.5) * 0.7  # 0.7 accounts for per-pair clipping
    return int(max(-40, min(40, round(delta))))

# ============================================================================
# CAR/TIER SETUP
# ============================================================================
CAR_TIERS = {}
for tk, tv in tiers_cat['tiers'].items():
    for c in tv.get('bundledCars', []): CAR_TIERS[c['carId']] = int(tk.split('_')[1])

def get_cars(tier):
    return [cid for cid, t in CAR_TIERS.items() if t == tier]

def car_name(cid):
    return cars_cat['cars'][cid]['displayName']

def car_level_data(cid, lvl):
    return cars_cat['cars'][cid]['levels'].get(str(lvl), {})

# Mastery
def calc_mastery(car_levels):
    total = 0
    cw = mastery_cat.get('carWeight', 1.0)
    for cid, lvl in car_levels.items():
        car = cars_cat['cars'][cid]
        for l in range(lvl):
            total += car['levels'].get(str(l), {}).get('xpToNext', 0) * cw
    return total

def get_mr(pts):
    r = 0
    for rank in range(1, 51):
        if pts >= mastery_cat['rankThresholds'].get(str(rank), float('inf')): r = rank
    return r

# Crate drop table
CRATE_TABLE = [('none',27.9),('common',20),('rare',7.5),('exotic',5),('legendary',2.5),('mythical',1.5)]
CW = sum(w for _,w in CRATE_TABLE)
def roll_crate():
    r = random.random() * CW; c = 0
    for rar, w in CRATE_TABLE:
        c += w
        if r <= c: return rar
    return 'none'
CRATE_TIMERS = {k: v['durationSeconds'] for k, v in crate_slots['unlockDurations'].items()}

# ============================================================================
# SIMULATION
# ============================================================================
def simulate(name, rpd, skill_bias, days_per_week, seed_val, total_days=180):
    """
    skill_bias: -2 to +2. 0=average. +2=very skilled (places ~2 positions better).
    Determines placement variance: place = expected_place + random(-1,1) - skill_bias
    """
    random.seed(seed_val)
    
    # Player state
    coins = 5000  # starter
    gems = 0
    shards = 0
    player_xp = 0
    trophies = 0
    
    # Car states: {cid: {level, xp, unlocked, upgrading_until, tier}}
    car_st = {}
    for cid in cars_cat['cars']:
        t = CAR_TIERS.get(cid, 99)
        car_st[cid] = {
            'level': 0, 'xp': 0, 'unlocked': t == 1,
            'upgrading_until': 0,  # timestamp when upgrade completes (0 = not upgrading)
            'tier': t
        }
    
    # Spell state
    spell_lvl = 1  # starter spell
    spell_shards_spent = 0
    
    # Speed-up bank from starter pack
    speed_bank = 10*300 + 5*900 + 3*3600 + 1*10800  # 485 min
    
    # Fuel per car per day
    MAX_FUEL = 5
    FUEL_REGEN_RACES = 3  # ad gives 3 fuel
    
    # Tracking
    total_races = 0
    coins_spent = 0
    gems_spent = 0
    timer_wait_s = 0
    timer_free_s = 0
    crate_q = []  # (rarity, timer_remaining_s)
    crates_opened = 0
    unlocked_tiers = {1}
    milestones = []
    
    # Daily login
    dl_day = 0
    
    # Time tracking (seconds from start)
    global_time = 0  # seconds since day 0
    
    for day in range(1, total_days + 1):
        # Skip off-days
        if (day - 1) % 7 >= days_per_week:
            # Advance crate timers by 24h
            for i, (r, t) in enumerate(crate_q):
                if i == 0: crate_q[i] = (r, max(0, t - 86400))
            # Advance upgrade timers
            global_time += 86400
            continue
        
        global_time += 86400  # new day
        
        # Daily login
        dl_day = (dl_day % 30) + 1
        # Simplified: ~5 gems avg per day from login
        gems += 5
        
        # Advance crate timers by overnight (16h not playing)
        for i, (r, t) in enumerate(crate_q):
            if i == 0: crate_q[i] = (r, max(0, t - 57600))  # 16h passive
        
        # Open completed crates
        while crate_q and crate_q[0][1] <= 0:
            rarity, _ = crate_q.pop(0)
            label = rank_for(trophies)
            ri = rank_idx(label)
            # Crate coins and shards (from CrateRewardsConfig)
            coin_mult = {'common':0.25,'rare':0.5,'exotic':1.0,'legendary':2.0,'mythical':4.0}
            caps = COIN_CAPS.get(label, COIN_CAPS['Unranked'])
            c_coins = int(caps[0] * coin_mult.get(rarity, 0.25) * (0.85 + random.random() * 0.3))
            sb = shard_base(label)
            s_mult = {'common':0.4,'rare':0.8,'exotic':1.5,'legendary':2.5,'mythical':4.0}
            c_shards = int(sb * s_mult.get(rarity, 0.4) * (0.85 + random.random() * 0.3))
            coins += c_coins
            shards += c_shards
            crates_opened += 1
        
        # Complete any car upgrades
        for cid, cs in car_st.items():
            if cs['upgrading_until'] > 0 and global_time >= cs['upgrading_until']:
                cs['level'] += 1
                cs['upgrading_until'] = 0
                cs['xp'] = 0  # Reset car XP for new level
                if cs['level'] >= 9:
                    milestones.append((day, f"CAR {car_name(cid)} MAXED (T{cs['tier']})"))
        
        # Determine available cars for racing (unlocked, not mid-upgrade, can earn XP)
        label = rank_for(trophies)
        fuel = {}
        for cid, cs in car_st.items():
            if cs['unlocked']:
                fuel[cid] = MAX_FUEL
        
        ads_left = max(1, rpd // 8)  # ~1 ad per 8 races
        
        # ==== RACE LOOP ====
        session_time = 0  # seconds of play session
        
        for race_num in range(rpd):
            # Smart car selection: pick car that can earn XP
            best_car = None
            candidates = []
            for cid, cs in car_st.items():
                if not cs['unlocked']: continue
                if fuel.get(cid, 0) <= 0: continue
                if cs['upgrading_until'] > 0: continue  # mid-upgrade
                if cs['level'] >= 9: continue  # maxed, XP would be wasted
                # Check if XP is already capped for current level
                ld = car_level_data(cid, cs['level'])
                xp_cap = ld.get('xpToNext', 0)
                if xp_cap > 0 and cs['xp'] >= xp_cap: continue  # capped, needs upgrade
                candidates.append(cid)
            
            if not candidates:
                # Fall back: any car with fuel (even maxed — just for trophy/coin/shard farming)
                candidates = [cid for cid, cs in car_st.items() 
                              if cs['unlocked'] and fuel.get(cid, 0) > 0 and cs['upgrading_until'] == 0]
            
            if not candidates:
                # Try ad refuel
                if ads_left > 0:
                    for cid, cs in car_st.items():
                        if cs['unlocked'] and cs['upgrading_until'] == 0:
                            fuel[cid] = FUEL_REGEN_RACES
                            ads_left -= 1
                            candidates = [cid]
                            break
            
            if not candidates:
                break  # No cars available
            
            # Prioritize: non-maxed cars with lowest level in lowest tier
            candidates.sort(key=lambda c: (
                car_st[c]['level'] >= 9,  # maxed last
                car_st[c]['tier'],        # lower tier first
                car_st[c]['level']        # lower level first
            ))
            race_car = candidates[0]
            fuel[race_car] -= 1
            total_races += 1
            session_time += 180  # ~3 min per race
            
            # Determine placement (8 players)
            # Base expected place = 4.5 (median)
            # Skill bias shifts this. Random variance +-1.5
            expected = max(1, min(8, round(4.5 - skill_bias + random.gauss(0, 1.2))))
            place = max(1, min(8, expected))
            
            # --- REWARDS (exact economy.ts formulas) ---
            label = rank_for(trophies)
            ri = rank_idx(label)
            
            # Coins
            caps = COIN_CAPS.get(label, COIN_CAPS['Unranked'])
            difficulty_mult = 0.85 + random.random() * 0.30  # difficultyFloor=0.85, ceiling=1.15
            raw_coins = caps[min(place - 1, 7)] * difficulty_mult
            race_coins = round(raw_coins / 100) * 100  # roundTo: 100
            coins += race_coins
            
            # XP (= car XP)
            eb = exp_base(label)
            xp_gain = round(eb * EXP_MULTS[min(place - 1, 7)])
            player_xp += xp_gain
            
            # Car XP (same as player XP!)
            cs = car_st[race_car]
            if cs['level'] < 9:
                ld = car_level_data(race_car, cs['level'])
                xp_cap = ld.get('xpToNext', 0)
                if xp_cap > 0:
                    cs['xp'] = min(cs['xp'] + xp_gain, xp_cap)
            
            # Shards
            sb = shard_base(label)
            race_shards = round(sb * SHARD_MULTS[min(place - 1, 7)])
            shards += race_shards
            
            # Trophies
            td = trophy_delta(trophies, place)
            trophies = max(0, trophies + td)
            
            # Crate drop
            drop = roll_crate()
            if drop != 'none':
                if len(crate_q) < 4:
                    crate_q.append((drop, CRATE_TIMERS.get(drop, 1800)))
                else:
                    coins += 500; shards += 25  # slot-full fallback
            
            # Advance first crate timer by race time
            if crate_q:
                crate_q[0] = (crate_q[0][0], max(0, crate_q[0][1] - 180))
        
        # ==== POST-RACE: UPGRADE CARS ====
        for cid, cs in car_st.items():
            if not cs['unlocked'] or cs['level'] >= 9 or cs['upgrading_until'] > 0:
                continue
            
            ld = car_level_data(cid, cs['level'])
            xp_cap = ld.get('xpToNext', 0)
            price = ld.get('priceCoins', 0)
            timer = ld.get('upgradeTimerSeconds', 0)
            
            # Check if XP is sufficient
            if xp_cap > 0 and cs['xp'] < xp_cap:
                continue
            
            # Check if can afford
            if price > coins:
                continue
            
            # Buy upgrade
            coins -= price
            coins_spent += price
            
            # Handle timer
            if timer <= FREE_SKIP:
                # Free skip
                timer_free_s += timer
                cs['level'] += 1
                cs['xp'] = 0
                if cs['level'] >= 9:
                    milestones.append((day, f"CAR {car_name(cid)} MAXED (T{cs['tier']})"))
            elif speed_bank >= timer:
                # Use speed-up inventory
                speed_bank -= timer
                timer_free_s += timer
                cs['level'] += 1
                cs['xp'] = 0
                if cs['level'] >= 9:
                    milestones.append((day, f"CAR {car_name(cid)} MAXED (T{cs['tier']})"))
            else:
                # Must wait (or skip with gems — model as waiting)
                timer_wait_s += timer
                cs['upgrading_until'] = global_time + timer
        
        # ==== SPELL UPGRADES ====
        car_levels = {cid: cs['level'] for cid, cs in car_st.items() if cs['unlocked']}
        mxp = calc_mastery(car_levels)
        mr = get_mr(mxp)
        
        if spell_lvl < 5:
            next_lvl = spell_lvl + 1
            rc = spell_cat['researchCosts'].get(str(next_lvl), {})
            shard_cost = rc.get('shards', 9999)
            timer = rc.get('durationSeconds', 9999)
            gate = spell_cat['masteryGates'].get(str(next_lvl), 99)
            
            if mr >= gate and shards >= shard_cost:
                shards -= shard_cost
                spell_shards_spent += shard_cost
                spell_lvl = next_lvl
                if timer <= FREE_SKIP:
                    timer_free_s += timer
                else:
                    timer_wait_s += timer
                milestones.append((day, f"SPELL L{next_lvl} (MR{mr}, spent {shard_cost} shards)"))
        
        # ==== TIER UNLOCKS ====
        mxp = calc_mastery({cid: cs['level'] for cid, cs in car_st.items() if cs['unlocked']})
        mr = get_mr(mxp)
        
        for tk, tv in sorted(tiers_cat['tiers'].items()):
            tn = int(tk.split('_')[1])
            if tn in unlocked_tiers: continue
            req = tv['requirements']
            if mr >= req['masteryRank'] and coins >= req['coins']:
                coins -= req['coins']
                coins_spent += req['coins']
                unlocked_tiers.add(tn)
                for c in tv['bundledCars']:
                    if c['carId'] in car_st:
                        car_st[c['carId']]['unlocked'] = True
                milestones.append((day, f"TIER {tn} UNLOCKED (MR{mr}, {req['coins']:,}c)"))
    
    # ============ OUTPUT ============
    print(f"\n{'='*110}")
    print(f"  {name} | {rpd} races/day | skill={skill_bias:+.1f} | {days_per_week}d/wk | {total_days} days")
    print(f"{'='*110}")
    
    # Milestones
    print(f"\n  Milestones:")
    for d, m in milestones:
        gameplay_h = (d * rpd * 3) / 60  # rough gameplay hours to this point
        print(f"    Day {d:>3} (~{gameplay_h:.0f}h play): {m}")
    
    # Final state
    mxp = calc_mastery({cid: cs['level'] for cid, cs in car_st.items() if cs['unlocked']})
    mr = get_mr(mxp)
    
    K, P, S = 50.0, 1.7, 1.0
    def get_level(xp):
        if xp <= 0: return 1
        l = max(1, int(math.pow(math.pow(S, P) + xp / K, 1.0 / P) + 1.0 - S))
        while l > 1 and round(K * (math.pow(l - 1 + S, P) - math.pow(S, P))) > xp: l -= 1
        while round(K * (math.pow(l + S, P) - math.pow(S, P))) <= xp: l += 1
        return l
    
    print(f"\n  Final State (Day {total_days}):")
    print(f"    Races: {total_races:,} | Level: {get_level(player_xp)} | Trophies: {trophies:,} ({rank_for(trophies)})")
    print(f"    Coins: {coins:,} (spent: {coins_spent:,}) | Shards: {shards:,} | Gems: {gems:,}")
    print(f"    Mastery: MR{mr} ({mxp:,.0f} XP) | Tiers: {sorted(unlocked_tiers)}")
    print(f"    Timer Wait: {timer_wait_s/3600:.1f}h | Free Skip: {timer_free_s/3600:.1f}h")
    print(f"    Spell: L{spell_lvl} (spent {spell_shards_spent:,} shards)")
    print(f"    Crates opened: {crates_opened}")
    
    # Car details
    print(f"\n  Cars:")
    for tier in range(1, 6):
        tier_cars = [cid for cid, cs in car_st.items() if cs['tier'] == tier and cs['unlocked']]
        if not tier_cars: continue
        for cid in tier_cars:
            cs = car_st[cid]
            ld = car_level_data(cid, cs['level'])
            xp_cap = ld.get('xpToNext', 0)
            xp_str = f"{cs['xp']}/{xp_cap}" if xp_cap > 0 else "MAX"
            upgrading = " [UPGRADING]" if cs['upgrading_until'] > 0 else ""
            print(f"    T{tier} {car_name(cid):>20}: Lv{cs['level']} ({xp_str}){upgrading}")
    
    # Economy analysis
    coins_earned = coins + coins_spent
    print(f"\n  Economy:")
    print(f"    Total coins earned: {coins_earned:,}")
    print(f"    Total coins spent:  {coins_spent:,} ({coins_spent*100//max(1,coins_earned)}% utilization)")
    print(f"    Avg coins/race: {coins_earned//max(1,total_races):,}")
    print(f"    Avg shards/race: {(shards+spell_shards_spent)/max(1,total_races):.1f}")

# ============================================================================
# RUN PROFILES
# ============================================================================
# Casual: 5 races/day, average skill, 5 days/week
simulate("CASUAL (avg skill)", rpd=5, skill_bias=0.0, days_per_week=5, seed_val=42, total_days=180)

# Casual GOOD: 5 races/day, skilled player, 5 days/week
simulate("CASUAL (skilled)", rpd=5, skill_bias=1.0, days_per_week=5, seed_val=43, total_days=180)

# Medium: 12 races/day, slightly above average, 6 days/week
simulate("MEDIUM (avg skill)", rpd=12, skill_bias=0.5, days_per_week=6, seed_val=44, total_days=180)

# Hardcore: 25 races/day, skilled, 7 days/week
simulate("HARDCORE (skilled)", rpd=25, skill_bias=1.0, days_per_week=7, seed_val=45, total_days=180)

# Hardcore BAD: 25 races/day, below average skill, 7 days/week
simulate("HARDCORE (poor skill)", rpd=25, skill_bias=-0.5, days_per_week=7, seed_val=46, total_days=180)
