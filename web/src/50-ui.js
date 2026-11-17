/* ========================================================================
   9. INTERFACE: strip, missions, coach, glossary, inspector, readouts
   ======================================================================== */
const $ = id => document.getElementById(id);
const nowS = () => (performance.now() - S.t0) / 1000;
function storeGet(k, d) { try { const v = localStorage.getItem("edsl3:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } }
function storeSet(k, v) { try { localStorage.setItem("edsl3:" + k, JSON.stringify(v)); } catch {} }
const trackKey = () => S.mode === "plain" ? "plain" : "full";
let done = storeGet("done", {plain: {}, full: {}});

function centerHealth(loads) {
  const out = {};
  for (const [c, host, up] of CENTERS) {
    let L = 0; if (M) M.edges.forEach((e, i) => { if (e.head === host || (e.link === up && e.tail === "NOC-SW")) L = Math.max(L, loads ? loads[i] : 0); });
    out[c] = {L, cls: L >= .6 ? "crit" : L >= .05 ? "warn" : "good"};
  }
  return out;
}
function select(s) { S.sel = s; hideGloss(); renderAll(); }

/* ---- coach */
let coachTimer = null;
function coach(title, body, tone = "info") {
  const c = $("coach"); c.className = "coach " + tone; c.hidden = false;
  c.innerHTML = `<button class="x" aria-label="Dismiss">×</button><b>${title}</b><p>${termHTML(body)}</p>`;
  c.querySelector(".x").onclick = () => { c.hidden = true; };
  clearTimeout(coachTimer); coachTimer = setTimeout(() => { c.hidden = true; }, S.mode === "engineer" ? 6000 : 11000);
}
const say = (plain, student, engineer) => S.mode === "plain" ? plain : S.mode === "engineer" ? (engineer || student) : student;

/* ---- reacting to model changes */
let prevRegime = null, prevBlocked = 0, saidBlocked = false;
function onModelChange() {
  if (prevRegime !== null && prevRegime !== M.regime) {
    const loopPts = []; M.loops.forEach(cp => cp.forEach(i => { const e = M.edges[i]; const l = LINK[e.link]; loopPts.push(pointOn(l, .5, true)); }));
    if (M.regime === "CIRCULATING") {
      loopPts.forEach(([x, y]) => wave(x, y, PAL.magenta, 140)); banner(S.mode === "plain" ? "CIRCLE!" : "LOOP FORMED", PAL.magenta);
      const [t, b] = say(["You made a circle", "There are two ways between the same junctions now. Any message that gets in will go around forever."],
        ["Loop formed · ρ = 1", "There's a [[loop]] spanning tree can't see. A broadcast that reaches it circles forever. It won't multiply, but every new broadcast adds more."],
        ["ρ: 0 → 1", "A simple cycle in edge space. Load grows linearly with each broadcast that reaches it."]);
      coach(t, b, "warn");
    } else if (M.regime === "AMPLIFYING") {
      loopPts.forEach(([x, y]) => wave(x, y, PAL.crit, 180)); banner(S.mode === "plain" ? "ECHO STORM" : "STORM", PAL.crit); shake(500);
      const dbl = (Math.log(2) / M.r * 1000).toFixed(2);
      const [t, b] = say(["Echo storm!", "Messages now multiply every time they go around. The network fills up in a blink."],
        [`Storm · ρ = ${M.rho.toFixed(2)}`, `Frames now multiply every lap and double every ${dbl} ms. Nothing in Ethernet will ever stop them.`],
        [`ρ = ${M.rho.toFixed(4)}`, `Renewal growth r = ${M.r.toFixed(1)}/s, doubling every ${dbl} ms.`]);
      coach(t, b, "crit");
    } else if (prevRegime !== "TREE") {
      banner(S.mode === "plain" ? "QUIET" : "LOOP BROKEN", PAL.good);
      const [t, b] = say(["Circle broken", "Messages die out again."], ["Loop broken · ρ = 0", "There's exactly one path between any two switches again."], ["ρ → 0", "Edge graph is acyclic."]);
      coach(t, b, "good");
    }
  } else if (M.blocked.size > prevBlocked && prevRegime !== null && !saidBlocked && S.mode !== "engineer") {
    saidBlocked = true;
    const [t, b] = say(["A road just closed", "See the ☒? The loop guard closed one road so messages can't go in circles."],
      ["Spanning tree blocked a port", "See the new ☒? [[stp|Spanning tree]] turned off one end of a loop so it can't storm. The cable stays as a backup."]);
    coach(t, b, "good");
  }
  prevRegime = M.regime; prevBlocked = M.blocked.size;
}
function onSlowDone(still, total) {
  if (still) coach(...say(["It never stops", "The message is stuck in the circle. It will go around forever."], ["Still going after 40 hops", "This broadcast will never stop on its own. Only breaking the loop ends it."]), "warn");
  else coach(...say(["Everyone heard it once", `${total} copies, then silence. No circles, so nothing came back.`], [`${total} copies, then silence`, "Every switch copied the broadcast once. With no loops, nothing came back."], [`${total} transmissions`, "B is nilpotent: x_k = 0 after a few hops."]), "good");
}

/* ---- strip */
let rhoShown = 0, rhoT = 0, gsWasDown = false, calmSince = null;
function renderStrip(loads) {
  $("rhoK").innerHTML = T("rhoK"); $("centersK").textContent = T("centersK");
  rhoT = M.rho;
  const v = $("verdict"); const V = {TREE: ["good", T("tree")], CIRCULATING: ["warn", T("circ")], AMPLIFYING: ["crit", T("amp")]}[M.regime];
  v.className = "verdict " + V[0]; v.textContent = V[1];
  const H = centerHealth(loads); let down = 0;
  $("centers").innerHTML = CENTERS.map(([c]) => { const h = H[c]; if (h.cls === "crit") down++;
    const name = S.mode === "plain" ? {ZFW: "Fort Worth", ZME: "Memphis", ZAB: "Albuquerque"}[c] : c;
    const word = {crit: "▲ Down", warn: "● Degraded", good: "✓ Normal"}[h.cls];
    return `<div class="center ${h.cls}"><b>${name}</b><span>${word}${h.L > .004 ? " · " + Math.round(h.L * 100) + "%" : ""}</span></div>`; }).join("");
  const gs = $("gs"), t = performance.now();
  if (down >= 2) {
    if (!S.gsStart) { S.gsStart = t; S.seen.gs = true; shake(700); banner("GROUND STOP", PAL.crit);
      coach(...say(["Ground stop", "Two air traffic centers can't hear their radios. In real life the FAA stopped every departure in the country."],
        ["Ground stop", "Two Centers are down. That's what the FAA did on Nov 13: stop every departure. Contain it: cut El Dorado off from the core."],
        ["Ground stop", "≥ 2 ARTCCs saturated. Isolate the source site."]), "crit"); }
    S.gsLast = null; const s = Math.floor((t - S.gsStart) / 1000); gs.hidden = false; gs.className = "groundstop";
    gs.textContent = `GROUND STOP ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; $("strip").classList.add("alarm");
  } else {
    $("strip").classList.remove("alarm");
    if (S.gsStart) { const s = Math.floor((t - S.gsStart) / 1000); S.gsLast = s; S.gsStart = null; S.seen.gsCleared = true;
      if ((trackKey() === "full" && S.mission === 4) || (trackKey() === "plain" && S.mission === 2)) S.containS = S.containS == null ? s : Math.min(S.containS, s);
      banner("CENTERS BACK", PAL.good); coach(...say(["Planes can fly again", `The ground stop lasted ${s} seconds here. The real one lasted 4 hours 21 minutes.`],
        ["Ground stop lifted", `Contained in ${s} s. Now find the root cause before reconnecting El Dorado.`]), "good");
      gs.hidden = false; gs.className = "groundstop lifted"; gs.textContent = `Ground stop lifted after ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
    else if (S.gsLast === null) gs.hidden = true;
  }
  if (S.chatter && S.live && CENTERS.every(([c]) => H[c].cls === "good")) { calmSince = calmSince || t; if (t - calmSince > 5000) S.seen.calm5 = true; } else calmSince = null;
  if (M.regime === "CIRCULATING") S.seen.circ = true;
  if (M.regime === "AMPLIFYING") { S.seen.amp = true; if (["NOC-SW", "ZFW-SW", "ZME-SW", "ZAB-SW"].some(d => !S.stp[d])) S.seen.coreAmp = true; }
  if (trackKey() === "full" && S.mission === 7) {
    if (M.regime !== "TREE" && S.seen.planStart) { S.seen.planStart = false; coach("ρ left 0", "The plan failed a check. Press Reset this mission and try a different order.", "warn"); }
    if (S.seen.planStart && ["L6", "L14", "L15", "L16"].every(on) && S.stp["ELD-NEW"] && S.stp["ELD-OLD"]) S.seen.planRun = true;
  }
}

/* ---- readouts */
function renderReadouts(loads) {
  $("mathK").textContent = T("mathK");
  const plain = S.mode === "plain", eng = S.mode === "engineer";
  $("explain").innerHTML = termHTML({
    TREE: plain ? "No circles in the wiring. Every message reaches everyone once, then stops." : "Every broadcast dies out after a few hops. Spanning tree (or the cabling) leaves no way back.",
    CIRCULATING: plain ? "There's a circle in the wiring. Messages that get in go around forever, and every new message adds to the pile." : "A broadcast that reaches the [[loop]] circles forever without multiplying. Each new broadcast adds more looping frames, so load piles up.",
    AMPLIFYING: plain ? "Messages are multiplying every time they go around. The network fills up almost instantly." : "Frames multiply every time they pass a switch with more than one looped way out. Growth is exponential."}[M.regime]);
  let busy = 0; if (loads) for (const x of loads) busy = Math.max(busy, x);
  $("meterWrap").innerHTML = S.live ? `<div class="muted" style="margin-bottom:4px">${plain ? "Busiest cable" : "Busiest link"}: <b class="mono">${Math.round(busy * 100)}% full</b></div><div class="meter"><i style="width:${Math.round(busy * 100)}%"></i></div>` : "";
  const kv = []; const reach = [...M.reachDevs].filter(d => DEV[d].kind === "host");
  if (plain) {
    kv.push(["Circle in the wiring?", M.regime === "TREE" ? "no" : "yes"]);
    kv.push(["Places a stuck message reaches", reach.length ? String(reach.length) : "none"]);
  } else {
    kv.push(["Links on a loop", M.loops.reduce((s, c) => s + c.length, 0) + " of " + M.n]);
    kv.push(["Storm can reach", reach.length ? reach.length + " hosts" : "nothing"]);
    if (M.regime === "CIRCULATING") {
      const {y} = steadyRates($("src").value || "ZFW-VOICE"); let worst = 0; M.edges.forEach((e, i) => worst = Math.max(worst, y[i] / e.cap));
      kv.push(["One broadcast adds", worst > 0 ? Math.round(worst * 100) + "% load" : "nothing"]);
      kv.push(["Broadcasts to fill a link", worst > 0 ? String(Math.ceil(1 / worst)) : "never"]);
    }
    if (M.regime === "AMPLIFYING") kv.push(["Frames double every", (Math.log(2) / M.r * 1000).toFixed(2) + " ms"]);
    if (eng) { kv.push(["ρ(B)", M.rho.toFixed(6)]); kv.push(["|E| directed", String(M.n)]); kv.push(["Blocked ports", String(M.blocked.size)]);
      if (M.r) kv.push(["Growth r", M.r.toFixed(2) + " /s"]); }
  }
  $("kv").innerHTML = kv.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("");
}
function renderChart() {
  const H = S.history, n = nowS();
  const pts = H.filter(h => h[0] > n - 20).map(h => [300 * (1 - (n - h[0]) / 20), 88 - 80 * h[1]]);
  let s = `<line class="axis" x1="0" y1="88" x2="300" y2="88"/><line class="axis" x1="0" y1="8" x2="300" y2="8" stroke-dasharray="3 3"/><text x="2" y="19">100%</text><text x="2" y="84">0%</text>`;
  if (pts.length > 1) { const d = pts.map(p => p.join(",")).join(" "); s += `<polygon class="area" points="${pts[0][0]},88 ${d} ${pts[pts.length - 1][0]},88"/><polyline class="ln" points="${d}"/>`; }
  else s += `<text x="150" y="52" text-anchor="middle">${S.mode === "plain" ? "Switch to real time to see traffic" : "Switch to live mode to plot load"}</text>`;
  $("chart").innerHTML = s;
}

/* ---- inspector */
function renderInspector() {
  const box = $("inspector"), plain = S.mode === "plain";
  const picker = `<label class="muted" for="cablePick">${plain ? "Pick a cable" : "Cables"}</label>
    <select id="cablePick"><option value="">Choose…</option>${LINKS.filter(linkVisible).map(l => `<option value="${l.id}" ${S.sel && S.sel.link === l.id ? "selected" : ""}>${linkName(l.id)}${S.link[l.id] === "absent" ? " (not installed)" : S.link[l.id] === "shut" ? " (shut)" : ""}</option>`).join("")}</select>`;
  let body = "";
  if (!S.sel) body = `<p class="muted">${plain ? "Click a box or a cable on the map." : "Click a device or a cable on the map. Dotted cables are not installed yet."}</p>`;
  else if (S.sel.link) {
    const l = LINK[S.sel.link], st = S.link[l.id], optional = ["L14", "L15", "L16"].includes(l.id);
    const onLoop = M.edges.some((e, i) => e.link === l.id && M.inComp[i] >= 0);
    body = `<p class="mono" style="font-weight:600">${linkName(l.id)}</p>
      <p class="muted">${plain ? (st === "absent" ? "Not plugged in" : st === "shut" ? "Switched off" : "Working") : `${l.label ? l.label + " · " : ""}${l.cap >= GE ? "Gigabit" : "FastEthernet"} · ${l.prop >= 1e-3 ? (l.prop * 1e3) + " ms" : "local patch"} · ${st === "absent" ? "not installed" : st === "shut" ? "shut down" : "up"}`}${onLoop ? ` · <b style="color:var(--magenta)">${plain ? "part of a circle" : "on a loop"}</b>` : ""}</p>
      <div class="row">${st === "absent" ? `<button class="primary" data-act="install">${plain ? "Plug in" : "Install cable"}</button>` :
        `<button data-act="toggle">${st === "up" ? (plain ? "Unplug" : "Shut down") : (plain ? "Plug back in" : "No shutdown")}</button>${optional && !plain ? `<button data-act="remove">Remove cable</button>` : ""}`}</div>`;
  } else {
    const d = S.sel.dev, D = DEV[d];
    if (D.kind === "switch") {
      const ports = activeLinks().filter(l => l.a === d || l.b === d).map(l => { const port = l.a === d ? l.ap : l.bp, other = l.a === d ? l.b : l.a, blk = M.blocked.has(d + "|" + port);
        return `<span>${plain ? devName(other) : port + " → " + other}</span><span class="${blk ? "b" : ""}">${blk ? (plain ? "closed" : "BLOCKED") : (plain ? "open" : "forwarding")}</span>`; }).join("");
      body = `<p class="mono" style="font-weight:600">${plain ? D.ptag + (D.psub ? " " + D.psub : "") : d} <span class="muted">· ${plain ? d : D.tag}${D.prio === 4096 && !plain ? " · STP root" : ""}</span></p>
        <div class="row"><button data-act="stp" aria-pressed="${!!S.stp[d]}">${T("stp")}: ${S.stp[d] ? "ON" : "OFF"}</button>
        ${!S.stp[d] && !plain ? `<button data-act="bpdu" aria-pressed="${S.bpduPass}">${T("bpdu")}: ${S.bpduPass ? "passed along" : "dropped"}</button>` : ""}
        ${d === "ELD-NEW" && !plain ? `<button data-act="routed">${S.routed ? "Remove routed edge" : "Install routed edge"}</button>` : ""}</div>
        <div class="ports">${ports || '<span class="muted">No cables up.</span>'}</div>`;
    } else if (D.kind === "router") body = `<p class="mono" style="font-weight:600">${d}</p><p class="muted">${termHTML("[[router|Routers]] never forward broadcasts. The broadcast domain ends here.")}</p>`;
    else body = `<p class="mono" style="font-weight:600">${devName(d)}</p><p class="muted">${plain ? "A computer. It hears messages but never passes them on." : "Receives broadcasts and never forwards them."}</p><div class="row"><button data-act="sendfrom">${plain ? "Shout from here" : "Send a broadcast from here"}</button></div>`;
  }
  box.innerHTML = body + `<div class="row" style="margin-top:4px">${picker}</div>`;
  box.querySelectorAll("button[data-act]").forEach(b => b.onclick = () => act(b.dataset.act));
  $("cablePick").onchange = e => { if (e.target.value) select({link: e.target.value}); };
}
function act(a) {
  const s = S.sel, m = track()[S.mission];
  if (a === "install") {
    if (m.predict && m.predict.gate === s.link && S.predicted === null && S.mode !== "engineer") {
      coach(...say(["Make a guess first", "Before you plug in this cable, pick what you think will happen. Scientists predict first!"], ["Prediction first", "Commit to a prediction in the mission panel before installing this cable."]), "warn");
      const p = document.querySelector(".predict"); if (p) { p.scrollIntoView({behavior: REDUCED ? "auto" : "smooth", block: "center"}); p.animate?.([{boxShadow: "0 0 0 0 transparent"}, {boxShadow: "0 0 0 6px var(--magenta)"}, {boxShadow: "0 0 0 0 transparent"}], {duration: 900}); }
      return;
    }
    S.link[s.link] = "up";
  }
  if (a === "toggle") { S.link[s.link] = S.link[s.link] === "up" ? "shut" : "up";
    if (s.link === "L4") { if (S.link.L4 === "shut") S.seen.L4shut = true; else if (S.seen.L4shut) S.seen.L4cycled = true; } }
  if (a === "remove") S.link[s.link] = "absent";
  if (a === "stp") { S.stp[s.dev] = !S.stp[s.dev];
    if (s.dev === "ELD-NEW" && S.stp[s.dev] && ["L14", "L15", "L16"].every(id => S.link[id] === "absent")) S.seen.planStpFirst = true; }
  if (a === "bpdu") S.bpduPass = !S.bpduPass;
  if (a === "routed") setRouted(!S.routed);
  if (a === "sendfrom") { $("src").value = s.dev; send(); return; }
  recompute();
}

/* ---- missions */
function renderNav() {
  const tr = track(), nav = $("mnav"); nav.innerHTML = "";
  $("trackName").textContent = T("track"); $("trackCount").textContent = `${Object.keys(done[trackKey()] || {}).length} of ${tr.length} done`;
  tr.forEach((m, i) => { const b = document.createElement("button");
    b.className = (i === S.mission ? "current " : "") + (done[trackKey()][i] ? "done" : "");
    b.setAttribute("aria-label", `${i + 1}. ${m.title}${done[trackKey()][i] ? " (complete)" : ""}`); b.title = m.title;
    b.onclick = () => openMission(i); nav.appendChild(b); });
}
function openMission(i) {
  const tr = track(); i = Math.max(0, Math.min(i, tr.length - 1));
  S.mission = i; S.seen = {}; S.stepDone = []; S.predicted = null; S.hints = 0; S.predResult = null; S.containS = null; storeSet("m_" + trackKey(), i);
  anim = null; particles = []; prevRegime = null; held = 0;
  preset(tr[i].preset);
  if (trackKey() === "full" && i === 7) S.seen.planStart = true;
  if (S.mode === "engineer") $("matrixBox").open = true;
  renderMission(); renderNav(); renderAll();
}
function renderMission() {
  const tr = track(), i = S.mission, m = tr[i], eng = S.mode === "engineer", plain = S.mode === "plain";
  const el = $("mission");
  el.innerHTML = `<div><div class="num">${plain ? "Chapter" : "Mission"} ${i + 1} of ${tr.length}</div><h2>${m.title}</h2></div>
    ${!eng ? `<div class="idea"><h3>${plain ? "The idea" : "Key idea"}</h3><p>${termHTML(m.idea)}</p></div>` : ""}
    ${m.body ? `<div class="body"><p>${termHTML(m.body)}</p></div>` : ""}
    <ul class="steps" id="steps">${m.steps.map((s, k) => `<li data-k="${k}"><span class="tick">${k + 1}</span><span class="txt">${termHTML(s.text)}</span>${s.show ? `<button class="show" data-k="${k}">Show me</button>` : "<span></span>"}</li>`).join("")}</ul>
    ${m.predict && !eng ? `<div class="predict" id="predict"><h3>${plain ? "Your guess" : "Predict first"}</h3><p>${m.predict.q}</p><div class="opts">${m.predict.options.map((o, k) => `<button data-o="${k}">${o}</button>`).join("")}</div><div class="reveal" id="reveal" hidden></div></div>` : ""}
    ${m.fact ? `<p class="fact">${m.fact}</p>` : ""}
    ${!eng && m.hints ? `<div class="hints" id="hints"><button id="hintBtn">Show a hint</button></div>` : ""}
    <div class="complete" id="complete" hidden><span>✓ ${plain ? "Chapter" : "Mission"} complete</span>${i < tr.length - 1 ? `<button id="next2">Next ${plain ? "chapter" : "mission"}</button>` : ""}</div>
    <div class="q"><label for="ans">${m.q}</label><textarea id="ans" placeholder="Your answer (saved in this browser only)"></textarea></div>
    <div class="mrow"><button id="reset">Reset this ${plain ? "chapter" : "mission"}</button>${i < tr.length - 1 ? `<button id="next">Next</button>` : ""}</div>`;
  const ans = $("ans"); ans.value = storeGet(`ans_${trackKey()}_${i}`, ""); S.ansLen = ans.value.trim().length;
  ans.oninput = () => { storeSet(`ans_${trackKey()}_${i}`, ans.value); S.ansLen = ans.value.trim().length; };
  $("reset").onclick = () => openMission(i);
  for (const id of ["next", "next2"]) if ($(id)) $(id).onclick = () => openMission(i + 1);
  el.querySelectorAll(".show").forEach(b => b.onclick = () => { const s = m.steps[+b.dataset.k].show; highlight = {...s, until: performance.now() + 4500};
    $("mapwrap").scrollIntoView({behavior: REDUCED ? "auto" : "smooth", block: "center"}); if (s.link) select({link: s.link}); });
  el.querySelectorAll(".predict .opts button").forEach(b => b.onclick = () => { S.predicted = +b.dataset.o;
    el.querySelectorAll(".predict .opts button").forEach(x => { x.classList.toggle("pick", x === b); x.disabled = true; });
    $("reveal").hidden = false; $("reveal").innerHTML = `<b>${plain ? "Guess locked in." : "Locked in."}</b> ${plain ? "Now plug in the cable and see." : "Now install the cable and test it."}`; updateSteps(); });
  if ($("hintBtn")) $("hintBtn").onclick = () => { if (S.hints < m.hints.length) { const p = document.createElement("p"); p.textContent = "Hint: " + m.hints[S.hints++]; $("hints").insertBefore(p, $("hintBtn")); }
    $("hintBtn").textContent = S.hints < m.hints.length ? "Show another hint" : "No more hints"; $("hintBtn").disabled = S.hints >= m.hints.length; };
  updateSteps();
}
function updateSteps() {
  const m = track()[S.mission]; if (!m || !$("steps") || $("steps").children.length !== m.steps.length || !$("complete")) return;
  let next = -1;
  m.steps.forEach((s, k) => { let ok = false; try { ok = !!s.check(); } catch {} if (ok) S.stepDone[k] = true; });
  const items = $("steps").children;
  m.steps.forEach((s, k) => { const li = items[k], d = !!S.stepDone[k]; if (!d && next < 0) next = k;
    li.classList.toggle("done", d); li.querySelector(".tick").textContent = d ? "✓" : k + 1; });
  [...items].forEach((li, k) => li.classList.toggle("next", k === next));
  highlight = next >= 0 && m.steps[next].show && S.mode !== "engineer" ? {...m.steps[next].show} : (highlight && highlight.until ? highlight : null);
  if (m.predict && S.predicted !== null && S.link[m.predict.gate] === "up" && $("reveal") && !$("reveal").dataset.shown) {
    const right = S.predicted === m.predict.answer; $("reveal").dataset.shown = "1"; S.predResult = right ? "right" : "wrong";
    $("reveal").innerHTML = `<b>${right ? "You called it." : "Not quite."}</b> ${m.predict.explain}`;
  }
  const all = m.steps.every((s, k) => S.stepDone[k]);
  $("complete").hidden = !all;
  if (all && !done[trackKey()][S.mission]) { done[trackKey()][S.mission] = true; storeSet("done", done); renderNav();
    burstConfetti(); banner(S.mode === "plain" ? "CHAPTER COMPLETE" : "MISSION COMPLETE", PAL.good);
    coach(...say(["Nice work!", "Write your answer below, then go to the next chapter."], ["Mission complete", "Answer the question in the panel, then move on."]), "good"); }
}

/* ---- glossary */
const gloss = $("gloss");
function hideGloss() { gloss.hidden = true; }
document.addEventListener("click", e => {
  const t = e.target.closest(".term");
  if (!t) { if (!e.target.closest("#gloss")) hideGloss(); return; }
  const g = GLOSS[t.dataset.g]; S.seen["g_" + t.dataset.g] = true;
  const def = S.mode === "plain" ? g.p : g.s;
  gloss.innerHTML = `<b>${g.t}</b>${def}${g.a ? `<div class="an">${g.a}</div>` : ""}`;
  gloss.hidden = false;
  const r = t.getBoundingClientRect(), w = Math.min(320, innerWidth - 32);
  gloss.style.left = Math.max(16, Math.min(innerWidth - w - 16, r.left + scrollX)) + "px"; gloss.style.top = (r.bottom + scrollY + 8) + "px";
  updateSteps();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") { hideGloss(); $("coach").hidden = true; } });

/* ---- toolbar, mode, map clicks */
function renderToolbar() {
  $("srcK").textContent = T("srcK"); $("send").textContent = T("send");
  $("mode").textContent = S.live ? T("live") : T("slow"); $("mode").setAttribute("aria-pressed", S.live);
  $("chatter").textContent = `${T("chatter")}: ${S.chatter ? "on" : "off"}`; $("chatter").setAttribute("aria-pressed", S.chatter);
  $("drain").textContent = T("drain");
  const cur = $("src").value || "ZFW-VOICE";
  $("src").innerHTML = Object.keys(DEV).filter(d => DEV[d].kind === "host").map(h => `<option value="${h}" ${h === cur ? "selected" : ""}>${devName(h)}</option>`).join("");
  document.querySelectorAll(".modes button").forEach(b => b.setAttribute("aria-pressed", b.dataset.mode === S.mode));
  $("matrixBox").hidden = S.mode === "plain";
  const plain = S.mode === "plain";
  $("legend").innerHTML = `<span><i class="sw"></i>${plain ? "working cable" : "cable up"}</span><span><i class="sw s"></i>${plain ? "switched off" : "shut down"}</span>
    <span><i class="sw d"></i>${plain ? "not plugged in · click it" : "not installed · click to install"}</span><span><i class="sw p"></i>${plain ? "part of a circle" : "on a loop"}</span>
    <span><i class="sw l"></i>${plain ? "stuck messages" : "storm traffic"}</span>
    <span><svg width="16" height="16" aria-hidden="true"><rect x="1" y="1" width="14" height="14" rx="3" style="fill:var(--panel);stroke:var(--ink);stroke-width:1.5"/><path d="M5 5 L11 11 M11 5 L5 11" style="stroke:var(--ink);stroke-width:1.5"/></svg>${plain ? "road closed by loop guard" : "port blocked by spanning tree"}</span>
    <span class="badge">${HIC ? "HTML-in-Canvas ✓" : "standard rendering"}</span>`;
}
function setMode(m) {
  const wasPlain = S.mode === "plain"; S.mode = m; storeSet("mode", m); bgDirty = true; saidBlocked = false;
  if (wasPlain !== (m === "plain")) openMission(storeGet("m_" + trackKey(), 0)); else { renderMission(); renderNav(); renderAll(); }
}
document.querySelectorAll(".modes button").forEach(b => b.onclick = () => setMode(b.dataset.mode));
fx.addEventListener("click", e => {
  const r = fx.getBoundingClientRect(), x = (e.clientX - r.left) / K, y = (e.clientY - r.top) / K;
  let best = null, bd = 14;
  for (const l of LINKS) { if (!linkVisible(l)) continue; for (let i = 0; i <= 40; i++) { const [px, py] = pointOn(l, i / 40, true); const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = l.id; } } }
  select(best ? {link: best} : null);
});

function send() {
  const host = $("src").value || "ZFW-VOICE";
  if (S.live) { S.broadcasts.push({t: nowS(), host}); if (S.broadcasts.length > 400) S.broadcasts.shift();
    if (M.regime === "AMPLIFYING") S.seen.liveAmp = true; if (M.regime === "CIRCULATING") S.seen.liveCirc = true;
    const [x, y] = [DEV[host].x, DEV[host].y]; wave(x, y, PAL.accent, 60, 700); updateSteps(); return; }
  S.seen.sentSlow = true; if (host === "ZFW-VOICE") S.seen.sentZFW = true; if (M.regime !== "TREE") S.seen.slowLoop = true;
  const xs = [inject(host)]; for (let k = 0; k < 40; k++) { const nx = step(xs[k]); if (!nx.some(v => v)) break; xs.push(nx); }
  anim = {xs, start: performance.now()}; wave(DEV[host].x, DEV[host].y, PAL.magenta, 60, 700); updateSteps();
}
$("send").onclick = send;
$("src").onchange = () => renderAll();
$("mode").onclick = () => { S.live = !S.live; anim = null; renderAll(); updateSteps(); };
$("chatter").onclick = () => { S.chatter = !S.chatter; if (S.chatter) S.live = true; renderAll(); updateSteps(); };
$("drain").onclick = () => { S.broadcasts = []; S.history = []; particles = []; renderAll(); };
$("matrixBox").addEventListener("toggle", () => drawMatrix(null));

/* ---- intro */
let introRAF = null;
function showIntro() {
  const intro = $("intro"); intro.hidden = false;
  const cv = $("introfx"), c = cv.getContext("2d"), t0 = performance.now();
  const blips = Array.from({length: 22}, () => ({a: Math.random() * 6.283, r: .2 + Math.random() * .75}));
  const tick = now => {
    const w = cv.width = innerWidth * DPR, h = cv.height = innerHeight * DPR, R = Math.min(w, h) * .48, cx = w * .78, cy = h * .5;
    c.clearRect(0, 0, w, h); c.strokeStyle = "rgba(120,170,200,.10)"; c.lineWidth = DPR;
    for (let k = 1; k <= 4; k++) { c.beginPath(); c.arc(cx, cy, R * k / 4, 0, 6.283); c.stroke(); }
    const ang = REDUCED ? 0 : ((now - t0) / 2200) * 6.283 % 6.283;
    for (let k = 0; k < 40; k++) { c.fillStyle = `rgba(226,117,173,${.09 * (1 - k / 40)})`; c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, R, ang - k * .02 - .02, ang - k * .02); c.fill(); }
    const stormy = (now - t0) > 1900;
    for (const b of blips) { const d = ((ang - b.a) % 6.283 + 6.283) % 6.283; const a = Math.max(0, 1 - d / 2.5);
      c.fillStyle = stormy ? `rgba(255,90,90,${.25 + .75 * a})` : `rgba(140,220,170,${.2 + .8 * a})`;
      c.beginPath(); c.arc(cx + Math.cos(b.a) * R * b.r, cy + Math.sin(b.a) * R * b.r, 3 * DPR, 0, 6.283); c.fill(); }
    const k = Math.min(1, Math.max(0, (now - t0 - 2900) / 2200)); $("flights").textContent = Math.round(12462 * (1 - Math.pow(1 - k, 3))).toLocaleString();
    introRAF = requestAnimationFrame(tick);
  };
  introRAF = requestAnimationFrame(tick);
}
function closeIntro(mode) { $("intro").hidden = true; cancelAnimationFrame(introRAF); storeSet("intro", true); if (mode) setMode(mode); }
document.querySelectorAll(".intro .who button").forEach(b => b.onclick = () => closeIntro(b.dataset.mode));
$("skip").onclick = () => closeIntro(null);
$("replay").onclick = () => showIntro();

/* ========================================================================
   10. MAIN LOOP
   ======================================================================== */
function recompute() { buildModel(); onModelChange(); renderAll(); }
let lastLoads = null;
function renderAll() {
  if (!M) return;
  const loads = S.live ? linkLoads(nowS()).load : null; lastLoads = loads;
  renderToolbar(); renderStrip(loads); renderReadouts(loads); renderInspector(); renderChart(); updateSteps(); drawMatrix(null);
}
let lastTick = 0, lastChat = 0;
function frame() {
  requestAnimationFrame(frame);
  try { tickFrame(performance.now()); } catch (err) { console.warn(err); }
}
function tickFrame(t) {
  if (S.live) { const n = nowS();
    if (S.chatter && n - lastChat > .5) { lastChat = n; const hosts = Object.keys(DEV).filter(d => DEV[d].kind === "host");
      S.broadcasts.push({t: n, host: hosts[Math.floor(Math.random() * hosts.length)]}); if (S.broadcasts.length > 400) S.broadcasts.shift(); } }
  const loads = drawFrame(t);
  if (Math.abs(rhoShown - rhoT) > 1e-4) { rhoShown += (rhoT - rhoShown) * (REDUCED ? 1 : .12); if (Math.abs(rhoShown - rhoT) < 1e-3) rhoShown = rhoT;
    $("rho").textContent = rhoShown < 1e-6 ? "0" : rhoShown.toFixed(rhoShown === rhoT ? 3 : 2).replace(/\.?0+$/, ""); }
  if (t - lastTick > 200) { lastTick = t;
    if (S.live) { let busy = 0; if (loads) for (const x of loads) busy = Math.max(busy, x); const n = nowS();
      S.history.push([n, busy]); S.history = S.history.filter(h => h[0] > n - 21);
      const z = new Date(Date.UTC(2026, 10, 13, 20, 36) + n * 1000); $("zulu").textContent = String(z.getUTCHours()).padStart(2, "0") + String(z.getUTCMinutes()).padStart(2, "0") + "Z"; }
    renderStrip(loads); renderReadouts(loads); renderChart(); updateSteps(); }
}
fx.addEventListener("paint", () => drawFrame(performance.now()));

readPalette();
S.mode = storeGet("mode", "student");
$("hicNote").textContent = HIC ? "Device cards are real HTML buttons painted into the map canvas with the HTML-in-Canvas API." : "Tip: open this page in Microsoft Edge or Chrome 157 or newer to get the full HTML-in-Canvas effects.";
resize();
openMission(storeGet("m_" + trackKey(), 0));
if (!storeGet("intro", false)) showIntro();
requestAnimationFrame(frame);
