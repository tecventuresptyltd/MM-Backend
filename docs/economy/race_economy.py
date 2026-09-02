"""
race_economy.py  (SERVER-ONLY, HEAVILY COMMENTED)

Everything you need to settle post-race rewards on the server:

A) TROPHIES (Elo-like, multi-opponent)
   - Pairwise vs all opponents with distance-weighted expectations
   - Piecewise K by trophy band; soft ceiling damping above 7000
   - Per-pair clip and final clamp for stability
   - Quit-proofing:
       • At race start: pre-deduct as-if last place
       • At finish: settle against that pre-deduction

B) COINS
   - Per-rank, per-place caps (1..8)
   - Difficulty multiplier from average expected win vs lobby (same math as trophies)
   - Optional 2× booster
   - Rounded to nearest 100
   - Rank label is derived from trophies automatically (no external input)

C) EXP
   - Per-rank, per-place EXP caps (≈250 max at top for 1st place), with formula fallback
   - Optional 2× booster
   - Rank label is derived from trophies automatically

D) RANKS
   - Inclusive thresholds (exact threshold promotes)
   - Orchestrator returns old_rank, new_rank, promoted/demoted

SERVER FLOW
-----------
RACE START (pre-deduction):
    last_delta = calculate_last_place_delta(i, ratings_snapshot, tcfg)
    DB: trophies += last_delta  # usually negative; blocks "quit to dodge"
    Persist with match: last_delta + ratings_snapshot (immutable for this race)

RACE FINISH:
    results = compute_race_rewards_with_prededuction(...)
    DB (one transaction):
        trophies += results.trophies_settlement
        coins    += results.coins
        xp       += results.exp
    UI: show results.trophies_actual, old_rank → new_rank animation

NO FINISH (disconnect):
    Do nothing at finish — the pre-deduction stands as last place.
"""

from __future__ import annotations
from dataclasses import dataclass, replace
from typing import List, Dict, Optional
import math


# =============================================================================
# RANK THRESHOLDS (inclusive)
# =============================================================================
RANK_THRESHOLDS: List[tuple[int, str]] = [
    (0,    "Unranked"),
    (250,  "Bronze I"),
    (500,  "Bronze II"),
    (750,  "Bronze III"),
    (1000, "Silver I"),
    (1250, "Silver II"),
    (1500, "Silver III"),
    (1750, "Gold I"),
    (2000, "Gold II"),
    (2250, "Gold III"),
    (2500, "Platinum I"),
    (2750, "Platinum II"),
    (3000, "Platinum III"),
    (3250, "Diamond I"),
    (3500, "Diamond II"),
    (3750, "Diamond III"),
    (4000, "Master I"),
    (4250, "Master II"),
    (4500, "Master III"),
    (4750, "Champion I"),
    (5000, "Champion II"),
    (5250, "Champion III"),
    (5500, "Ascendant I"),
    (5750, "Ascendant II"),
    (6000, "Ascendant III"),
    (6250, "Hypersonic I"),
    (6500, "Hypersonic II"),
    (7000, "Hypersonic III"),
]

# Convenient ordered list for table generation/lookups
RANK_LABELS = [name for _, name in RANK_THRESHOLDS]


def get_rank_for_trophies(trophies: int) -> str:
    """Map total trophies → rank label using inclusive thresholds."""
    for threshold, name in reversed(RANK_THRESHOLDS):
        if trophies >= threshold:
            return name
    return "Unranked"


# =============================================================================
# CONFIG STRUCTS (tuning lives here; logic reads from these)
# =============================================================================
@dataclass
class TrophyConfig:
    # Elo-like params and guards
    D: float = 700.0              # Elo spread (larger = rating gaps matter less)
    TAU: float = 600.0            # Distance weighting scale for downweighting far gaps
    W_MIN: float = 0.20           # Min per-opponent weight
    PER_PAIR_CLIP: float = 8.0    # Clip each pair's contribution to ±8
    CLAMP_MIN: int = -40          # Final clamp per race
    CLAMP_MAX: int = 40

    # Piecewise K schedule by trophy bands (bigger swings early game)
    base_k_breakpoints: List[tuple] = (
        (2000, 48),
        (4000, 40),
        (6000, 32),
        (7000, 24),
        (8000, 12),
        (9000, 10),
        (10000, 8),
        (float("inf"), 6),
    )

    # Soft ceiling to make the very top sticky
    soft_ceiling_start: float = 7000.0
    soft_ceiling_lambda: float = 1 / 2000.0  # exp(- (r - start) * lambda)


