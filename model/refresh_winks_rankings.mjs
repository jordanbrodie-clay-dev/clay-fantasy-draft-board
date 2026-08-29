#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const modelDir = path.dirname(new URL(import.meta.url).pathname);
const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error("Usage: node model/refresh_winks_rankings.mjs <downloaded-yahoo-widget.jsonp>");
}

const raw = fs.readFileSync(inputPath, "utf8").trim();
const prefix = "FPW.rankingsCB(";
if (!raw.startsWith(prefix) || !raw.endsWith(");")) {
  throw new Error("Expected the JSONP response embedded by Hayden Winks' Yahoo rankings hub.");
}

const payload = JSON.parse(raw.slice(prefix.length, -2));
const rankings = {
  meta: {
    source: "Hayden Winks' Yahoo Sports half-PPR rankings hub",
    source_url: "https://sports.yahoo.com/fantasy/article/2026-fantasy-football-rankings-hayden-winks-200458512.html",
    embedded_expert: payload.expert_names?.["7666"] ?? "Hayden Winks",
    scoring: payload.scoring,
    last_updated: payload.expert_pub?.["7666"] ?? payload.last_updated,
    count: payload.count,
  },
  players: payload.players.map((player) => ({
    player: player.player_name,
    team: player.player_team_id,
    pos: player.player_position_id,
    rank: Number(player.experts?.["7666"] ?? player.rank_ecr),
  })),
};

const outputPath = path.join(modelDir, "data", "winks_yahoo_2026.json");
fs.writeFileSync(outputPath, `${JSON.stringify(rankings, null, 2)}\n`);
console.log(`Saved ${rankings.players.length} Winks half-PPR rankings updated ${rankings.meta.last_updated}.`);
