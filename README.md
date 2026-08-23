# Clay (Unofficial) Fantasy Football Draft Board

2026 half-PPR redraft board — 200 players scored by a model built on Clay workflows.
By Jordan Brodie.

Static site, no build step: `index.html` + `board.js` (the scored dataset).
The source-controlled scoring and refresh pipeline lives in `model/`.

**Draft live from the board.** Mark players Taken or Mine, filter to Available,
and track your roster in the My team panel. State persists in localStorage,
so a mid-draft refresh loses nothing.

## How the dataset was made

Three Clay workflows, authored from the command line with the Clay CLI:

1. **Player research** — per player: 2025 usage, efficiency, Vegas props, injury history. Each value carries a source URL.
2. **Team environment** — all 32 teams: Vegas win totals, O-line ranks, coaching changes, vacated carries and targets.
3. **Coach sentiment** — player news, beat reporting and direct coach quotes, graded for role language. Concrete role statements ("first-team reps") are separated from generic August coachspeak ("he's looked great"); only the specific kind moves a score.

Scoring: six weighted buckets (opportunity, production, situation, efficiency, market, regression) × a risk multiplier determine each positional order, anchored to expert consensus. The overall board optimizes `(expected PPG - replacement PPG) / position PPG standard deviation`.

Backtested against five seasons of real preseason ADP (2020–2025).

## Columns worth knowing

- **Clay rank** — where to actually draft him. Cross-position order is standard deviations of expected PPG above replacement at position.
- **Value (σ)** — expected PPG above the position-specific replacement baseline, standardized by that position's expected-PPG spread.
- **Positional score** — how strong the profile is *versus his own position*. 50 = positional average.
- **Edge** — projected points per game above/below what his ADP slot historically returns.
- **Conf** — A–D grade for how much verified data supports the rank.

Unofficial and just for fun. Not affiliated with the NFL.
