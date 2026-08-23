#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const modelDir = path.dirname(new URL(import.meta.url).pathname);
const dataDir = path.join(modelDir, "data");
const board = JSON.parse(fs.readFileSync(path.join(dataDir, "board.json"), "utf8"));
const sleeper = JSON.parse(fs.readFileSync(path.join(dataDir, "sleeper_market_2026.json"), "utf8"));
const fantasyPros = JSON.parse(fs.readFileSync(path.join(dataDir, "fantasypros_ecr_2026.json"), "utf8"));
const historical = JSON.parse(fs.readFileSync(path.join(dataDir, "historical_calibration.json"), "utf8"));

function normalize(name) {
  return name.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const sleeperByName = new Map(sleeper.players.map((player) => [normalize(player.player), player]));
const fpByName = new Map(fantasyPros.players.map((player) => [normalize(player.player), player]));
const marketPosRanks = new Map();
for (const pos of ["QB", "RB", "WR", "TE"]) {
  sleeper.players.filter((player) => player.pos === pos).sort((a, b) => a.adp - b.adp)
    .forEach((player, index) => marketPosRanks.set(`${pos}:${normalize(player.player)}`, index + 1));
}

function validRank(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function weightedConsensus(sources) {
  const usable = sources.filter(([value]) => validRank(value) != null);
  return usable.reduce((sum, [value, weight]) => sum + Number(value) * weight, 0)
    / usable.reduce((sum, [, weight]) => sum + weight, 0);
}

function historicalBucket(position, pick) {
  const draftRound = Math.max(1, Math.ceil(pick / 12));
  const label = draftRound <= 2 ? "1-2"
    : draftRound <= 4 ? "3-4"
      : draftRound <= 6 ? "5-6"
        : draftRound <= 9 ? "7-9"
          : draftRound <= 12 ? "10-12" : "13+";
  return historical.round_position_results?.[position]?.[label] ?? null;
}

const skillPlayers = board.map((player) => {
  const market = sleeperByName.get(normalize(player.player));
  const fp = fpByName.get(normalize(player.player));
  const adp = market?.adp ?? player.adp ?? player.ecr;
  // Winks is the user's preferred expert anchor, so it receives the same 1.5x
  // weight used by the recovered scoring model. Sleeper remains the availability
  // distribution: consensus says when a player is worth buying; Sleeper says how
  // likely the room is to let him get there.
  const consensusPick = weightedConsensus([
    [adp, 1],
    [player.ecr, 1],
    [player.winks_skill, 1.5],
  ]);
  const marketPosRank = marketPosRanks.get(`${player.pos}:${normalize(player.player)}`) ?? player.model_pos_rank;
  const positionalEdge = marketPosRank - player.model_pos_rank;
  const reachWindow = Math.min(10, Math.max(1.5, consensusPick * 0.08));
  const valueAdjustment = reachWindow * Math.tanh(positionalEdge / 3);
  const smartPick = Math.max(1, consensusPick - valueAdjustment);
  const fpSpread = Number(fp?.rank_std_dev);
  const historicalSpread = historical.availability?.[player.pos]?.stdev_per_sqrt_adp_p75 ?? 1;
  const availabilitySd = Math.max(3.5, Number.isFinite(fpSpread) ? fpSpread : Math.sqrt(adp) * historicalSpread);
  const history = historicalBucket(player.pos, smartPick);
  const buyEarly = Math.max(1, smartPick - Math.max(2, availabilitySd * 0.55));
  const buyLate = smartPick + Math.max(2, availabilitySd * 0.45);

  return {
    ...player,
    player_id: `p-${slug(player.player)}-${slug(player.team)}`,
    quality_rank: player.model_rank,
    sleeper_adp: Math.round(adp * 10) / 10,
    consensus_pick: Math.round(consensusPick * 10) / 10,
    market_pos_rank: marketPosRank,
    availability_sd: Math.round(availabilitySd * 10) / 10,
    smart_pick: Math.round(smartPick * 10) / 10,
    buy_early: Math.round(buyEarly * 10) / 10,
    buy_late: Math.round(buyLate * 10) / 10,
    historical_hit_rate: history?.starter_hit_rate ?? null,
    historical_vor_ppg: history?.mean_vor_ppg ?? null,
    historical_sample: history?.n ?? null,
    market_source: market ? "Sleeper" : "fallback",
  };
});

const specialists = sleeper.players
  .filter((player) => ["K", "DEF"].includes(player.pos))
  .map((player, index, rows) => {
    const posRows = rows.filter((row) => row.pos === player.pos);
    const posRank = posRows.findIndex((row) => row.sleeper_id === player.sleeper_id) + 1;
    const projectedPpg = player.projected_season_points ? player.projected_season_points / 17 : null;
    return {
      model_rank: 1000 + index,
      player_id: `s-${slug(player.sleeper_id)}`,
      player: player.player,
      pos: player.pos,
      team: player.team,
      model_pos_rank: posRank,
      tier: Math.ceil(posRank / 6),
      playr_score: null,
      classification: "Fair",
      adp: player.adp,
      sleeper_adp: player.adp,
      ecr: null,
      winks_skill: null,
      proj_ppg: projectedPpg == null ? null : Math.round(projectedPpg * 10) / 10,
      replacement_ppg: projectedPpg == null ? null : Math.round(projectedPpg * 10) / 10,
      position_ppg_sd: null,
      z_vor: 0,
      edge_pts_per_game: null,
      confidence: "B",
      sp: {},
      wa: {},
      sent: {},
      insights: player.pos === "K"
        ? "Simple specialist ranking from Sleeper half-PPR ADP. Defer kicker until the final rounds unless league settings force the slot earlier."
        : "Simple specialist ranking from Sleeper half-PPR ADP. Draft late and treat the position as streamable unless the market presents unusual value.",
      draft_note: "Sleeper ADP only; no research or sentiment premium.",
      tag: null,
      quality_rank: null,
      market_pos_rank: posRank,
      availability_sd: Math.round(Math.max(7, Math.sqrt(player.adp) * 1.35) * 10) / 10,
      smart_pick: player.adp,
      consensus_pick: player.adp,
      buy_early: player.adp,
      buy_late: player.adp,
      historical_hit_rate: null,
      historical_vor_ppg: null,
      historical_sample: null,
      market_source: "Sleeper",
      specialist: true,
    };
  });

const optimized = [...skillPlayers, ...specialists]
  .sort((a, b) => a.smart_pick - b.smart_pick || (b.z_vor ?? 0) - (a.z_vor ?? 0));
optimized.forEach((player, index) => { player.smart_rank = index + 1; });

fs.writeFileSync(path.join(dataDir, "draft_board.json"), `${JSON.stringify(optimized, null, 2)}\n`);
console.log(`Built a ${optimized.length}-player market-aware draft board. Top 10: ${optimized.slice(0, 10).map((player) => player.player).join(", ")}`);
