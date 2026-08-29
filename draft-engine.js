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
  function playerTier(player) {
    const tier = Number(player.ti);
    if (Number.isFinite(tier) && tier > 0) return tier;
    return Math.max(1, Math.ceil((Number(player.pr) || 1) / 6));
  }
  function anySurvival(players, fromPick, toPick) {
    if (!players.length) return 0;
    return clamp(1 - players.reduce((noneSurvive, player) => {
      return noneSurvive * (1 - conditionalAvailability(player, fromPick, toPick));
    }, 1), 0, 1);
  }
  function rosterCounts(roster) {
    return roster.reduce((counts, player) => {
      counts[player.p] = (counts[player.p] || 0) + 1;
      return counts;
    }, {});
  }
  function unfilledStarterCount(roster, settings) {
    const counts = rosterCounts(roster);
    const basePositions = ["QB", "RB", "WR", "TE", "K", "DEF"];
    const baseMissing = basePositions.reduce((sum, position) => {
      return sum + Math.max(0, (Number(settings.slots[position]) || 0) - (counts[position] || 0));
    }, 0);
    const flexFilled = [...FLEX_POSITIONS].reduce((sum, position) => {
      const base = Number(settings.slots[position]) || 0;
      return sum + Math.max(0, (counts[position] || 0) - base);
    }, 0);
    return baseMissing + Math.max(0, (Number(settings.slots.FLEX) || 0) - flexFilled);
  }
  function needFactor(position, roster, settings, decisionPick = 1) {
    const counts = rosterCounts(roster);
    const required = Number(settings.slots[position]) || 0;
    const count = counts[position] || 0;
    if (count < required) return 1;
    if (FLEX_POSITIONS.has(position)) {
      const flexUsed = [...FLEX_POSITIONS].reduce((sum, pos) => {
        const base = Number(settings.slots[pos]) || 0;
        return sum + Math.max(0, (counts[pos] || 0) - base);
      }, 0);
      if (flexUsed < (Number(settings.slots.FLEX) || 0)) return position === "RB" || position === "WR" ? 0.94 : 0.68;
      // Early RB/WR depth is an asset, not dead roster weight. This intentionally
      // permits three-RB starts (and similar BPA builds) while still discounting
      // backups relative to unfilled starters.
      const round = Math.ceil(decisionPick / settings.teams);
      return position === "RB" || position === "WR" ? (round <= 6 ? 0.82 : 0.68) : 0.32;
    }
    if (position === "QB" || position === "TE") return 0.30;
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
  function backupSpecialistPenalty(player, decisionPick, roster, settings) {
    if (player.p !== "QB" && player.p !== "TE") return 0;
    const required = Math.max(0, Number(settings.slots[player.p]) || 0);
    const rosterAtPosition = roster.filter((item) => item.p === player.p);
    const count = rosterAtPosition.length;
    if (count < required) return 0;
    // In a normal one-QB league there is no reason to spend a shallow bench spot
    // on another quarterback. A second TE is allowed only when he is genuinely
    // elite enough to be a FLEX asset, not merely the best late specialist left.
    if (player.p === "TE" && count === required && (Number(settings.slots.FLEX) || 0) > 0 && playerValue(player) >= 1.5) {
      return 0;
    }
    return 100;
  }
  function recommendations(players, state, settings, queueIds = [], excludedPositions = [], excludedPlayerIds = []) {
    const draftedIds = new Set(Object.keys(state));
    const excluded = new Set(excludedPositions);
    const excludedPlayers = new Set(excludedPlayerIds);
    const available = players.filter((player) => !draftedIds.has(player.id) && !excluded.has(player.p) && !excludedPlayers.has(player.id));
    const roster = players.filter((player) => state[player.id] === "mine");
    const currentPick = draftedIds.size + 1;
    const decisionPicks = myPicksFrom(currentPick, settings, 3);
    if (!decisionPicks.length) return { currentPick, decisionPick: null, nextPick: null, onClock: false, recommendations: [] };
    const decisionPick = decisionPicks[0];
    const nextPick = decisionPicks[1] ?? decisionPick + settings.teams;
    const nextTwoPick = decisionPicks[2] ?? nextPick + settings.teams;
    const onClock = decisionPick === currentPick;
    const counts = rosterCounts(roster);
    const unfilledStarters = unfilledStarterCount(roster, settings);
    const remainingRosterPicks = myPicksFrom(currentPick, settings, totalRounds(settings)).length;
    const rosterSlack = Math.max(0, remainingRosterPicks - unfilledStarters);
    const queue = new Set(queueIds);
    const flexFilled = [...FLEX_POSITIONS].reduce((sum, position) => {
      return sum + Math.max(0, (counts[position] || 0) - (Number(settings.slots[position]) || 0));
    }, 0);
    const flexOpen = flexFilled < (Number(settings.slots.FLEX) || 0);
    const mustFillStarters = remainingRosterPicks <= unfilledStarters;
    const eligibleAvailable = available.filter((player) => {
      const fillsBaseStarter = (counts[player.p] || 0) < (Number(settings.slots[player.p]) || 0);
      const fillsFlex = flexOpen && FLEX_POSITIONS.has(player.p);
      if (mustFillStarters && !fillsBaseStarter && !fillsFlex) return false;
      return specialistPenalty(player, decisionPick, roster, settings)
        + backupSpecialistPenalty(player, decisionPick, roster, settings) < 100;
    });
    const bestAvailable = [...eligibleAvailable].sort((a, b) => a.r - b.r)[0] ?? null;
    const bestAvailableRank = Number(bestAvailable?.r) || 999;
    const scored = available.map((player) => {
      const value = Math.max(0, playerValue(player));
      const need = needFactor(player.p, roster, settings, decisionPick);
      const future = expectedFutureAtPosition(available, player.p, decisionPick, nextPick);
      const futureTwo = expectedFutureAtPosition(available, player.p, decisionPick, nextTwoPick);
      const baseUrgency = Math.max(0, value - future.expected) * need;
      const survival = conditionalAvailability(player, decisionPick, nextPick);
      const twoPickSurvival = conditionalAvailability(player, decisionPick, nextTwoPick);
      const tierPeers = available.filter((candidate) => candidate.p === player.p && playerTier(candidate) === playerTier(player));
      const tierSurvival = anySurvival(tierPeers, decisionPick, nextPick);
      const tierTwoPickSurvival = anySurvival(tierPeers, decisionPick, nextTwoPick);
      const reachesDecision = conditionalAvailability(player, currentPick, decisionPick);
      const pressure = 1 - survival;
      const penalty = specialistPenalty(player, decisionPick, roster, settings)
        + backupSpecialistPenalty(player, decisionPick, roster, settings);
      const starterOpen = (counts[player.p] || 0) < (Number(settings.slots[player.p]) || 0);
      const tierCliff = starterOpen ? Math.max(0, value - futureTwo.expected) : 0;
      const completionPressure = starterOpen ? clamp((3 - rosterSlack) / 3, 0, 1) : 0;
      const tierPressureWeight = player.p === "QB" || player.p === "TE" ? 1 : 0.35;
      // Empty starters gain urgency from the quality cliff over the user's next two
      // turns, the chance this exact player disappears, and late-draft roster
      // feasibility. This is intentionally market-aware rather than a fixed
      // "draft a QB in round six" command.
      const starterPressure = starterOpen
        ? tierPressureWeight * (0.55 * tierCliff + 0.25 * (1 - tierTwoPickSurvival) * value) + 0.80 * completionPressure
        : 0;
      const urgency = baseUrgency + starterPressure;
      // Do not pay materially ahead of the multi-source acquisition window. This
      // keeps elite one-QB profiles from becoming first-round recommendations just
      // because their above-replacement z-score is large.
      const reachPicks = Math.max(0, (Number(player.be) || Number(player.spk) || decisionPick) - decisionPick);
      const reachPenalty = Math.min(3, reachPicks / settings.teams) * 0.55;
      const historicalHit = Number.isFinite(Number(player.hhr)) ? Number(player.hhr) : 0.5;
      const evidenceFactor = 0.94 + 0.12 * historicalHit;
      const rankGap = Math.max(0, (Number(player.r) || 999) - bestAvailableRank);
      const bpaPenalty = Math.min(2.4, rankGap * 0.08);
      // BPA is the foundation. Scarcity can break a close call, but it must earn
      // any departure from the highest Smart Rank rather than winning on fit alone.
      const decisionScore = (1.8 * baseUrgency + 1.05 * starterPressure + 0.22 * value * need + 0.25 * pressure) * evidenceFactor
        + (queue.has(player.id) ? 0.08 : 0) - penalty - reachPenalty - bpaPenalty;
      const score = decisionScore * (decisionPick === currentPick ? 1 : reachesDecision);
      return {
        player,
        score,
        value,
        need,
        urgency,
        baseUrgency,
        starterOpen,
        starterPressure,
        tierCliff,
        survival,
        twoPickSurvival,
        tierSurvival,
        tierTwoPickSurvival,
        reachesDecision,
        nextPick,
        nextTwoPick,
        laterAlternative: future.likelyAlternative,
        laterTwoAlternative: futureTwo.likelyAlternative,
        futureValue: future.expected,
        futureTwoValue: futureTwo.expected,
        reachPenalty,
        historicalHit,
        completionPressure,
        penalty,
        rankGap,
        bpaPenalty,
      };
    }).sort((a, b) => b.score - a.score || a.player.r - b.player.r);
    const decisionCandidates = scored.filter((candidate) => candidate.penalty < 100);
    const strategyLeader = decisionCandidates[0] ?? null;
    const bpaCandidate = decisionCandidates.find((candidate) => candidate.player.id === bestAvailable?.id) ?? null;
    const urgencyAdvantage = strategyLeader && bpaCandidate ? strategyLeader.urgency - bpaCandidate.urgency : 0;
    const scoreAdvantage = strategyLeader && bpaCandidate ? strategyLeader.score - bpaCandidate.score : 0;
    const decisionRound = Math.ceil(decisionPick / settings.teams);
    const overrideRankLimit = strategyLeader?.starterPressure >= 0.60
      ? (decisionRound >= 4 ? Math.max(6, settings.teams) : 6)
      : strategyLeader?.starterPressure >= 0.35 ? Math.max(4, Math.ceil(settings.teams / 2)) : 3;
    // A strategy pick may pass BPA only on strong evidence and only within a tight
    // rank neighborhood. This preserves the future-availability edge without
    // allowing "best fit" to create a full-tier reach.
    const overrideApplied = Boolean(
      strategyLeader && bpaCandidate && strategyLeader.player.id !== bpaCandidate.player.id
      && strategyLeader.rankGap <= overrideRankLimit && urgencyAdvantage >= 0.75 && scoreAdvantage >= 0.35
    );
    const ordered = overrideApplied || !bpaCandidate
      ? decisionCandidates
      : [bpaCandidate, ...decisionCandidates.filter((candidate) => candidate !== bpaCandidate)];
    const positionPlans = ["QB", "RB", "WR", "TE"].map((position) => {
      const positionCandidates = scored.filter((candidate) => candidate.player.p === position);
      const tierLeader = [...positionCandidates].sort((a, b) => {
        return a.player.pr - b.player.pr || b.value - a.value || a.player.r - b.player.r;
      })[0];
      if (!tierLeader) return null;
      const currentTier = playerTier(tierLeader.player);
      const currentTierPlayers = positionCandidates
        .filter((candidate) => playerTier(candidate.player) === currentTier)
        .sort((a, b) => a.player.pr - b.player.pr || a.player.r - b.player.r);
      const currentTierSurvival = tierLeader.tierSurvival;
      const currentTierTwoPickSurvival = tierLeader.tierTwoPickSurvival;
      const projectedTier = tierLeader.laterAlternative ? playerTier(tierLeader.laterAlternative) : null;
      const projectedTwoTier = tierLeader.laterTwoAlternative ? playerTier(tierLeader.laterTwoAlternative) : null;
      const tierDrop = projectedTier == null ? null : Math.max(0, projectedTier - currentTier);
      const twoTierDrop = projectedTwoTier == null ? null : Math.max(0, projectedTwoTier - currentTier);
      const tierValueDrop = Math.max(0, tierLeader.value - tierLeader.futureValue);
      const tierTwoValueDrop = Math.max(0, tierLeader.value - tierLeader.futureTwoValue);
      const tierBreak = tierDrop > 0 && currentTierSurvival < 0.55;
      const twoTurnTierBreak = twoTierDrop > 0 && currentTierTwoPickSurvival < 0.50;
      let tierAction;
      if (position === "QB" || position === "TE") {
        if (!tierLeader.starterOpen) tierAction = "FILLED";
        else if (tierLeader.reachPenalty >= 0.50) tierAction = "WAIT";
        else if ((tierBreak && tierValueDrop >= 0.20) || (twoTurnTierBreak && tierTwoValueDrop >= 0.25) || tierLeader.completionPressure >= 0.90) tierAction = "DRAFT THIS TIER";
        else tierAction = "WAIT";
      } else {
        tierAction = tierLeader.need >= 0.68 ? "STACK" : "DEPTH ONLY";
      }
      return {
        position,
        ...tierLeader,
        currentTier,
        currentTierPlayers: currentTierPlayers.map((candidate) => candidate.player),
        currentTierSurvival,
        currentTierTwoPickSurvival,
        projectedTier,
        projectedTwoTier,
        tierDrop,
        twoTierDrop,
        tierValueDrop,
        tierTwoValueDrop,
        tierAction,
      };
    }).filter(Boolean);
    return {
      currentPick, decisionPick, nextPick, onClock, bestAvailable,
      strategyPick: strategyLeader?.player ?? null, overrideApplied, overrideRankLimit,
      unfilledStarters, remainingRosterPicks, rosterSlack,
      recommendations: ordered.slice(0, 8), positionPlans,
    };
  }
  function hashNoise(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) / 4294967295) * 2 - 1;
  }
  function simulateToMyPick(players, state, settings, protectedPlayerIds = []) {
    const nextState = { ...state };
    const protectedPlayers = new Set(protectedPlayerIds);
    const picks = [];
    const finalPick = totalRounds(settings) * settings.teams;
    let pick = Object.keys(nextState).length + 1;
    while (pick <= finalPick && ownerOfPick(pick, settings) !== settings.slot) {
      const round = Math.ceil(pick / settings.teams);
      const specialistTooEarly = round < totalRounds(settings) - 2;
      const available = players.filter((player) => !nextState[player.id] && !protectedPlayers.has(player.id));
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
    playerTier,
    anySurvival,
    unfilledStarterCount,
    needFactor,
    expectedFutureAtPosition,
    backupSpecialistPenalty,
    recommendations,
    simulateToMyPick,
  };
})(typeof window !== "undefined" ? window : globalThis);
