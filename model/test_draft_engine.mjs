#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const context = { window: {} };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, "board.js"), "utf8"), context);
vm.runInContext(fs.readFileSync(path.join(root, "draft-engine.js"), "utf8"), context);

const board = context.window.BOARD;
const draft = context.window.DRAFT;
assert.equal(board.length, 240);
assert.equal(new Set(board.map((player) => player.id)).size, board.length);
board.forEach((player, index) => assert.equal(player.r, index + 1));
const allen = board.find((player) => player.n === "Josh Allen");
assert.ok(allen.r >= 20 && allen.r <= 36, `Josh Allen should be a market-window pick, got rank ${allen.r}`);
assert.equal(allen.qr, 3);
assert.equal(allen.wk, 28);
assert.ok(allen.be >= 20, `Josh Allen should not have a first-round buy window, got ${allen.be}`);
assert.ok(allen.hn > 0 && allen.hhr > 0);
assert.equal(board.filter((player) => player.p === "K").length, 20);
assert.equal(board.filter((player) => player.p === "DEF").length, 20);

const settings = structuredClone(draft.DEFAULTS);
assert.deepEqual(Array.from(draft.myPicksFrom(1, settings, 4)), [1, 24, 25, 48]);
settings.slot = 12;
assert.deepEqual(Array.from(draft.myPicksFrom(1, settings, 4)), [12, 13, 36, 37]);

settings.slot = 1;
const opening = draft.recommendations(board, {}, settings);
assert.equal(opening.onClock, true);
assert.equal(opening.recommendations[0].player.n, "Jahmyr Gibbs");
assert.equal(opening.recommendations.slice(0, 8).some((item) => item.player.spec), false);

const round11 = {};
board.filter((player) => !player.spec).slice(0, 120).forEach((player) => { round11[player.id] = "taken"; });
assert.equal(draft.recommendations(board, round11, settings).recommendations.some((item) => item.player.spec), false);

const round13 = {};
board.filter((player) => !player.spec).slice(0, 144).forEach((player) => { round13[player.id] = "taken"; });
assert.equal(draft.recommendations(board, round13, settings).recommendations.some((item) => item.player.spec), true);

for (const player of board.slice(0, 80)) {
  assert.ok(draft.conditionalAvailability(player, 1, 24) >= draft.conditionalAvailability(player, 1, 48));
}

// Future availability must beat a superficially higher same-position score: the
// engine should take the scarce RB when a nearly identical WR is likely next turn.
const scarcityBoard = [
  { id: "rb-now", n: "Scarce RB", p: "RB", r: 2, pr: 1, zv: 2.9, adp: 2, asd: 3.5, be: 1, spk: 2, hhr: 0.7 },
  { id: "wr-now", n: "Good WR", p: "WR", r: 1, pr: 1, zv: 3.0, adp: 2, asd: 3.5, be: 1, spk: 2, hhr: 0.7 },
  { id: "wr-later", n: "Later WR", p: "WR", r: 25, pr: 2, zv: 2.9, adp: 27, asd: 5, be: 22, spk: 27, hhr: 0.65 },
];
const scarcity = draft.recommendations(scarcityBoard, {}, structuredClone(draft.DEFAULTS));
assert.equal(scarcity.recommendations[0].player.id, "rb-now");

const calibration = JSON.parse(fs.readFileSync(path.join(root, "model/data/historical_calibration.json"), "utf8"));
assert.equal(calibration.meta.fold_count, 5);
assert.equal(calibration.folds.reduce((sum, fold) => sum + fold.matched_players, 0), 851);
assert.ok(calibration.availability.QB.stdev_per_sqrt_adp_median > calibration.availability.WR.stdev_per_sqrt_adp_median);

console.log("Draft engine invariants passed.");
