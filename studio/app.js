// OpenPacketRouter Studio: load a spec, draw it, run its actions on the engine and play the frames back.
import {validateSpec, validateActions} from "../engine/src/spec.js";
import {simulate, analyse} from "./sim.js";
import {autoLayout} from "./layout.js";
import * as ed from "./editor.js";
import {parseData, dumpYaml} from "../engine/src/yaml.js";
import {EXAMPLES} from "./examples.js";
import {renderGuide} from "./guide.js";
import {createSession} from "../cli/src/index.js";
import {engineBackend} from "../cli/src/backends/engine.js";

const $ = s => document.querySelector(s);
const SVG = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, parent = null) => { const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (parent) parent.appendChild(e); return e; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"})[c]);
const KINDS = ["arp", "icmp", "tcp", "udp", "dhcp", "dns", "ntp", "syslog", "http", "bpdu", "lacp", "rip", "ripng", "ospf", "lldp", "icmp6", "ndp", "vrrp"];
const KIND_LABEL = {bpdu: "STP", icmp6: "ICMPv6", ndp: "IPv6 ND"};   // the filter and the list say STP for spanning-tree BPDUs
const kindName = k => KIND_LABEL[k] || k.toUpperCase();
const VLAN_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#ca8a04", "#db2777"];
const vlanColor = v => v === 1 ? "#98a2b3" : VLAN_COLORS[(v * 7) % VLAN_COLORS.length];
const HALF = {switch: [34, 16], router: [24, 24], server: [24, 22], host: [28, 18]};   // half width/height of each device shape
const ms = t => `${(t * 1000).toFixed(t < 0.01 ? 3 : 1)} ms`;

export const S = {hidden: new Set(), sessions: new Map(), console: null, spec: null, actions: [], name: "", cut: new Set(), sim: null, an: null, pos: {}, step: -1,
  playing: false, speed: 1, selected: null, timer: null, anim: null, error: null, tool: "select", pending: null};

// ---------------------------------------------------------------- loading

async function fetchJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }

/** The example list: examples/index.json when it exists, else the built-in list. */
async function exampleList() {
  try {
    const idx = await fetchJson("../examples/index.json");
    if (Array.isArray(idx.labs)) return idx.labs.map(l => ({id: l.id, title: l.name || l.id,
      spec: new URL(l.spec, new URL("../examples/", location.href)).href, actions: l.actions && new URL(l.actions, new URL("../examples/", location.href)).href}));
  } catch { /* not there yet */ }
  return EXAMPLES.map(e => ({...e, spec: `../examples/${e.id}/spec.json`, actions: `../examples/${e.id}/actions.json`}));
}

async function loadExample(ex) {
  const spec = await fetchJson(ex.spec);
  const actions = ex.actions ? await fetchJson(ex.actions).catch(() => []) : [];
  load(spec, actions, ex.id);
  showGuide(ex, spec);
}

/** The lab's student guide (README.md next to spec.json) in the side panel; hidden when there is none. */
async function showGuide(ex, spec) {
  const box = $("#guideBox"); box.hidden = true; $("#guideBody").innerHTML = "";
  try {
    const r = await fetch(new URL("README.md", new URL(ex.spec, location.href))); if (!r.ok) return;
    const names = spec.nodes.map(n => n.name), first = (spec.nodes.find(n => n.kind === "router") || spec.nodes.find(n => n.kind !== "switch") || {}).name || null;
    $("#guideBody").innerHTML = renderGuide(await r.text(), names, first); box.hidden = false;
    for (const b of $("#guideBody").querySelectorAll(".run-cmd")) b.addEventListener("click", () => runInConsole(b.dataset.device, b.dataset.cmd));
  } catch { /* no guide: nothing to show */ }
}

/** Type a guide command into a device's console tab and press Enter. */
export function runInConsole(device, cmd) {
  if (!S.spec.nodes.some(n => n.name === device)) return false;
  openConsole(device); const inp = $("#consoleInput"); inp.value = cmd;
  consoleKey({key: "Enter", target: inp, preventDefault() {}}); return true;
}

/** Show a spec. Problems with the spec or the actions are listed instead of thrown. */
export function load(spec, actions = [], name = "") {
  stop();
  const v = validateSpec(spec);
  const errs = v.errors.map(e => `spec ${e.path}: ${e.message}`);
  if (v.ok) for (const e of validateActions(actions, spec).errors) errs.push(`actions ${e.path}: ${e.message}`);
  showErrors(errs.concat(v.warnings.map(w => `warning: spec ${w.path}: ${w.message}`)));
  if (!v.ok) return false;
  S.spec = spec; S.actions = errs.length ? [] : actions; S.name = name; S.cut = new Set(); S.selected = null;
  S.sessions = new Map(); closeConsole();
  { const g = $("#guideBox"); if (g) g.hidden = true; }   // a guide belongs to the example it came with; loadExample shows it again
  S.loading = true;
  S.pos = savedLayout(spec) || autoLayout(spec);
  $("#title").innerHTML = `${esc(spec.name || name || "Untitled network")}${spec.about ? `<small>${esc(spec.about)}</small>` : ""}`;
  rerun(); S.loading = false;
  return true;
}

// ---------------------------------------------------------------- save, export, autosave

const AUTOSAVE = "studio-autosave";
/** Remember the network in this browser after every change (not after a plain load). Storage may be full or off: never throw. */
function autosave() {
  try { localStorage.setItem(AUTOSAVE, JSON.stringify({spec: S.spec, actions: S.actions, name: S.name, pos: S.pos})); showRestore(); } catch { /* ignore */ }
}
function readAutosave() {
  try { const a = JSON.parse(localStorage.getItem(AUTOSAVE)); return a && a.spec && Array.isArray(a.spec.nodes) ? a : null; } catch { return null; }
}
function showRestore() { const b = $("#restore"); if (b) b.hidden = !readAutosave(); }
export function restoreAutosave() {
  const a = readAutosave(); if (!a) return false;
  if (!load(a.spec, a.actions || [], a.name || "")) return false;
  if (a.pos && a.spec.nodes.every(n => a.pos[n.name])) { S.pos = a.pos; drawMap(); }
  $("#examples").value = ""; return true;
}

/** The spec as the JSON a file would hold (two-space indent, trailing newline). */
export const specJson = () => JSON.stringify(S.spec, null, 2) + "\n";
function download(filename, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], {type}));
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileBase = () => ((S.spec && S.spec.name) || S.name || "network").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "network";

function showErrors(list) { const e = $("#errors"); e.hidden = !list.length; e.textContent = list.join("\n"); }

/** Run the engine again (after loading, or when a cable is cut or restored). */
export function rerun() {
  stop();
  const cut = [...S.cut];
  try {
    S.an = analyse(S.spec, {cut});
    S.sim = simulate(S.spec, S.actions, {cut});
  } catch (e) { showErrors([String(e.message || e)]); S.sim = {actions: [], steps: [], routes: {}, final: {}}; }
  S.step = -1;
  drawMap(); drawStorm(); drawActions(); drawFilters(); drawEvents(); showStep(); drawDevice();
  if (!S.loading) autosave();
}

