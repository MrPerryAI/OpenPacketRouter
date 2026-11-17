/* ========================================================================
   11. SCORING, SCOREBOARD, SCORE REPORT
   Points per mission attempt (the best attempt counts):
     10 per step · 100 for finishing · prediction 50 right / 15 for trying
     25 for a written answer (15+ characters) · ground stop containment
     bonus 150 minus 3 per second · clean change plan +100 · minus 10 per hint
   Scoreboard backends, tried in order:
     1. the published Claude page's shared store (db + user capabilities)
     2. a class server (server/ in the repo, e.g. Docker on the teacher's Mac)
     3. this device only
   ======================================================================== */
const POINTS = {step: 10, finish: 100, predRight: 50, predTry: 15, answer: 25, containMax: 150, containPerSec: 3, plan: 100, hint: 10};
let best = storeGet("best", {plain: {}, full: {}});
function attempt() {
  const m = track()[S.mission]; const steps = m.steps.filter((s, k) => S.stepDone[k]).length;
  const r = {title: m.title, steps, of: m.steps.length, complete: steps === m.steps.length, pred: S.predResult || null, hints: S.hints,
    answer: (S.ansLen || 0) >= 15, contain: S.containS ?? null, plan: !!S.seen.planRun};
  let p = POINTS.step * steps + (r.complete ? POINTS.finish : 0) + (r.pred ? (r.pred === "right" ? POINTS.predRight : POINTS.predTry) : 0)
    + (r.answer ? POINTS.answer : 0) + (r.contain != null ? Math.max(0, POINTS.containMax - POINTS.containPerSec * r.contain) : 0) + (r.plan ? POINTS.plan : 0) - POINTS.hint * r.hints;
  r.pts = Math.max(0, Math.round(p)); return r;
}
function totals() {
  let total = 0, done = 0, contain = null;
  for (const tk of ["plain", "full"]) for (const r of Object.values(best[tk] || {})) { total += r.pts; if (r.complete) done++; if (r.contain != null) contain = contain == null ? r.contain : Math.min(contain, r.contain); }
  return {total, done, contain};
}
let shownScore = 0;
function scoreTick() {
  const a = attempt(), tk = trackKey(), cur = best[tk][S.mission];
  if (!cur || a.pts > cur.pts) { best[tk][S.mission] = a; storeSet("best", best); }
  const t = totals(); if (t.total !== shownScore) { shownScore = t.total; $("scoreV").textContent = t.total.toLocaleString(); queuePost(); }
}

