#!/usr/bin/env python3
"""Export ../board.json (full model output) -> board.js (compact site dataset).
Also computes a single priority-ordered [tag] per player for quick scanning."""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "board.json")
OUT = os.path.join(HERE, "board.js")

def cut(s, n):
    """truncate on a word boundary so text never breaks mid-word"""
    if not s: return ""
    s = str(s).strip()
    if len(s) <= n: return s
    return s[:n].rsplit(" ", 1)[0].rstrip(" ,;·-•") + "…"

SEVERE_INJURY = {"IR", "PUP", "DNR", "OUT", "DOUBTFUL"}

def tag_for(p):
    """One priority-ordered tag: injury > rookie > team change > crowded role > value read."""
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
    out = []
    for p in b:
        s = p.get("sent") or {}
        sp = p.get("sp") or {}
        wa = p.get("wa") or {}
        out.append({
            "r": p["model_rank"], "n": p["player"], "p": p["pos"], "t": p["team"],
            "pr": p["model_pos_rank"], "ti": p["tier"], "s": p["playr_score"], "c": p["classification"],
            "adp": p["adp"], "ecr": p["ecr"], "wk": p["winks_skill"], "pj": p.get("proj_ppg"),
            "ep": p.get("edge_pts_per_game"), "cf": p["confidence"],
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