const layoutKey = spec => "studio-layout:" + (spec.name || "") + ":" + spec.nodes.map(n => n.name).join(",");
function savedLayout(spec) {
  try { const p = JSON.parse(localStorage.getItem(layoutKey(spec)));
    return p && spec.nodes.every(n => p[n.name]) ? p : null; } catch { return null; }
}

// ---------------------------------------------------------------- map

function linkInfo(l, idx) {
  const [a, b] = [l[0], l[1]].map(r => { const [node, iface] = r.split(":"); return {node, iface}; });
  const vl = end => { const n = S.spec.nodes.find(x => x.name === end.node); if (!n || n.kind !== "switch" || !n.vlans) return null;
    const c = n.vlans[end.iface] || {access: 1}; return c.access !== undefined ? {access: c.access} : {trunk: c.trunk, native: c.native}; };
  const va = vl(a), vb = vl(b), trunk = (va && va.trunk) || (vb && vb.trunk);
  const access = !trunk && ((va && va.access) || (vb && vb.access));
  return {idx, a, b, trunk, access, delay: l[2] ?? 1, shape: l[3]};
}

function portState(sw, port) {
  const node = S.spec.nodes.find(n => n.name === sw);
  if (node && node.blocked && node.blocked.includes(port)) return "blocked";
  const st = currentState(), d = st && st[sw];
  if (d && d.stp && d.stp.ports[port]) return d.stp.ports[port].state;
  return S.an ? S.an.ports[`${sw}:${port}`] || "forwarding" : "forwarding";
}

function drawMap() {
  const svg = $("#map"); svg.innerHTML = "";
  const gl = el("g", {class: "links"}, svg), gp = el("g", {class: "ports"}, svg), gn = el("g", {class: "nodes"}, svg);
  S.pktLayer = el("g", {class: "packets"}, svg);
  S.cableEls = {};
  S.spec.links.forEach((l, i) => {
    const info = linkInfo(l, i), p = S.pos[info.a.node], q = S.pos[info.b.node];
    if (!p || !q) return;
    const g = el("g", {class: "cable-group", "data-link": i}, gl);
    const cls = ["cable"]; if (info.trunk) cls.push("trunk"); if (S.cut.has(i)) cls.push("cut"); if (info.shape && (info.shape.loss || info.shape.lossBack)) cls.push("lossy");
    const line = el("line", {class: cls.join(" "), x1: p.x, y1: p.y, x2: q.x, y2: q.y, "data-link": i}, g);
    const hit = el("line", {class: "cable-hit", x1: p.x, y1: p.y, x2: q.x, y2: q.y}, g);   // wide, invisible, on top: easy to click
    if (info.access && !S.cut.has(i)) line.style.stroke = vlanColor(info.access);
    if (info.trunk && !S.cut.has(i)) line.style.stroke = "#475467";
    const title = el("title", {}, g);
    title.textContent = `${l[0]} — ${l[1]}, ${info.delay} ms` + (info.trunk ? `, trunk VLANs ${info.trunk.join(", ")}` : info.access ? `, VLAN ${info.access}` : "") +
      (info.shape ? `, shaped ${info.shape.shape?.rate ?? ""}` : "") + (info.shape && (info.shape.loss || info.shape.lossBack) ? ", lossy (frames can be dropped)" : "") + (S.cut.has(i) ? " (unplugged: click to plug back in)" : " (click to unplug)");
    hit.addEventListener("click", () => S.tool === "delete" ? edit(ed.removeLink(S.spec, i)) : S.tool === "select" ? toggleCut(i) : 0);
    hit.setAttribute("tabindex", "0"); hit.setAttribute("role", "button");
    hit.setAttribute("aria-label", `Cable ${l[0]} to ${l[1]}, ${S.cut.has(i) ? "unplugged. Enter plugs it back in" : "plugged in. Enter unplugs it"}`);
    hit.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); S.refocus = `link:${i}`; toggleCut(i); } });
    g.dataset.focusId = `link:${i}`;
    S.cableEls[i] = line;
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    if (S.cut.has(i)) { const t = el("text", {class: "cutmark", x: mx, y: my + 5, "text-anchor": "middle"}, g); t.textContent = "✂"; }
    else if (info.trunk || info.access > 1) {
      const t = el("text", {class: "vlan-label", x: mx + 6, y: my - 6}, g);
      t.textContent = info.trunk ? `trunk ${info.trunk.join(",")}` : `VLAN ${info.access}`;
    }
    // port labels and spanning-tree dots near each end
    for (const [end, from, to] of [[info.a, p, q], [info.b, q, p]]) {
      const d = Math.hypot(to.x - from.x, to.y - from.y) || 1, ux = (to.x - from.x) / d, uy = (to.y - from.y) / d;
      const n = S.spec.nodes.find(z => z.name === end.node);
      const [hw, hh] = HALF[n ? n.kind : "host"], edge = Math.min(hw / (Math.abs(ux) || 1e-9), hh / (Math.abs(uy) || 1e-9)) + 8;
      const x = from.x + ux * edge, y = from.y + uy * edge, lx = from.x + ux * (edge + 16), ly = from.y + uy * (edge + 16);
      const lbl = el("text", {class: "port", x: lx - uy * 9, y: ly + ux * 9 + 3, "text-anchor": "middle"}, gp); lbl.textContent = end.iface;
      if (n && n.kind === "switch") {
        const st = portState(end.node, end.iface);
        const dot = el("circle", {class: `port-dot ${st}`, cx: x, cy: y, r: 5, "data-port": `${end.node}:${end.iface}`}, gp);
        el("title", {}, dot).textContent = `${end.node} ${end.iface}: ${st}`;
      }
    }
  });
  for (const n of S.spec.nodes) {
    const p = S.pos[n.name]; if (!p) continue;
    const g = el("g", {class: `node ${n.kind}${S.selected === n.name ? " selected" : ""}${S.pending === n.name ? " pending" : ""}`, "data-node": n.name, transform: `translate(${p.x},${p.y})`}, gn);
    if (n.kind === "switch") el("rect", {class: "shape", x: -34, y: -16, width: 68, height: 32, rx: 4}, g);
    else if (n.kind === "router") el("circle", {class: "shape", r: 24}, g);
    else if (n.kind === "server") el("rect", {class: "shape", x: -24, y: -22, width: 48, height: 44, rx: 3}, g);
    else el("rect", {class: "shape", x: -28, y: -18, width: 56, height: 36, rx: 10}, g);
    const name = el("text", {class: "name", y: n.kind === "router" ? 4 : 2}, g); name.textContent = n.name;
    const sub = el("text", {class: "sub", y: n.kind === "router" ? 38 : 32}, g);
    const ip = n.ifaces ? Object.values(n.ifaces)[0] : null;
    sub.textContent = n.kind === "switch" ? (n.stp ? "switch · STP" : n.vlans ? "switch · VLANs" : "switch") : ip ? `${n.kind} · ${ip}` : n.kind;
    g.addEventListener("pointerdown", e => S.tool === "select" ? startDrag(e, n.name) : toolClick(n.name));
    g.addEventListener("dblclick", () => openConsole(n.name));
    g.setAttribute("tabindex", "0"); g.setAttribute("role", "button");
    g.setAttribute("aria-label", `${n.kind} ${n.name}${S.selected === n.name ? ", selected" : ""}. Enter selects, C opens the console, arrow keys move it.`);
    g.addEventListener("keydown", e => nodeKey(e, n.name));
  }
  restoreFocus();
}

