#!/usr/bin/env python3
"""Full game progression simulator v2 — fixed car rotation & mastery model"""
import json, math, random, os
random.seed(42)
SEEDS = 'seeds/Atul-Final-Seeds'
def load(f):
    with open(os.path.join(SEEDS, f)) as fh: return json.load(fh)

cars_cat = load('CarsCatalog.json')
tiers_cat = load('TiersCatalog.json')
evo_cat = load('CarEvolutionV2Catalog.json')
spell_cat = load('SpellEvolutionV2Catalog.json')
mastery_cat = load('MasteryConfig.json')
crate_slots = load('CrateSlotsConfig.json')
daily_cfg = load('DailyRewardsConfig.json')
ranks_cat = load('RanksCatalog.json')
FREE_SKIP = evo_cat['skipCost']['freeSkipThresholdSeconds']

RANK_T = [(r['minMmr'], r['displayName']) for r in ranks_cat['ranks']]
def rank_label(t):
    l = 'Unranked'
    for m, n in RANK_T:
        if t >= m: l = n
    return l
def rank_idx(t):
    i = 0
    for m, _ in RANK_T:
        if t >= m: i += 1
    return min(i, len(RANK_T) - 1)

COIN_CAPS = {
    'Unranked': [2000, 1500, 1200, 900], 'Bronze I': [2200, 1650, 1300, 1000],
    'Bronze II': [2500, 1900, 1500, 1100], 'Bronze III': [2800, 2100, 1700, 1300],
    'Silver I': [3100, 2300, 1900, 1400], 'Silver II': [3500, 2600, 2100, 1600],
    'Silver III': [3900, 2900, 2300, 1800], 'Gold I': [4300, 3200, 2600, 1900],
    'Gold II': [4800, 3600, 2900, 2200], 'Gold III': [5400, 4100, 3200, 2400],
    'Platinum I': [6000, 4500, 3600, 2700], 'Platinum II': [6700, 5000, 4000, 3000],
    'Platinum III': [7500, 5600, 4500, 3400], 'Diamond I': [8400, 6300, 5000, 3800],
    'Diamond II': [9400, 7100, 5600, 4200], 'Diamond III': [10500, 7900, 6300, 4700],
    'Master I': [11800, 8900, 7100, 5300], 'Master II': [13200, 9900, 7900, 5900],
    'Master III': [14800, 11100, 8900, 6600], 'Champion I': [16600, 12400, 10000, 7500],
    'Champion II': [18600, 14000, 11200, 8400], 'Champion III': [20900, 15700, 12500, 9400],
    'Ascendant I': [23400, 17600, 14000, 10500], 'Ascendant II': [26200, 19700, 15700, 11800],
    'Ascendant III': [29400, 22100, 17600, 13200], 'Hypersonic I': [32900, 24700, 19700, 14800],
    'Hypersonic II': [36900, 27700, 22100, 16600], 'Hypersonic III': [41300, 31000, 24800, 18600],
}
XP_M = [1.2, 1.14, 1.09, 1.03, 0.97, 0.91, 0.86, 0.80]
SHARD_M = [1.2, 1.14, 1.09, 1.03, 0.97, 0.91, 0.86, 0.80]
K, P, S2 = 50.0, 1.7, 1.0

def get_level(xp):
    if xp <= 0: return 1
    l = max(1, int(math.pow(math.pow(S2, P) + xp / K, 1.0 / P) + 1.0 - S2))
    while l > 1 and round(K * (math.pow(l - 1 + S2, P) - math.pow(S2, P))) > xp: l -= 1
    while round(K * (math.pow(l + S2, P) - math.pow(S2, P))) <= xp: l += 1
    return l

CAR_TIERS = {}
for tk, tv in tiers_cat['tiers'].items():
    for c in tv.get('bundledCars', []): CAR_TIERS[c['carId']] = int(tk.split('_')[1])

def calc_mastery_xp(car_st, spell_lvls):
    total = 0
    cw = mastery_cat.get('carWeight', 1.0)
    sw = mastery_cat.get('spellWeight', 0.33)
    for cid, cs in car_st.items():
        if not cs['unlocked']: continue
        car = cars_cat['cars'][cid]
        for lvl in range(cs['level']):
            total += car['levels'].get(str(lvl), {}).get('xpToNext', 0) * cw
    caps = spell_cat.get('spellXpConfig', {}).get('xpCapPerLevel', {})
    for sn, sl in spell_lvls.items():
        for lv in range(1, sl):
            total += caps.get(str(lv), 100) * sw
    return total

def mastery_rank_fn(pts):
    r = 0
    for rank in range(1, 51):
        if pts >= mastery_cat['rankThresholds'].get(str(rank), float('inf')): r = rank
    return r

CRATE_TABLE = [('none', 27.9), ('common', 20), ('rare', 7.5), ('exotic', 5), ('legendary', 2.5), ('mythical', 1.5)]
CWT = sum(w for _, w in CRATE_TABLE)
def roll_crate():
    r = random.random() * CWT; c = 0
    for rar, w in CRATE_TABLE:
        c += w
        if r <= c: return rar
    return 'none'
