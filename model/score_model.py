#!/usr/bin/env python3
"""2026 Half-PPR Redraft Model — scoring engine + edge detection.

Inputs:
  players_layerAF.csv        seed + Sleeper layer A + ECR/Winks consensus
  team_environment_final.json  32-team environment (vegas, oline, coaching, EPA, vacated)
  player_metrics.json        {sportradar_id: metrics packet} from Player Research workflow runs
Outputs:
  board.json / board.csv     full scored board with tiers, deltas, conviction flags
"""
import csv, json, math, os, sys
from statistics import mean, pstdev

HERE = os.path.dirname(os.path.abspath(__file__))
SCRATCH = os.environ.get("FANTASY_MODEL_DATA", os.path.join(HERE, "data"))

REPLACEMENT = {"QB": 16, "RB": 30, "WR": 36, "TE": 12}  # QB16: streaming makes effective single-QB replacement deeper than QB12
BUCKET_W = {"opportunity": 0.30, "production": 0.20, "situation": 0.15, "efficiency": 0.10, "market": 0.15, "regression": 0.10}
# consensus anchor weight by consensus overall rank: heavy at the top (consensus is sharpest
# there and the market prices positional scarcity, e.g. Bowers), looser deep
def consensus_alpha(cons_rank):
    if cons_rank is None: return 0.35
    if cons_rank <= 30: return 0.65
    if cons_rank <= 60: return 0.55
    if cons_rank <= 100: return 0.45
    return 0.35

def f(x):
    """tolerant float"""
    if x is None or x == "" or isinstance(x, bool): return None
    try:
        v = float(str(x).replace("%", "").replace(",", ""))
        return v
    except (ValueError, TypeError):
        return None

def zscores(vals):
    """z-score list with None passthrough -> 0 (position mean)."""
    known = [v for v in vals if v is not None]
    if len(known) < 3: return [0.0] * len(vals)
    m, s = mean(known), pstdev(known)
    if s == 0: return [0.0] * len(vals)
    return [((v - m) / s) if v is not None else 0.0 for v in vals]

def wblend(zmap, weights, i):
    num = den = 0.0
    for k, w in weights.items():
        num += w * zmap[k][i]; den += w
    return num / den if den else 0.0

def load():
    rows = list(csv.DictReader(open(f"{SCRATCH}/players_layerAF.csv")))
    env = {t["team"]: t for t in json.load(open(f"{SCRATCH}/team_environment_final.json"))["teams"]}
    try:
        metrics = json.load(open(f"{SCRATCH}/player_metrics.json"))
    except FileNotFoundError:
        metrics = {}
    try:
        weekly = json.load(open(f"{SCRATCH}/weekly_analysis.json"))
    except FileNotFoundError:
        weekly = {}
    try:
        spikes = json.load(open(f"{SCRATCH}/spikes_2026.json"))
    except FileNotFoundError:
        spikes = {}
    try:
        senti = json.load(open(f"{SCRATCH}/sentiment_2026.json"))
    except FileNotFoundError:
        senti = {}
    return rows, env, metrics, weekly, spikes, senti

def qb_tiers(rows):
    """team -> QB tier 1(elite)-5 from seed QB positional ranks."""
    tiers = {}
    for r in rows:
        if r["Pos"].strip() != "QB": continue
        team = (r.get("sleeper_team") or r["Team"]).strip()
        pr = f(r["PosRank"]) or 99
        t = 1 if pr <= 4 else 2 if pr <= 10 else 3 if pr <= 18 else 4 if pr <= 26 else 5
        tiers[team] = min(tiers.get(team, 5), t)
    return tiers

def implied_fp(u, props, pos):
    """half-PPR implied fantasy points from season props."""
    ry, rcy, rc = f(props.get("rush_yds_prop")), f(props.get("rec_yds_prop")), f(props.get("receptions_prop"))
    td, py, ptd = f(props.get("total_td_prop")), f(props.get("pass_yds_prop")), f(props.get("pass_td_prop"))
    if all(v is None for v in (ry, rcy, rc, td, py, ptd)): return None
    pts = 0.1 * ((ry or 0) + (rcy or 0)) + 0.5 * (rc or 0) + 6 * (td or 0) + 0.04 * (py or 0) + 4 * (ptd or 0)
    return pts

def scope_srids():
    """Top-200 players on both lists (seed CSV + Winks) = run queue + test batch."""
    srids = set()
    for fn in ("run_queue.json", "test_payloads.json"):
        try:
            srids |= {p["sportradar_id"] for p in json.load(open(f"{SCRATCH}/{fn}"))}
        except FileNotFoundError:
            pass
    return srids