/** Keyboard on a focused device: Enter/Space select, C opens its console, arrows move it (Shift: bigger steps), Escape clears the selection. */
function nodeKey(e, name) {
  const step = e.shiftKey ? 40 : 10, d = {ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step]}[e.key];
  if (d) { e.preventDefault(); e.stopPropagation(); const p = S.pos[name];
    S.pos[name] = {x: Math.max(30, Math.min(870, p.x + d[0])), y: Math.max(30, Math.min(530, p.y + d[1]))};
    S.refocus = name; drawMap(); try { localStorage.setItem(layoutKey(S.spec), JSON.stringify(S.pos)); } catch {} }
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); S.refocus = name; select(name); }
  else if (e.key === "c" || e.key === "C") { e.preventDefault(); openConsole(name); }
  else if (e.key === "Escape") { S.selected = null; S.refocus = name; drawMap(); drawDevice(); }
}
function restoreFocus() {
  const id = S.refocus; S.refocus = null; if (!id) return;
  const t = id.startsWith("link:") ? document.querySelector(`[data-focus-id="${id}"] .cable-hit`) : document.querySelector(`.node[data-node="${CSS.escape(id)}"]`);
  if (t) t.focus();
}

function startDrag(e, name) {
  const svg = $("#map"), pt = svg.createSVGPoint(), start = {x: e.clientX, y: e.clientY}; let moved = false;
  const toSvg = ev => { pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); };
  const move = ev => { if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4) moved = true;
    if (!moved) return; const q = toSvg(ev); S.pos[name] = {x: Math.round(q.x), y: Math.round(q.y)}; drawMap(); };
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
    if (moved) { try { localStorage.setItem(layoutKey(S.spec), JSON.stringify(S.pos)); } catch {} }
    else select(name); };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
}

export function toggleCut(i) {
  if (S.cut.has(i)) S.cut.delete(i); else S.cut.add(i);
  rerun();
}

function drawLegend() {
  $("#legend").innerHTML = KINDS.map(k => `<span><i style="background:var(--${k})"></i>${kindName(k)}</span>`).join("") +
    `<span><i style="background:#12b76a"></i>forwarding port</span><span><i style="background:#f04438"></i>blocked port</span><span><i style="background:#f79009"></i>listening / learning</span>`;
}

// ---------------------------------------------------------------- storm badge

function drawStorm() {
  const s = S.an && S.an.storm, b = $("#storm");
  if (!s) { b.className = "storm"; b.textContent = ""; return; }
  b.className = `storm ${s.regime}`;
  const label = {TREE: "No loop", CIRCULATING: "Loop: broadcasts circulate", AMPLIFYING: "Broadcast storm", DECAYING: "Loop, decaying"}[s.regime] || s.regime;
  const detail = s.regime === "AMPLIFYING" ? `ρ ${s.rho.toFixed(3)} · grows ×e every ${ms(1 / s.growthRate)} · doubles every ${ms(s.doublingTime)}`
    : s.regime === "TREE" ? "ρ 0: every broadcast dies out" : `ρ ${s.rho.toFixed(3)} · growth rate 0`;
  b.innerHTML = `${esc(label)}<small>${esc(detail)}</small>`;
  b.dataset.regime = s.regime; b.dataset.rho = s.rho; b.dataset.growth = s.growthRate;
}

// ---------------------------------------------------------------- actions + playback

function drawActions() {
  const ol = $("#actions"); ol.innerHTML = "";
  if (!S.sim.actions.length) { ol.innerHTML = `<li class="hint">No actions: open an actions file to run something.</li>`; return; }
  S.sim.actions.forEach((a, k) => {
    const li = document.createElement("li"); li.dataset.action = k;
    const ok = a.result && (a.result.ok || a.result.reached || a.action.do === "udpBurst");
    const neutral = !["ping", "traceroute", "dns", "dhcp", "tcp"].includes(a.action.do);   // wait, link, reads: nothing that can fail
    const n = a.last - a.first + 1;
    li.innerHTML = `<span class="${neutral ? "ok" : ok ? "ok" : "bad"}">${neutral ? "•" : ok ? "✔" : "✘"}</span> ${esc(a.summary)}<small>${n > 0 ? `${n} frame${n === 1 ? "" : "s"}` : "no frames"}${a.lost ? `, ${a.lost} lost on a lossy cable` : ""}</small>`;
    li.addEventListener("click", () => { stop(); goto(a.last >= a.first ? a.first : -1); });
    ol.appendChild(li);
  });
  if (S.sim.truncated) ol.insertAdjacentHTML("beforeend", `<li class="hint">Recording stopped at ${S.sim.steps.length} frames (a loop that never ends).</li>`);
}

function currentState() {
  if (!S.sim) return null;
  if (S.step >= 0 && S.sim.steps[S.step]) return S.sim.steps[S.step].state;
  return S.an ? S.an.devices : null;
}

// ---------------------------------------------------------------- protocol filters and the event list

const shown = st => !S.hidden.has(st.kind);
/** The nearest frame after (dir 1) or before (dir -1) the current one whose protocol is not filtered out; -1 / null at the ends. */
export function nextShown(dir) {
  const steps = S.sim.steps;
  for (let i = S.step + dir; i >= 0 && i < steps.length; i += dir) if (shown(steps[i])) return i;
  return dir < 0 ? -1 : null;
}

function drawFilters() {
  const box = $("#filters"), count = {};
  for (const st of S.sim.steps) count[st.kind] = (count[st.kind] || 0) + 1;
  box.innerHTML = Object.keys(count).length ? `<b>Show</b>` : "";
  for (const k of KINDS.filter(k => count[k])) {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" data-kind="${k}" ${S.hidden.has(k) ? "" : "checked"}><span style="color:var(--${k})">●</span> ${kindName(k)} <span class="n">${count[k]}</span>`;
    l.querySelector("input").addEventListener("change", e => { if (e.target.checked) S.hidden.delete(k); else S.hidden.add(k);
      if (S.step >= 0 && S.sim.steps[S.step] && !shown(S.sim.steps[S.step])) { stop(); goto(nextShown(-1)); }
      drawEvents(); showStep(); });
    box.appendChild(l);
  }
}

