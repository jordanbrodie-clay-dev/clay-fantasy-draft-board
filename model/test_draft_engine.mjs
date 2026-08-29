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
const winks = JSON.parse(fs.readFileSync(path.join(root, "model/data/winks_yahoo_2026.json"), "utf8"));
assert.equal(board.length, 240);
assert.equal(new Set(board.map((player) => player.id)).size, board.length);
board.forEach((player, index) => assert.equal(player.r, index + 1));
const allen = board.find((player) => player.n === "Josh Allen");
assert.ok(allen.r >= 20 && allen.r <= 36, `Josh Allen should be a market-window pick, got rank ${allen.r}`);
assert.equal(allen.qr, 3);
assert.equal(allen.wk, winks.players.find((player) => player.player === "Josh Allen").rank);
assert.ok(allen.be >= 20, `Josh Allen should not have a first-round buy window, got ${allen.be}`);
assert.ok(allen.hn > 0 && allen.hhr > 0);
assert.equal(board.filter((player) => player.p === "K").length, 20);
assert.equal(board.filter((player) => player.p === "DEF").length, 20);

const settings = structuredClone(draft.DEFAULTS);
assert.deepEqual(Array.from(draft.myPicksFrom(1, settings, 4)), [1, 24, 25, 48]);
settings.slot = 12;
assert.deepEqual(Array.from(draft.myPicksFrom(1, settings, 4)), [12, 13, 36, 37]);
assert.equal(draft.needFactor("QB", [], settings, 1), 1);
assert.equal(draft.needFactor("RB", [{ p: "RB" }, { p: "RB" }], settings, 25), 0.94);
assert.equal(draft.needFactor("RB", [{ p: "RB" }, { p: "RB" }, { p: "RB" }], settings, 37), 0.82);
assert.equal(draft.backupSpecialistPenalty({ p: "QB" }, 160, [{ p: "QB", zv: 2 }], settings), 100);
assert.equal(draft.backupSpecialistPenalty({ p: "QB" }, 160, [{ p: "QB", zv: 2 }, { p: "QB", zv: 1 }], settings), 100);
assert.equal(draft.backupSpecialistPenalty({ p: "QB" }, 100, [{ p: "QB", zv: 2 }], { ...settings, slots: { ...settings.slots, QB: 2 } }), 0);

settings.slot = 1;
const opening = draft.recommendations(board, {}, settings);
assert.equal(opening.onClock, true);
assert.equal(opening.recommendations[0].player.n, "Jahmyr Gibbs");
assert.equal(opening.positionPlans.find((item) => item.position === "QB").tierAction, "WAIT");
assert.equal(opening.positionPlans.find((item) => item.position === "TE").tierAction, "WAIT");
assert.equal(opening.positionPlans.find((item) => item.position === "RB").tierAction, "STACK");
opening.positionPlans.forEach((item) => {
  assert.ok(item.currentTier >= 1);
  assert.ok(item.currentTierPlayers.length >= 1);
  assert.ok(item.currentTierSurvival >= 0 && item.currentTierSurvival <= 1);
});
assert.equal(opening.recommendations.slice(0, 8).some((item) => item.player.spec), false);
const noQuarterbacksOrTightEnds = draft.recommendations(board, {}, settings, [], ["QB", "TE"]);
assert.equal(noQuarterbacksOrTightEnds.recommendations.some((item) => ["QB", "TE"].includes(item.player.p)), false);
assert.equal(noQuarterbacksOrTightEnds.positionPlans.some((item) => ["QB", "TE"].includes(item.position)), false);
const hardFadeGibbs = draft.recommendations(board, {}, settings, [], [], [board[0].id]);
assert.notEqual(hardFadeGibbs.recommendations[0].player.id, board[0].id);

// A default one-QB roster may take a late backup, but it must never become a
// three- or four-QB build merely because quarterbacks project well versus QB16.
const capSettings = structuredClone(draft.DEFAULTS);
capSettings.slot = 1;
let capState = {};
while (Object.keys(capState).length < draft.totalRounds(capSettings) * capSettings.teams) {
  capState = draft.simulateToMyPick(board, capState, capSettings).state;
  const capDecision = draft.recommendations(board, capState, capSettings);
  if (!capDecision.recommendations.length) break;
  capState[capDecision.recommendations[0].player.id] = "mine";
}
const cappedRoster = board.filter((player) => capState[player.id] === "mine");
assert.equal(cappedRoster.filter((player) => player.p === "QB").length, 1);
assert.ok(cappedRoster.filter((player) => player.p === "TE").length <= 2);
assert.equal(cappedRoster.filter((player) => player.p === "K").length, 1);
assert.equal(cappedRoster.filter((player) => player.p === "DEF").length, 1);

const protectedGibbs = draft.simulateToMyPick(board, {}, { ...settings, slot: 12 }, [board[0].id]);
assert.equal(protectedGibbs.picks.some((pick) => pick.player.id === board[0].id), false);
assert.equal(protectedGibbs.state[board[0].id], undefined);

// Regression: at the 12/13 turn, positional fit previously elevated Trey
// McBride over materially higher Smart Rank players. BPA must now lead unless a
// nearby strategy alternative clears the explicit scarcity override threshold.
const turnSettings = structuredClone(draft.DEFAULTS);
turnSettings.slot = 12;
let turnState = draft.simulateToMyPick(board, {}, turnSettings).state;
const firstTurnPick = draft.recommendations(board, turnState, turnSettings).recommendations[0].player;
turnState[firstTurnPick.id] = "mine";
const secondTurn = draft.recommendations(board, turnState, turnSettings);
assert.equal(secondTurn.recommendations[0].player.id, secondTurn.bestAvailable.id);
assert.notEqual(secondTurn.recommendations[0].player.n, "Trey McBride");