@dataclass
class CoinConfig:
    # Per-rank, per-place caps (1..8). Replace with DB-configured map later.
    rank_max_by_place: Dict[str, List[int]] = None
    # Difficulty multiplier range (avg expected win → [floor..ceiling])
    difficulty_floor: float = 0.85
    difficulty_ceiling: float = 1.15
    # Round final coins to nearest N (spec: 100)
    round_to: int = 100
    # Booster multiplier (2.0 if coin booster active) — injected by orchestrator
    booster_multiplier: float = 1.0


@dataclass
class ExpConfig:
    """
    EXP calculation supports two modes:
      1) Table mode (preferred): provide rank_place_caps and we use it.
      2) Formula fallback: base_min..base_max by trophies, position 1.20..0.80.
    """
    base_min: int = 100
    base_max: int = 208
    pos_min_mult: float = 0.80
    pos_max_mult: float = 1.20
    booster_multiplier: float = 1.0
    rank_place_caps: Optional[Dict[str, List[int]]] = None


# =============================================================================
# TROPHIES — Elo-like multi-opponent calculation
# =============================================================================
def _base_k(r: float, cfg: TrophyConfig) -> float:
    """Pick K from the piecewise schedule based on r trophies."""
    for bound, k in cfg.base_k_breakpoints:
        if r < bound:
            return float(k)
    return float(cfg.base_k_breakpoints[-1][1])


def _high_rank_damping(r: float, cfg: TrophyConfig) -> float:
    """Soft ceiling damping multiplier (0..1], stronger above soft_ceiling_start."""
    over = max(0.0, r - cfg.soft_ceiling_start)
    return math.exp(-cfg.soft_ceiling_lambda * over)


def _expected(ra: float, rb: float, cfg: TrophyConfig) -> float:
    """Standard Elo expected score of A vs B (0..1)."""
    return 1.0 / (1.0 + math.pow(10.0, (rb - ra) / cfg.D))


def _precompute_for_player(i: int, ratings: List[int], cfg: TrophyConfig):
    """
    Precompute for player i at race start:
      - w[j]: normalized opponent weights (downweight big trophy gaps)
      - E[j]: expected score vs each opponent
      - K, H: static factors used in per-opponent contributions
    """
    n = len(ratings)
    ri = float(ratings[i])

    # Raw distance weights with exponential decay; floor at W_MIN
    raw = [0.0] * n
    total = 0.0
    for j in range(n):
        if j == i:
            continue
        dist = abs(float(ratings[j]) - ri)
        w = math.exp(-dist / cfg.TAU)
        if w < cfg.W_MIN: w = cfg.W_MIN
        raw[j] = w
        total += w

    # Normalize to sum=1 over opponents
    if total > 0.0:
        w_norm = [(raw[j] / total if j != i else 0.0) for j in range(n)]
    else:
        # Safety: equal split if total somehow zero
        w_norm = [(0.0 if j == i else 1.0/(n-1)) for j in range(n)]

    E = [(_expected(ri, float(ratings[j]), cfg) if j != i else 0.0) for j in range(n)]
    return {"K": _base_k(ri, cfg), "H": _high_rank_damping(ri, cfg), "w": w_norm, "E": E}