const EVENT_CAP = 1500;
/** Packet Tracer style event list: one row per frame that passes the filter. Click a row to jump there. */
function drawEvents() {
  const box = $("#events"); box.innerHTML = "";
  const rows = S.sim.steps.filter(shown);
  $("#evCount").textContent = S.sim.steps.length ? `${rows.length} of ${S.sim.steps.length}` : "";
  if (!S.sim.steps.length) { box.innerHTML = `<p class="hint">No frames yet.</p>`; return; }
  for (const st of rows.slice(0, EVENT_CAP)) {
    const r = document.createElement("div"); r.className = `ev${st.i === S.step ? " current" : ""}`; r.dataset.step = st.i; r.setAttribute("role", "option");
    r.innerHTML = `<span>${st.i + 1}</span><span>${ms(st.t)}</span><span><span class="k" style="color:var(--${st.kind})">${kindName(st.kind)}</span> ${esc(st.from)} → ${esc(st.to)}: ${esc(st.desc)}</span>`;
    r.addEventListener("click", () => { stop(); goto(st.i); });
    box.appendChild(r);
  }
  if (rows.length > EVENT_CAP) box.insertAdjacentHTML("beforeend", `<p class="hint">Showing the first ${EVENT_CAP}; hide some protocols to see the rest.</p>`);
}
function markEvent() {
  for (const r of document.querySelectorAll("#events .ev.current")) r.classList.remove("current");
  const cur = document.querySelector(`#events .ev[data-step="${S.step}"]`);
  if (cur) { cur.classList.add("current"); cur.scrollIntoView({block: "nearest"}); }
}

export function goto(k) {
  const n = S.sim.steps.length;
  S.step = Math.max(-1, Math.min(n - 1, k));
  showStep(); drawDevice(); refreshPorts(); markEvent();
}

function refreshPorts() {
  for (const d of document.querySelectorAll(".port-dot")) {
    const [sw, p] = d.dataset.port.split(":"); const st = portState(sw, p);
    d.setAttribute("class", `port-dot ${st}`); d.querySelector("title").textContent = `${sw} ${p}: ${st}`;
  }
}

function showStep() {
  const n = S.sim.steps.length, st = S.sim.steps[S.step];
  const vis = S.sim.steps.filter(shown).length;
  $("#counter").textContent = n ? `frame ${S.step + 1} / ${n}${S.sim.truncated ? "+" : ""}${vis < n ? ` (${vis} shown)` : ""}` : "no frames";
  for (const li of document.querySelectorAll("#actions li[data-action]")) li.classList.toggle("current", !!st && +li.dataset.action === st.action);
  for (const c of Object.values(S.cableEls || {})) c.classList.remove("active");
  for (const g of document.querySelectorAll(".node.busy")) g.classList.remove("busy");
  const r = $("#reason");
  if (!st) {
    S.pktLayer && (S.pktLayer.innerHTML = "");
    r.innerHTML = n ? `<span class="where">Press ▶ to play the ${n} frames the actions put on the wire, or → to step through them.</span>`
      : `<span class="where">Nothing to play.</span>`;
    return;
  }
  const a = S.sim.actions[st.action];
  const prev = S.sim.steps[S.step - 1];
  const tail = (!S.sim.steps[S.step + 1] || S.sim.steps[S.step + 1].action !== st.action) ? a.tail : [];
  const notes = st.notes.concat(tail);
  r.innerHTML = `<div class="where">Action ${st.action + 1}: ${esc(a.summary)} · t = ${ms(st.t - (S.sim.steps[a.first]?.t ?? st.t))}</div>
    <div class="frame"><span style="color:var(--${st.kind})">●</span> ${esc(st.from)}:${esc(st.fromIf)} → ${esc(st.to)}:${esc(st.toIf)} &nbsp; ${esc(st.desc)}</div>
    ${notes.length ? `<ul>${notes.map(e => `<li class="${e.node === st.from ? "mine" : ""}"><span class="node">${esc(e.node)}</span> ${esc(e.detail)}</li>`).join("")}</ul>`
      : prev && prev.t === st.t && prev.from === st.from ? `<ul><li>(same decision as the frame before)</li></ul>` : ""}`;
  const cable = S.cableEls[st.link]; if (cable) cable.classList.add("active");
  document.querySelector(`.node[data-node="${CSS.escape(st.to)}"]`)?.classList.add("busy");
  animatePacket(st);
}

function animatePacket(st) {
  cancelAnimationFrame(S.anim); S.pktLayer.innerHTML = "";
  const p = S.pos[st.from], q = S.pos[st.to]; if (!p || !q) return;
  const dot = el("circle", {class: "packet", r: 8, cx: p.x, cy: p.y, fill: `var(--${st.kind})`}, S.pktLayer);
  const dur = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : Math.min(700, interval() * 0.85), t0 = performance.now();
  const frame = now => { const f = dur ? Math.min(1, (now - t0) / dur) : 1, e = f < .5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
    dot.setAttribute("cx", p.x + (q.x - p.x) * e); dot.setAttribute("cy", p.y + (q.y - p.y) * e); if (f < 1) S.anim = requestAnimationFrame(frame); };
  S.anim = requestAnimationFrame(frame);
}

const interval = () => 900 / S.speed;
export function play() {
  if (!S.sim.steps.length) return;
  if (nextShown(1) === null) goto(-1);
  S.playing = true; $("#play").textContent = "⏸";
  const tick = () => { if (!S.playing) return; const nx = nextShown(1); if (nx === null) return stop(); goto(nx); S.timer = setTimeout(tick, interval()); };
  tick();
}
export function stop() { S.playing = false; clearTimeout(S.timer); const b = $("#play"); if (b) b.textContent = "▶"; }

// ---------------------------------------------------------------- device panel

export function select(name) {
  S.selected = S.selected === name ? null : name;
  for (const g of document.querySelectorAll(".node")) { g.classList.toggle("selected", g.dataset.node === S.selected);
    g.setAttribute("aria-label", `${g.classList.contains("router") ? "router" : g.classList.contains("switch") ? "switch" : g.classList.contains("server") ? "server" : "host"} ${g.dataset.node}${g.dataset.node === S.selected ? ", selected" : ""}. Enter selects, C opens the console, arrow keys move it.`); }
  drawDevice();
}

const ports0 = n => S.spec.links.flat().filter(r => typeof r === "string" && r.startsWith(n.name + ":")).map(r => r.split(":")[1]);
const table = (head, rows) => rows.length
  ? `<table><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${esc(c ?? "")}</td>`).join("")}</tr>`).join("")}</table>`
  : `<div class="empty">empty</div>`;