// Real-board roster-relative timing: after four RB/WR selections, the round-five
// decision should recognize a collapsing single-starter tier without changing
// the opening-round BPA behavior asserted above.
const midRoundSettings = structuredClone(draft.DEFAULTS);
let midRoundState = {};
for (let turn = 0; turn < 4; turn += 1) {
  midRoundState = draft.simulateToMyPick(board, midRoundState, midRoundSettings).state;
  const decision = draft.recommendations(board, midRoundState, midRoundSettings);
  const receiverOrBack = decision.recommendations.find((item) => item.player.p === "RB" || item.player.p === "WR").player;
  midRoundState[receiverOrBack.id] = "mine";
}
midRoundState = draft.simulateToMyPick(board, midRoundState, midRoundSettings).state;
const midRoundDecision = draft.recommendations(board, midRoundState, midRoundSettings);
assert.equal(midRoundDecision.currentPick, 49);
assert.equal(midRoundDecision.recommendations[0].player.id, midRoundDecision.bestAvailable.id);
assert.equal(midRoundDecision.overrideApplied, false);
assert.equal(midRoundDecision.positionPlans.find((item) => item.position === "TE").tierAction, "WAIT");
assert.equal(midRoundDecision.positionPlans.find((item) => item.position === "QB").tierAction, "WAIT");

// BPA roster construction: two early RBs must not block a third RB when that
// player is the top remaining asset and the FLEX/depth value is still high.
const depthSettings = structuredClone(draft.DEFAULTS);
depthSettings.slot = 3;
const depthState = {};
const breeceIndex = board.findIndex((player) => player.n === "Breece Hall");
board.slice(0, breeceIndex).forEach((player) => { depthState[player.id] = "taken"; });
board.slice(0, breeceIndex).filter((player) => player.p === "RB").slice(0, 2)
  .forEach((player) => { depthState[player.id] = "mine"; });
// Control for a legitimate last-player-in-tier TE override; this invariant is
// specifically about whether RB depth is permitted once starters are covered.
const earlyTightEnd = board.slice(0, breeceIndex).find((player) => player.p === "TE");
if (earlyTightEnd) depthState[earlyTightEnd.id] = "mine";
const depthDecision = draft.recommendations(board, depthState, depthSettings);
assert.equal(depthDecision.currentPick, breeceIndex + 1);
assert.equal(depthDecision.recommendations[0].player.n, "Breece Hall");
assert.equal(depthDecision.recommendations[0].need, 0.94);

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

// An empty single-starter position should become urgent when its useful tier is
// likely to vanish across the next two turns, but its acquisition window must
// still prevent the same player from becoming an early reach.
const tierSettings = {
  teams: 2, slot: 1, snake: true,
  slots: { QB: 0, RB: 0, WR: 0, TE: 1, FLEX: 0, K: 0, DEF: 0, BENCH: 7 },
};
const tierBoard = [
  { id: "wr-bpa", n: "BPA WR", p: "WR", r: 1, pr: 1, ti: 1, zv: 2.0, adp: 9, asd: 3, be: 9, spk: 9, hhr: 0.7 },
  { id: "te-cliff", n: "Last Tier TE", p: "TE", r: 4, pr: 1, ti: 1, zv: 1.8, adp: 9, asd: 2, be: 9, spk: 9, hhr: 0.7 },
  { id: "wr-later", n: "Later WR", p: "WR", r: 10, pr: 2, ti: 1, zv: 1.95, adp: 24, asd: 4, be: 20, spk: 24, hhr: 0.7 },
  { id: "te-later", n: "Replacement TE", p: "TE", r: 12, pr: 2, ti: 2, zv: 0.3, adp: 18, asd: 3, be: 16, spk: 18, hhr: 0.4 },
];
assert.equal(draft.recommendations(tierBoard, {}, tierSettings).recommendations[0].player.id, "wr-bpa");
const roundFiveState = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`gone-${index}`, "taken"]));
const tierDecision = draft.recommendations(tierBoard, roundFiveState, tierSettings);
assert.equal(tierDecision.recommendations[0].player.id, "te-cliff");
assert.ok(tierDecision.recommendations[0].starterPressure > 0.75);
assert.ok(tierDecision.recommendations[0].twoPickSurvival < 0.5);
const teTier = tierDecision.positionPlans.find((item) => item.position === "TE");
assert.equal(teTier.currentTier, 1);
assert.equal(teTier.projectedTier, 1);
assert.equal(teTier.projectedTwoTier, 2);
assert.equal(teTier.tierAction, "DRAFT THIS TIER");

const calibration = JSON.parse(fs.readFileSync(path.join(root, "model/data/historical_calibration.json"), "utf8"));
assert.equal(calibration.meta.fold_count, 5);
assert.equal(calibration.folds.reduce((sum, fold) => sum + fold.matched_players, 0), 851);
assert.ok(calibration.availability.QB.stdev_per_sqrt_adp_median > calibration.availability.WR.stdev_per_sqrt_adp_median);

console.log("Draft engine invariants passed.");
