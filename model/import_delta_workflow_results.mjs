#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [researchPath, sentimentPath, manifestPath, researchRun, sentimentRun] = process.argv.slice(2);
if (!sentimentRun) {
  throw new Error("Usage: node model/import_delta_workflow_results.mjs <research-results.json> <sentiment-results.json> <delta-manifest.json> <research-run-id> <sentiment-run-id>");
}

const readRows = (file) => {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  if (text.startsWith("{")) {
    const packet = JSON.parse(text);
    if (!Array.isArray(packet.data)) throw new Error(`${file} has no data array`);
    if (packet.status !== "complete") throw new Error(`${file} is not complete (status: ${packet.status})`);
    return packet.data;
  }
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
};

const excerpt = (value, maxWords = 20) => {
  if (typeof value !== "string") return value;
  const words = value.trim().split(/\s+/);
  return words.length > maxWords ? `${words.slice(0, maxWords).join(" ")}…` : value;
};

const researchRows = readRows(researchPath);
const sentimentRows = readRows(sentimentPath);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const playerById = new Map(manifest.map((player) => [player.sportradar_id, player]));
const allowed = new Set(playerById.keys());

for (const [label, rows] of [["research", researchRows], ["sentiment", sentimentRows]]) {
  const unexpected = rows.filter((row) => !allowed.has(row.id)).map((row) => row.id);
  if (unexpected.length) throw new Error(`${label} returned IDs outside the approved shortlist: ${unexpected.join(", ")}`);
}

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
const research = JSON.parse(fs.readFileSync(path.join(dataDir, "player_metrics.json"), "utf8"));
const sentiment = JSON.parse(fs.readFileSync(path.join(dataDir, "sentiment_2026.json"), "utf8"));
const failures = { research: [], sentiment: [] };
const updated = { research: [], sentiment: [] };

for (const row of researchRows) {
  const player = playerById.get(row.id);
  if (row.status !== "complete") {
    failures.research.push({ ...player, error: row.error?.message ?? "unknown workflow failure" });
    continue;
  }
  try {
    const packet = JSON.parse(row.result.structuredOutputs.metrics_json);
    research[row.id] = { ...packet, refresh_status: "fresh" };
    updated.research.push(player.player);
  } catch (error) {
    failures.research.push({ ...player, error: `Invalid metrics_json: ${error.message}` });
  }
}

for (const row of sentimentRows) {
  const player = playerById.get(row.id);
  if (row.status !== "complete") {
    failures.sentiment.push({ ...player, error: row.error?.message ?? "unknown workflow failure" });
    continue;
  }
  sentiment[row.id] = {
    ...row.result.structuredOutputs,
    key_quote: excerpt(row.result.structuredOutputs.key_quote),
    sportradar_id: row.id,
    player: player.player,
    refresh_status: "fresh",
  };
  updated.sentiment.push(player.player);
}

fs.writeFileSync(path.join(dataDir, "player_metrics.json"), `${JSON.stringify(research, null, 2)}\n`);
fs.writeFileSync(path.join(dataDir, "sentiment_2026.json"), `${JSON.stringify(sentiment, null, 2)}\n`);

const reportPath = path.join(dataDir, "workflow_refresh_report.json");
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const previousDelta = report.last_delta_refresh;
if (previousDelta) {
  const history = report.delta_refresh_history ?? [];
  const previousResearchRun = previousDelta.workflow_runs?.research;
  if (!history.some((entry) => entry.workflow_runs?.research === previousResearchRun)) history.push(previousDelta);
  report.delta_refresh_history = history;
}
report.last_delta_refresh = {
  refreshed_at: new Date().toISOString(),
  workflow_runs: { research: researchRun, sentiment: sentimentRun },
  requested: manifest.length,
  research_complete: updated.research.length,
  sentiment_complete: updated.sentiment.length,
  updated,
  failures,
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Merged ${updated.research.length}/${manifest.length} research and ${updated.sentiment.length}/${manifest.length} sentiment packets.`);
if (failures.research.length || failures.sentiment.length) {
  console.log(JSON.stringify({ failures }, null, 2));
}
