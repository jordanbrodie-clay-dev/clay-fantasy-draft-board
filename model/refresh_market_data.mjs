#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const source = process.argv[2];
if (!source) throw new Error("Usage: node model/refresh_market_data.mjs <FantasyPros rankings HTML>");

const html = fs.readFileSync(source, "utf8");
const match = html.match(/var ecrData = (\{.*?\});\s*var /s)
  ?? html.match(/var ecrData = (\{.*?\});/s);
if (!match) throw new Error("FantasyPros ecrData payload was not found");

const payload = JSON.parse(match[1]);
const players = payload.players
  .filter((player) => ["QB", "RB", "WR", "TE"].includes(player.player_position_id))
  .map((player) => ({
    player: player.player_name,
    team: player.player_team_id,
    pos: player.player_position_id,
    ecr: Number(player.rank_ecr),
    average_expert_rank: Number(player.rank_ave),
    rank_std_dev: Number(player.rank_std),
    pos_rank: player.pos_rank,
    tier: Number(player.tier),
  }));

const output = {
  source: "FantasyPros half-PPR Expert Consensus Rankings",
  source_url: "https://www.fantasypros.com/nfl/rankings/half-point-ppr-cheatsheets.php",
  season: Number(payload.year),
  source_last_updated: payload.last_updated,
  expert_count: Number(payload.total_experts),
  fetched_at: new Date().toISOString(),
  players,
};

const outputPath = path.join(path.dirname(new URL(import.meta.url).pathname), "data", "fantasypros_ecr_2026.json");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Saved ${players.length} skill-position rankings from ${output.expert_count} experts (updated ${output.source_last_updated}).`);