def _delta_at_finish_using_i(
    i: int,
    finish_order: List[int],
    pre: dict,
    ratings_count: int,
    cfg: TrophyConfig,
    place_index_for_i: Optional[int] = None,
) -> int:
    """
    Sum per-opponent contributions:
      S_ij = 1 if i finished before j, else 0
      Δ_ij = K * H * w[j] * (S_ij - E[j])  clipped to ± PER_PAIR_CLIP
    Then round total and clamp to [CLAMP_MIN, CLAMP_MAX].
    """
    K, H, w, E = pre["K"], pre["H"], pre["w"], pre["E"]

    # Who finished before i?
    if i in finish_order:
        pos_i = finish_order.index(i)           # 0 = first, 1 = second, ...
        finished_before = set(finish_order[:pos_i])
    else:
        if place_index_for_i is None:
            raise ValueError("i not in finish_order; provide place_index_for_i.")
        finished_before = set(finish_order[:place_index_for_i])

    total = 0.0
    for j in range(ratings_count):
        if j == i:
            continue
        Sij = 0.0 if j in finished_before else 1.0
        d = K * H * w[j] * (Sij - E[j])
        # Per-pair clip prevents spikes from any single mismatch
        if d > cfg.PER_PAIR_CLIP: d = cfg.PER_PAIR_CLIP
        if d < -cfg.PER_PAIR_CLIP: d = -cfg.PER_PAIR_CLIP
        total += d

    delta = round(total)
    if delta < cfg.CLAMP_MIN: delta = cfg.CLAMP_MIN
    if delta > cfg.CLAMP_MAX: delta = cfg.CLAMP_MAX
    return int(delta)


def calculate_trophies(
    player_index: int,
    finish_order: List[int],
    ratings: List[int],
    cfg: TrophyConfig,
    place_index_for_i: Optional[int] = None,
) -> int:
    """Public entry: trophy delta for player_index given start ratings + finish order."""
    pre = _precompute_for_player(player_index, ratings, cfg)
    return _delta_at_finish_using_i(player_index, finish_order, pre, len(ratings), cfg, place_index_for_i)


# =============================================================================
# COINS — caps × difficulty × booster, rounded (rank auto-derived)
# =============================================================================
# Hardcoded rank/position caps. Replace with DB source later.
COIN_CAPS_BY_RANK: Dict[str, List[int]] = {
    "Unranked":        [2000, 1500, 1200, 900, 900, 900, 900, 900],
    "Bronze I":        [2200, 1650, 1300, 1000, 1000, 1000, 1000, 1000],
    "Bronze II":       [2500, 1900, 1500, 1100, 1100, 1100, 1100, 1100],
    "Bronze III":      [2800, 2100, 1700, 1300, 1300, 1300, 1300, 1300],
    "Silver I":        [3100, 2300, 1900, 1400, 1400, 1400, 1400, 1400],
    "Silver II":       [3500, 2600, 2100, 1600, 1600, 1600, 1600, 1600],
    "Silver III":      [3900, 2900, 2300, 1800, 1800, 1800, 1800, 1800],
    "Gold I":          [4300, 3200, 2600, 1900, 1900, 1900, 1900, 1900],
    "Gold II":         [4800, 3600, 2900, 2200, 2200, 2200, 2200, 2200],
    "Gold III":        [5400, 4100, 3200, 2400, 2400, 2400, 2400, 2400],
    "Platinum I":      [6000, 4500, 3600, 2700, 2700, 2700, 2700, 2700],
    "Platinum II":     [6700, 5000, 4000, 3000, 3000, 3000, 3000, 3000],
    "Platinum III":    [7500, 5600, 4500, 3400, 3400, 3400, 3400, 3400],
    "Diamond I":       [8400, 6300, 5000, 3800, 3800, 3800, 3800, 3800],
    "Diamond II":      [9400, 7100, 5600, 4200, 4200, 4200, 4200, 4200],
    "Diamond III":     [10500, 7900, 6300, 4700, 4700, 4700, 4700, 4700],
    "Master I":        [11800, 8900, 7100, 5300, 5300, 5300, 5300, 5300],
    "Master II":       [13200, 9900, 7900, 5900, 5900, 5900, 5900, 5900],
    "Master III":      [14800, 11100, 8900, 6600, 6600, 6600, 6600, 6600],
    "Champion I":      [16600, 12400, 10000, 7500, 7500, 7500, 7500, 7500],
    "Champion II":     [18600, 14000, 11200, 8400, 8400, 8400, 8400, 8400],
    "Champion III":    [20900, 15700, 12500, 9400, 9400, 9400, 9400, 9400],
    "Ascendant I":     [23400, 17600, 14000, 10500, 10500, 10500, 10500, 10500],
    "Ascendant II":    [26200, 19700, 15700, 11800, 11800, 11800, 11800, 11800],
    "Ascendant III":   [29400, 22100, 17600, 13200, 13200, 13200, 13200, 13200],
    "Hypersonic I":    [32900, 24700, 19700, 14800, 14800, 14800, 14800, 14800],
    "Hypersonic II":   [36900, 27700, 22100, 16600, 16600, 16600, 16600, 16600],
    "Hypersonic III":  [41300, 31000, 24800, 18600, 18600, 18600, 18600, 18600],
}

