#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [projectionsPath, playersPath] = process.argv.slice(2);
if (!projectionsPath || !playersPath) {
  throw new Error("Usage: node model/refresh_sleeper_market.mjs <projections.json> <players.json>");
}

const projections = JSON.parse(fs.readFileSync(projectionsPath, "utf8"));
const players = JSON.parse(fs.readFileSync(playersPath, "utf8"));
const allowed = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

const rows = projections
  .filter((row) => row.company === "rotowire" && row.week == null)
  .map((row) => {
    const player = players[row.player_id] ?? row.player ?? {};
    const position = player.position ?? (row.player_id.length <= 3 ? "DEF" : null);
    const adp = Number(row.stats?.adp_half_ppr);
    if (!allowed.has(position) || !Number.isFinite(adp) || adp <= 0) return null;
    return {
      sleeper_id: row.player_id,
      player: position === "DEF" ? `${row.player_id} D/ST` : player.full_name,
      team: position === "DEF" ? row.player_id : (player.team ?? row.team),
      pos: position,
      adp,
      projected_season_points: Number(row.stats?.pts_half_ppr) || null,
      updated_at: row.updated_at ?? row.last_modified ?? null,
    };
  })
  .filter((row) => row?.player)
  .sort((a, b) => a.adp - b.adp);

const specialists = rows.filter((row) => ["K", "DEF"].includes(row.pos));
const specialistLimit = 20;
const filtered = [
  ...rows.filter((row) => !["K", "DEF"].includes(row.pos) && row.adp <= 300),
  ...specialists.filter((row) => row.pos === "K" && row.team && row.projected_season_points).slice(0, specialistLimit),
  ...specialists.filter((row) => row.pos === "DEF").slice(0, specialistLimit),
].sort((a, b) => a.adp - b.adp);

const output = {
  source: "Sleeper 2026 half-PPR projections and ADP (Rotowire feed)",
  source_url: "https://api.sleeper.com/projections/nfl/2026?season_type=regular&order_by=adp_half_ppr",
  fetched_at: new Date().toISOString(),
  players: filtered,
};

const outputPath = path.join(path.dirname(new URL(import.meta.url).pathname), "data", "sleeper_market_2026.json");
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Saved ${filtered.length} Sleeper market rows, including ${filtered.filter((row) => row.pos === "K").length} K and ${filtered.filter((row) => row.pos === "DEF").length} D/ST.`);
