# Ranking model

The cross-position draft objective is:

```text
z_vor = (expected_ppg - replacement_ppg_at_position) / sd(expected_ppg_at_position)
```

Replacement ranks are QB16, RB30, WR36, and TE12. Expected half-PPR PPG is produced from position-rank log curves calibrated on 2024–2025 actual scoring. The denominator is the population standard deviation of expected PPG among the board's players at that position.

This makes the final overall ordering comparable across positions. Expert consensus, quantitative research, and specific (not generic) coach-role language determine the order *within* each position; `z_vor` determines the order *across* positions.

## Refresh pipeline

1. Run the Clay `Player Research 2026` and `Player Sentiment 2026` workflows over `refresh_manifest.json`.
2. Import their bulk JSONL output with `import_workflow_results.mjs`.
3. Download the current FantasyPros half-PPR rankings page and parse it with `refresh_market_data.mjs`.
4. Run `rebuild_board.mjs` and then `../export_web.py`.

`score_model.py` is the recovered full scoring engine. It uses the same standardized above-replacement objective when all original raw feature layers are available. `rebuild_board.mjs` is the source-controlled refresh path for the published compact board.

The Aug. 22 refresh completed 179/200 research packets and 180/200 sentiment packets. Failed source lookups remain explicit in `workflow_refresh_report.json`; the board falls back conservatively rather than inventing values.
