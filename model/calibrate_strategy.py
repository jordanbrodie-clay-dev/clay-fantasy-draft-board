#!/usr/bin/env python3
"""Build reproducible draft-strategy calibration from historical ADP + outcomes.

Inputs are intentionally external so the repository does not vendor large upstream
datasets. Fantasy Football Calculator supplies preseason PPR ADP distributions and
nflverse supplies regular-season stats. We evaluate half-PPR points per 17 scheduled
games, so injuries and missed games remain part of the draft outcome.

Example:
  python3 model/calibrate_strategy.py \
    --adp-pattern ../ffc_adp_{season}.json \
    --stats-pattern ../nflverse_season_{season}.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import statistics
import unicodedata
from collections import defaultdict
from datetime import date
from pathlib import Path

POSITIONS = ("QB", "RB", "WR", "TE")
REPLACEMENT_RANK = {"QB": 16, "RB": 30, "WR": 36, "TE": 12}
STARTER_RANK = {"QB": 12, "RB": 24, "WR": 30, "TE": 12}
ROUND_BUCKETS = ((1, 2), (3, 4), (5, 6), (7, 9), (10, 12), (13, 99))


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = "".join(char for char in value if not unicodedata.combining(char)).lower()
    value = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", value)
    return re.sub(r"[^a-z0-9]", "", value)


def number(value, default=0.0):
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else default
    except (TypeError, ValueError):
        return default


def percentile(values, probability):
    rows = sorted(values)
    if not rows:
        return None
    offset = (len(rows) - 1) * probability
    lower = math.floor(offset)
    upper = math.ceil(offset)
    if lower == upper:
        return rows[lower]
    return rows[lower] * (upper - offset) + rows[upper] * (offset - lower)


def rounded(value, digits=3):
    return None if value is None else round(value, digits)


def bucket_label(adp):
    draft_round = max(1, math.ceil(adp / 12))
    for low, high in ROUND_BUCKETS:
        if low <= draft_round <= high:
            return f"{low}-{high}" if high < 99 else "13+"
    return "13+"


def summarize(rows, starter_rank):
    if not rows:
        return {"n": 0}
    vors = [row["actual_vor_ppg"] for row in rows]
    ppgs = [row["effective_ppg"] for row in rows]
    return {
        "n": len(rows),
        "mean_effective_ppg": rounded(statistics.fmean(ppgs)),
        "mean_vor_ppg": rounded(statistics.fmean(vors)),
        "median_vor_ppg": rounded(statistics.median(vors)),
        "vor_sd": rounded(statistics.pstdev(vors)),
        "positive_vor_rate": rounded(sum(value > 0 for value in vors) / len(vors)),
        "starter_hit_rate": rounded(sum(row["actual_pos_rank"] <= starter_rank for row in rows) / len(rows)),
        "season_losing_rate": rounded(sum(value <= -1 for value in vors) / len(vors)),
    }


def load_outcomes(path):
    by_name = {}
    by_pos_team_last = defaultdict(list)
    with path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("season_type") != "REG" or row.get("position") not in POSITIONS:
                continue
            receptions = number(row.get("receptions"))
            half_points = number(row.get("fantasy_points")) + 0.5 * receptions
            item = {
                "name": row.get("player_display_name") or row.get("player_name"),
                "position": row["position"],
                "team": row.get("recent_team") or "",
                "games": int(number(row.get("games"))),
                # Per scheduled game measures the roster-slot result, not just games played.
                "effective_ppg": half_points / 17,
                "active_ppg": half_points / max(1, number(row.get("games"))),
            }
            by_name[(item["position"], normalize(item["name"]))] = item
            last = normalize(item["name"].split()[-1] if item["name"] else "")
            by_pos_team_last[(item["position"], item["team"], last)].append(item)
    return by_name, by_pos_team_last


def match_outcome(player, by_name, by_pos_team_last):
    key = (player["position"], normalize(player["name"]))
    if key in by_name:
        return by_name[key]
    last = normalize(player["name"].split()[-1])
    fallback = by_pos_team_last.get((player["position"], player.get("team") or "", last), [])
    return fallback[0] if len(fallback) == 1 else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seasons", default="2020,2021,2022,2023,2024")
    parser.add_argument("--adp-pattern", required=True)
    parser.add_argument("--stats-pattern", required=True)
    parser.add_argument("--output", default=str(Path(__file__).parent / "data" / "historical_calibration.json"))
    args = parser.parse_args()
    seasons = [int(value) for value in args.seasons.split(",")]

    all_rows = []
    folds = []
    replacement_by_season = {}
    availability_ratios = defaultdict(list)

    for season in seasons:
        adp_path = Path(args.adp_pattern.format(season=season))
        stats_path = Path(args.stats_pattern.format(season=season))
        adp_payload = json.loads(adp_path.read_text())
        by_name, by_pos_team_last = load_outcomes(stats_path)

        outcome_positions = defaultdict(list)
        for item in by_name.values():
            outcome_positions[item["position"]].append(item)
        replacements = {}
        ranks_by_name = {}
        for position in POSITIONS:
            ordered = sorted(outcome_positions[position], key=lambda row: row["effective_ppg"], reverse=True)
            replacements[position] = ordered[min(REPLACEMENT_RANK[position], len(ordered)) - 1]["effective_ppg"]
            for index, item in enumerate(ordered, 1):
                ranks_by_name[(position, normalize(item["name"]))] = index
        replacement_by_season[str(season)] = {pos: rounded(value) for pos, value in replacements.items()}

        matched = 0
        position_counts = defaultdict(int)
        for player in adp_payload.get("players", []):
            if player.get("position") not in POSITIONS or number(player.get("adp"), 999) > 216:
                continue
            outcome = match_outcome(player, by_name, by_pos_team_last)
            if not outcome:
                continue
            matched += 1
            position = player["position"]
            position_counts[position] += 1
            outcome_rank = ranks_by_name.get((position, normalize(outcome["name"])))
            row = {
                "season": season,
                "player": player["name"],
                "position": position,
                "adp": number(player["adp"]),
                "round_bucket": bucket_label(number(player["adp"])),
                "effective_ppg": outcome["effective_ppg"],
                "active_ppg": outcome["active_ppg"],
                "actual_pos_rank": outcome_rank,
                "actual_vor_ppg": outcome["effective_ppg"] - replacements[position],
            }
            all_rows.append(row)
            stdev = number(player.get("stdev"), None)
            if stdev and row["adp"] > 0:
                availability_ratios[position].append(stdev / math.sqrt(row["adp"]))

        folds.append({
            "season": season,
            "matched_players": matched,
            "drafts": int(number((adp_payload.get("meta") or {}).get("total_drafts"))),
            "players_by_position": dict(position_counts),
        })

    grouped = {position: {} for position in POSITIONS}
    for position in POSITIONS:
        for low, high in ROUND_BUCKETS:
            label = f"{low}-{high}" if high < 99 else "13+"
            rows = [row for row in all_rows if row["position"] == position and row["round_bucket"] == label]
            grouped[position][label] = summarize(rows, STARTER_RANK[position])

    output = {
        "meta": {
            "generated": date.today().isoformat(),
            "seasons": seasons,
            "fold_count": len(seasons),
            "scoring": "half-PPR points divided by 17 scheduled games",
            "objective": "expected PPG above replacement at position",
            "adp_source": "Fantasy Football Calculator PPR, 12-team drafts",
            "outcome_source": "nflverse seasonal player stats",
            "replacement_rank": REPLACEMENT_RANK,
            "starter_rank": STARTER_RANK,
        },
        "folds": folds,
        "replacement_ppg_by_season": replacement_by_season,
        "round_position_results": grouped,
        "availability": {
            position: {
                "n": len(values),
                "stdev_per_sqrt_adp_median": rounded(statistics.median(values)),
                "stdev_per_sqrt_adp_p75": rounded(percentile(values, 0.75)),
            }
            for position, values in availability_ratios.items()
        },
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, indent=2) + "\n")
    print(f"Wrote {output_path} from {len(all_rows)} matched player-seasons across {len(seasons)} folds.")
    for fold in folds:
        print(f"  {fold['season']}: {fold['matched_players']} matches / {fold['drafts']} drafts")


if __name__ == "__main__":
    main()