def build():
    rows, env, metrics, weekly, spikes, senti = load()
    scope = scope_srids()
    if scope:
        rows = [r for r in rows if r["Sport_radar_id"].strip() in scope]
    qbt = qb_tiers(rows)
    players = []
    for r in rows:
        srid = r["Sport_radar_id"].strip()
        pos = r["Pos"].strip()
        team = (r.get("sleeper_team") or "").strip() or r["Team"].strip()
        m = metrics.get(srid, {})
        u = dict(m.get("usage", {}) or {})
        # defensive scale normalization from mixed extraction outputs
        tprr = f(u.get("tprr"))
        if tprr is not None and tprr > 1.5: u["tprr"] = tprr / 100
        for k in ("route_participation_pct", "snap_share_pct"):
            v = f(u.get(k))
            if v is not None and v <= 1.0: u[k] = v * 100
        rp, ss = f(u.get("route_participation_pct")), f(u.get("snap_share_pct"))
        if rp == 100.0 and ss is not None and ss < 40: u["route_participation_pct"] = None  # implausible pair
        pr = m.get("props", {}) or {}
        inj = m.get("injury", {}) or {}
        e = env.get(team if team != "JAC" else "JAX", {})
        p = {
            "player": r["Player"].strip(), "team": team, "pos": pos, "srid": srid,
            "seed_rank": f(r["Rank"]), "adp": f(r["ADP"]), "pos_rank_seed": f(r["PosRank"]),
            "age": f(r.get("age")), "years_exp": f(r.get("years_exp")),
            "rookie": r.get("rookie_flag") == "TRUE",
            "team_changed": r.get("team_mismatch_flag") == "TRUE",
            "injury_status": (r.get("injury_status") or "").strip(),
            "depth_order": f(r.get("depth_chart_order")),
            "trending": f(r.get("trending_add_count")) or 0,
            "ecr": f(r.get("ecr_half_ppr")), "winks": f(r.get("winks_rank")),
            "per_game_2025": f(r.get("Per Game 2025")),
            "env": e, "usage": u, "props": pr, "injury": inj,
            "wa": weekly.get(srid, {}),
            "sp": spikes.get(srid, {}),
            "sent": senti.get(srid, {}),
            "notes": m.get("notes", {}),
            "has_metrics": bool(u),
        }
        # derived
        ts, ays = f(u.get("target_share_pct")), f(u.get("air_yards_share_pct"))
        p["wopr"] = (1.5 * ts + 0.7 * ays) if (ts is not None and ays is not None) else None
        p["vegas_fp"] = implied_fp(u, pr, pos)
        players.append(p)

    # teammate competition for touches: same-team, same touch pool (WR+TE share targets;
    # RBs share carries). Strength = how highly the market prices each competitor.
    for p in players:
        pool = ("WR", "TE") if p["pos"] in ("WR", "TE") else (p["pos"],)
        comp = 0.0
        for q in players:
            if q is p or q["team"] != p["team"] or q["pos"] not in pool:
                continue
            c = q["adp"] or q["ecr"]
            if c:
                comp += max(0.0, (120 - c) / 120)
        p["_comp_score"] = min(comp, 2.5)

    # position-group scoring
    for pos in ("QB", "RB", "WR", "TE"):
        grp = [p for p in players if p["pos"] == pos]
        idx = {id(p): i for i, p in enumerate(grp)}
        def col(fn): return [fn(p) for p in grp]
        g = lambda key: col(lambda p: f(p["usage"].get(key)))
        ge = lambda key: col(lambda p: f(p["env"].get(key)))

        if pos in ("WR", "TE"):
            zm = {"xfp": zscores(g("xfp_per_game")), "wopr": zscores(col(lambda p: p["wopr"])),
                  "ts": zscores(g("target_share_pct")), "route": zscores(g("route_participation_pct")),
                  "rz": zscores(g("rz_target_share_pct"))}
            opp_w = {"xfp": 0.50, "wopr": 0.25, "ts": 0.10, "route": 0.10, "rz": 0.05}
            zeff = {"yprr": zscores(g("yprr")), "tprr": zscores(g("tprr")), "epat": zscores(g("epa_per_target"))}
            eff_w = {"yprr": 0.45, "tprr": 0.30, "epat": 0.25}
            vac_z = zscores(ge("vacated_target_pct"))
            env_qual = zscores(ge("epa_per_pass_2025"))
        elif pos == "RB":
            zm = {"xfp": zscores(g("xfp_per_game")), "oppsh": zscores(g("opportunity_share_pct")),
                  "gl": zscores(g("goal_line_carry_share_pct")), "rz": zscores(g("rz_touch_share_pct")),
                  "route": zscores(g("route_participation_pct"))}
            opp_w = {"xfp": 0.50, "oppsh": 0.20, "gl": 0.15, "rz": 0.10, "route": 0.05}
            zeff = {"mtf": zscores(g("mtf_per_touch")), "yac": zscores(g("yac_per_attempt")),
                    "repa": zscores(g("rush_epa_per_att")), "tpg": zscores(g("targets_per_game"))}
            eff_w = {"mtf": 0.30, "yac": 0.25, "repa": 0.25, "tpg": 0.20}
            vac_z = zscores(ge("vacated_opportunity_pct"))
            env_qual = zscores(ge("epa_per_rush_2025"))
        else:  # QB
            zm = {"rush": zscores(g("rush_yds_per_game")), "xfp": zscores(g("xfp_per_game"))}
            opp_w = {"rush": 0.50, "xfp": 0.50}
            zeff = {"epa": zscores(g("epa_per_play"))}
            eff_w = {"epa": 1.0}
            vac_z = [0.0] * len(grp)
            env_qual = zscores(ge("epa_per_pass_2025"))

        # production: 2025 per-game positional finish from the seed CSV (lower = better);
        # log-scaled so PG3 vs PG10 matters far more than PG40 vs PG47
        zprod = zscores(col(lambda p: -math.log(p["per_game_2025"]) if p["per_game_2025"] else None))
        # trajectory: last-5 games (incl. playoffs) vs season half-PPR ppg — catches late
        # role expansions (Burden post-Moore) and playoff surges (Walker) that season
        # aggregates bury
        ztraj = zscores(col(lambda p: p["wa"].get("trajectory")))
        # upside: height of the 90th-percentile week. Backtested (5 folds, sign-stable 5/5,
        # +4.0 pts VOR per sd at equal draft cost). NOTE: spike FREQUENCY tested negative
        # (the market already pays for remembered spike weeks) so it is surfaced as context,
        # not scored.
        zp90 = zscores(col(lambda p: p["sp"].get("p90")))

        zsit = {"ppg": zscores(ge("implied_ppg")), "wint": zscores(ge("win_total")),
                "oline": zscores(col(lambda p: -(f(p["env"].get("oline_rank")) or 16.5))),
                "envq": env_qual, "vac": vac_z,
                "qbt": zscores(col(lambda p: -(qbt.get(p["team"], 3)))) if pos != "QB" else [0.0] * len(grp),
                "comp": zscores(col(lambda p: -p["_comp_score"])) if pos != "QB" else [0.0] * len(grp)}
        sit_w = {"ppg": 0.25, "wint": 0.08, "oline": 0.12, "envq": 0.15, "vac": 0.15, "qbt": 0.10, "comp": 0.15}

        zmkt = {"vfp": zscores(col(lambda p: p["vegas_fp"])),
                "trend": zscores(col(lambda p: math.log1p(p["trending"])))}
        mkt_w = {"vfp": 0.85, "trend": 0.15}
        zreg = {"reg": zscores(col(lambda p: -(f(p["usage"].get("fp_minus_xfp")) or 0) if p["has_metrics"] else None))}
        reg_w = {"reg": 1.0}

        for i, p in enumerate(grp):
            p["_vac_z"] = zsit["vac"][i]
            # backtest note: trajectory fit to ~zero weight out-of-sample on both folds —
            # kept only as a light tiebreaker, not a driver
            p["b_production"] = 0.72 * zprod[i] + 0.08 * ztraj[i] + 0.20 * zp90[i]
            p["b_upside"] = zp90[i]
            p["b_opportunity"] = wblend(zm, opp_w, i)
            p["b_situation"] = wblend(zsit, sit_w, i)
            p["b_efficiency"] = wblend(zeff, eff_w, i)
            p["b_market"] = wblend(zmkt, mkt_w, i)
            p["b_regression"] = wblend(zreg, reg_w, i)
            # playcaller: only the scheme-reset upside on bad offenses counts; continuity
            # itself is a weak signal and shouldn't tax half the league
            if p["env"].get("new_oc") or p["env"].get("new_hc"):
                epa = f(p["env"].get("epa_per_play_2025")) or 0
                if epa < -0.05: p["b_situation"] += 0.15

    # ---- post-bucket adjustments ----
    try:
        _draft = json.load(open(f"{SCRATCH}/draft_capital_2026.json"))
    except FileNotFoundError:
        _draft = []
    def _n(s): return s.lower().replace(".", "").replace("'", "").replace(" jr", "").replace(" ii", "").strip()
    dc_map = {_n(d["player"]): d["pick"] for d in _draft}
    for p in players:
        # rookies: opportunity = vacated volume + draft capital + market, NOT team quality
        # (bad teams still feed their RB1; ARI's 18 implied ppg says nothing about Love's touches)
        if p["rookie"] and not p["has_metrics"]:
            pick = dc_map.get(_n(p["player"]))
            dc = 0.6 if pick and pick <= 15 else 0.4 if pick and pick <= 32 else 0.2 if pick and pick <= 64 else 0.0 if pick and pick <= 105 else -0.3
            p["draft_pick"] = pick
            p["b_opportunity"] = 0.6 * p["_vac_z"] + 0.4 * p["b_market"] + dc
        # team-changers: 2025 usage measured the OLD role — vacated volume on the new team
        # plus (lack of) competition is most of the story
        elif p.get("team_changed") and p["has_metrics"]:
            p["b_opportunity"] = 0.3 * p["b_opportunity"] + 0.7 * p["_vac_z"]
        # role discontinuity: team vacated 45%+ of the touch pool and nobody priced competes —
        # trailing usage understates the 2026 role (Walker-in-KC case). Upgrade-only: max()
        # never hurts an incumbent whose own usage already reflects the lead role.
        if not p["rookie"] and p["has_metrics"]:
            vac_pct = f(p["env"].get("vacated_opportunity_pct" if p["pos"] == "RB" else "vacated_target_pct")) or 0
            # smooth ramp (25%..60% vacated), scaled down as priced competition rises —
            # no cliff at any single threshold
            ramp = max(0.0, min(1.0, (vac_pct - 25) / 35)) * max(0.0, 1 - p["_comp_score"] / 1.2)
            if ramp > 0:
                w = 0.7 * ramp
                p["b_opportunity"] = max(p["b_opportunity"], (1 - w) * p["b_opportunity"] + w * p["_vac_z"])
        # vacated-volume succession: young player with flashes or Day 1-2 capital on a team
        # that lost 25%+ of its targets is first in line for them
        if (not p["rookie"] and p["has_metrics"] and (p["years_exp"] or 9) <= 2
                and (f(p["env"].get("vacated_target_pct")) or 0) >= 25 and p["pos"] in ("WR", "TE")
                and p["b_efficiency"] > 0.25):
            p["b_opportunity"] += 0.4
        # ---- weekly-split evidence (2025 game logs) ----
        p["split_boost_note"] = p["contingency_note"] = None
        p["contingency_ppg"] = None
        splits = (p["wa"].get("splits") or {})
        # (a) competitor DEPARTED: games without him are the direct preview of the 2026 role
        best = None
        for cname, sp in splits.items():
            if sp["departed"] and sp["out_g"] >= 2 and sp["out_ppg"] - sp["with_ppg"] >= 2.0:
                if best is None or sp["out_ppg"] > best[1]["out_ppg"]:
                    best = (cname, sp)
        if best:
            cname, sp = best
            shrink = sp["out_g"] / (sp["out_g"] + 3)  # empirical-Bayes: 2-game splits count ~40%, 8-game ~73%
            p["b_opportunity"] += min(1.0, 0.12 * (sp["out_ppg"] - sp["with_ppg"]) * shrink)
            p["split_boost_note"] = (f"averaged {sp['out_ppg']} half-PPR/g in {sp['out_g']} games without {cname} "
                                     f"(vs {sp['with_ppg']} with) — and they're on different teams in 2026")
        # (b) competitor STILL AHEAD on this roster: those games are quantified handcuff upside
        cont = None
        for cname, sp in splits.items():
            if not sp["departed"] and sp["comp_priced_above"] and sp["out_g"] >= 2 and sp["out_ppg"] >= 10:
                if cont is None or sp["out_ppg"] > cont[1]["out_ppg"]:
                    cont = (cname, sp)
        if cont:
            cname, sp = cont
            p["contingency_ppg"] = sp["out_ppg"]
            shrink = sp["out_g"] / (sp["out_g"] + 3)
            p["b_opportunity"] += min(0.35, 0.03 * (sp["out_ppg"] - 8) * shrink)
            p["contingency_note"] = (f"contingency value: {sp['out_ppg']} half-PPR/g in {sp['out_g']} games "
                                     f"{cname} missed — league-winning insurance if it happens again")
        # (c) P is the priced LEAD and torched it when his committee-mate sat: ceiling preview
        elif not best:
            lead = None
            for cname, sp in splits.items():
                if (not sp["departed"] and not sp["comp_priced_above"]
                        and sp["out_g"] >= 2 and sp["out_ppg"] >= 15 and sp["out_ppg"] - sp["with_ppg"] >= 5):
                    if lead is None or sp["out_ppg"] > lead[1]["out_ppg"]:
                        lead = (cname, sp)
            if lead:
                cname, sp = lead
                shrink = sp["out_g"] / (sp["out_g"] + 3)
                p["b_opportunity"] += min(0.5, 0.05 * (sp["out_ppg"] - sp["with_ppg"]) * shrink)
                p["contingency_ppg"] = sp["out_ppg"]
                p["contingency_note"] = (f"ceiling preview: {sp['out_ppg']} half-PPR/g in {sp['out_g']} games "
                                         f"{cname} missed — the full-backfield version is a league-winner")
        # qualitative role signal — deliberately small and GATED on specificity, because
        # generic August praise ("he's looked great") is said about everyone and predicts
        # nothing. Only concrete role statements move the score; everything else is context.
        s = p["sent"] or {}
        ROLE_ADJ = {"locked_starter": 0.25, "clear_lead": 0.20, "featured_role": 0.10,
                    "competing": -0.05, "rotational": -0.15, "buried": -0.30, "no_signal": 0.0}
        if s.get("specificity") == "specific":
            p["sent_adj"] = ROLE_ADJ.get(s.get("role_language"), 0.0)
        else:
            p["sent_adj"] = 0.0
        p["b_opportunity"] += p["sent_adj"]

        # regression persistence: rushing QBs and elite per-game producers beat xFP by skill, not luck
        if p["b_regression"] < 0:
            rush_att = f(p["usage"].get("rush_att_per_game"))
            elite = p["per_game_2025"] is not None and p["per_game_2025"] <= 15
            if (p["pos"] == "QB" and rush_att and rush_att >= 5) or elite:
                p["b_regression"] *= 0.4

    # risk multiplier
    for p in players:
        pos, age = p["pos"], p["age"] or 24
        inj_flag = 1.0 if p["injury_status"] in ("IR", "PUP", "DNR", "Doubtful", "Out") else 0.5 if p["injury_status"] == "Questionable" else 0.0
        soft = f(p["injury"].get("soft_tissue_events_2yr")) or 0
        soft_flag = 1.0 if soft >= 2 else 0.0
        # competition label from the priced-teammate score (market-based, not depth-chart guesses)
        comp = "HIGH" if p["_comp_score"] >= 1.2 else "MEDIUM" if p["_comp_score"] >= 0.5 else "LOW"
        ambiguity = 1.0 if (p["depth_order"] is None or p["injury_status"] in ("PUP", "DNR")
                            or p["_comp_score"] >= 0.8) else 0.0
        cliff = 0.0
        if pos == "RB": cliff = 0.05 if age >= 28 else 0.02 if age >= 26 else 0.0
        elif pos == "WR": cliff = 0.05 if age >= 31 else 0.03 if age >= 29 else 0.0
        elif pos == "TE": cliff = 0.03 if age >= 30 else 0.0
        elif pos == "QB": cliff = 0.02 if age >= 36 else 0.0
        breakout = -0.02 if (pos == "WR" and p["years_exp"] in (1, 2)) else 0.0
        risk = 1 - (0.03 * inj_flag + 0.02 * soft_flag + 0.03 * (comp == "HIGH") + 0.02 * ambiguity + cliff + breakout)
        # rookie day 1-2 capital in vacated spot gets upside credit back
        vac = f(p["env"].get("vacated_opportunity_pct" if pos == "RB" else "vacated_target_pct")) or 0
        if p["rookie"] and vac >= 30: risk += 0.03
        p["risk_adj"] = max(0.82, min(risk, 1.03))
        p["competition"] = comp
        p["ambiguity"] = bool(ambiguity)

        raw = sum(BUCKET_W[b] * p[f"b_{b}"] for b in BUCKET_W) * p["risk_adj"]
        # data-completeness shrinkage: a veteran with no usage data must not float on situation alone
        if not p["has_metrics"] and not p["rookie"]:
            raw *= 0.3
        elif p["has_metrics"]:
            u_known = sum(1 for v in p["usage"].values() if v is not None and v != [])
            if u_known <= 3: raw *= 0.6  # thin packet
        p["pos_score"] = raw

    # ---- consensus anchor: blend model score toward market/expert consensus, slot-weighted ----
    winks_all = json.load(open(f"{SCRATCH}/winks_top300.json"))
    skill_w = [w for w in winks_all if w["pos"] in ("QB", "RB", "WR", "TE")]
    wmap = {w["winks_rank"]: i for i, w in enumerate(sorted(skill_w, key=lambda x: x["winks_rank"]), 1)}
    for p in players:
        p["winks_skill"] = wmap.get(p["winks"]) if p["winks"] else None
        comps, wts = [], []
        for v, w in ((p["adp"], 1.0), (p["ecr"], 1.0), (p["winks_skill"], 1.5)):
            if v: comps.append(v * w); wts.append(w)
        p["consensus_overall"] = (sum(comps) / sum(wts)) if wts else None
    for pos in ("QB", "RB", "WR", "TE"):
        grp = [p for p in players if p["pos"] == pos]
        ranked = sorted([p for p in grp if p["consensus_overall"]], key=lambda x: x["consensus_overall"])
        for i, p in enumerate(ranked, 1): p["consensus_pos_rank"] = i
        cons_z = zscores([-math.log(p["consensus_pos_rank"]) if p.get("consensus_pos_rank") else None for p in grp])
        cons_z = [min(z, 2.0) for z in cons_z]  # cap: the log scale over-rewards the #1 at a position (scarcity is already VOR's job)
        for i, p in enumerate(grp):
            a = consensus_alpha(p["consensus_overall"])
            p["model_score_raw"] = p["pos_score"]
            p["pos_score"] = a * cons_z[i] + (1 - a) * p["pos_score"]

    # VOR + overall rank
    for pos in ("QB", "RB", "WR", "TE"):
        grp = sorted([p for p in players if p["pos"] == pos], key=lambda x: -x["pos_score"])
        repl_i = min(REPLACEMENT[pos], len(grp)) - 1
        repl = grp[repl_i]["pos_score"]
        for rank, p in enumerate(grp, 1):
            p["model_pos_rank"] = rank
            p["vor"] = p["pos_score"] - repl
        # tiers: gap > 0.4 breaks
        tier = 1
        for i, p in enumerate(grp):
            if i and (grp[i-1]["pos_score"] - p["pos_score"]) > 0.4: tier += 1
            p["tier"] = tier
    # Positional ADP ranks are needed by the projection and classification blocks.
    for pos in ("QB", "RB", "WR", "TE"):
        grp = [p for p in players if p["pos"] == pos and p["adp"] is not None]
        for i, p in enumerate(sorted(grp, key=lambda x: x["adp"]), 1):
            p["adp_pos_rank"] = i

    # ---- optimization objective: standard deviations of expected PPG above replacement ----
    # Expected PPG comes from position-rank curves calibrated on 2024+2025 actuals. The
    # numerator is projected PPG minus the position-specific replacement baseline; dividing
    # by the within-position PPG spread puts QB/RB/WR/TE advantages on one comparable scale.
    # Consensus is already embedded in the positional score above, so the final cross-position
    # ordering can optimize this objective directly instead of blending unrelated rank units.
    try:
        curves = json.load(open(f"{SCRATCH}/rank_ppg_curves.json"))
    except FileNotFoundError:
        curves = None
    if curves:
        for pos in ("QB", "RB", "WR", "TE"):
            grp = [p for p in players if p["pos"] == pos]
            c = curves[pos]
            replacement_ppg = c["a"] + c["b"] * math.log(REPLACEMENT[pos])
            projected = [c["a"] + c["b"] * math.log(p["model_pos_rank"]) for p in grp]
            position_sd = pstdev(projected) if len(projected) >= 2 else 0.0
            for p, expected_ppg in zip(grp, projected):
                p["proj_ppg"] = round(expected_ppg, 1)
                p["replacement_ppg"] = round(replacement_ppg, 1)
                p["position_ppg_sd"] = round(position_sd, 3)
                p["vor_pts"] = round(expected_ppg - replacement_ppg, 1)
                p["z_vor"] = round((expected_ppg - replacement_ppg) / position_sd, 4) if position_sd else 0.0

        board = sorted(
            players,
            key=lambda p: (-p["z_vor"], p.get("consensus_overall") or 9999),
        )
        for rank, p in enumerate(board, 1):
            p["model_rank"] = rank

        for p in board:
            c = curves[p["pos"]]
            apr = p.get("adp_pos_rank")
            p["adp_implied_ppg"] = round(c["a"] + c["b"] * math.log(apr), 1) if apr else None
            p["edge_pts_per_game"] = round(p["proj_ppg"] - p["adp_implied_ppg"], 1) if apr else None
    else:
        # Defensive fallback for incomplete local data: standardize the evidence-space VOR.
        for pos in ("QB", "RB", "WR", "TE"):
            grp = [p for p in players if p["pos"] == pos]
            spread = pstdev([p["pos_score"] for p in grp]) if len(grp) >= 2 else 0.0
            for p in grp:
                p["z_vor"] = p["vor"] / spread if spread else 0.0
        board = sorted(players, key=lambda p: (-p["z_vor"], p.get("consensus_overall") or 9999))
        for rank, p in enumerate(board, 1):
            p["model_rank"] = rank

    # ---- data-confidence grade (A-D): how much verified evidence sits under the rank ----
    for p in board:
        u_known = sum(1 for v in p["usage"].values() if v is not None and v != []) if p["has_metrics"] else 0
        has_logs = bool((p["wa"] or {}).get("games"))
        has_props = any(v is not None for k, v in p["props"].items() if k not in ("book", "as_of"))
        has_splits = bool((p["wa"] or {}).get("splits"))
        if u_known >= 8 and has_logs and (has_props or has_splits):
            g = "A"
        elif u_known >= 5 and has_logs:
            g = "B"
        elif u_known >= 1 or has_logs:
            g = "C"
        else:
            g = "D"
        p["confidence"] = g

    # deltas vs consensus sources (winks_skill already computed in the anchor pass)
    for p in board:
        p["delta_vs_ecr"] = (p["ecr"] - p["model_rank"]) if p["ecr"] else None
        p["delta_vs_winks"] = (p["winks_skill"] - p["model_rank"]) if p["winks_skill"] else None
        p["delta_vs_adp"] = (p["adp"] - p["model_rank"]) if p["adp"] else None

    # conviction flags (1.5x Winks weight: winks threshold 12 vs ecr 15)
    for p in board:
        de, dw = p["delta_vs_ecr"], p["delta_vs_winks"]
        flag = None
        if (de is not None and abs(de) >= 15) or (dw is not None and abs(dw) >= 12):
            score_up = (de or 0) + 1.5 * (dw or 0) > 0
            drivers = []
            if p["b_opportunity"] > 0.5: drivers.append("usage")
            if p["b_market"] > 0.5: drivers.append("vegas")
            if p["b_regression"] > 0.5: drivers.append("xFP regression")
            if p["b_situation"] > 0.5: drivers.append("situation")
            if not p["has_metrics"]:
                flag = "DISAGREE-INVESTIGATE"
            elif score_up:
                flag = "SMASH VALUE" if (p["b_market"] > 0.25 or p["b_opportunity"] > 0.75) and min(x for x in (de, dw) if x is not None) > 0 else "MILD VALUE"
            else:
                flag = "FADE"
            p["conviction_drivers"] = drivers
        p["conviction_flag"] = flag

    # ---- PLAYR score (0-100, 50 = positional average) + Target/Value/Fade vs ADP ----
    # Classified on POSITIONAL rank deltas: comparing overall ranks would just re-discover
    # the market's structural positional pricing (cheap QBs/TEs, elite-RB scarcity premium).
    # adp_pos_rank was assigned before the PPG objective so it can also feed edge PPG.
    # raw (un-anchored) positional ranks drive the edge classification: published ranks stay
    # consensus-anchored, but Target/Value/Fade reflects what the MODEL's evidence says vs ADP
    for pos in ("QB", "RB", "WR", "TE"):
        grp = sorted([p for p in board if p["pos"] == pos], key=lambda x: -x.get("model_score_raw", 0))
        for i, p in enumerate(grp, 1): p["raw_pos_rank"] = i
    for p in board:
        p["playr_score"] = round(max(0.0, min(100.0, 50 + 20 * p["pos_score"])), 1)
        apr = p.get("adp_pos_rank")
        d = (apr - p["raw_pos_rank"]) if apr else None
        p["pos_delta_vs_adp"] = d
        conviction_up = p["b_market"] > 0.25 or p["b_opportunity"] > 0.75 or p["b_regression"] > 0.5
        # thresholds scale with positional draft slot: +4 at RB3 is seismic, at RB40 it's noise
        base = apr or 30
        t_target, t_value, t_fade = max(4, 0.35 * base), max(2, 0.10 * base), max(5, 0.45 * base)
        u_known = sum(1 for v in p["usage"].values() if v is not None and v != []) if p["has_metrics"] else 0
        if d is None or not p["has_metrics"] or u_known <= 3:
            cls = "Fair"  # no/thin research data -> no edge claim, in either direction
        elif d >= t_target or (d >= 0.7 * t_target and conviction_up):
            cls = "Target"
        elif d >= t_value:
            cls = "Value"
        elif d <= -t_fade:
            cls = "Fade"
        else:
            cls = "Fair"
        # agreement rule: a label may not contradict the published rank (a player we PUBLISH
        # above his positional ADP cannot simultaneously be a "Fade", and vice versa)
        if apr is not None:
            if cls == "Fade" and p["model_pos_rank"] <= apr:
                cls = "Fair"
            elif cls in ("Target", "Value") and p["model_pos_rank"] > apr:
                cls = "Fair"
        p["classification"] = cls

    # ---- insights + summary (deterministic, no AI spend) ----
    metrics_store = {}
    try:
        metrics_store = json.load(open(f"{SCRATCH}/player_metrics.json"))
    except FileNotFoundError:
        pass
    for p in board:
        ins = []
        e, u, inj = p["env"], p["usage"], p["injury"]
        pos = p["pos"]
        s = p["sent"] or {}
        if s.get("specificity") == "specific" and s.get("role_language") in ("locked_starter", "clear_lead"):
            ins.append(f"coaches on record: {s.get('role_language','').replace('_',' ')}"
                       + (f" — {s['key_quote'][:110]}" if s.get("key_quote") else ""))
        elif s.get("specificity") == "generic" and (s.get("coach_sentiment") or 0) > 0:
            ins.append("positive coach talk but no concrete role statement — August optimism, not signal")
        if s.get("red_flags"): ins.append(f"caution: {s['red_flags'][:110]}")
        sp = p["sp"] or {}
        if sp.get("p90"):
            ins.append(f"ceiling: {sp['p90']} half-PPR at his 90th-percentile week, "
                       f"{sp['spike_weeks']}/{sp['games']} spike games (best {sp['best']})")
        if p.get("split_boost_note"): ins.append(p["split_boost_note"])
        traj = p["wa"].get("trajectory")
        if traj is not None and traj >= 3:
            ins.append(f"closed 2025 hot: {p['wa']['last5_ppg']} half-PPR/g over his last 5 (season {p['wa']['ppg']})")
        pp = p["wa"].get("playoff_ppg")
        if pp is not None and p["wa"].get("playoff_games", 0) >= 2 and p["wa"].get("ppg") is not None and pp - p["wa"]["ppg"] >= 4:
            ins.append(f"playoff surge: {pp} half-PPR/g across {p['wa']['playoff_games']} postseason games")
        if p.get("team") and e:
            vac_t, vac_c = f(e.get("vacated_target_pct")) or 0, f(e.get("vacated_opportunity_pct")) or 0
            if pos in ("WR", "TE") and vac_t >= 30:
                ins.append(f"{e['team']} has {int(f(e.get('vacated_targets')) or 0)} vacated targets ({vac_t:.0f}%) — target vacuum")
            if pos == "RB" and vac_c >= 30:
                ins.append(f"{e['team']} vacated {int(f(e.get('vacated_rb_carries')) or 0)} RB carries ({vac_c:.0f}%) — touch expansion spot")
            if (e.get("new_hc") or e.get("new_oc")) and (f(e.get("epa_per_play_2025")) or 0) < -0.05:
                ins.append("new play-caller on a bottom-tier 2025 offense — scheme-reset upside")
        fpx = f(u.get("fp_minus_xfp"))
        if fpx is not None and fpx >= 1.5: ins.append(f"scored {fpx:+.1f} FP/g over expected — TD regression risk")
        elif fpx is not None and fpx <= -1.5: ins.append(f"scored {fpx:+.1f} FP/g under expected — positive regression buy")
        soft = f(inj.get("soft_tissue_events_2yr")) or 0
        if soft >= 2: ins.append(f"{int(soft)} soft-tissue injuries in 2 yrs — highest re-injury class")
        if p["injury_status"] in ("IR", "PUP", "DNR"): ins.append(f"currently {p['injury_status']} — verify camp status before drafting")
        age = p["age"] or 0
        if pos == "RB" and age >= 28: ins.append(f"age-{int(age)} RB — on the wrong side of the cliff")
        elif pos == "WR" and age >= 31: ins.append(f"age-{int(age)} WR — decline window")
        if pos == "WR" and p["years_exp"] in (1, 2) and p.get("b_efficiency", 0) > 0.4:
            ins.append("year-2/3 WR with efficiency flashes — historical breakout window")
        if p["competition"] == "HIGH": ins.append("crowded touch pool — market prices real competition on this roster")
        elif p["_comp_score"] < 0.3 and (p.get("team_changed") or p["rookie"] or (f(p["env"].get("vacated_opportunity_pct" if p["pos"]=="RB" else "vacated_target_pct")) or 0) >= 25):
            ins.append("clear runway — no priced competition for these touches")
        if p["trending"] >= 5000: ins.append(f"{int(p['trending']):,} Sleeper adds in 72h — market moving now")
        if p.get("contingency_note"): ins.append(p["contingency_note"])
        if p["rookie"]: ins.append("rookie — priced on situation + draft capital, not 2025 stats")
        if p["classification"] == "Target" and p.get("b_opportunity", 0) > 0.5:
            ins.insert(0, "usage profile the market hasn't repriced — role is better than the ADP")
        if p["classification"] == "Fade" and p.get("b_market", 0) < -0.3:
            ins.append("Vegas projects less production than the ADP implies")
        p["insights"] = " • ".join(ins[:4]) if ins else "no notable signals — profile is what it looks like"

        adp = f"{p['adp']:.0f}" if p["adp"] else "n/a"
        ecr = f"#{int(p['ecr'])}" if p["ecr"] else "n/a"
        wnk = f"#{int(p['winks_skill'])}" if p["winks_skill"] else "outside top-300"
        proj = f" | proj {p['proj_ppg']} ppg" if p.get("proj_ppg") is not None else ""
        p["player_summary"] = (f"Model #{p['model_rank']} ({pos}{p['model_pos_rank']}, Tier {p['tier']}) | "
                               f"PLAYR {p['playr_score']}{proj} | ADP {adp} | ECR {ecr} | Winks {wnk} | "
                               f"{p['classification']} | data: {p['confidence']}")

    json.dump([{k: v for k, v in p.items() if k not in ("env", "usage", "props", "injury", "notes")} for p in board],
              open(f"{SCRATCH}/board.json", "w"), indent=1)
    return board

if __name__ == "__main__":
    board = build()
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    print(f"{'MR':<4}{'Player':<24}{'Pos':<4}{'Tm':<4}{'score':<7}{'VOR':<7}{'T':<3}{'ECR':<5}{'Wnk':<5}{'ADP':<6}{'dECR':<6}{'flag'}")
    for p in board[:n]:
        print(f"{p['model_rank']:<4}{p['player']:<24}{p['pos']:<4}{p['team']:<4}"
              f"{p['pos_score']:<7.2f}{p['vor']:<7.2f}{p['tier']:<3}"
              f"{str(int(p['ecr']) if p['ecr'] else '-'):<5}{str(int(p['winks_skill']) if p['winks_skill'] else '-'):<5}"
              f"{str(p['adp'] or '-'):<6}{str(int(p['delta_vs_ecr']) if p['delta_vs_ecr'] is not None else '-'):<6}"
              f"{p['conviction_flag'] or ''}")