const ruleText = r => `${r.action} ${r.proto || "ip"} ${r.src || "any"}${r.sport !== undefined ? ":" + r.sport : ""} → ${r.dst || "any"}${r.dport !== undefined ? ":" + r.dport : ""}${r.icmpType !== undefined ? " type " + r.icmpType : ""}${r.established ? " established" : ""}`;

/** Tables for the routing, NAT, ACL and LLDP features a device has, from the snapshot at the current frame. */
function featurePanels(n, d) {
  let h = "";
  if (d.tcp && d.tcp.length) h += `<h4>TCP connections</h4>` + table(["local", "remote", "state", "unacked", "queued B", "window", "retx"], d.tcp.map(c => [c.local, c.remote, c.state, c.unacked, c.pending, c.peerWindow, c.retransmits]));
  if (d.vrrp && d.vrrp.length) h += `<h4>VRRP</h4>` + table(["iface", "vrid", "virtual IP", "priority", "state", "master"], d.vrrp.map(g => [g.iface, g.vrid, g.ip, g.priority + (g.preempt ? "" : " (no preempt)"), g.state.toUpperCase(), g.masterIp || ""]));
  if (d.ripng) h += `<h4>RIPng routes</h4>` + table(["prefix", "next hop", "metric", "type", "iface"], d.ripng.map(r => [r.network, r.nextHop, r.metric, r.type, r.iface]));
  if (d.rip) h += `<h4>RIP routes</h4>` + table(["network", "next hop", "metric", "type", "iface"], d.rip.map(r => [r.network, r.nextHop, r.metric, r.type, r.iface]));
  if (d.ospf) {
    h += `<div class="when">${d.ospf.areas.length > 1 ? `Area border router (ABR) between areas ${esc(d.ospf.areas.join(", "))}.` : `Area ${esc(d.ospf.areas.join(", ") || "none")}.`}</div>`;
    h += `<h4>OSPF neighbors</h4>` + table(["router ID", "address", "iface", "state", "role"], d.ospf.neighbors.map(x => [x.routerId, x.address, x.iface, x.state, x.role]));
    h += `<h4>OSPF interfaces</h4>` + table(["iface", "area", "state", "type", "cost", "DR", "BDR"], d.ospf.interfaces.map(x => [x.iface, x.area, x.state, x.type, x.cost, x.dr, x.bdr]));
    if (d.ospf.asbr) h += `<div class="when">Autonomous system boundary router (ASBR): redistributes routes into OSPF.</div>`;
    h += `<h4>OSPF routes</h4>` + table(["network", "kind", "cost", "via"], d.ospf.routes.map(x => [x.network, ({inter: "inter-area", intra: "intra-area", e1: "external E1", e2: "external E2"})[x.type] || x.type, x.cost, x.via.map(v => `${v.gw} (${v.iface})`).join(", ")]));
    const lsaDetail = l => l.type === "router" ? `${l.abr ? "ABR " : ""}${l.asbr ? "ASBR " : ""}${l.links.length} link(s)` : l.type === "network" ? `${l.mask}, attached ${l.attached.join(" ")}` : l.type === "external" ? `${l.mask}, metric ${l.metric} (E${l.eType})` : `${l.mask || ""} metric ${l.metric}`;
    const byArea = new Map();
    for (const l of d.ospf.lsdb || []) { const a = l.type === "external" ? "AS external" : "area " + (l.area || "0.0.0.0"); if (!byArea.has(a)) byArea.set(a, []); byArea.get(a).push(l); }
    for (const [a, ls] of byArea) h += `<h4>OSPF database, ${esc(a)}</h4>` + table(["type", "ID", "advertised by", "seq", "detail"], ls.map(l => [l.type, l.id, l.adv, l.seq, lsaDetail(l)]));
  }
  if (d.nat) h += `<h4>NAT translations</h4>` + table(["proto", "inside global", "inside local", "outside global", "left"], d.nat.map(x => [x.proto, x.insideGlobal, x.insideLocal, x.outsideGlobal, x.static ? "static" : x.secondsLeft === undefined ? "" : `${x.secondsLeft} s`]));
  if (n.acl && n.acl.lists) {
    const hits = d.aclHits || {};
    for (const [name, rules] of Object.entries(n.acl.lists)) {
      const binds = Object.entries(n.acl.bind || {}).flatMap(([i, b]) => Object.entries(b).filter(([, l]) => l === name).map(([dir]) => `${i} ${dir}`));
      h += `<h4>ACL ${esc(name)}${binds.length ? ` <small>(${esc(binds.join(", "))})</small>` : ""}</h4>` +
        table(["#", "rule", "hits"], rules.map((r, i) => [i + 1, ruleText(r), hits[`${name}:${i}`] || 0]).concat([["", "implicit deny", hits[`${name}:deny`] || 0]]));
    }
  }
  if (d.v6) {
    h += `<h4>IPv6 addresses</h4>` + table(["iface", "address"], d.v6.addrs.map(a => [a.iface, a.ip]));
    if (d.v6.routes.length) h += `<h4>IPv6 routes</h4>` + table(["destination", "via"], d.v6.routes.map(r => [r.dst, r.via]));
    h += `<h4>IPv6 neighbors</h4>` + table(["address", "MAC", "iface"], d.v6.neighbors.map(x => [x.ip, x.mac, x.iface]));
  }
  if (d.services) {
    h += `<h4>Services</h4>`;
    if (d.services.ntp) h += `<div class="when">NTP server (UDP 123) at stratum ${d.services.ntp.stratum}: ${d.services.ntp.queries} client ${d.services.ntp.queries === 1 ? "query" : "queries"} answered so far.</div>`;
    if (d.services.syslog) h += `<div class="when">Syslog receiver (UDP 514): ${d.services.syslog.length} message${d.services.syslog.length === 1 ? "" : "s"} stored.</div>` +
      table(["message"], d.services.syslog.map(m => [m]));
  }
  if (d.lldp) h += `<h4>LLDP neighbors</h4>` + table(["iface", "system", "port", "description"], d.lldp.map(x => [x.iface, x.sysName, x.portId, x.portDescr]));
  return h;
}

