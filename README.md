# Clay (Unofficial) Fantasy Football Draft Board

2026 half-PPR redraft board and simulator — player quality from Clay workflows, market cost from Sleeper, and live recommendations driven by roster construction and future availability.
By Jordan Brodie.

Static site, no build step: `index.html` + `board.js` (the scored dataset).
The source-controlled scoring and refresh pipeline lives in `model/`.

**Draft live from the board.** Configure league size, snake slot, starters, flex,
bench, K, and D/ST; simulate opponents to your next pick; and use the ordered
draft queue. State persists in localStorage, so a mid-draft refresh loses nothing.

## How the dataset was made

Three Clay workflows, authored from the command line with the Clay CLI:

1. **Player research** — per player: 2025 usage, efficiency, Vegas props, injury history. Each value carries a source URL.
2. **Team environment** — all 32 teams: Vegas win totals, O-line ranks, coaching changes, vacated carries and targets.
3. **Coach sentiment** — player news, beat reporting and direct coach quotes, graded for role language. Concrete role statements ("first-team reps") are separated from generic August coachspeak ("he's looked great"); only the specific kind moves a score.

Scoring: six weighted buckets (opportunity, production, situation, efficiency, market, regression) × a risk multiplier determine player quality within position. Standardized value above replacement is one input. The published Smart Rank is anchored to Sleeper ADP, while the live recommendation engine optimizes expected completed-roster value using current roster need, positional cliffs, and the probability each player survives to the user's next pick.

Backtested against five seasons of real preseason ADP (2020–2025).

## Columns worth knowing

- **Smart rank** — market-aware default rank. It respects Sleeper draft cost and applies only bounded adjustments for the model's within-position opinion.
- **Quality rank** — raw player-quality order before draft cost. Useful diagnostically; it is not an instruction to reach multiple rounds.
- **Value (σ)** — expected PPG above the position-specific replacement baseline, standardized by that position's expected-PPG spread.
- **Positional score** — how strong the profile is *versus his own position*. 50 = positional average.
- **Conf** — A–D grade for how much verified data supports the rank.

K and D/ST are intentionally simple: Sleeper half-PPR ADP, projected points for display, and a late-round defer rule. They do not run through the research or sentiment workflows.

Unofficial and just for fun. Not affiliated with the NFL.
