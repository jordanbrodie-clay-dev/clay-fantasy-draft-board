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
assert.equal(board.find((player) => player.n === "Josh Allen").r, 21);
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

console.log("Draft engine invariants passed.");