function drawDevice() {
  const box = $("#device");
  const n = S.spec && S.spec.nodes.find(x => x.name === S.selected);
  if (!n) { box.innerHTML = `<h2>Device</h2><p class="hint">Click a device to see its tables, double-click it for its console. Drag to move it. Click a cable to unplug it (or plug it back in).</p>`; return; }
  const st = currentState(), d = (st && st[n.name]) || {};
  const when = S.step >= 0 ? `As frame ${S.step + 1} leaves (each action starts with empty caches).` :
    S.an && S.an.converged ? `At rest, after the network settles (${S.an.converged} s: spanning tree, LACP, routing protocols, LLDP).` : "At rest, before any action.";
  let h = `<h2>Device</h2><h3>${esc(n.name)} <small>${esc(n.kind)}</small></h3><div class="when">${esc(when)}</div>`;
  if (n.kind === "switch") {
    const left = m => m.stale ? "aged out (waiting for the collector)" : `${Math.max(0, Math.round(((d.aging ? d.aging.hold : 300) - m.age) * 10) / 10)} s`;
    h += `<h4>MAC address table</h4>` + (d.aging ? `<div class="when">Aging time ${d.aging.time} s${d.aging.hold !== d.aging.time ? ` (shortened to ${d.aging.hold} s by a topology change)` : ""}.</div>` : "") +
      table(n.vlans ? ["VLAN", "MAC", "port", "age", "expires in"] : ["MAC", "port", "age", "expires in"],
        (d.mac || []).map(m => (n.vlans ? [m.vlan, m.mac, m.port] : [m.mac, m.port]).concat([`${m.age} s`, left(m)])));
    if (d.snooping) h += `<h4>DHCP snooping</h4><div class="when">DHCP server messages are accepted only on trusted ports: ${esc(d.snooping.trusted.join(", ") || "none")}.</div>` +
      table(["port", "trusted", "server messages dropped"], ports0(n).map(p => [p, d.snooping.trusted.includes(p) ? "yes" : "no", d.snooping.dropped[p] || 0]));
    if ((d.channels || []).length) h += `<h4>Port-channels (LACP)</h4>` + table(["channel", "member", "link", "mux", "partner state", "bundled"],
      d.channels.flatMap(c => c.members.map(m => [`${c.name} (${c.rate})`, m.port, m.up ? "up" : "down", m.mux, `0x${(m.partner.state || 0).toString(16)}`, m.aggregated ? "yes" : "no"])));
    const ports = S.spec.links.flat().filter(r => typeof r === "string" && r.startsWith(n.name + ":")).map(r => r.split(":")[1]);
    if (d.stp) {
      h += `<h4>Spanning tree</h4><div class="when">Bridge ${esc(d.stp.bridgeId)} · root ${esc(d.stp.root)}${d.stp.isRoot ? " (this switch is the root)" : ` · root port ${esc(d.stp.rootPort)}, cost ${d.stp.rootCost}`}</div>`;
      h += table(["port", "role", "state", "cost"], Object.entries(d.stp.ports).map(([p, x]) => [p, x.role, x.state, x.cost]));
    } else {
      h += `<h4>Ports</h4>` + table(n.vlans ? ["port", "state", "VLAN"] : ["port", "state"], ports.map(p => {
        const c = n.vlans && (n.vlans[p] || {access: 1});
        return n.vlans ? [p, portState(n.name, p), c.access !== undefined ? `access ${c.access}` : `trunk ${c.trunk.join(",")}${c.native !== undefined ? ` native ${c.native}` : ""}`] : [p, portState(n.name, p)];
      }));
    }
  } else {
    h += `<h4>Interfaces</h4>` + table(["iface", "address", "MAC"], (d.ifaces || []).map(i => [i.name, i.ip, i.mac]));
    h += `<h4>Routing table</h4>` + table(["destination", "via", "iface"], (S.sim.routes[n.name] || []).map(r => [r.dst, r.via, r.iface]));
    h += `<h4>ARP cache</h4>` + table(["IP", "MAC", "iface"], (d.arp || []).map(a => [a.ip, a.mac, a.iface]));
    if (n.services && n.services.dhcp) h += `<h4>DHCP leases</h4>` + table(["MAC", "IP"], (d.leases || []).map(l => [l.mac, l.ip]));
  }
  h += featurePanels(n, d);
  h += editForm(n);
  h += `<button class="open-console" data-console="${esc(n.name)}">Open console on ${esc(n.name)}</button>`;
  box.innerHTML = h;
  box.querySelector(".open-console").addEventListener("click", () => openConsole(n.name));
  wireForm(box, n);
}

// ---------------------------------------------------------------- topology editor

/** Apply an edited spec if the spec validator accepts it; otherwise show why and change nothing. Actions that no longer fit are dropped. */
export function edit(spec, actions = S.actions, keepSessions = false) {
  const v = validateSpec(spec);
  if (!v.ok) { showErrors(v.errors.map(e => `spec ${e.path}: ${e.message}`)); return false; }
  const kept = actions.filter(a => validateActions([a], spec).ok), dropped = actions.length - kept.length;
  showErrors(v.warnings.map(w => `warning: spec ${w.path}: ${w.message}`).concat(dropped ? [`${dropped} action(s) no longer fit this network and were removed`] : []));
  const pos = {}; for (const n of spec.nodes) pos[n.name] = S.pos[n.name] || freeSpot();
  S.pos = pos; S.spec = spec; S.actions = kept; S.cut = new Set(); S.pending = null;
  if (!spec.nodes.some(n => n.name === S.selected)) S.selected = null;
  if (!keepSessions) { S.sessions = new Map(); closeConsole(); }
  try { localStorage.setItem(layoutKey(spec), JSON.stringify(S.pos)); } catch {}
  rerun(); return true;
}

function freeSpot() {
  for (let r = 0; r < 20; r++) for (let a = 0; a < 12; a++) {
    const x = 450 + r * 40 * Math.cos(a * Math.PI / 6), y = 280 + r * 25 * Math.sin(a * Math.PI / 6);
    if (x > 60 && x < 840 && y > 50 && y < 510 && !Object.values(S.pos).some(p => Math.hypot(p.x - x, p.y - y) < 90)) return {x: Math.round(x), y: Math.round(y)};
  }
  return {x: 450, y: 280};
}

export function addDevice(kind) {
  const name = ed.freeName(S.spec, kind);
  S.pos[name] = freeSpot();
  if (edit(ed.addNode(S.spec, kind, name), S.actions, true)) { S.selected = name; drawMap(); drawDevice(); return name; }
  delete S.pos[name]; return null;
}

function toolClick(name) {
  if (S.tool === "delete") { const r = ed.removeNode(S.spec, name, S.actions); edit(r.spec, r.actions); return; }
  if (S.tool !== "cable") return;
  if (!S.pending) { S.pending = name; drawMap(); setToolHint(); return; }
  const a = S.pending; S.pending = null;
  try { edit(ed.addLink(S.spec, a, name)); } catch (e) { showErrors([e.message]); drawMap(); }
  setToolHint();
}

export function setTool(t) {
  S.tool = t; S.pending = null;
  for (const b of document.querySelectorAll("[data-tool]")) b.classList.toggle("on", b.dataset.tool === t);
  $("#map").setAttribute("class", `tool-${t}`); setToolHint(); drawMap();
}
function setToolHint() {
  $("#toolHint").textContent = S.tool === "cable" ? (S.pending ? `Cable from ${S.pending}: click the other device` : "Click the first device")
    : S.tool === "delete" ? "Click a cable or a device" : "";
}

