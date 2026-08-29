(() => {
  "use strict";

  const players = Array.isArray(window.BOARD) ? window.BOARD : [];
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const playablePositions = new Set(["QB", "RB", "WR", "TE"]);

  function meanAndSd(values) {
    const clean = values.filter(Number.isFinite);
    if (!clean.length) return { mean: 0, sd: 1 };
    const mean = clean.reduce((sum, value) => sum + value, 0) / clean.length;
    const variance = clean.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / clean.length;
    return { mean, sd: Math.sqrt(variance) || 1 };
  }

  function z(value, stats) {
    return Number.isFinite(value) ? (value - stats.mean) / stats.sd : 0;
  }

  const positionStats = {};
  for (const position of playablePositions) {
    const group = players.filter((player) => player.p === position && !player.spec);
    positionStats[position] = {
      p90: meanAndSd(group.map((player) => Number(player.p90))),
      spikeRate: meanAndSd(group.map((player) => Number(player.g) > 0 ? Number(player.sw) / Number(player.g) : NaN)),
      ceilingGap: meanAndSd(group.map((player) => Number.isFinite(Number(player.p90)) && Number.isFinite(Number(player.pj)) ? Number(player.p90) - Number(player.pj) : NaN)),
    };
  }

  for (const player of players) {
    const smartRank = Number(player.r) || 999;
    if (!playablePositions.has(player.p) || player.spec) {
      player.bb = -10000 - smartRank;
      player.bbr = 999;
      player.bbBonus = 0;
      continue;
    }

    const stats = positionStats[player.p];
    const p90 = Number(player.p90);
    const projected = Number(player.pj);
    const spikeRate = Number(player.g) > 0 ? Number(player.sw) / Number(player.g) : NaN;
    const ceilingGap = Number.isFinite(p90) && Number.isFinite(projected) ? p90 - projected : NaN;
    const contingency = Number(player.cont);
    const contingencyGain = Number.isFinite(contingency) && Number.isFinite(projected)
      ? Math.max(0, contingency - projected)
      : 0;

    // Best ball starts from Smart Rank, then only adds upside. Stable players are
    // not punished; explosive profiles simply get a bounded boost. All three
    // weekly-ceiling inputs are normalized within position so QB scoring does not
    // swamp WR/RB/TE scoring. Contingency upside rewards players whose role can
    // become materially larger when a teammate misses time.
    const ceilingBoost = 3.25 * Math.max(0, z(p90, stats.p90));
    const spikeBoost = 4.25 * Math.max(0, z(spikeRate, stats.spikeRate));
    const volatilityBoost = 2.25 * Math.max(0, z(ceilingGap, stats.ceilingGap));
    const contingencyBoost = Math.min(4, contingencyGain * 0.55);
    const bonus = clamp(ceilingBoost + spikeBoost + volatilityBoost + contingencyBoost, 0, 14);
    const effectiveRank = smartRank - bonus;

    // app-core.js already sorts unknown numeric metrics high-to-low. A larger BB
    // score therefore means a better best-ball rank without changing the core app.
    player.bb = 1000 - effectiveRank;
    player.bbBonus = +bonus.toFixed(1);
  }

  [...players]
    .filter((player) => playablePositions.has(player.p) && !player.spec)
    .sort((a, b) => b.bb - a.bb || a.r - b.r)
    .forEach((player, index) => { player.bbr = index + 1; });

  const sort = document.getElementById("sort");
  if (sort && !sort.querySelector('option[value="bb"]')) {
    const option = document.createElement("option");
    option.value = "bb";
    option.textContent = "Sort: Best ball rank";
    option.title = "Smart Rank plus bounded boosts for position-normalized weekly ceiling, spike-week rate, volatility, and contingency upside.";
    sort.insertBefore(option, sort.children[1] || null);
  }

  window.BEST_BALL = {
    version: 1,
    methodology: "Smart Rank + positive, position-normalized p90/spike/ceiling-gap boosts + contingency upside; max 14-rank boost",
    leaders: () => [...players]
      .filter((player) => Number.isFinite(player.bbr))
      .sort((a, b) => a.bbr - b.bbr)
      .map((player) => ({ id: player.id, player: player.n, rank: player.bbr, smartRank: player.r, bonus: player.bbBonus })),
  };

  const core = document.createElement("script");
  core.src = "app-core.js";
  core.onerror = () => console.error("Failed to load app-core.js");
  document.body.appendChild(core);
})();
