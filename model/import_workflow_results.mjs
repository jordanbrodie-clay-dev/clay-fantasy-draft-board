#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const [researchPath, sentimentPath, manifestPath] = process.argv.slice(2);
if (!researchPath || !sentimentPath || !manifestPath) {
  throw new Error("Usage: node model/import_workflow_results.mjs <research.jsonl> <sentiment.jsonl> <manifest.json>");
}

const readJsonl = (file) => fs.readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const excerpt = (value, maxWords = 20) => {
  if (typeof value !== "string") return value;
  const words = value.trim().split(/\s+/);
  return words.length > maxWords ? `${words.slice(0, maxWords).join(" ")}…` : value;
};

const researchRows = readJsonl(researchPath);
const sentimentRows = readJsonl(sentimentPath);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const playerById = new Map(manifest.map((player) => [player.sportradar_id, player]));

const research = {};
const sentiment = {};
const failures = { research: [], sentiment: [] };

for (const row of researchRows) {
  if (row.status !== "complete") {
    failures.research.push({
      ...playerById.get(row.id),
      error: row.error?.message ?? "unknown workflow failure",
    });
    continue;
  }
  try {
    const packet = JSON.parse(row.result.structuredOutputs.metrics_json);
    packet.refresh_status = "fresh";
    research[row.id] = packet;
  } catch (error) {
    failures.research.push({
      ...playerById.get(row.id),
      error: `Invalid metrics_json: ${error.message}`,
    });
  }
}

for (const row of sentimentRows) {
  if (row.status !== "complete") {
    failures.sentiment.push({
      ...playerById.get(row.id),
      error: row.error?.message ?? "unknown workflow failure",
    });
    continue;
  }
  sentiment[row.id] = {
    ...row.result.structuredOutputs,
    key_quote: excerpt(row.result.structuredOutputs.key_quote),
    sportradar_id: row.id,
    player: playerById.get(row.id)?.player,
    refresh_status: "fresh",
  };
}

const dataDir = path.join(path.dirname(new URL(import.meta.url).pathname), "data");
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "player_metrics.json"), `${JSON.stringify(research, null, 2)}\n`);
fs.writeFileSync(path.join(dataDir, "sentiment_2026.json"), `${JSON.stringify(sentiment, null, 2)}\n`);
fs.writeFileSync(path.join(dataDir, "workflow_refresh_report.json"), `${JSON.stringify({
  refreshed_at: new Date().toISOString(),
  workflow_runs: {
    research: "run_0tk7ahvS4zd9bH5UTPP",
    sentiment: "run_0tk7ahv2Z2Shim8JQer",
  },
  requested: manifest.length,
  research_complete: Object.keys(research).length,
  sentiment_complete: Object.keys(sentiment).length,
  failures,
}, null, 2)}\n`);

console.log(`Imported ${Object.keys(research).length}/${manifest.length} research packets and ${Object.keys(sentiment).length}/${manifest.length} sentiment packets.`);