function editForm(n) {
  let h = `<h4>Edit</h4><div class="edit"><label><span>Hostname</span><input data-f="name" value="${esc(n.name)}" aria-label="Hostname"></label>`;
  if (n.kind === "switch") {
    for (const p of [...new Set(ed.cabledPorts(S.spec, n.name))]) {
      const c = n.vlans && n.vlans[p], v = !c ? "" : c.access !== undefined ? String(c.access) : `trunk ${c.trunk.join(",")}${c.native !== undefined ? ` native ${c.native}` : ""}`;
      h += `<label><span>${esc(p)}</span><input data-f="vlan" data-port="${esc(p)}" value="${esc(v)}" placeholder="VLAN 1 (access)" aria-label="VLAN of ${esc(p)}"></label>`;
    }
  } else {
    for (const [i, ip] of Object.entries(n.ifaces || {}))
      h += `<label><span>${esc(i)}</span><input data-f="addr" data-iface="${esc(i)}" value="${esc(ip)}" placeholder="10.0.0.1/24 or dhcp" aria-label="Address of ${esc(i)}"></label>`;
    h += `<label><span>Gateway</span><input data-f="gw" value="${esc(n.gw || "")}" placeholder="10.0.0.1" aria-label="Default gateway"></label>`;
  }
  return h + `<button class="del" data-f="delete">Delete ${esc(n.name)}</button></div>`;
}

function wireForm(box, n) {
  for (const inp of box.querySelectorAll(".edit input")) inp.addEventListener("change", () => {
    try {
      const f = inp.dataset.f;
      if (f === "name") { const r = ed.renameNode(S.spec, n.name, inp.value.trim(), S.actions); S.pos[inp.value.trim()] = S.pos[n.name]; S.selected = inp.value.trim(); if (!edit(r.spec, r.actions)) { S.selected = n.name; drawDevice(); } }
      else if (f === "addr") { if (!edit(ed.setAddress(S.spec, n.name, inp.dataset.iface, inp.value), S.actions, true)) drawDevice(); }
      else if (f === "gw") { if (!edit(ed.setGateway(S.spec, n.name, inp.value), S.actions, true)) drawDevice(); }
      else if (f === "vlan") { if (!edit(ed.setVlan(S.spec, n.name, inp.dataset.port, inp.value), S.actions, true)) drawDevice(); }
    } catch (e) { showErrors([e.message]); drawDevice(); }
  });
  box.querySelector("[data-f=delete]").addEventListener("click", () => { const r = ed.removeNode(S.spec, n.name, S.actions); edit(r.spec, r.actions); });
}

// ---------------------------------------------------------------- wiring

function readFile(input) { return new Promise((res, rej) => { const f = input.files[0]; if (!f) return rej(new Error("no file"));
  const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsText(f); }); }

async function init() {
  drawLegend();
  const list = await exampleList(); S.examples = list;
  const sel = $("#examples");
  sel.innerHTML = list.map((e, i) => `<option value="${i}">${esc(e.title)}</option>`).join("") + `<option value="" disabled hidden>(your file)</option>`;
  sel.addEventListener("change", () => { if (sel.value !== "") loadExample(list[+sel.value]).catch(e => showErrors([String(e)])); });
  $("#specFile").addEventListener("change", async e => {
    try { const spec = parseData(await readFile(e.target), e.target.files[0].name); sel.value = ""; load(spec, [], e.target.files[0].name); }
    catch (err) { showErrors([`${e.target.files[0]?.name}: ${err.message}`]); }
    e.target.value = "";
  });
  $("#actionsFile").addEventListener("change", async e => {
    try { const a = parseData(await readFile(e.target), e.target.files[0].name); if (S.spec) { const vs = validateActions(a, S.spec);
      if (!vs.ok) showErrors(vs.errors.map(x => `actions ${x.path}: ${x.message}`)); else { showErrors([]); S.actions = a; rerun(); } } }
    catch (err) { showErrors([`${e.target.files[0]?.name}: ${err.message}`]); }
    e.target.value = "";
  });
  $("#saveSpec").addEventListener("click", () => S.spec && download(`${fileBase()}.spec.json`, specJson()));
  $("#saveYaml").addEventListener("click", () => S.spec && download(`${fileBase()}.spec.yaml`, dumpYaml(S.spec), "text/yaml"));
  $("#saveActions").addEventListener("click", () => S.spec && download(`${fileBase()}.actions.json`, JSON.stringify(S.actions, null, 2) + "\n"));
  $("#restore").addEventListener("click", restoreAutosave); showRestore();
  for (const l of document.querySelectorAll("label.file")) { l.tabIndex = 0; l.setAttribute("role", "button");
    l.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); l.querySelector("input").click(); } }); }
  $("#consoleInput").addEventListener("keydown", consoleKey);
  $("#consoleClose").addEventListener("click", closeConsole);
  $(".console-head").addEventListener("pointerdown", e => {         // drag the console by its title bar
    if (e.target.closest("button")) return;
    const box = $("#console"), r = box.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = ev => { box.style.left = `${Math.max(0, Math.min(innerWidth - 80, ev.clientX - dx))}px`; box.style.top = `${Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy))}px`;
      box.style.right = "auto"; box.style.bottom = "auto"; };
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); };
    addEventListener("pointermove", move); addEventListener("pointerup", up);
  });
  $("#play").addEventListener("click", () => S.playing ? stop() : play());
  $("#step").addEventListener("click", () => { stop(); const n = nextShown(1); if (n !== null) goto(n); });
  $("#back").addEventListener("click", () => { stop(); goto(nextShown(-1)); });
  $("#first").addEventListener("click", () => { stop(); goto(-1); });
  const sp = $("#speed"); const setSpeed = () => { S.speed = 2 ** +sp.value; $("#speedOut").textContent = `${+S.speed.toFixed(2)}×`; };
  sp.addEventListener("input", setSpeed); setSpeed();
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !$("#console").hidden) { closeConsole(); return; }
    if (e.target.closest && e.target.closest("input, select, textarea, button, label.file, .node, .cable-hit")) return;
    if (e.key === " ") { e.preventDefault(); S.playing ? stop() : play(); }
    else if (e.key === "ArrowRight") { stop(); const n = nextShown(1); if (n !== null) goto(n); }
    else if (e.key === "ArrowLeft") { stop(); goto(nextShown(-1)); }
    else if (e.key === "Home") { stop(); goto(-1); }
  });
  for (const b of document.querySelectorAll("[data-add]")) b.addEventListener("click", () => addDevice(b.dataset.add));
  for (const b of document.querySelectorAll("[data-tool]")) b.addEventListener("click", () => setTool(b.dataset.tool));
  const want = new URLSearchParams(location.search).get("lab");
  const i = Math.max(0, list.findIndex(e => e.id === want)); sel.value = String(i);
  await loadExample(list[i]);
  document.body.dataset.ready = "1";
}

// ---------------------------------------------------------------- console: the project's CLI (cli/) on the engine backend

