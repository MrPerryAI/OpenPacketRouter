/* ========================================================================
   7. RENDERER  (canvas map + HTML device cards)
   With HTML-in-Canvas (Edge/Chrome 157+, or older Chromium with the
   canvas-draw-element flag) the cards are real <button>s inside the canvas,
   painted with drawElementImage() so effects can wrap around them; they stay
   focusable and clickable. Without it, the same buttons sit on a layer above.
   ======================================================================== */
const fx = document.getElementById("fx"), mapwrap = document.getElementById("mapwrap");
const HIC = typeof CanvasRenderingContext2D !== "undefined" && "drawElementImage" in CanvasRenderingContext2D.prototype;
if (HIC) { fx.setAttribute("layoutsubtree", ""); fx.setAttribute("content", "drawable"); }
const ctx = fx.getContext("2d");
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
let K = 1, DPR = 1;
let cardInner = null;
if (!HIC) { const layer = document.createElement("div"); layer.className = "cardlayer"; cardInner = document.createElement("div"); cardInner.className = "cardinner";
  layer.appendChild(cardInner); mapwrap.appendChild(layer); }
function resize() {
  const r = fx.getBoundingClientRect(); if (!r.width) return;
  DPR = Math.min(2, window.devicePixelRatio || 1); K = r.width / 1000;
  fx.width = Math.round(r.width * DPR); fx.height = Math.round(r.width * .68 * DPR);
  if (cardInner) cardInner.style.transform = `scale(${K})`;
  bgDirty = true;
}
new ResizeObserver(resize).observe(fx);

let PAL = {};
function readPalette() { const cs = getComputedStyle(document.documentElement); const g = n => cs.getPropertyValue(n).trim();
  PAL = {chart: g("--chart"), grid: g("--grid"), ink: g("--ink"), ink2: g("--ink2"), accent: g("--accent"), magenta: g("--magenta"),
    storm0: g("--storm0"), storm1: g("--storm1"), good: g("--good"), warn: g("--warn"), crit: g("--crit"), panel: g("--panel"),
    dark: matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light" || document.documentElement.dataset.theme === "dark"};
  bgDirty = true; }
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readPalette);
new MutationObserver(readPalette).observe(document.documentElement, {attributes: true, attributeFilter: ["data-theme"]});

