(() => {
  "use strict";
  const B = window.BOARD;
  const D = window.DRAFT;
  const KEY = "clay-board-draft";
  const OKEY = "clay-board-order";
  const OLD_WKEY = "clay-board-watch";
  const QKEY = "clay-board-queue";
  const SKEY = "clay-board-settings";
  const HKEY = "clay-board-hidden-positions";
  const RKEY = "clay-board-room-compact";
  const SIMKEY = "clay-board-simulation-checkpoint";
  const byId = new Map(B.map((player) => [player.id, player]));

  function migrateId(value) {
    if (byId.has(String(value))) return String(value);
    const oldRank = Number(value);
    return B.find((player) => player.qr === oldRank)?.id ?? B.find((player) => player.r === oldRank)?.id ?? null;
  }
  function loadState() {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return Object.fromEntries(Object.entries(raw).map(([key, value]) => [migrateId(key), value]).filter(([key]) => key));
  }
  function loadOrder() {
    const raw = JSON.parse(localStorage.getItem(OKEY) || "[]");
    return raw.map(migrateId).filter((id, index, rows) => id && rows.indexOf(id) === index);
  }
  function loadQueue() {
    const saved = JSON.parse(localStorage.getItem(QKEY) || "null");
    const raw = saved ?? JSON.parse(localStorage.getItem(OLD_WKEY) || "[]");
    return raw.map(migrateId).filter((id, index, rows) => id && rows.indexOf(id) === index);
  }
  function loadSimulationCheckpoint() {
    const saved = JSON.parse(localStorage.getItem(SIMKEY) || "null");
    if (!saved || typeof saved.state !== "object" || !Array.isArray(saved.pickOrder)) return null;
    const state = Object.fromEntries(Object.entries(saved.state).map(([key, value]) => [migrateId(key), value]).filter(([key]) => key));
    const order = saved.pickOrder.map(migrateId).filter((id, index, rows) => id && rows.indexOf(id) === index);
    const savedQueue = Array.isArray(saved.queue) ? saved.queue : [];
    const restoredQueue = savedQueue.map(migrateId).filter((id, index, rows) => id && rows.indexOf(id) === index);
    return { state, pickOrder: order, queue: restoredQueue };
  }
  function mergeSettings(saved) {
    const base = structuredClone(D.DEFAULTS);
    if (!saved) return base;
    return { ...base, ...saved, slots: { ...base.slots, ...(saved.slots || {}) } };
  }

  let st = loadState();
  let pickOrder = loadOrder();
  let queue = loadQueue();
  let settings = mergeSettings(JSON.parse(localStorage.getItem(SKEY) || "null"));
  let hiddenPositions = new Set(JSON.parse(localStorage.getItem(HKEY) || "[]").filter((pos) => ["QB", "RB", "WR", "TE", "K", "DEF"].includes(pos)));
  let roomCompact = JSON.parse(localStorage.getItem(RKEY) || "true");
  let simulationCheckpoint = loadSimulationCheckpoint();
  let f = { pos: "All", cls: "All", draft: "Available", q: "", sort: "r", hideFades: false };
  let open = new Set();
  const TAGCOLOR = { Injured: "amber", "Injury risk": "amber", "Crowded role": "amber", Rookie: "gray", "New team": "gray", "High value": "matcha", "Fade risk": "brick", Sleeper: "blue" };
  const tagHtml = (player) => player.tg ? `<span class="tag tag-${TAGCOLOR[player.tg] || "gray"}">[${player.tg}]</span>` : "";
  const n1 = (value) => value == null ? "—" : (+value).toFixed(1);
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[char]));
  const pct = (value) => `${Math.round(100 * value)}%`;

  function save() {
    localStorage.setItem(KEY, JSON.stringify(st));
    localStorage.setItem(OKEY, JSON.stringify(pickOrder));
    localStorage.setItem(QKEY, JSON.stringify(queue));
    localStorage.setItem(SKEY, JSON.stringify(settings));
    localStorage.setItem(HKEY, JSON.stringify([...hiddenPositions]));
    localStorage.setItem(RKEY, JSON.stringify(roomCompact));
    if (simulationCheckpoint) localStorage.setItem(SIMKEY, JSON.stringify(simulationCheckpoint));
    else localStorage.removeItem(SIMKEY);
  }
  save();

  function chips(element, values, key) {
    element.innerHTML = values.map((value) => `<button class="chip" data-k="${key}" data-v="${value}" aria-pressed="${f[key] === value}">${value === "DEF" ? "D/ST" : value}</button>`).join("");
  }
  function renderChips() {
    chips(document.getElementById("posF"), ["All", "QB", "RB", "WR", "TE", "K", "DEF"], "pos");
    chips(document.getElementById("clsF"), ["All", "Target", "Value", "Fade", "Fair"], "cls");
    chips(document.getElementById("draftF"), ["Available", "Taken", "My team", "Queue", "All"], "draft");
    document.getElementById("hideFadesBtn").setAttribute("aria-pressed", f.hideFades);
    document.getElementById("hidePosF").innerHTML = `<span class="chiplabel">Hide</span>${["QB", "RB", "WR", "TE", "K", "DEF"].map((pos) => `<button class="chip" data-hide-pos="${pos}" aria-pressed="${hiddenPositions.has(pos)}">${pos === "DEF" ? "D/ST" : pos}</button>`).join("")}`;
  }
  function currentDecision() { return D.recommendations(B, st, settings, queue, [...hiddenPositions]); }
  function simulationDelta() {
    if (!simulationCheckpoint) return { opponentPicks: 0, myPicks: 0 };
    return Object.entries(st).reduce((delta, [id, status]) => {
      if (simulationCheckpoint.state[id] === status) return delta;
      if (status === "mine") delta.myPicks += 1;
      else if (status === "taken") delta.opponentPicks += 1;
      return delta;
    }, { opponentPicks: 0, myPicks: 0 });
  }
  function view() {
    let players = B.filter((player) => {
      if (f.pos !== "All" && player.p !== f.pos) return false;
      if (hiddenPositions.has(player.p)) return false;
      if (f.cls !== "All" && player.c !== f.cls) return false;
      if (f.hideFades && player.c === "Fade") return false;
      const status = st[player.id];
      if (f.draft === "Available" && status) return false;
      if (f.draft === "Taken" && status !== "taken") return false;
      if (f.draft === "My team" && status !== "mine") return false;
      if (f.draft === "Queue" && !queue.includes(player.id)) return false;
      if (f.q && !(player.n + " " + player.t + " " + player.p).toLowerCase().includes(f.q.toLowerCase())) return false;
      return true;
    });
    const key = f.sort;
    const ascending = ["r", "adp", "ecr", "wk", "qr"].includes(key);
    players.sort((a, b) => {
      let left = a[key], right = b[key];
      if (left == null) left = ascending ? 1e9 : -1e9;
      if (right == null) right = ascending ? 1e9 : -1e9;
      return ascending ? left - right : right - left;
    });
    return players;
  }

  function renderDraftRoom() {
    const result = currentDecision();
    const body = document.getElementById("recommendationBody");
    const round = result.decisionPick ? Math.ceil(result.decisionPick / settings.teams) : null;
    const room = document.getElementById("draftRoom");
    const delta = simulationDelta();
    room.classList.toggle("compact", roomCompact);
    room.classList.toggle("simulating", Boolean(simulationCheckpoint));
    const simulationBadge = document.getElementById("simulationBadge");
    simulationBadge.hidden = !simulationCheckpoint;
    simulationBadge.textContent = `Preview · ${delta.opponentPicks} opponent · ${delta.myPicks} mine`;
    document.getElementById("exitSimBtn").hidden = !simulationCheckpoint;
    const keep = document.getElementById("keepSimBtn");
    keep.hidden = !simulationCheckpoint;
    keep.textContent = delta.myPicks
      ? `Keep scenario (${delta.myPicks} mine)`
      : `Keep ${delta.opponentPicks} opponent picks only`;
    keep.title = delta.myPicks
      ? "Commit the simulated opponent picks and your drafted players."
      : "No player has been drafted to your team in this preview yet.";
    document.getElementById("roomToggleBtn").textContent = roomCompact ? "Expand strategy" : "Collapse strategy";
    document.getElementById("clockTitle").textContent = result.decisionPick
      ? `${result.onClock ? "You’re on the clock" : "Planning ahead"} · Pick ${result.decisionPick} (Round ${round})`
      : "Draft complete";
    document.getElementById("clockSub").textContent = simulationCheckpoint && result.onClock
      ? "This is your simulated turn. Draft a player to add him to My team, then simulate forward—or keep or exit the scenario."
      : result.nextPick
        ? `Your following pick is ${result.nextPick}. Recommendations compare today’s option with the expected player pool then.`
        : "No future selection remains under the current roster settings.";
    const sim = document.getElementById("simBtn");
    const quickDraft = document.getElementById("quickDraftBtn");
    sim.hidden = result.onClock || !result.decisionPick;
    sim.textContent = `Simulate ${Math.max(0, result.decisionPick - result.currentPick)} picks to my turn`;
    quickDraft.hidden = true;
    quickDraft.removeAttribute("data-draft");
    if (!result.recommendations.length) { document.getElementById("compactRec").textContent = "No eligible positions are visible."; body.innerHTML = "<div class=recmain>No eligible recommendations remain. Reveal a position to add it back to the decision engine.</div>"; return; }
    const top = result.recommendations[0];
    quickDraft.hidden = !result.onClock;
    quickDraft.dataset.draft = top.player.id;
    quickDraft.textContent = `Draft ${top.player.n}`;
    quickDraft.title = `Add ${top.player.n} to My team at pick ${result.decisionPick}.`;
    const bpa = result.bestAvailable;
    const alternative = top.laterAlternative;
    const drop = Math.max(0, top.value - top.futureValue);
    const decisionPrefix = result.onClock ? "" : `${pct(top.reachesDecision)} chance he reaches your pick ${result.decisionPick}. `;
    const strategyAlternative = result.strategyPick?.id !== top.player.id ? result.strategyPick : null;
    const bpaRead = bpa?.id === top.player.id
      ? ` He is the highest-ranked available player (Smart #${top.player.r}).${strategyAlternative ? ` The fit model liked ${strategyAlternative.n}, but the scarcity edge was not strong enough to pass BPA.` : ""}`
      : ` Pure BPA is ${bpa?.n} (Smart #${bpa?.r}); this is a ${top.rankGap}-spot strategy override.`;
    const marketRead = top.player.wk
      ? ` Winks ranks him #${top.player.wk}; the model's buy window is picks ${Math.round(top.player.be)}–${Math.round(top.player.bl)}.`
      : "";
    document.getElementById("compactRec").innerHTML = `<b>${esc(top.player.n)}</b> · Smart #${top.player.r} · ${bpa?.id === top.player.id ? "BPA" : `${top.rankGap}-spot override`} · ${drop.toFixed(2)}σ drop if you wait`;
    const explanation = alternative
      ? `${decisionPrefix}${pct(top.survival)} chance he then reaches pick ${top.nextPick}. If you wait at ${top.player.p === "DEF" ? "D/ST" : top.player.p}, the best likely option is ${alternative.n}; the modeled position drop is ${drop.toFixed(2)}σ.${bpaRead}${marketRead}`
      : `${decisionPrefix}The model sees no dependable ${top.player.p} alternative at pick ${top.nextPick}; this is a positional-cliff selection.${bpaRead}${marketRead}`;
    body.innerHTML = `<div class="recmain">
      <div class="eyebrow">Best pick now · BPA guarded</div>
      <div class="recname">${esc(top.player.n)} <span class="pmeta">${top.player.p === "DEF" ? "D/ST" : top.player.p}${top.player.pr} · ${esc(top.player.t)}</span></div>
      <p class="recwhy">${esc(explanation)}</p>
      <div class="recmetrics"><div class="recmetric"><b>#${top.player.r}</b><span>Smart rank / BPA</span></div><div class="recmetric"><b>${top.value.toFixed(2)}σ</b><span>above replacement</span></div><div class="recmetric"><b>${pct(top.survival)}</b><span>there next pick</span></div><div class="recmetric"><b>${drop.toFixed(2)}σ</b><span>position drop if waiting</span></div><div class="recmetric"><b>${n1(top.player.adp)}</b><span>Sleeper ADP</span></div><div class="recmetric"><b>${top.player.wk ?? "—"}</b><span>Winks rank</span></div><div class="recmetric"><b>${top.player.hhr == null ? "—" : pct(top.player.hhr)}</b><span>historical starter hit</span></div></div>
      <div class="hactions" style="margin-top:14px"><button class="btn-primary" data-draft="${top.player.id}">Draft to my team</button><button class="btn" data-queue="${top.player.id}">${queue.includes(top.player.id) ? "Remove from queue" : "Add to queue"}</button></div>
    </div><div class="reclist"><div class="eyebrow">Decision board · BPA first</div>${result.recommendations.slice(0, 6).map((item, index) => `<div class="recline"><span class="rank">${index + 1}</span><span><b>${esc(item.player.n)}</b><span class="pmeta"> ${item.player.p === "DEF" ? "D/ST" : item.player.p} · Smart #${item.player.r} · Winks ${item.player.wk ?? "—"}</span><br><span class="pmeta">${pct(item.survival)} to pick ${item.nextPick} · ${item.urgency.toFixed(2)}σ urgency${item.rankGap ? ` · ${item.rankGap} spots behind BPA` : " · BPA"}</span></span><button class="btn mini" data-queue="${item.player.id}">${queue.includes(item.player.id) ? "Queued" : "+ Queue"}</button></div>`).join("")}</div>
    <div class="positionplans"><div class="eyebrow">Position timing · quality rank is not draft rank</div><div class="positiongrid">${result.positionPlans.map((item) => { const waitDrop = Math.max(0, item.value - item.futureValue); const later = item.laterAlternative; return `<div class="positioncard"><div><span class="draftbadge">${item.position}</span><b>${esc(item.player.n)}</b></div><p><b>${item.player.p}${item.player.pr}</b> quality · Winks ${item.player.wk ?? "—"} · buy ${Math.round(item.player.be)}–${Math.round(item.player.bl)}</p><p>${pct(item.survival)} to pick ${item.nextPick}${later ? ` · likely ${esc(later.n)}` : " · no dependable fallback"} · <b>${waitDrop.toFixed(2)}σ</b> drop</p></div>`; }).join("")}</div></div>`;
  }

  function render() {
    const decision = currentDecision();
    const rows = view();
    const tbody = document.getElementById("tb");
    tbody.innerHTML = rows.map((player) => {
      const status = st[player.id];
      const queued = queue.includes(player.id);
      const rowClass = ["pr", status === "taken" ? "taken" : "", status === "mine" ? "mine" : "", open.has(player.id) ? "open" : ""].join(" ");
      const nextChance = decision.nextPick ? D.conditionalAvailability(player, decision.decisionPick, decision.nextPick) : 0;
      const detail = open.has(player.id) ? `<tr class="det"><td colspan="16"><div class="det-in"><div><h4>Insights</h4><p>${esc(player.i)}</p>${player.d ? `<h4>Draft note</h4><p>${esc(player.d)}</p>` : ""}${player.sq ? `<h4>Coach quote excerpt</h4><p class="quote">${esc(player.sq)}</p>` : ""}${player.hc ? `<h4>Signal check</h4><p style="color:var(--muted)">${esc(player.hc)}</p>` : ""}</div><div><div class="kv"><span>Smart rank</span><b class="num">${player.r}</b></div><div class="kv"><span>Winks / ECR / quality rank</span><b class="num">${player.wk ?? "—"} / ${player.ecr ?? "—"} / ${player.qr ?? "—"}</b></div><div class="kv"><span>Buy window / consensus pick</span><b class="num">${n1(player.be)}–${n1(player.bl)} / ${n1(player.cp)}</b></div><div class="kv"><span>Sleeper ADP</span><b class="num">${n1(player.adp)}</b></div><div class="kv"><span>Projected / replacement PPG</span><b class="num">${n1(player.pj)} / ${n1(player.rp)}</b></div><div class="kv"><span>Value above replacement</span><b class="num">${player.zv == null ? "—" : player.zv.toFixed(2) + "σ"}</b></div><div class="kv"><span>Historical position/round result</span><b class="num">${player.hhr == null ? "—" : `${pct(player.hhr)} starter hit · ${player.hvor > 0 ? "+" : ""}${n1(player.hvor)} VOR PPG (n=${player.hn})`}</b></div><div class="kv"><span>There at pick ${decision.nextPick ?? "—"}</span><b class="num">${decision.nextPick ? pct(nextChance) : "—"}</b></div><div class="kv"><span>Coach role language</span><b>${esc(player.rl || (player.spec ? "Sleeper-only" : "no signal"))}</b></div><div class="kv"><span>Data confidence</span><b>${player.cf}</b></div></div></div></td></tr>` : "";
      return `<tr class="${rowClass}" data-id="${player.id}" tabindex="0"><td><input type="checkbox" class="tk" data-tk="${player.id}" ${status === "taken" ? "checked" : ""} aria-label="Taken"></td><td><button class="star" data-mine="${player.id}" aria-pressed="${status === "mine"}" title="My team (M)">★</button></td><td><button class="watch" data-queue="${player.id}" aria-pressed="${queued}" title="Draft queue (Q)">☷</button></td><td class="num" style="color:var(--faint)">${player.r}</td><td><div class="pname">${esc(player.n)}${tagHtml(player)}</div><div class="pmeta">${player.t} · ${player.p === "DEF" ? "D/ST" : player.p}${player.pr}</div></td><td class="num">${player.ti}</td><td class="num" style="color:var(--matcha);font-weight:600">${n1(player.s)}</td><td class="num">${n1(player.pj)}</td><td class="num">${n1(player.adp)}</td><td class="num">${player.wk ?? "—"}</td><td class="num">${player.qr ?? "—"}</td><td class="num">${decision.nextPick ? pct(nextChance) : "—"}</td><td class="num ${player.zv > 0 ? "pos" : player.zv < 0 ? "neg" : ""}">${player.spec ? "market" : player.zv == null ? "—" : player.zv.toFixed(2) + "σ"}</td><td><span class="badge b-${player.c}">${player.c}</span></td><td><span class="cf cf-${player.cf}">${player.cf}</span></td><td><span class="chev">▸</span></td></tr>${detail}`;
    }).join("");
    const mine = B.filter((player) => st[player.id] === "mine");
    document.getElementById("mineN").textContent = mine.length;
    document.getElementById("queueN").textContent = queue.length;
    document.getElementById("dcount").textContent = Object.keys(st).length;
    document.getElementById("playerN").textContent = B.length;
    document.getElementById("tTotal").textContent = rows.length;
    const count = (classification) => B.filter((player) => player.c === classification).length;
    document.getElementById("cT").textContent = count("Target"); document.getElementById("cV").textContent = count("Value"); document.getElementById("cF").textContent = count("Fade");
    document.getElementById("tTar").textContent = count("Target"); document.getElementById("tFade").textContent = count("Fade");
    const top24 = B.filter((player) => !player.spec).slice(0, 24).map((player) => player.pj).filter(Number.isFinite);
    document.getElementById("tPpg").textContent = (top24.reduce((sum, value) => sum + value, 0) / top24.length).toFixed(1);
    renderDraftRoom();
    renderPanel(mine);
  }

  function renderPanel(mine) {
    const top = currentDecision().recommendations.slice(0, 3);
    document.getElementById("bestAv").innerHTML = `<h4 style="color:var(--muted);font-size:12px;margin-bottom:6px">Smart recommendations</h4>${top.map((item) => `<div class="mrow"><span>${esc(item.player.n)} <span class="pmeta">${item.player.p}</span></span><b class="num">${item.urgency.toFixed(2)}σ urgent</b></div>`).join("") || "<div class=pmeta>Draft complete</div>"}`;
    const queued = queue.map((id) => byId.get(id)).filter(Boolean);
    document.getElementById("queueBody").innerHTML = `<div class="grp"><div class="gh" style="display:flex;justify-content:space-between"><span>Draft queue</span>${queued.length ? "<button class=\"btn mini\" id=\"clearQueue\">Clear</button>" : ""}</div>${queued.length ? queued.map((player, index) => `<div class="mrow"><span><b>${index + 1}.</b> ${esc(player.n)} <span class="pmeta">${player.p}</span></span><span class="queue-actions"><button class="btn mini" data-qmove="up" data-id="${player.id}">↑</button><button class="btn mini" data-qmove="down" data-id="${player.id}">↓</button><button class="btn mini" data-draft="${player.id}">Draft</button><button class="btn mini" data-queue="${player.id}">×</button></span></div>`).join("") : "<p class=pmeta>Add players from the board or decision panel, then reorder them here.</p>"}</div>`;
    const orderedRoster = pickOrder.filter((id) => st[id] === "mine").map((id) => byId.get(id)).filter(Boolean);
    const counts = {}; orderedRoster.forEach((player) => { counts[player.p] = (counts[player.p] || 0) + 1; });
    const total = orderedRoster.reduce((sum, player) => sum + (player.pj || 0), 0);
    let html = `<div class="grp"><div class="gh">My team · target allotment</div><div class="mrow"><span>Roster</span><b>${["QB", "RB", "WR", "TE", "FLEX", "K", "DEF"].map((pos) => `${pos === "DEF" ? "D/ST" : pos} ${counts[pos] || 0}/${settings.slots[pos] || 0}`).join(" · ")}</b></div><div class="mrow"><span>Roster PPG sum</span><b class="num">${total.toFixed(1)}</b></div></div>`;
    ["QB", "RB", "WR", "TE", "K", "DEF"].forEach((pos) => {
      const group = orderedRoster.filter((player) => player.p === pos); if (!group.length) return;
      html += `<div class="grp"><div class="gh">${pos === "DEF" ? "D/ST" : pos}</div>${group.map((player) => `<div class="mrow"><span>${esc(player.n)}${tagHtml(player)}</span><span class="num">${n1(player.pj)}</span></div>`).join("")}</div>`;
    });
    document.getElementById("teamBody").innerHTML = html + (orderedRoster.length ? "" : "<p class=pmeta style=margin-top:14px>No players drafted yet.</p>");
  }

  function setState(id, value) {
    if (value) st[id] = value; else delete st[id];
    pickOrder = pickOrder.filter((item) => item !== id);
    if (value) pickOrder.push(id);
    if (value) queue = queue.filter((item) => item !== id);
    save(); render();
  }
  function toggleQueue(id) {
    queue = queue.includes(id) ? queue.filter((item) => item !== id) : [...queue, id];
    save(); render();
  }
  function moveQueue(id, direction) {
    const index = queue.indexOf(id); if (index < 0) return;
    const next = clamp(index + (direction === "up" ? -1 : 1), 0, queue.length - 1);
    [queue[index], queue[next]] = [queue[next], queue[index]]; save(); render();
  }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
  function simulate() {
    const result = D.simulateToMyPick(B, st, settings);
    if (!result.picks.length) return;
    if (!simulationCheckpoint) {
      simulationCheckpoint = { state: structuredClone(st), pickOrder: [...pickOrder], queue: [...queue] };
    }
    st = result.state;
    result.picks.forEach((pick) => pickOrder.push(pick.player.id));
    save(); render();
  }
  function exitSimulation() {
    if (!simulationCheckpoint) return;
    st = structuredClone(simulationCheckpoint.state);
    pickOrder = [...simulationCheckpoint.pickOrder];
    queue = [...simulationCheckpoint.queue];
    simulationCheckpoint = null;
    save(); render();
  }
  function keepSimulation() {
    if (!simulationCheckpoint) return;
    simulationCheckpoint = null;
    save(); render();
  }
  function openSettings() {
    document.getElementById("setTeams").value = settings.teams; document.getElementById("setSlot").value = settings.slot; document.getElementById("setSnake").checked = settings.snake;
    Object.keys(settings.slots).forEach((pos) => { document.getElementById(`set${pos}`).value = settings.slots[pos]; });
    document.getElementById("settingsModal").classList.add("on");
  }
  function saveSettings() {
    const teams = clamp(Number(document.getElementById("setTeams").value) || 12, 4, 20);
    settings.teams = teams; settings.slot = clamp(Number(document.getElementById("setSlot").value) || 1, 1, teams); settings.snake = document.getElementById("setSnake").checked;
    Object.keys(settings.slots).forEach((pos) => { settings.slots[pos] = Math.max(0, Number(document.getElementById(`set${pos}`).value) || 0); });
    document.getElementById("settingsModal").classList.remove("on"); save(); render();
  }

  document.addEventListener("click", (event) => {
    const hidePosition = event.target.closest("[data-hide-pos]");
    if (hidePosition) {
      const pos = hidePosition.dataset.hidePos;
      hiddenPositions.has(pos) ? hiddenPositions.delete(pos) : hiddenPositions.add(pos);
      if (f.pos === pos && hiddenPositions.has(pos)) f.pos = "All";
      save(); renderChips(); render(); return;
    }
    const chip = event.target.closest(".chip");
    if (chip) { if (chip.dataset.k === "toggle") f[chip.dataset.v] = !f[chip.dataset.v]; else { f[chip.dataset.k] = chip.dataset.v; if (chip.dataset.k === "pos" && chip.dataset.v !== "All") hiddenPositions.delete(chip.dataset.v); } save(); renderChips(); render(); return; }
    const taken = event.target.closest("[data-tk]"); if (taken) { setState(taken.dataset.tk, taken.checked ? "taken" : null); event.stopPropagation(); return; }
    const mine = event.target.closest("[data-mine]"); if (mine) { setState(mine.dataset.mine, st[mine.dataset.mine] === "mine" ? null : "mine"); event.stopPropagation(); return; }
    const draft = event.target.closest("[data-draft]"); if (draft) { setState(draft.dataset.draft, "mine"); event.stopPropagation(); return; }
    const queued = event.target.closest("[data-queue]"); if (queued) { toggleQueue(queued.dataset.queue); event.stopPropagation(); return; }
    const mover = event.target.closest("[data-qmove]"); if (mover) { moveQueue(mover.dataset.id, mover.dataset.qmove); event.stopPropagation(); return; }
    if (event.target.id === "clearQueue") { queue = []; save(); render(); return; }
    const row = event.target.closest("tr.pr"); if (row) { open.has(row.dataset.id) ? open.delete(row.dataset.id) : open.add(row.dataset.id); render(); }
  });
  document.getElementById("q").addEventListener("input", (event) => { f.q = event.target.value; render(); });
  document.getElementById("sort").addEventListener("change", (event) => { f.sort = event.target.value; render(); });
  document.getElementById("teamBtn").onclick = () => document.getElementById("panel").classList.add("on");
  document.getElementById("queueBtn").onclick = () => document.getElementById("panel").classList.add("on");
  document.getElementById("closePanel").onclick = () => document.getElementById("panel").classList.remove("on");
  document.getElementById("settingsBtn").onclick = openSettings; document.getElementById("roomSettingsBtn").onclick = openSettings;
  document.getElementById("closeSettings").onclick = () => document.getElementById("settingsModal").classList.remove("on");
  document.getElementById("saveSettings").onclick = saveSettings;
  document.getElementById("defaultSettings").onclick = () => { settings = structuredClone(D.DEFAULTS); save(); openSettings(); render(); };
  document.getElementById("simBtn").onclick = simulate;
  document.getElementById("exitSimBtn").onclick = exitSimulation;
  document.getElementById("keepSimBtn").onclick = keepSimulation;
  document.getElementById("roomToggleBtn").onclick = () => { roomCompact = !roomCompact; save(); renderDraftRoom(); };
  document.getElementById("aboutBtn").onclick = () => document.getElementById("modal").classList.add("on");
  document.getElementById("closeModal").onclick = () => document.getElementById("modal").classList.remove("on");
  document.querySelectorAll(".modal").forEach((modal) => modal.addEventListener("click", (event) => { if (event.target === modal) modal.classList.remove("on"); }));
  document.getElementById("resetBtn").onclick = () => { if (confirm("Clear all draft picks? (Your queue and league settings are kept.)")) { st = {}; pickOrder = []; simulationCheckpoint = null; save(); render(); } };
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { document.querySelectorAll(".modal.on,.panel.on").forEach((element) => element.classList.remove("on")); return; }
    const row = document.activeElement?.closest?.("tr.pr"); if (!row) return; const id = row.dataset.id;
    if (event.key.toLowerCase() === "t") setState(id, st[id] === "taken" ? null : "taken");
    if (event.key.toLowerCase() === "m") setState(id, st[id] === "mine" ? null : "mine");
    if (event.key.toLowerCase() === "q") toggleQueue(id);
  });
  const controls = document.querySelector(".controls");
  const syncStickyOffset = () => document.documentElement.style.setProperty("--controls-height", `${Math.ceil(controls.getBoundingClientRect().height)}px`);
  new ResizeObserver(syncStickyOffset).observe(controls);
  renderChips(); render(); syncStickyOffset();
})();