/** Studio's tables at the current frame, in the shape cli/ show commands read (see stateOf in cli/src/backends/engine.js). */
function cliState(dev) {
  const d = (currentState() || {})[dev] || {}, node = S.spec.nodes.find(n => n.name === dev);
  if (!node) return {};
  const status = port => { const i = S.spec.links.findIndex(l => l[0] === `${dev}:${port}` || l[1] === `${dev}:${port}`);
    return i < 0 ? "down" : S.cut.has(i) ? "admin-down" : "up"; };
  if (node.kind === "switch") {
    const ports = S.spec.links.flatMap(l => l.slice(0, 2)).filter(r => typeof r === "string" && r.startsWith(dev + ":")).map(r => r.slice(dev.length + 1));
    return {interfaces: ports.map(p => ({name: p, status: (node.blocked || []).includes(p) ? "admin-down" : status(p)})),
      mac: (d.mac || []).map(m => ({vlan: m.vlan || 1, mac: m.mac, port: m.port})), stp: d.stp || null};
  }
  return {
    interfaces: (d.ifaces || []).map(i => ({name: i.name, address: /^\d/.test(i.ip) ? i.ip : null, dhcp: node.ifaces?.[i.name] === "dhcp", mac: i.mac, status: status(i.name)})),
    routes: ((S.sim.routes || {})[dev] || []).map(r => r.via === "connected" ? {prefix: r.dst, protocol: "connected", interface: r.iface}
      : {prefix: r.dst, protocol: "static", nextHop: r.via, interface: r.iface === "?" ? null : r.iface}),
    arp: (d.arp || []).map(a => ({ip: a.ip, mac: a.mac, interface: a.iface})),
    leases: d.leases || [],
  };
}

const backend = engineBackend({
  spec: () => S.spec,
  /** Keep a changed spec if it is still valid; returns the problems otherwise. Devices keep their place (also when renamed). */
  setSpec(spec) {
    const v = validateSpec(spec); if (!v.ok) return v.errors.map(e => `${e.path}: ${e.message}`);
    const pos = {}; spec.nodes.forEach((n, i) => { pos[n.name] = S.pos[S.spec.nodes[i]?.name] || S.pos[n.name] || {x: 450, y: 280}; });
    if (S.selected) { const i = S.spec.nodes.findIndex(n => n.name === S.selected); if (i >= 0) S.selected = spec.nodes[i].name; }
    S.pos = pos; S.spec = spec; return [];
  },
  get cut() { return S.cut; }, setCut(c) { S.cut = new Set(c); },
  onRename(old, name) { S.actions = S.actions.map(a => a.src === old ? {...a, src: name} : a); },
  state: cliState,
  /** ping / traceroute from the console: added to the actions, so its frames play like any other. */
  run(action) { S.actions = [...S.actions, action]; rerun(); const a = S.sim.actions[S.sim.actions.length - 1];
    if (a.last >= a.first) goto(a.first); return a.result; },
});

export function openConsole(name) {
  const box = $("#console"); box.hidden = false;
  S.selected = name; for (const g of document.querySelectorAll(".node")) g.classList.toggle("selected", g.dataset.node === name); drawDevice();
  if (!S.sessions.has(name)) S.sessions.set(name, {cli: createSession(backend, name), log: `${name} console: the OpenPacketRouter CLI. Type ? for help, Tab to complete, | json after a show command. Drag the title bar to move this window.\n\n`, hist: [], at: 0});
  S.console = name; showConsole(); $("#consoleInput").focus();
}
function closeConsole() { const b = $("#console"); if (b) b.hidden = true; S.console = null; }
function showTabs() {
  const box = $("#consoleTabs"); box.innerHTML = "";
  for (const name of S.sessions.keys()) {
    const t = document.createElement("div"); t.className = `tab${name === S.console ? " on" : ""}`; t.dataset.tab = name; t.setAttribute("role", "tab"); t.setAttribute("aria-selected", name === S.console);
    t.innerHTML = `<span>${esc(name)}</span><button title="Close this console" aria-label="Close console ${esc(name)}">✕</button>`;
    t.addEventListener("click", () => { S.console = name; showConsole(); $("#consoleInput").focus(); });
    t.querySelector("button").addEventListener("click", e => { e.stopPropagation(); closeTab(name); });
    box.appendChild(t);
  }
}
/** Close one console tab (its history goes with it); the window closes with the last tab. */
function closeTab(name) {
  const names = [...S.sessions.keys()], i = names.indexOf(name); S.sessions.delete(name);
  if (S.console !== name) return showConsole();
  const next = [...S.sessions.keys()][Math.min(i, S.sessions.size - 1)];
  if (next) { S.console = next; showConsole(); $("#consoleInput").focus(); } else closeConsole();
}
function showConsole() {
  showTabs();
  const c = S.sessions.get(S.console); if (!c) return;
  $("#consoleTitle").textContent = `Console: ${c.cli.device}`; $("#consolePrompt").textContent = c.cli.prompt();
  const out = $("#consoleOut"); out.textContent = c.log; out.scrollTop = out.scrollHeight;
}
function consoleKey(e) {
  const c = S.sessions.get(S.console); if (!c) return;
  const inp = e.target;
  if (e.key === "Enter") {
    const line = inp.value; inp.value = ""; c.log += `${c.cli.prompt()}${line}\n`;
    if (line.trim()) { c.hist.push(line); c.at = c.hist.length; }
    const before = c.cli.device, r = c.cli.exec(line);
    if (r.output) c.log += r.output + "\n";
    if (r.changed === "spec" || r.changed === "cut") rerun();
    if (before !== c.cli.device) { S.sessions.delete(before); S.sessions.set(c.cli.device, c); S.console = c.cli.device; }
    if (c.cli.closed) { closeTab(S.console); return; }
    showConsole();
  } else if (e.key === "Tab") {
    e.preventDefault(); const r = c.cli.complete(inp.value);
    if (r.options.length > 1 && r.line === inp.value) { c.log += `${c.cli.prompt()}${inp.value}\n${r.options.join("  ")}\n`; showConsole(); }
    inp.value = r.line;
  } else if (e.key === "?") {
    e.preventDefault(); c.log += `${c.cli.prompt()}${inp.value}?\n${c.cli.help(inp.value + "?")}\n`; showConsole();
  } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault(); c.at = Math.max(0, Math.min(c.hist.length, c.at + (e.key === "ArrowUp" ? -1 : 1))); inp.value = c.hist[c.at] ?? "";
  } else if (e.key === "z" && e.ctrlKey) {
    e.preventDefault(); inp.value = "end"; consoleKey({key: "Enter", target: inp, preventDefault() {}});
  }
}

window.studio = {S, dumpYaml, edit, addDevice, setTool, restoreAutosave, specJson, closeTab, load, rerun, goto, play, stop, select, toggleCut, openConsole, runInConsole};
init().catch(e => { showErrors([String(e.stack || e)]); document.body.dataset.ready = "error"; });