def _avg_expected_vs_lobby(i: int, ratings: List[int], cfg: TrophyConfig) -> float:
    """Weighted average expected win probability vs the lobby (trophy math aligned)."""
    pre = _precompute_for_player(i, ratings, cfg)
    avg_E = 0.0
    for j, Ej in enumerate(pre["E"]):
        if j == i: continue
        avg_E += pre["w"][j] * Ej
    return avg_E  # ≈0.5 for equal lobby


def _difficulty_multiplier(avg_E: float, floor: float, ceiling: float) -> float:
    """
    Map avg expected win probability (0..1) to [floor..ceiling], centered at 1.0 when avgE=0.5.
      avgE=0.20 → tough lobby → near 'ceiling'
      avgE=0.80 → easy lobby  → near 'floor'
    """
    x = max(-0.5, min(0.5, 0.5 - avg_E)) / 0.5  # normalize to [-1..+1]
    if x >= 0:
        return 1.0 + x * (ceiling - 1.0)
    else:
        return 1.0 + x * (1.0 - floor)


def calculate_coins(
    rank_label: str,              # derived from trophies
    place: int,                   # 1..8
    lobby_ratings: List[int],     # trophies at race start (all players)
    player_index: int,
    coin_cfg: CoinConfig,
    trophy_cfg: TrophyConfig,
) -> int:
    """
    Coins = cap(rank_label, place) × difficulty_multiplier(avgE) × booster
    Then rounded to nearest coin_cfg.round_to (e.g., 100).
    """
    if coin_cfg.rank_max_by_place is None:
        raise ValueError("CoinConfig.rank_max_by_place must be provided.")

    caps = coin_cfg.rank_max_by_place.get(rank_label)
    if not caps or not (1 <= place <= len(caps)):
        raise KeyError(f"Missing caps for rank '{rank_label}' or invalid place {place}")

    max_for_place = float(caps[place - 1])
    avgE = _avg_expected_vs_lobby(player_index, lobby_ratings, trophy_cfg)
    mult = _difficulty_multiplier(avgE, coin_cfg.difficulty_floor, coin_cfg.difficulty_ceiling)

    raw = max_for_place * mult * coin_cfg.booster_multiplier
    rounded = int(round(raw / coin_cfg.round_to) * coin_cfg.round_to)
    return max(0, rounded)


# =============================================================================
# EXP — per-rank caps (~250 max, 1st at top) or formula fallback (rank auto-derived)
# =============================================================================
# Deterministic EXP table generation from the flat rules:
#   • Base per-rank: 100 → 208 (across 28 ranks; +4 per step)
#   • Per-place multiplier: linear 1.20 → 0.80 (8 steps)
_exp_place_mults = [1.20, 1.142857, 1.085714, 1.028571, 0.971429, 0.914286, 0.857143, 0.80]

def _exp_base_for_rank(rank_label: str, base_min=100, base_max=208) -> float:
    idx = RANK_LABELS.index(rank_label) if rank_label in RANK_LABELS else 0
    steps = max(1, len(RANK_LABELS) - 1)  # 27
    return base_min + (base_max - base_min) * (idx / steps)

EXP_CAPS_BY_RANK: Dict[str, List[int]] = {
    r: [int(round(_exp_base_for_rank(r) * m)) for m in _exp_place_mults] for r in RANK_LABELS
}