const lerp = (a, b, t) => a + (b - a) * t;
function lerpColor(a, b, t) { const pa = a.match(/\w\w/g).map(h => parseInt(h, 16)), pb = b.match(/\w\w/g).map(h => parseInt(h, 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join(""); }
function pointOn(l, t, fromA) { const A = DEV[l.a], B = DEV[l.b]; if (!fromA) t = 1 - t;
  if (!l.ctrl) return [A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t];
  const [cx, cy] = l.ctrl, u = 1 - t; return [u*u*A.x + 2*u*t*cx + t*t*B.x, u*u*A.y + 2*u*t*cy + t*t*B.y]; }
function tracePath(c, l) { const A = DEV[l.a], B = DEV[l.b]; c.beginPath(); c.moveTo(A.x, A.y);
  if (l.ctrl) c.quadraticCurveTo(l.ctrl[0], l.ctrl[1], B.x, B.y); else c.lineTo(B.x, B.y); }
const linkVisible = l => l.routedOnly ? S.routed : !(S.routed && (l.id === "L6" || l.id === "L14"));

/* ---- static background: chart paper, graticule, site outline */
let bg = document.createElement("canvas"), bgDirty = true;
function drawBg() {
  bg.width = fx.width; bg.height = fx.height; const c = bg.getContext("2d");
  c.setTransform(DPR * K, 0, 0, DPR * K, 0, 0);
  c.fillStyle = PAL.chart; c.fillRect(0, 0, 1000, 680);
  c.strokeStyle = PAL.grid; c.lineWidth = 1; c.fillStyle = PAL.ink2; c.font = "500 11px 'IBM Plex Mono', monospace";
  const TOP = 168; c.setLineDash([2, 4]); c.beginPath(); c.moveTo(0, TOP); c.lineTo(1000, TOP); c.stroke(); c.setLineDash([]);
  c.globalAlpha = .8; c.fillText(S.mode === "plain" ? "NETWORK HQ (NOT ON THE MAP)" : "NETWORK CORE · NOT TO SCALE", 14, TOP - 8); c.globalAlpha = 1;
  for (let lon = -106; lon <= -90; lon += 2) { const [x] = proj(lon, 35); c.beginPath(); c.moveTo(x, TOP); c.lineTo(x, 680); c.stroke(); c.globalAlpha = .8; c.fillText(`${-lon}°W`, x + 4, 672); c.globalAlpha = 1; }
  for (let lat = 36; lat >= 32; lat--) { const [, y] = proj(-100, lat); c.beginPath(); c.moveTo(0, y); c.lineTo(1000, y); c.stroke(); c.globalAlpha = .8; c.fillText(`${lat}°N`, 6, y - 5); c.globalAlpha = 1; }
  c.strokeStyle = PAL.magenta; c.lineWidth = 1.5; c.setLineDash([6, 5]); c.globalAlpha = .8;
  c.beginPath(); c.roundRect(SITE.x, SITE.y, SITE.w, SITE.h, 14); c.stroke(); c.setLineDash([]); c.globalAlpha = 1;
  c.fillStyle = PAL.magenta; c.font = "600 12px 'IBM Plex Sans', sans-serif"; c.fillText(SITE.label, SITE.x + 14, SITE.y + 19);
  bgDirty = false;
}

/* ---- icons (classic network-diagram glyphs, drawn here) */
const ICON = {
  router: `<svg class="ic" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="var(--icon)"/><circle cx="24" cy="24" r="22" fill="none" stroke="var(--icon2)" stroke-width="2"/>
    <g fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M27 21 L35 13 M29 13 H35 V19"/><path d="M21 27 L13 35 M13 29 V35 H19"/><path d="M12 12 L20 20 M20 14 V20 H14"/><path d="M36 36 L28 28 M28 34 V28 H34"/></g></svg>`,
  switch: `<svg class="ic" viewBox="0 0 40 40" aria-hidden="true"><rect x="1.5" y="5" width="37" height="30" rx="6" fill="var(--icon)" stroke="var(--icon2)" stroke-width="2"/>
    <g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 14 H30 M26 10.5 L30 14 L26 17.5"/><path d="M31 26 H10 M14 22.5 L10 26 L14 29.5"/></g></svg>`,
  V: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 14 V12 a8 8 0 0 1 16 0 V14"/><rect x="2.5" y="13" width="4" height="6" rx="1.5"/><rect x="17.5" y="13" width="4" height="6" rx="1.5"/><path d="M19.5 19 q0 3 -5 3 h-2"/></svg>`,
  R: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14 a9 9 0 0 0 12 -9 z"/><path d="M10 10 L15 5"/><path d="M8 17 L6 22 H14 L12 17"/><path d="M17 2 a5 5 0 0 1 5 5"/></svg>`,
  RF: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9 L7 22 M12 9 L17 22 M9 16 H15"/><circle cx="12" cy="7" r="1.6"/><path d="M8 4 a6 6 0 0 0 0 6 M16 4 a6 6 0 0 1 0 6 M5 2 a10 10 0 0 0 0 10 M19 2 a10 10 0 0 1 0 10"/></svg>`,
  M: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M8 21 H16 M12 17 V21"/><path d="M6 12 L9 9 L12 11 L17 7"/></svg>`,
};

/* ---- device cards (real HTML) */
const cards = {};
for (const [name, d] of Object.entries(DEV)) {
  const b = document.createElement("button"); b.type = "button"; b.className = "card " + d.kind; b.dataset.dev = name;
  b.onclick = e => { e.stopPropagation(); select({dev: name}); };
  if (HIC) { b.setAttribute("drawable", ""); fx.appendChild(b); }
  else { b.style.left = d.x + "px"; b.style.top = (d.kind === "host" ? d.y + 9 : d.y) + "px"; cardInner.appendChild(b); }
  cards[name] = {el: b, html: "", cls: "", m: ""};
}
function updateCards(H) {
  for (const [name, d] of Object.entries(DEV)) {
    const c = cards[name]; let html, cls = "card " + d.kind;
    if (d.kind === "host") html = `<span class="dot">${ICON[d.glyph]}</span><span class="nm">${devName(name)}</span>`;
    else {
      const plain = S.mode === "plain"; const h = d.center ? H[d.center] : null;
      const stat = h && h.cls !== "good" ? `<span class="stat">${h.cls === "crit" ? "▲ DOWN" : "● DEGRADED"}</span>` : "";
      if (h) cls += " " + h.cls;
      const pill = d.kind === "switch" && !S.stp[name] ? `<span class="pill">${T("stpOff")}</span>` : "";
      const main = plain ? (d.ptag || d.label) : d.label, sub = plain ? (d.psub ?? "") : d.tag;
      if (plain) cls += " pl";
      html = `${ICON[d.kind]}<span class="tx">${pill ? `<span>${pill}</span>` : ""}<span>${main}</span>${sub ? `<small>${sub}</small>` : ""}${stat}</span>`;
    }
    if (S.sel && S.sel.dev === name) cls += " sel";
    if (!HIC && glitching.has(name)) cls += " glitch";
    const hidden = d.routedOnly && !S.routed;
    if (c.html !== html) { c.el.innerHTML = html; c.html = html; }
    if (c.cls !== cls) { c.el.className = cls; c.cls = cls; }
    if (c.el.hidden !== hidden) c.el.hidden = hidden;
    const al = `${d.label}${d.tag ? ", " + d.tag : ""}${d.kind === "switch" ? (S.stp[name] ? ", spanning tree on" : ", spanning tree off") : ""}`;
    if (c.al !== al) { c.el.setAttribute("aria-label", al); c.al = al; }
  }
}

/* ---- effects state */
let particles = [], spawnAcc = new Float64Array(0), waves = [], banners = [], confetti = [], shakeUntil = 0, glitching = new Set();
let anim = null, highlight = null, lastT = performance.now();
let planes = [], planeAcc = 0, held = 0;
function updatePlanes(dt) {
  if (!S.gsStart) { planeAcc += dt; if (planeAcc > 1.1 && planes.length < 14) { planeAcc = 0;
      const side = () => { const r = Math.random(); return r < .25 ? [0, 190 + Math.random() * 470] : r < .5 ? [1000, 190 + Math.random() * 470] : r < .75 ? [Math.random() * 1000, 180] : [Math.random() * 1000, 680]; };
      const a = side(), b = side(); if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 400) planes.push({a, b, p: 0, sp: .03 + Math.random() * .03}); } }
  else held += dt * 2.9;  // departures held while the ground stop lasts
  for (const q of planes) q.p += dt * q.sp; planes = planes.filter(q => q.p < 1);
}
function drawPlanes() {
  ctx.fillStyle = PAL.ink2; ctx.globalAlpha = .45;
  for (const q of planes) { const x = lerp(q.a[0], q.b[0], q.p), y = lerp(q.a[1], q.b[1], q.p), ang = Math.atan2(q.b[1] - q.a[1], q.b[0] - q.a[0]);
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.beginPath();
    ctx.moveTo(9, 0); ctx.lineTo(2, -1.4); ctx.lineTo(-2, -8); ctx.lineTo(-4, -8); ctx.lineTo(-2, -1.4); ctx.lineTo(-7, -1.4); ctx.lineTo(-9, -4); ctx.lineTo(-10, -4); ctx.lineTo(-9, 0);
    ctx.lineTo(-10, 4); ctx.lineTo(-9, 4); ctx.lineTo(-7, 1.4); ctx.lineTo(-2, 1.4); ctx.lineTo(-4, 8); ctx.lineTo(-2, 8); ctx.lineTo(2, 1.4); ctx.closePath(); ctx.fill(); ctx.restore(); }
  ctx.globalAlpha = 1;
  if (held >= 1) { ctx.font = "700 14px 'IBM Plex Mono', monospace"; const s = `DEPARTURES HELD: ${Math.floor(held).toLocaleString()}`;
    ctx.lineWidth = 4; ctx.strokeStyle = PAL.chart; ctx.strokeText(s, 18, 646); ctx.fillStyle = PAL.crit; ctx.fillText(s, 18, 646); }
}
function wave(x, y, color, maxR = 120, dur = 1100) { if (!REDUCED) waves.push({x, y, color, maxR, dur, t0: performance.now()}); }
function banner(text, color) { banners = [{text, color, t0: performance.now()}]; }
function shake(ms) { if (!REDUCED) shakeUntil = performance.now() + ms; }
function burstConfetti() { if (REDUCED) return; const cols = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#6250d6"];
  for (let i = 0; i < 140; i++) confetti.push({x: 500 + (Math.random() - .5) * 200, y: 200, vx: (Math.random() - .5) * 520, vy: -Math.random() * 520 - 120,
    r: Math.random() * 6.28, vr: (Math.random() - .5) * 12, w: 6 + Math.random() * 6, h: 3 + Math.random() * 4, c: cols[i % cols.length], t0: performance.now()}); }

function devPoint(name) { const d = DEV[name]; return [d.x, d.y]; }
function drawFrame(now) {
  if (!M || !fx.width) return;
  if (bgDirty) drawBg();
  const live = S.live ? linkLoads(nowS()) : null, loads = live ? live.load : null;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, fx.width, fx.height);
  let sx = 0, sy = 0; if (now < shakeUntil) { const a = 5 * (shakeUntil - now) / 600; sx = (Math.random() - .5) * a * 2; sy = (Math.random() - .5) * a * 2; }
  ctx.drawImage(bg, sx * DPR, sy * DPR);
  ctx.setTransform(DPR * K, 0, 0, DPR * K, sx * DPR, sy * DPR);
  const t = now / 1000;

  // planes under everything
  if (!REDUCED) updatePlanes(Math.min(.05, (now - lastT) / 1000)); drawPlanes();
  // links
  const perLink = {}, loopLink = new Set();
  M.edges.forEach((e, i) => { if (loads) perLink[e.link] = Math.max(perLink[e.link] || 0, loads[i]); if (M.inComp[i] >= 0) loopLink.add(e.link); });
  ctx.lineCap = "round";
  for (const l of LINKS) {
    if (!linkVisible(l)) continue;
    const st = S.link[l.id], sel = S.sel && S.sel.link === l.id;
    const v = perLink[l.id] || 0;
    if (v > .003) { tracePath(ctx, l); ctx.strokeStyle = lerpColor(PAL.storm0, PAL.storm1, Math.min(1, v)); ctx.globalAlpha = .28; ctx.lineWidth = 8 + 14 * v; ctx.stroke(); ctx.globalAlpha = 1; }
    tracePath(ctx, l);
    ctx.setLineDash(st === "absent" ? [1, 8] : st === "shut" ? [9, 6] : []);
    ctx.lineWidth = sel ? 4.5 : st === "absent" ? 3 : 2.5;
    ctx.strokeStyle = sel ? PAL.accent : PAL.ink2; ctx.globalAlpha = sel ? 1 : st === "up" ? .6 : st === "shut" ? .4 : .75;
    ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    if (loopLink.has(l.id)) { // marching "loop" outline
      tracePath(ctx, l); ctx.setLineDash([10, 8]); ctx.lineDashOffset = REDUCED ? 0 : -t * 40; ctx.strokeStyle = PAL.magenta; ctx.lineWidth = 3;
      ctx.shadowColor = PAL.magenta; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0; ctx.setLineDash([]); ctx.lineDashOffset = 0;
    }
    const lbl = S.mode === "plain" ? PLAIN_LINK[l.id] : l.label;
    if (lbl) { const xc = l.id === "L15" || l.id === "L16";
      const [x, y] = pointOn(l, l.id === "L5" ? .22 : l.id === "L14" ? .42 : l.id === "L6" ? .62 : .5, true);
      ctx.font = "500 12px 'IBM Plex Sans', sans-serif"; ctx.textAlign = xc ? "center" : "left";
      const tx = xc ? x : x + 8, ty = l.id === "L16" ? y + 17 : y - 8;
      ctx.lineWidth = 4; ctx.strokeStyle = PAL.chart; ctx.strokeText(lbl, tx, ty); ctx.fillStyle = PAL.ink2; ctx.fillText(lbl, tx, ty); ctx.textAlign = "left"; }
  }
  // blocked ports
  const act = activeLinks();
  for (const key of M.blocked) {
    const [dev, port] = key.split("|"); const l = act.find(l => (l.a === dev && l.ap === port) || (l.b === dev && l.bp === port)); if (!l) continue;
    const len = Math.hypot(DEV[l.b].x - DEV[l.a].x, DEV[l.b].y - DEV[l.a].y);
    const [x, y] = pointOn(l, l.ctrl && len > 400 ? .25 : Math.min(.45, 130 / len), l.a === dev);
    ctx.fillStyle = PAL.panel; ctx.strokeStyle = PAL.ink; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.roundRect(x - 8, y - 8, 16, 16, 3); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
  }
  // storm particles
  if (loads && !REDUCED) {
    const dt = Math.min(.05, (now - lastT) / 1000);
    if (spawnAcc.length !== M.n) spawnAcc = new Float64Array(M.n);
    for (let i = 0; i < M.n; i++) { const v = loads[i]; if (v < .003) continue; spawnAcc[i] += dt * (6 + 70 * v);
      while (spawnAcc[i] >= 1) { spawnAcc[i]--; particles.push({e: i, p: 0, sp: .9 + .9 * v, v}); } }
    if (particles.length > 1400) particles.splice(0, particles.length - 1400);
    ctx.globalCompositeOperation = PAL.dark ? "lighter" : "source-over";
    for (const q of particles) { q.p += dt * q.sp; const e = M.edges[q.e]; if (!e || q.p > 1) { q.dead = true; continue; }
      const l = LINK[e.link]; const [x, y] = pointOn(l, q.p, l.a === e.tail);
      ctx.fillStyle = lerpColor(PAL.storm0, PAL.storm1, Math.min(1, q.v)); ctx.beginPath(); ctx.arc(x, y, 2 + 2.2 * q.v, 0, 6.283); ctx.fill(); }
    ctx.globalCompositeOperation = "source-over"; particles = particles.filter(q => !q.dead);
  } else particles = [];
  // guided highlight
  if (highlight && (S.mode !== "engineer" || now < highlight.until)) {
    const pulse = .5 + .5 * Math.sin(t * 5);
    ctx.strokeStyle = PAL.accent; ctx.shadowColor = PAL.accent; ctx.shadowBlur = 14;
    if (highlight.dev && !(DEV[highlight.dev].routedOnly && !S.routed)) { const [x, y] = devPoint(highlight.dev);
      ctx.lineWidth = 3; ctx.globalAlpha = .4 + .6 * pulse; ctx.beginPath(); ctx.ellipse(x, y, 84 + 8 * pulse, 40 + 6 * pulse, 0, 0, 6.283); ctx.stroke(); }
    if (highlight.link && linkVisible(LINK[highlight.link])) { tracePath(ctx, LINK[highlight.link]); ctx.lineWidth = 10 + 6 * pulse; ctx.globalAlpha = .18 + .25 * pulse; ctx.stroke(); }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }
  // health glow behind Centers
  const H = centerHealth(loads);
  for (const [name, d] of Object.entries(DEV)) { if (!d.center || H[d.center].cls === "good") continue;
    const col = H[d.center].cls === "crit" ? PAL.crit : PAL.warn; const r = 90 + (REDUCED ? 0 : 12 * Math.sin(t * 6));
    const g = ctx.createRadialGradient(d.x, d.y, 10, d.x, d.y, r); g.addColorStop(0, col + "66"); g.addColorStop(1, col + "00");
    ctx.fillStyle = g; ctx.fillRect(d.x - r, d.y - r, 2 * r, 2 * r); }
  // slow-motion comets
  if (anim) drawComets(now);
  // shockwaves
  waves = waves.filter(w => now - w.t0 < w.dur);
  for (const w of waves) { const k = Math.min(1, Math.max(0, (now - w.t0) / w.dur)); ctx.strokeStyle = w.color; ctx.globalAlpha = 1 - k; ctx.lineWidth = 3 * (1 - k) + 1;
    ctx.beginPath(); ctx.arc(w.x, w.y, w.maxR * (1 - Math.pow(1 - k, 3)), 0, 6.283); ctx.stroke(); } ctx.globalAlpha = 1;
  // device cards
  updateCards(H);
  glitching = new Set();
  if (loads) for (const [name, d] of Object.entries(DEV)) if (d.center && H[d.center].cls === "crit") glitching.add(name);
  if (HIC) for (const [name, d] of Object.entries(DEV)) {
    const c = cards[name]; if (c.el.hidden) continue;
    const w = c.el.offsetWidth, h = c.el.offsetHeight; if (!w) continue;
    const x = d.x - w / 2, y = d.kind === "host" ? d.y - 15 : d.y - h / 2;
    try {
      if (glitching.has(name) && !REDUCED && Math.random() < .55) {
        ctx.globalAlpha = .7;
        for (let s = 0; s < 3; s++) { const sy0 = Math.random() * h * .8, sh = 4 + Math.random() * 9;
          ctx.drawElementImage(c.el, 0, sy0, w, sh, x + (Math.random() - .5) * 18, y + sy0, w, sh); }
        ctx.globalAlpha = 1;
      }
      const m = ctx.drawElementImage(c.el, x, y);
      if (m && typeof m.toString === "function") { const s = m.toString(); if (s !== c.m) { c.el.style.transform = s; c.m = s; } }
      if (glitching.has(name)) { ctx.fillStyle = PAL.crit; ctx.globalAlpha = .08 + (REDUCED ? 0 : .08 * Math.random()); ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1; }
    } catch (err) { /* no snapshot yet: drawn on the next paint */ }
  }
  // banners
  banners = banners.filter(b => now - b.t0 < 1800);
  for (const b of banners) { const k = Math.max(0, (now - b.t0) / 1800), a = k < .15 ? k / .15 : k > .7 ? (1 - k) / .3 : 1;
    ctx.globalAlpha = a; ctx.font = `800 ${58 + 10 * k}px 'Barlow Condensed', sans-serif`; ctx.textAlign = "center";
    ctx.lineWidth = 8; ctx.strokeStyle = PAL.chart; ctx.strokeText(b.text, 500, 360); ctx.fillStyle = b.color; ctx.fillText(b.text, 500, 360);
    ctx.textAlign = "left"; ctx.globalAlpha = 1; }
  // confetti
  if (confetti.length) { const dt = Math.min(.05, (now - lastT) / 1000);
    confetti = confetti.filter(p => now - p.t0 < 2600);
    for (const p of confetti) { p.vy += 900 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.globalAlpha = 1 - (now - p.t0) / 2600; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore(); } }
  // ground stop vignette
  if (S.gsStart) { const a = .16 + (REDUCED ? 0 : .1 * Math.sin(t * 4)); const g = ctx.createRadialGradient(500, 340, 260, 500, 340, 640);
    g.addColorStop(0, "rgba(220,40,40,0)"); g.addColorStop(1, `rgba(220,40,40,${a})`); ctx.fillStyle = g; ctx.fillRect(0, 0, 1000, 680); }
  lastT = now;
  return loads;
}

