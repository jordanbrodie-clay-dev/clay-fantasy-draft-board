#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const dataDir = path.join(root, "model", "data");
const replacementRanks = { QB: 16, RB: 30, WR: 36, TE: 12 };
const positions = Object.keys(replacementRanks);

const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, "board.js"), "utf8"), context);

// board.js also carries lightweight K/DST market rows for the simulator. Those
// specialists deliberately bypass the research scorer and are re-added later by
// optimize_draft_board.mjs.
const baseline = context.window.BOARD.filter((player) => positions.includes(player.p) && !player.spec);
const market = JSON.parse(fs.readFileSync(path.join(dataDir, "fantasypros_ecr_2026.json"), "utf8"));
const research = JSON.parse(fs.readFileSync(path.join(dataDir, "player_metrics.json"), "utf8"));
const sentiment = JSON.parse(fs.readFileSync(path.join(dataDir, "sentiment_2026.json"), "utf8"));
const manifestPath = process.argv[2] ?? path.join(dataDir, "refresh_manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const roleAdjustment = {
  locked_starter: 0.25,
  clear_lead: 0.20,
  featured_role: 0.10,
  competing: -0.05,
  rotational: -0.15,
  buried: -0.30,
  no_signal: 0,
};

function normalize(name) {
  return name.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function excerpt(value, maxWords = 20) {
  if (typeof value !== "string") return value;
  const words = value.trim().split(/\s+/);
  return words.length > maxWords ? `${words.slice(0, maxWords).join(" ")}…` : value;
}

function zScores(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  return values.map((value) => sd ? (value - mean) / sd : 0);
}

function fitLogCurve(rows) {
  const points = rows.map((row) => ({
    rank: row.bpr ?? row.pr,
    ppg: row.bpj ?? row.pj,
  })).filter((row) => Number.isFinite(row.rank) && Number.isFinite(row.ppg));
  const xs = points.map((row) => Math.log(row.rank));
  const ys = points.map((row) => row.ppg);
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const numerator = xs.reduce((sum, value, index) => sum + (value - xMean) * (ys[index] - yMean), 0);
  const denominator = xs.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
  const b = numerator / denominator;
  return { a: yMean - b * xMean, b };
}

const marketByName = new Map(market.players.map((player) => [normalize(player.player), player]));
const manifestByName = new Map(manifest.map((player) => [normalize(player.player), player]));
const curves = Object.fromEntries(
  positions.map((position) => [position, fitLogCurve(baseline.filter((player) => player.p === position))]),
);

const players = baseline.map((player) => {
  const manifestPlayer = manifestByName.get(normalize(player.n));
  const id = manifestPlayer?.sportradar_id;
  const ecr = marketByName.get(normalize(player.n));
  const freshSentiment = sentiment[id];
  const freshResearch = research[id];

  return {
    ...player,
    id,
    baseScore: player.bs ?? player.s,
    basePositionRank: player.bpr ?? player.pr,
    baseProjPpg: player.bpj ?? player.pj,
    baseInsight: player.bi ?? player.i,
    ecr: ecr?.ecr ?? player.ecr,
    t: ecr?.team || player.t,
    freshSentiment,
    freshResearch,
  };
});

for (const position of positions) {
  const group = players.filter((player) => player.p === position);
  // Always score from the immutable pre-refresh model input. Using the last
  // exported score here would compound ECR and sentiment on every rebuild.
  const oldScoreZ = zScores(group.map((player) => player.baseScore));
  const ecrOrdered = [...group].sort((a, b) => a.ecr - b.ecr);
  const ecrPositionRank = new Map(ecrOrdered.map((player, index) => [player.id, index + 1]));
  const ecrZ = zScores(group.map((player) => -Math.log(ecrPositionRank.get(player.id))));

  group.forEach((player, index) => {
    const sent = player.freshSentiment;
    const sentimentSignal = sent?.specificity === "specific"
      ? (roleAdjustment[sent.role_language] ?? 0)
      : 0;
    player.positionSignal = 0.75 * oldScoreZ[index] + 0.25 * ecrZ[index] + sentimentSignal;
    player.sentimentSignal = sentimentSignal;
  });

  // Preserve Jordan's explicit Burden-over-Odunze judgment after the data-driven sort.
  const ordered = [...group].sort((a, b) => b.positionSignal - a.positionSignal);
  if (position === "WR") {
    const burden = ordered.find((player) => player.n === "Luther Burden");
    const odunzeIndex = ordered.findIndex((player) => player.n === "Rome Odunze");
    if (burden && odunzeIndex >= 0) {
      ordered.splice(ordered.indexOf(burden), 1);
      ordered.splice(odunzeIndex, 0, burden);
    }
  }

  let tier = 1;
  ordered.forEach((player, index) => {
    if (index && ordered[index - 1].positionSignal - player.positionSignal > 0.4) tier += 1;
    player.pr = index + 1;
    player.ti = tier;
    player.s = Math.round(Math.max(0, Math.min(100, 50 + 20 * player.positionSignal)) * 10) / 10;
  });

  const curve = curves[position];
  const replacementPpg = curve.a + curve.b * Math.log(replacementRanks[position]);
  const expected = ordered.map((player) => curve.a + curve.b * Math.log(player.pr));
  const mean = expected.reduce((sum, value) => sum + value, 0) / expected.length;
  const sd = Math.sqrt(expected.reduce((sum, value) => sum + (value - mean) ** 2, 0) / expected.length);

  ordered.forEach((player, index) => {
    const ppg = expected[index];
    player.pj = Math.round(ppg * 10) / 10;
    player.rp = Math.round(replacementPpg * 10) / 10;
    player.psd = Math.round(sd * 1000) / 1000;
    player.zv = Math.round(((ppg - replacementPpg) / sd) * 10000) / 10000;
  });
}

players.sort((a, b) => b.zv - a.zv || a.ecr - b.ecr);
players.forEach((player, index) => { player.r = index + 1; });

const board = players.map((player) => {
  const sent = player.freshSentiment ?? {};
  const researchPacket = player.freshResearch ?? {};
  const recovery = researchPacket.injury?.current_recovery_note;
  const freshInsight = [
    sent.red_flags ? `camp caution: ${sent.red_flags}` : null,
    recovery ? `recovery: ${recovery}` : null,
    player.baseInsight,
  ].filter(Boolean).join(" • ");

  return {
    model_rank: player.r,
    player: player.n,
    pos: player.p,
    team: player.t,
    model_pos_rank: player.pr,
    tier: player.ti,
    playr_score: player.s,
    base_playr_score: player.baseScore,
    base_position_rank: player.basePositionRank,
    base_proj_ppg: player.baseProjPpg,
    classification: player.c,
    adp: player.adp,
    ecr: player.ecr,
    winks_skill: player.wk,
    proj_ppg: player.pj,
    replacement_ppg: player.rp,
    position_ppg_sd: player.psd,
    z_vor: player.zv,
    edge_pts_per_game: player.ep,
    confidence: player.cf,
    sp: { p90: player.p90, spike_weeks: player.sw, games: player.g, best: player.bw },
    wa: { ppg: player.ppg },
    contingency_ppg: player.cont,
    sent: {
      role_language: sent.role_language ?? player.rl,
      specificity: sent.specificity ?? null,
      key_quote: excerpt(sent.key_quote ?? player.sq),
      hype_check: sent.hype_check ?? player.hc,
      red_flags: sent.red_flags ?? null,
      coach_sentiment: sent.coach_sentiment ?? null,
      sources: sent.sources ?? null,
      refresh_status: sent.refresh_status ?? "fallback",
    },
    base_insights: player.baseInsight,
    insights: freshInsight,
    draft_note: player.d,
    tag: player.tg,
    refresh: {
      research: researchPacket.refresh_status ?? "failed_fallback",
      sentiment: sent.refresh_status ?? "failed_fallback",
      sentiment_score_adjustment: player.sentimentSignal,
    },
  };
});

fs.writeFileSync(path.join(dataDir, "board.json"), `${JSON.stringify(board, null, 2)}\n`);
fs.writeFileSync(path.join(dataDir, "rank_curves.json"), `${JSON.stringify({
  replacement_ranks: replacementRanks,
  curves,
  objective: "(expected_ppg - replacement_ppg) / position_ppg_standard_deviation",
}, null, 2)}\n`);

console.log(`Rebuilt ${board.length} players. Top five: ${board.slice(0, 5).map((player) => `${player.player} (${player.z_vor.toFixed(2)}σ)`).join(", ")}`);