def calculate_exp(
    trophies: int,
    place: int,
    total_positions: int,
    cfg: ExpConfig,
    rank_label: Optional[str] = None,  # pass computed rank to use table mode
) -> int:
    """
    EXP with table-preferred logic:
      If cfg.rank_place_caps and rank_label:
          exp = caps[rank_label][place-1] × booster
      Else:
          exp = (lerp base_min..base_max by trophies/7000) × (linear pos 1.20→0.80) × booster
    """
    # Preferred: per-rank EXP caps mode (stable, easy to tune)
    if cfg.rank_place_caps is not None and rank_label is not None:
        caps = cfg.rank_place_caps.get(rank_label)
        if not caps or not (1 <= place <= len(caps)):
            raise KeyError(f"Missing EXP caps for rank '{rank_label}' or invalid place {place}")
        return max(0, int(round(caps[place - 1] * cfg.booster_multiplier)))

    # Fallback: flat-ish formula (kept for safety)
    t = max(0.0, min(1.0, float(trophies) / 7000.0))
    base = cfg.base_min + (cfg.base_max - cfg.base_min) * t

    if total_positions > 1:
        frac = (place - 1) / float(total_positions - 1)  # 0 for 1st .. 1 for last
        pos_mult = cfg.pos_max_mult + (cfg.pos_min_mult - cfg.pos_max_mult) * frac
    else:
        pos_mult = 1.0

    return max(0, int(round(base * pos_mult * cfg.booster_multiplier)))


# =============================================================================
# TROPHY PRE-DEDUCTION (quit-proofing)
# =============================================================================
def _synthetic_last_place_finish_order(n: int, player_index: int) -> List[int]:
    """Create a finish order where 'player_index' is last (others' order irrelevant)."""
    order = [j for j in range(n) if j != player_index]
    order.append(player_index)
    return order


def calculate_last_place_delta(player_index: int, ratings: List[int], trophy_cfg: TrophyConfig) -> int:
    """Trophy delta if the player finished LAST, using start-of-race ratings."""
    order = _synthetic_last_place_finish_order(len(ratings), player_index)
    return calculate_trophies(player_index, order, ratings, trophy_cfg)


@dataclass
class RaceSettlement:
    """Trophy settlement given pre-deduction at start."""
    actual_trophies_delta: int  # true net for this race (what UI displays)
    settlement_delta: int       # amount to apply now (offset pre-deduction)


def settle_trophies_after_finish(
    player_index: int,
    finish_order: List[int],
    ratings: List[int],
    trophy_cfg: TrophyConfig,
    last_place_delta_applied: int,
    place_index_for_i: Optional[int] = None,
) -> RaceSettlement:
    """Compute actual delta for the real finish and the settlement vs pre-deduction."""
    actual = calculate_trophies(player_index, finish_order, ratings, trophy_cfg, place_index_for_i)
    return RaceSettlement(actual_trophies_delta=actual, settlement_delta=actual - last_place_delta_applied)


# =============================================================================
# ORCHESTRATOR I/O
# =============================================================================
@dataclass
class RaceInputsWithPrededuction:
    """
    Inputs at finish time.
      - 'ratings' is the start-of-race trophies snapshot you persisted.
      - 'last_place_delta_applied' must match what you deducted at start.
      - No rank label here; we derive it from trophies for coins/EXP.
    """
    player_index: int
    finish_order: List[int]
    ratings: List[int]
    place: int
    total_positions: int
    has_coin_booster: bool = False
    has_exp_booster: bool = False
    last_place_delta_applied: int = 0
    place_index_for_i: Optional[int] = None


@dataclass
class RaceRewardsWithSettlement:
    """
    Authoritative output for DB + UI.
      trophies_actual      : net trophies for this race (UI should display this)
      trophies_settlement  : apply now to offset pre-deduction
      coins, exp           : currency/XP rewards (after multipliers, rounded)
      old_rank, new_rank   : rank labels
      promoted, demoted    : booleans for UI animation
      pre_deducted_last    : echo of the pre-deduction amount (telemetry/debug)
    """
    trophies_actual: int
    trophies_settlement: int
    coins: int
    exp: int
    old_rank: str
    new_rank: str
    promoted: bool
    demoted: bool
    pre_deducted_last: int