/* ========================================================================
   8. SLOW MOTION  (hop-by-hop: x_{k+1} = B^T x_k, drawn as comets)
   ======================================================================== */
function fmt(x) { return x >= 1e6 ? (x / 1e6).toFixed(1) + "M" : x >= 1e4 ? Math.round(x / 1e3) + "k" : Math.round(x).toLocaleString(); }
function drawComets(now) {
  const HOP = REDUCED ? 1100 : 800;
  const k = Math.floor((now - anim.start) / HOP), f = ((now - anim.start) % HOP) / HOP;
  if (k >= anim.xs.length) {
    const total = anim.xs.reduce((s, x) => s + x.reduce((a, b) => a + b, 0), 0);
    const still = anim.xs.length >= 41;
    document.getElementById("hopstats").textContent = still ? `Stopped watching after 40 hops: ${fmt(total)} copies so far, and it's still going.` : `Done after ${anim.xs.length} hops. ${fmt(total)} copies sent in total.`;
    S.seen.slowDone = true; onSlowDone(still, total); anim = null; drawMatrix(null); return;
  }
  const x = anim.xs[k]; let inflight = 0, total = 0;
  for (let j = 0; j <= k; j++) for (const v of anim.xs[j]) total += v;
  M.edges.forEach((e, i) => { if (!x[i]) return; inflight += x[i];
    const l = LINK[e.link], fromA = l.a === e.tail;
    for (let tr = 5; tr >= 0; tr--) { const p = Math.max(0, f - tr * .035); const [px, py] = pointOn(l, p, fromA);
      ctx.fillStyle = PAL.magenta; ctx.globalAlpha = tr ? .12 * (6 - tr) : 1; if (!tr) { ctx.shadowColor = PAL.magenta; ctx.shadowBlur = 14; }
      ctx.beginPath(); ctx.arc(px, py, tr ? 4 : (x[i] > 1 ? 11 : 7), 0, 6.283); ctx.fill(); ctx.shadowBlur = 0; }
    ctx.globalAlpha = 1;
    if (x[i] > 1) { const [px, py] = pointOn(l, f, fromA); ctx.fillStyle = "#fff"; ctx.font = "600 10px 'IBM Plex Mono', monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(fmt(x[i]), px, py); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; } });
  document.getElementById("hopstats").textContent = `Hop ${k + 1}: ${fmt(inflight)} copies in flight · ${fmt(total)} sent so far`;
  drawMatrix(x);
}
function drawMatrix(x) {
  const cv = document.getElementById("matrix"); if (!cv || !document.getElementById("matrixBox").open || !M) return;
  const c = cv.getContext("2d"), N = M.n, W = cv.width, s = W / Math.max(N, 1);
  c.fillStyle = PAL.panel; c.fillRect(0, 0, W, W);
  for (let i = 0; i < N; i++) {
    if (M.inComp[i] >= 0) { c.fillStyle = PAL.magenta; c.globalAlpha = .14; c.fillRect(0, i * s, W, s); c.globalAlpha = 1; }
    if (x && x[i]) { c.fillStyle = PAL.accent; c.globalAlpha = .3; c.fillRect(0, i * s, W, s); c.globalAlpha = 1; }
    c.fillStyle = PAL.ink; for (const j of M.out[i]) { c.beginPath(); c.arc(j * s + s / 2, i * s + s / 2, Math.max(1.5, s * .32), 0, 7); c.fill(); }
  }
}

