(function (root) {
  "use strict";

  const DEFAULTS = {
    teams: 12,
    slot: 1,
    snake: true,
    slots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1, BENCH: 6 },
  };
  const FLEX_POSITIONS = new Set(["RB", "WR", "TE"]);

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function totalRounds(settings) {
    return Object.values(settings.slots).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  }
  function ownerOfPick(pick, settings) {
    const teams = settings.teams;
    const round = Math.floor((pick - 1) / teams) + 1;
    const withinRound = ((pick - 1) % teams) + 1;
    return settings.snake && round % 2 === 0 ? teams - withinRound + 1 : withinRound;
  }
  function myPicksFrom(currentPick, settings, count = 3) {
    const picks = [];
    const lastPick = totalRounds(settings) * settings.teams;
    for (let pick = Math.max(1, currentPick); pick <= lastPick && picks.length < count; pick += 1) {
      if (ownerOfPick(pick, settings) === settings.slot) picks.push(pick);
    }
    return picks;
  }
  function normalCdf(x) {
    const sign = x < 0 ? -1 : 1;
    const value = Math.abs(x) / Math.sqrt(2);
    const t = 1 / (1 + 0.3275911 * value);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-value * value);
    return 0.5 * (1 + sign * erf);
  }
  function rawAvailability(player, pick) {
    const adp = Number(player.adp);
    if (!Number.isFinite(adp)) return 0.5;
    const sd = Math.max(4, Number(player.asd) || Math.sqrt(adp) * 1.35);
    return clamp(normalCdf((adp - pick + 0.5) / sd), 0.001, 0.999);
  }
  function conditionalAvailability(player, fromPick, toPick) {
    if (toPick <= fromPick) return 1;
    return clamp(rawAvailability(player, toPick) / rawAvailability(player, fromPick), 0, 1);
  }
  function playerValue(player) {
    if (player.p === "K" || player.p === "DEF") return Math.max(0.03, 0.22 - 0.01 * (player.pr - 1));
    return Number.isFinite(Number(player.zv)) ? Number(player.zv) : 0;
  }
  function rosterCounts(roster) {
    return roster.reduce((counts, player) => {
      counts[player.p] = (counts[player.p] || 0) + 1;
      return counts;
    }, {});
  }
  function needFactor(position, roster, settings) {
    const counts = rosterCounts(roster);
    const required = Number(settings.slots[position]) || 0;
    if (counts[position] < required) return 1;
    if (FLEX_POSITIONS.has(position)) {
      const flexUsed = [...FLEX_POSITIONS].reduce((sum, pos) => {
        const base = Number(settings.slots[pos]) || 0;
        return sum + Math.max(0, (counts[pos] || 0) - base);
      }, 0);
      if (flexUsed < (Number(settings.slots.FLEX) || 0)) return 0.88;
      return position === "RB" || position === "WR" ? 0.55 : 0.30;
    }
    if (position === "QB" || position === "TE") return 0.28;
    return 0.05;
  }
  function expectedFutureAtPosition(available, position, fromPick, toPick) {
    const candidates = available
      .filter((player) => player.p === position)
      .sort((a, b) => playerValue(b) - playerValue(a))
      .slice(0, 18);
    let noneHigher = 1;
    let expected = 0;
    let likelyAlternative = null;
    for (const player of candidates) {
      const probability = conditionalAvailability(player, fromPick, toPick);
      const bestProbability = noneHigher * probability;
      expected += bestProbability * Math.max(0, playerValue(player));
      if (!likelyAlternative && probability >= 0.45) likelyAlternative = player;
      noneHigher *= (1 - probability);
    }
    return { expected, likelyAlternative, emptyProbability: noneHigher };
  }
  function specialistPenalty(player, decisionPick, roster, settings) {
    if (player.p !== "K" && player.p !== "DEF") return 0;
    const round = Math.ceil(decisionPick / settings.teams);
    const rounds = totalRounds(settings);
    const count = roster.filter((item) => item.p === player.p).length;
    if (count >= (Number(settings.slots[player.p]) || 0)) return 100;
    return round < rounds - 2 ? 100 : 0;
  }
  function recommendations(players, state, settings, queueIds = []) {
    const draftedIds = new Set(Object.keys(state));
    const available = players.filter((player) => !draftedIds.has(player.id));
    const roster = players.filter((player) => state[player.id] === "mine");
    const currentPick = draftedIds.size + 1;
    const decisionPicks = myPicksFrom(currentPick, settings, 3);
    if (!decisionPicks.length) return { currentPick, decisionPick: null, nextPick: null, onClock: false, recommendations: [] };
    const decisionPick = decisionPicks[0];
    const nextPick = decisionPicks[1] ?? decisionPick + settings.teams;
    const onClock = decisionPick === currentPick;
    const queue = new Set(queueIds);
    const scored = available.map((player) => {
      const value = Math.max(0, playerValue(player));
      const need = needFactor(player.p, roster, settings);
      const future = expectedFutureAtPosition(available, player.p, decisionPick, nextPick);
      const urgency = Math.max(0, value - future.expected) * need;
      const survival = conditionalAvailability(player, decisionPick, nextPick);
      const reachesDecision = conditionalAvailability(player, currentPick, decisionPick);
      const pressure = 1 - survival;
      const penalty = specialistPenalty(player, decisionPick, roster, settings);
      // Urgency (the loss if this position is deferred) drives the decision. Raw
      // player quality is deliberately a small tiebreaker so a late-ADP QB/TE does
      // not jump several rounds simply because its standardized position value is high.
      const decisionScore = 2.4 * urgency + 0.08 * value * need + 0.25 * pressure + (queue.has(player.id) ? 0.08 : 0) - penalty;
      const score = decisionScore * (decisionPick === currentPick ? 1 : reachesDecision);
      return {
        player,
        score,
        value,
        need,
        urgency,
        survival,
        reachesDecision,
        nextPick,
        laterAlternative: future.likelyAlternative,
        futureValue: future.expected,
      };
    }).sort((a, b) => b.score - a.score || a.player.r - b.player.r);
    return { currentPick, decisionPick, nextPick, onClock, recommendations: scored.slice(0, 8) };
  }
  function hashNoise(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) / 4294967295) * 2 - 1;
  }
  function simulateToMyPick(players, state, settings) {
    const nextState = { ...state };
    const picks = [];
    const finalPick = totalRounds(settings) * settings.teams;
    let pick = Object.keys(nextState).length + 1;
    while (pick <= finalPick && ownerOfPick(pick, settings) !== settings.slot) {
      const round = Math.ceil(pick / settings.teams);
      const specialistTooEarly = round < totalRounds(settings) - 2;
      const available = players.filter((player) => !nextState[player.id]);
      const chosen = available.map((player) => {
        const specialist = player.p === "K" || player.p === "DEF";
        const noise = hashNoise(`${player.id}:${pick}`) * (Number(player.asd) || 8) * 0.42;
        return { player, marketPick: (Number(player.adp) || 999) + noise + (specialist && specialistTooEarly ? 500 : 0) };
      }).sort((a, b) => a.marketPick - b.marketPick)[0]?.player;
      if (!chosen) break;
      nextState[chosen.id] = "taken";
      picks.push({ pick, player: chosen });
      pick += 1;
    }
    return { state: nextState, picks, nextPick: pick };
  }

  root.DRAFT = {
    DEFAULTS,
    totalRounds,
    ownerOfPick,
    myPicksFrom,
    rawAvailability,
    conditionalAvailability,
    needFactor,
    expectedFutureAtPosition,
    recommendations,
    simulateToMyPick,
  };
})(typeof window !== "undefined" ? window : globalThis);
