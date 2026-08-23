#!/usr/bin/env python3
"""Export ../board.json (full model output) -> board.js (compact site dataset).
Also computes a single priority-ordered [tag] per player for quick scanning."""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.environ.get("FANTASY_BOARD_JSON", os.path.join(HERE, "model", "data", "board.json"))
OUT = os.path.join(HERE, "board.js")

def cut(s, n):
    """truncate on a word boundary so text never breaks mid-word"""
    if not s: return ""
    s = str(s).strip()
    if len(s) <= n: return s
    return s[:n].rsplit(" ", 1)[0].rstrip(" ,;·-•") + "…"

SEVERE_INJURY = {"IR", "PUP", "DNR", "OUT", "DOUBTFUL"}

def apply_overrides(players):
    """Preserve the model's strict standardized-VOR ordering in the web export."""
    order = sorted(players, key=lambda p: p["model_rank"])
    pos_seen = {}
    for i, p in enumerate(order, 1):
        p["_rank_web"] = i
        pos_seen[p["pos"]] = pos_seen.get(p["pos"], 0) + 1
        p["_pos_rank_web"] = pos_seen[p["pos"]]
    return order

def tag_for(p):
    """One priority-ordered tag: injury > rookie > team change > crowded role > value read."""
    if p.get("tag"):
        return p["tag"]
    inj = (p.get("injury_status") or "").strip().upper()
    if inj in SEVERE_INJURY:
        return "Injured"
    if inj == "QUESTIONABLE":
        return "Injury risk"
    if p.get("rookie"):
        return "Rookie"
    if p.get("team_changed"):
        return "New team"
    if p.get("competition") == "HIGH":
        return "Crowded role"
    c = p.get("classification")
    if c == "Target":
        return "High value"
    if c == "Fade":
        return "Fade risk"
    if c == "Value":
        return "Sleeper"
    return None

def main():
    b = json.load(open(SRC))
    b = apply_overrides(b)
    out = []
    for p in b:
        s = p.get("sent") or {}
        sp = p.get("sp") or {}
        wa = p.get("wa") or {}
        out.append({
            "r": p["_rank_web"], "n": p["player"], "p": p["pos"], "t": p["team"],
            "pr": p["_pos_rank_web"], "ti": p["tier"], "s": p["playr_score"], "c": p["classification"],
            "adp": p["adp"], "ecr": p["ecr"], "wk": p["winks_skill"], "pj": p.get("proj_ppg"),
            "ep": p.get("edge_pts_per_game"), "cf": p["confidence"],
            "zv": p.get("z_vor"), "rp": p.get("replacement_ppg"), "psd": p.get("position_ppg_sd"),
            "p90": sp.get("p90"), "sw": sp.get("spike_weeks"), "g": sp.get("games"), "bw": sp.get("best"),
            "ppg": wa.get("ppg"), "cont": p.get("contingency_ppg"),
            "rl": s.get("role_language"), "sq": cut(s.get("key_quote"), 260) or None,
            "hc": cut(s.get("hype_check"), 200) or None,
            "i": cut(p["insights"], 280), "d": cut(p.get("draft_note"), 150),
            "tg": tag_for(p),
        })
    with open(OUT, "w") as f:
        f.write("window.BOARD=" + json.dumps(out, separators=(",", ":")) + ";")
    tagged = sum(1 for x in out if x["tg"])
    print(f"wrote {len(out)} players to board.js ({tagged} tagged)")
    from collections import Counter
    print("tag distribution:", dict(Counter(x["tg"] for x in out if x["tg"])))

if __name__ == "__main__":
    main()
