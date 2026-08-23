# Ranking model

The cross-position player-quality metric is:

```text
z_vor = (expected_ppg - replacement_ppg_at_position) / sd(expected_ppg_at_position)
```

Replacement ranks are QB16, RB30, WR36, and TE12. Expected half-PPR PPG is produced from position-rank log curves calibrated on 2024–2025 actual scoring. The denominator is the population standard deviation of expected PPG among the board's players at that position.

This makes player quality comparable across positions. It is deliberately **not** the final draft order. Expert consensus, quantitative research, and specific (not generic) coach-role language determine the order within each position; Sleeper cost and the draft optimizer decide when that quality should be purchased.

## Draft optimization

`optimize_draft_board.mjs` creates the market-aware static board. It blends Sleeper ADP, ECR, and Winks (weighted 1.5×), then makes a bounded adjustment when the model and market disagree within a position. Sleeper remains the availability distribution. This keeps Josh Allen's QB1 quality visible without presenting him as a first-round pick.

`draft-engine.js` handles live decisions. For every candidate it estimates:

1. The conditional probability the player survives to the user's next snake pick.
2. The expected best alternative at the same position at that future pick.
3. The standardized position-value drop caused by waiting.
4. Whether the current roster still needs a starter, flex option, or only bench depth.

Position-drop urgency is the main decision signal; raw player quality is only a tiebreaker. K and D/ST use Sleeper ADP and are strongly deferred until the final three rounds unless roster settings require otherwise.

## Historical calibration

`calibrate_strategy.py` joins Fantasy Football Calculator preseason PPR ADP to nflverse regular-season outcomes for five completed folds (2020–2024). The committed calibration contains 851 matched player-seasons. Outcomes use half-PPR points divided by 17 scheduled games so missed time remains part of the draft result. It estimates position-by-round starter hit rates and position-specific ADP dispersion; those priors inform acquisition windows and future availability while current player projections still drive the decision.

## Refresh pipeline

1. Run the Clay `Player Research 2026` and `Player Sentiment 2026` workflows over `refresh_manifest.json`.
2. Import their bulk JSONL output with `import_workflow_results.mjs`.
3. Download the current FantasyPros half-PPR rankings page and parse it with `refresh_market_data.mjs`.
4. Download Sleeper projections/ADP and player metadata, then run `refresh_sleeper_market.mjs`.
5. Run `rebuild_board.mjs`, `optimize_draft_board.mjs`, and then `../export_web.py`.

`score_model.py` is the recovered full scoring engine. It uses the same standardized above-replacement objective when all original raw feature layers are available. `rebuild_board.mjs` is the source-controlled refresh path for the published compact board.

The Aug. 22 refresh completed 179/200 research packets and 180/200 sentiment packets. Failed source lookups remain explicit in `workflow_refresh_report.json`; the board falls back conservatively rather than inventing values.