CRATE_TM = {k: v['durationSeconds'] for k, v in crate_slots['unlockDurations'].items()}

def sim(name, rpd, avg_place, ads, dpw, days=180):
    coins = 5000; gems = 0; shards = 0; xp = 0; trophies = 0
    spd_bank = 10 * 300 + 5 * 900 + 3 * 3600 + 1 * 10800
    car_st = {}
    for cid in cars_cat['cars']:
        t = CAR_TIERS.get(cid, 99)
        car_st[cid] = {'level': 0, 'car_xp': 0, 'unlocked': t == 1, 'tier': t, 'name': cars_cat['cars'][cid]['displayName']}
    spell_lvls = {'starter_spell': 1}
    crate_q = []; crates_opened = 0; coins_spent = 0; dl_day = 0; total_races = 0
    unlocked_tiers = {1}; milestones = []; snaps = []; timer_wait = 0; timer_free = 0

    for day in range(1, days + 1):
        if (day - 1) % 7 >= dpw:
            for i, (r, t) in enumerate(crate_q): crate_q[i] = (r, max(0, t - 86400))
            continue

        dl_day = (dl_day % 30) + 1
        dl = daily_cfg['rewards'].get(f'day_{dl_day}', {})
        gems += dl.get('gems', 0)

        for i, (r, t) in enumerate(crate_q): crate_q[i] = (r, max(0, t - 28800))
        while crate_q and crate_q[0][1] <= 0:
            rarity, _ = crate_q.pop(0)
            ri = rank_idx(trophies); rl = rank_label(trophies)
            mult = {'common': 0.25, 'rare': 0.5, 'exotic': 1.0, 'legendary': 2.0, 'mythical': 4.0}
            cc = int(COIN_CAPS.get(rl, [2000])[0] * mult.get(rarity, 0.25) * (0.8 + random.random() * 0.4))
            sb = 5 + (20 * ri / 50)
            sm = {'common': 0.4, 'rare': 0.8, 'exotic': 1.5, 'legendary': 2.5, 'mythical': 4.0}
            csv_v = int(sb * sm.get(rarity, 0.4) * (0.8 + random.random() * 0.4))
            coins += cc; shards += csv_v; crates_opened += 1

        rl = rank_label(trophies); ri = rank_idx(trophies)

        # Round-robin across ALL unlocked cars, prioritize non-maxed
        avail = [cid for cid, s in car_st.items() if s['unlocked']]
        avail.sort(key=lambda c: (car_st[c]['level'] >= 9, car_st[c]['tier'], car_st[c]['level']))
        fuel = {c: 5 for c in avail}
        car_idx = 0; ads_left = ads

        for _ in range(rpd):
            rc = None
            for attempt in range(len(avail)):
                c = avail[(car_idx + attempt) % len(avail)]
                if fuel.get(c, 0) > 0:
                    rc = c; car_idx = (car_idx + attempt + 1) % len(avail); break
            if not rc and ads_left > 0 and avail:
                rc = avail[car_idx % len(avail)]
                fuel[rc] = min(5, fuel.get(rc, 0) + 3); ads_left -= 1
            if not rc: break
            fuel[rc] -= 1; total_races += 1

            place = max(1, min(8, avg_place + random.randint(-1, 1)))
            cap_list = COIN_CAPS.get(rl, [2000, 1500, 1200, 900])
            cr_v = int(cap_list[min(place - 1, len(cap_list) - 1)] * (0.85 + random.random() * 0.3))
            coins += cr_v
            eb = 100 + (208 - 100) * (ri / max(1, len(RANK_T) - 1))
            xp += round(eb * XP_M[min(place - 1, 7)])
            sb = 5 + (20 * ri / 50)
            shards += round(sb * SHARD_M[min(place - 1, 7)])

            if place <= 4: trophies += random.randint(15, 35)
            else: trophies = max(0, trophies - random.randint(5, 20))

            cs = car_st[rc]
            if cs['level'] < 9: cs['car_xp'] += random.randint(60, 90)

            cr_drop = roll_crate()
            if cr_drop != 'none' and len(crate_q) < 4:
                crate_q.append((cr_drop, CRATE_TM.get(cr_drop, 1800)))
            elif cr_drop != 'none':
                coins += 500; shards += 25
            rl = rank_label(trophies); ri = rank_idx(trophies)

        session_s = rpd * 180
        for i, (r, t) in enumerate(crate_q):
            if i == 0: crate_q[i] = (r, max(0, t - session_s))

        # Car upgrades
        for cid, cs in car_st.items():
            if not cs['unlocked'] or cs['level'] >= 9: continue
            car = cars_cat['cars'][cid]
            while cs['level'] < 9:
                ld = car['levels'].get(str(cs['level']), {})
                xn = ld.get('xpToNext', 0); pc = ld.get('priceCoins', 0); tmr = ld.get('upgradeTimerSeconds', 0)
                if xn > 0 and cs['car_xp'] < xn: break
                if pc > coins: break
                coins -= pc; coins_spent += pc; cs['car_xp'] = max(0, cs['car_xp'] - xn)
                if tmr <= FREE_SKIP: timer_free += tmr
                elif spd_bank >= tmr: spd_bank -= tmr; timer_free += tmr
                else: timer_wait += tmr
                cs['level'] += 1
                if cs['level'] == 9: milestones.append((day, f"CAR {cs['name']} MAXED (T{cs['tier']})"))

        # Spell upgrades
        mxp = calc_mastery_xp(car_st, spell_lvls)
        mr = mastery_rank_fn(mxp)
        for sn in list(spell_lvls.keys()):
            cl = spell_lvls[sn]
            if cl >= 5: continue
            nl = cl + 1
            rc_s = spell_cat['researchCosts'].get(str(nl), {})
            sc = rc_s.get('shards', 9999); tmr = rc_s.get('durationSeconds', 9999)
            gate = spell_cat['masteryGates'].get(str(nl), 99)
            if mr < gate or shards < sc: continue
            shards -= sc; spell_lvls[sn] = nl
            if tmr <= FREE_SKIP: timer_free += tmr
            else: timer_wait += tmr
            milestones.append((day, f"SPELL {sn}->L{nl} (MR{mr})"))

        # Tier unlocks
        mxp = calc_mastery_xp(car_st, spell_lvls)
        mr = mastery_rank_fn(mxp)
        for tk, tv in sorted(tiers_cat['tiers'].items()):
            tn = int(tk.split('_')[1])
            if tn in unlocked_tiers: continue
            req = tv['requirements']
            if mr >= req['masteryRank'] and coins >= req['coins']:
                coins -= req['coins']; coins_spent += req['coins']; unlocked_tiers.add(tn)
                for c in tv['bundledCars']:
                    if c['carId'] in car_st: car_st[c['carId']]['unlocked'] = True
                milestones.append((day, f"TIER {tn} UNLOCKED ({tv['displayName']}) MR{mr} {req['coins']:,}c"))

        if day % 14 == 0 or day == 1 or day == 7:
            mxp = calc_mastery_xp(car_st, spell_lvls)
            mr = mastery_rank_fn(mxp)
            mt = max(unlocked_tiers)
            uc = sum(1 for cs in car_st.values() if cs['unlocked'])
            ac = sum(cs['level'] for cs in car_st.values() if cs['unlocked']) / max(1, uc)
            snaps.append({
                'day': day, 'races': total_races, 'level': get_level(xp),
                'trophies': trophies, 'rank': rank_label(trophies),
                'coins': coins, 'shards': shards, 'mr': mr, 'tier': mt,
                'cars': uc, 'avg_car': ac, 'crates': crates_opened
            })

    # ---- Print results ----
    print(f"\n{'=' * 110}")
    print(f"  {name} -- {rpd} races/day, avg {avg_place}th, {dpw}d/wk")
    print(f"{'=' * 110}")
    print(f"\n{'Day':>5} {'Races':>6} {'Lvl':>4} {'Trophies':>8} {'Rank':>16} {'Coins':>12} {'Shards':>7} {'MR':>3} {'T':>2} {'Cars':>5} {'AvgLv':>6} {'Crates':>7}")
    print("-" * 90)
    for s in snaps:
        print(f"{s['day']:>5} {s['races']:>6} {s['level']:>4} {s['trophies']:>8,} {s['rank']:>16} {s['coins']:>12,} {s['shards']:>7,} {s['mr']:>3} {s['tier']:>2} {s['cars']:>5} {s['avg_car']:>6.1f} {s['crates']:>7}")

    print(f"\n--- Milestones ---")
    for d, m in milestones[:50]:
        print(f"  Day {d:>3}: {m}")
    if len(milestones) > 50:
        print(f"  ... +{len(milestones) - 50} more")

    f_mr = mastery_rank_fn(calc_mastery_xp(car_st, spell_lvls))
    print(f"\n--- FINAL (Day {days}) ---")
    print(f"  Races: {total_races:,}  Level: {get_level(xp)}  Trophies: {trophies:,} ({rank_label(trophies)})")
    print(f"  Coins: {coins:,} (spent: {coins_spent:,})  Shards: {shards:,}  Gems: {gems:,}")
    print(f"  Mastery Rank: {f_mr}  Tiers: {sorted(unlocked_tiers)}")
    print(f"  Timer Wait: {timer_wait / 3600:.1f}h  Free Skipped: {timer_free / 3600:.1f}h")
    cl = [f"{cs['name']}={cs['level']}" for cs in car_st.values() if cs['unlocked']]
    print(f"  Cars: {', '.join(cl)}")
    print(f"  Spells: {spell_lvls}")

sim('CASUAL', 5, 4, 1, 5, 180)
sim('MEDIUM', 12, 3, 3, 6, 180)
sim('HARDCORE', 25, 2, 5, 7, 180)