/* ---- scoreboard */
const Board = {kind: "local", rows: [], me: null, names: {}, isOwner: false, note: ""};
let postTimer = null, posting = false, lastPosted = "";
function queuePost() { clearTimeout(postTimer); postTimer = setTimeout(postScore, 1500); }
async function postScore() {
  if (posting) return queuePost(); const t = totals(); const body = {total: t.total, done: t.done, contain: t.contain};
  const key = JSON.stringify(body); if (key === lastPosted || Board.kind === "local") return;
  posting = true;
  try {
    if (Board.kind === "claude") await Board.db.doc("scores/" + Board.me).set({...body, updated: Date.now()});
    else if (Board.kind === "server") { const name = storeGet("bname", ""); if (!name) { posting = false; renderBoard(); return; }
      const r = await fetch("./api/scores", {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({id: Board.me, name, ...body})});
      if (!r.ok) throw new Error("server " + r.status); pollServer(); }
    lastPosted = key; Board.note = "";
  } catch (e) {
    Board.note = Board.kind === "claude" ? "Your score couldn't be posted. Ask your teacher to give you Contributor access to this page." : "The class server didn't accept your score. Check the connection.";
  }
  posting = false; renderBoard();
}
async function initBoard() {
  if (window.claude && typeof window.claude.use === "function") {
    try {
      const [db, user] = await Promise.all([claude.use("db"), claude.use("user")]);
      if (db && user) { const me = await user.me();
        if (me.id) { Object.assign(Board, {kind: "claude", db, user, me: me.id, isOwner: me.isOwner});
          let loaded = false; const timer = setTimeout(() => { if (!loaded) { Board.note = "The scoreboard can't be reached yet."; renderBoard(); } }, 10000);
          db.collection("scores").orderBy("total", "desc").limit(100).onSnapshot(snap => {
            if (!snap.metadata.fromCache) { loaded = true; clearTimeout(timer); if (Board.note.startsWith("The scoreboard can't")) Board.note = ""; }
            Board.rows = snap.docs.filter(d => d.exists).map(d => ({id: d.id, ...d.data()})); renderBoard(); },
            () => { clearTimeout(timer); Board.note = "The scoreboard stopped updating. Reload the page to reconnect."; renderBoard(); });
          renderBoard(); queuePost(); return; } }
    } catch {}
  }
  if (location.protocol.startsWith("http")) try {
    const r = await fetch("./api/scores", {cache: "no-store"});
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) {
      let id = storeGet("sid", null); if (!id) { id = "s" + Math.random().toString(36).slice(2, 12); storeSet("sid", id); }
      Object.assign(Board, {kind: "server", me: id}); Board.rows = await r.json(); renderBoard(); setInterval(pollServer, 5000); queuePost(); return;
    }
  } catch {}
  Board.kind = "local"; renderBoard();
}
async function pollServer() { try { const r = await fetch("./api/scores", {cache: "no-store"}); if (r.ok) { Board.rows = await r.json(); renderBoard(); } } catch {} }
const shortName = n => { const p = (n || "").trim().split(/\s+/); return p.length > 1 ? `${p[0]} ${p[p.length - 1][0]}.` : (p[0] || ""); };
async function nameFor(row) {
  if (Board.kind === "server") return row.name || "Student";
  if (Board.kind === "claude") { if (!(row.id in Board.names)) { try { const ps = await Board.user.profiles([row.id]); Board.names[row.id] = shortName(ps[row.id] && ps[row.id].name); } catch { Board.names[row.id] = ""; } }
    return Board.names[row.id] || "Student"; }
  return "You";
}
let boardRendering = false, boardAgain = false, clearArm = 0;
async function renderBoard() {
  if (boardRendering) { boardAgain = true; return; } boardRendering = true;
  const body = $("boardBody"), mode = $("boardMode");
  mode.textContent = {claude: "Live", server: "Live · class server", local: "This device only"}[Board.kind];
  const t = totals(); let rows = Board.rows.slice();
  if (Board.kind === "local") rows = [{id: "me", total: t.total, done: t.done, contain: t.contain}];
  if (Board.me && !rows.some(r => r.id === Board.me)) rows.push({id: Board.me, total: t.total, done: t.done, contain: t.contain});
  rows.forEach(r => { if (r.id === Board.me) Object.assign(r, {total: t.total, done: t.done, contain: t.contain}); });
  rows.sort((a, b) => (b.total || 0) - (a.total || 0));
  const myRank = rows.findIndex(r => r.id === Board.me || r.id === "me") + 1;
  const top = rows.slice(0, 10); if (myRank > 10) top.push(rows[myRank - 1]);
  const ol = document.createElement("ol");
  for (const r of top) {
    const li = document.createElement("li"); if (r.id === Board.me || r.id === "me") li.className = "me";
    const rk = document.createElement("span"); rk.className = "rk"; rk.textContent = rows.indexOf(r) + 1;
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = (r.id === Board.me && Board.kind !== "local") ? `${await nameFor(r)} (you)` : await nameFor(r);
    const sm = document.createElement("small"); sm.textContent = `${r.done || 0} missions${r.contain != null ? ` · contained in ${r.contain} s` : ""}`; nm.appendChild(sm);
    const pts = document.createElement("span"); pts.className = "pts"; pts.textContent = (r.total || 0).toLocaleString();
    li.append(rk, nm, pts); ol.appendChild(li);
  }
  body.replaceChildren(ol);
  if (Board.kind === "server" && !storeGet("bname", "")) {
    const wrap = document.createElement("div"); wrap.innerHTML = `<label class="muted" for="bname">Your name on the board (first name and last initial)</label><input id="bname" maxlength="24" autocomplete="off">`;
    body.prepend(wrap); const inp = wrap.querySelector("input");
    inp.addEventListener("change", () => { const v = inp.value.trim().slice(0, 24); if (v) { storeSet("bname", v); lastPosted = ""; postScore(); } });
  }
  if (Board.kind === "local") { const p = document.createElement("p"); p.className = "muted";
    p.textContent = "Scores are shared when this lab is opened from your teacher's published link or the class server."; body.appendChild(p); }
  if (Board.note) { const p = document.createElement("p"); p.className = "muted"; p.style.color = "var(--crit)"; p.textContent = Board.note; body.appendChild(p); }
  if (Board.kind === "claude" && Board.isOwner && Board.rows.length) {
    const b = document.createElement("button"); b.textContent = clearArm > Date.now() ? "Click again to clear every score" : "Clear scoreboard (teacher)";
    b.onclick = async () => { if (clearArm > Date.now()) { clearArm = 0; for (const r of Board.rows) { try { await Board.db.doc("scores/" + r.id).delete(); } catch {} } }
      else { clearArm = Date.now() + 4000; setTimeout(renderBoard, 4100); } renderBoard(); };
    body.appendChild(b);
  }
  boardRendering = false; if (boardAgain) { boardAgain = false; renderBoard(); }
}

