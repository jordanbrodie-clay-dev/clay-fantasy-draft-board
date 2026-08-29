# Clay (Unofficial) Fantasy Football Draft Board

2026 half-PPR redraft board and simulator — player quality from Clay workflows, market cost from Sleeper, and live recommendations driven by roster construction and future availability.
By Jordan Brodie.

Static site, no build step: `index.html` + `board.js` (the scored dataset).
The source-controlled scoring and refresh pipeline lives in `model/`.

**Draft live from the board.** Configure league size, snake slot, starters, flex,
bench, K, and D/ST; simulate opponents to your next pick; and use the ordered
draft queue. State persists in localStorage, so a mid-draft refresh loses nothing.
Default one-QB leagues spend one roster spot at quarterback. A second tight end is
eligible only when his value is elite enough for the FLEX; customized multi-QB or
multi-TE settings still fill every configured starter. When remaining selections
equal unfilled starters, the engine reserves those picks for the open positions.
Simulations are reversible previews: exit to restore the exact pre-simulation draft
and queue, or draft players at each simulated turn and keep the generated scenario.
The compact strategy bar includes the current recommendation as a one-click draft
action and shows exactly how many opponent picks and user picks the preview contains.
When planning ahead, that action can lock a player at the upcoming user pick while
simulating the intervening selections without allowing an opponent to take him.
Taken and My Team remain manual toggles outside simulation. Individual hard fades
persist, disappear from the board and recommendations, and can be restored through
the Hidden filter.
The strategy room defaults to a compact summary bar and expands on demand. Position
visibility is multi-select and persistent, so QB/TE or any other positions can be
hidden from both the table and live recommendations. Desktop table headers remain
pinned below the sticky controls while the board scrolls.

## How the dataset was made

Three Clay workflows, authored from the command line with the Clay CLI:

1. **Player research** — per player: 2025 usage, efficiency, Vegas props, injury history. Each value carries a source URL.
2. **Team environment** — all 32 teams: Vegas win totals, O-line ranks, coaching changes, vacated carries and targets.
3. **Coach sentiment** — player news, beat reporting and direct coach quotes, graded for role language. Concrete role statements ("first-team reps") are separated from generic August coachspeak ("he's looked great"); only the specific kind moves a score.

Scoring: six weighted buckets (opportunity, production, situation, efficiency, market, regression) × a risk multiplier determine player quality within position. Standardized value above replacement is one input. The published Smart Rank is anchored to Sleeper ADP. Live recommendations start with the best available Smart Rank. Future availability may normally override BPA only inside three rank spots and only when both scarcity and decision-score advantages clear explicit thresholds. From round four onward, an unfilled starter facing a strong measured two-turn tier cliff can widen that bound to at most one league round; acquisition-window penalties still prevent early QB/TE reaches. Early RB/WR depth retains meaningful value, so BPA builds such as three early running backs are supported rather than treated as roster mistakes.

Calibrated against five completed seasons of real preseason ADP and outcomes (2020–2024; 851 matched player-seasons).

## Columns worth knowing

- **Smart rank** — market-aware default rank. It blends Sleeper and ECR with a 1.5× Winks anchor, then applies only bounded adjustments for the model's within-position opinion.
- **Quality rank** — raw player-quality order before draft cost. Useful diagnostically; it is not an instruction to reach multiple rounds.
- **Value (σ)** — expected PPG above the position-specific replacement baseline, standardized by that position's expected-PPG spread.
- **Positional score** — how strong the profile is *versus his own position*. 50 = positional average.
- **Conf** — A–D grade for how much verified data supports the rank.

K and D/ST are intentionally simple: Sleeper half-PPR ADP, projected points for display, and a late-round defer rule. They do not run through the research or sentiment workflows.

Unofficial and just for fun. Not affiliated with the NFL.