# =============================================================================
# ORCHESTRATOR (finish-time single call) — rank auto-derived
# =============================================================================
def compute_race_rewards_with_prededuction(
    inp: RaceInputsWithPrededuction,
    trophy_cfg: TrophyConfig,
    coin_cfg: CoinConfig,
    exp_cfg: ExpConfig,
) -> RaceRewardsWithSettlement:
    """
    Compute everything for DB + UI:
      1) Trophy settlement against pre-deduction
      2) Coins and EXP (with boosters)
      3) Rank movement (old/new + promoted/demoted)
      • Rank label for payouts is derived from trophies automatically.
    """
    # Rank BEFORE race from starting trophies
    old_trophies = inp.ratings[inp.player_index]
    old_rank = get_rank_for_trophies(old_trophies)

    # Use computed rank label for both coins & EXP (prevents mismatches)
    rank_label_for_payouts = old_rank

    # Inject boosters (clone configs; don't mutate shared instances)
    coin_cfg_local = replace(coin_cfg, booster_multiplier=(2.0 if inp.has_coin_booster else 1.0))
    exp_cfg_local  = replace(
        exp_cfg,
        rank_place_caps=(exp_cfg.rank_place_caps or EXP_CAPS_BY_RANK),  # default to our table
        booster_multiplier=(2.0 if inp.has_exp_booster else 1.0),
    )

    # 1) Trophy settlement
    settle = settle_trophies_after_finish(
        player_index=inp.player_index,
        finish_order=inp.finish_order,
        ratings=inp.ratings,
        trophy_cfg=trophy_cfg,
        last_place_delta_applied=inp.last_place_delta_applied,
        place_index_for_i=inp.place_index_for_i,
    )

    # 2) Coins & EXP (both use computed rank)
    coins_amount = calculate_coins(
        rank_label=rank_label_for_payouts,
        place=inp.place,
        lobby_ratings=inp.ratings,
        player_index=inp.player_index,
        coin_cfg=coin_cfg_local,
        trophy_cfg=trophy_cfg,
    )

    exp_amount = calculate_exp(
        trophies=old_trophies,
        place=inp.place,
        total_positions=inp.total_positions,
        cfg=exp_cfg_local,
        rank_label=rank_label_for_payouts,
    )

    # 3) Rank AFTER applying settlement to trophies
    new_trophies = old_trophies + settle.settlement_delta
    new_rank = get_rank_for_trophies(new_trophies)

    # Promotion/demotion flags by index comparison
    def _rank_index(name: str) -> int:
        for idx, (_, label) in enumerate(RANK_THRESHOLDS):
            if label == name:
                return idx
        return 0

    promoted = _rank_index(new_rank) > _rank_index(old_rank)
    demoted  = _rank_index(new_rank) < _rank_index(old_rank)

    return RaceRewardsWithSettlement(
        trophies_actual=settle.actual_trophies_delta,
        trophies_settlement=settle.settlement_delta,
        coins=coins_amount,
        exp=exp_amount,
        old_rank=old_rank,
        new_rank=new_rank,
        promoted=promoted,
        demoted=demoted,
        pre_deducted_last=inp.last_place_delta_applied,
    )


# =============================================================================
# OPTIONAL: LOCAL SMOKE TEST (remove in production)
# =============================================================================
if __name__ == "__main__":
    # Instantiate configs (in production, load coin caps from DB)
    tcfg = TrophyConfig()
    ccfg = CoinConfig(rank_max_by_place=COIN_CAPS_BY_RANK, round_to=100)
    # Provide EXP caps table (preferred)
    xcfg = ExpConfig(rank_place_caps=EXP_CAPS_BY_RANK, base_min=100, base_max=208,
                     pos_min_mult=0.80, pos_max_mult=1.20)

    # Example: equal 7000-trophy lobby, player 0 finishes 1st → full Hypersonic III cap for 1st
    ratings = [7000] * 8
    i = 0

    # Race start: pre-deduct last place
    last_delta = calculate_last_place_delta(i, ratings, tcfg)
    print("Pre-deducted (as-if last):", last_delta)

    # Finish: player 0 wins
    finish_order = [0, 3, 4, 7, 2, 5, 6, 1]
    place_for_i = finish_order.index(i) + 1  # = 1

    out = compute_race_rewards_with_prededuction(
        inp=RaceInputsWithPrededuction(
            player_index=i,
            finish_order=finish_order,
            ratings=ratings,
            place=place_for_i,
            total_positions=len(ratings),
            has_coin_booster=False,
            has_exp_booster=False,
            last_place_delta_applied=last_delta,
        ),
        trophy_cfg=tcfg,
        coin_cfg=ccfg,
        exp_cfg=xcfg,
    )

    print("Coins (expect 41300):", out.coins)
    print("EXP  (top table 1st):", out.exp)
    print("Old→New:", out.old_rank, "→", out.new_rank, "| Promoted:", out.promoted, "Demoted:", out.demoted)