/* ---- score report */
function reportText(name) {
  const t = totals(); const lines = [`El Dorado Storm Lab · score report`, `${name}`, `Total: ${t.total} points · ${t.done} missions complete${t.contain != null ? ` · best containment ${t.contain} s` : ""}`, ""];
  for (const [tk, label, list] of [["full", "Student missions", TRACKS.full], ["plain", "Plain English story", TRACKS.plain]]) {
    const rs = list.map((m, i) => [i, best[tk][i]]).filter(([, r]) => r); if (!rs.length) continue;
    lines.push(label); for (const [i, r] of rs) lines.push(`  ${i + 1}. ${r.title}: ${r.pts} pts (${r.steps}/${r.of} steps${r.complete ? ", complete" : ""}${r.pred ? ", prediction " + r.pred : ""}${r.hints ? ", " + r.hints + " hints" : ""}${r.contain != null ? ", contained in " + r.contain + " s" : ""}${r.plan ? ", clean plan" : ""})`);
    lines.push("");
  }
  return lines.join("\n");
}
async function openReport() {
  const t = totals(); let name = "You";
  if (Board.kind === "claude") { try { const me = await Board.user.me(); name = me.name || "You"; } catch {} } else if (Board.kind === "server") name = storeGet("bname", "") || "You";
  const rows = Board.kind === "local" ? [] : Board.rows; const rank = rows.length ? [...rows, {id: Board.me, total: t.total}].filter((r, i, a) => a.findIndex(x => x.id === r.id) === i).sort((a, b) => (b.total || 0) - (a.total || 0)).findIndex(r => r.id === Board.me) + 1 : 0;
  const table = (tk, label, list) => { const rs = list.map((m, i) => [i, m, best[tk][i]]);
    if (!rs.some(([, , r]) => r)) return "";
    return `<h3>${label}</h3><div class="tbl"><table><thead><tr><th>${tk === "plain" ? "Chapter" : "Mission"}</th><th class="n">Steps</th><th>Prediction</th><th class="n">Hints</th><th>Answer</th><th>Bonus</th><th class="n">Points</th></tr></thead><tbody>
      ${rs.map(([i, m, r]) => r ? `<tr><td>${i + 1}. ${m.title}${r.complete ? " ✓" : ""}</td><td class="n">${r.steps}/${r.of}</td><td>${r.pred === "right" ? "✓ right" : r.pred === "wrong" ? "tried" : "—"}</td><td class="n">${r.hints}</td><td>${r.answer ? "✓" : "—"}</td><td>${r.contain != null ? `contained in ${r.contain} s` : r.plan ? "clean plan" : "—"}</td><td class="n">${r.pts}</td></tr>`
        : `<tr><td>${i + 1}. ${m.title}</td><td class="n">—</td><td>—</td><td class="n">—</td><td>—</td><td>—</td><td class="n">0</td></tr>`).join("")}</tbody></table></div>`; };
  const sheet = $("reportSheet");
  sheet.innerHTML = `<div class="head"><div><h3>Score report</h3><h2 id="reportTitle"></h2></div><div style="text-align:right"><div class="big">${t.total.toLocaleString()}</div><span class="muted">points${rank ? ` · rank ${rank} of ${Math.max(rank, rows.length)}` : ""}</span></div></div>
    <dl class="kv" style="max-width:420px"><dt>Missions complete</dt><dd>${t.done}</dd><dt>Best ground stop containment</dt><dd>${t.contain != null ? t.contain + " s" : "—"}</dd></dl>
    ${table("full", "Student missions", TRACKS.full)}${table("plain", "Plain English story", TRACKS.plain)}
    <p class="rules">How points work: 10 per step · 100 for finishing a mission · predictions 50 if right, 15 for committing · 25 for a written answer · up to 150 for containing the ground stop fast (minus 3 per second) · 100 for a clean change plan · minus 10 per hint. Your best attempt at each mission counts.</p>
    <div class="mrow"><button class="primary" id="copyReport">Copy report</button><button id="closeReport">Close</button></div>
    <textarea id="reportText" readonly hidden></textarea>`;
  $("reportTitle").textContent = name;
  const txt = reportText(name);
  $("copyReport").onclick = () => { const ta = $("reportText");
    navigator.clipboard?.writeText(txt).then(() => { $("copyReport").textContent = "Copied"; }, () => { ta.hidden = false; ta.value = txt; ta.select(); $("copyReport").textContent = "Select the text and copy it"; })
      ?? (ta.hidden = false, ta.value = txt, ta.select()); };
  $("closeReport").onclick = closeReport; $("report").hidden = false; $("closeReport").focus();
}
function closeReport() { $("report").hidden = true; $("reportBtn").focus(); }
$("reportBtn").onclick = openReport;
$("report").addEventListener("click", e => { if (e.target.id === "report") closeReport(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("report").hidden) closeReport(); });
setInterval(scoreTick, 500);
shownScore = -1; scoreTick();
initBoard();
