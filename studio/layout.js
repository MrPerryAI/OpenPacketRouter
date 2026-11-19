// Automatic layout for a spec's devices: a small, deterministic force-directed placement.
// Switches and routers are pulled to the middle; hosts and servers sit around the devices they are cabled to.

/** positions: {name: {x, y}} inside a w × h box. */
export function autoLayout(spec, w = 900, h = 560) {
  const nodes = spec.nodes.map(n => n.name), kind = Object.fromEntries(spec.nodes.map(n => [n.name, n.kind]));
  const edges = spec.links.map(l => [l[0].split(":")[0], l[1].split(":")[0]]).filter(([a, b]) => kind[a] && kind[b]);
  const core = nodes.filter(n => kind[n] === "switch" || kind[n] === "router"), edge = nodes.filter(n => !core.includes(n));
  const pos = {}, cx = w / 2, cy = h / 2;
  core.forEach((n, i) => { const a = 2 * Math.PI * i / Math.max(1, core.length) - Math.PI / 2;
    const r = core.length > 1 ? Math.min(w, h) * 0.22 : 0; pos[n] = {x: cx + r * Math.cos(a), y: cy + r * Math.sin(a)}; });
  edge.forEach((n, i) => { const a = 2 * Math.PI * (i + 0.5) / Math.max(1, edge.length) - Math.PI / 2;
    pos[n] = {x: cx + Math.min(w, h) * 0.42 * Math.cos(a), y: cy + Math.min(w, h) * 0.42 * Math.sin(a)}; });
  // a host starts next to its first neighbour, pushed outwards
  for (const n of edge) { const e = edges.find(([a, b]) => a === n || b === n); if (!e) continue;
    const m = e[0] === n ? e[1] : e[0]; const p = pos[m]; const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy) || 1;
    pos[n] = {x: p.x + (dx / d) * 140 + (pos[n].x - cx) * 0.2, y: p.y + (dy / d) * 140 + (pos[n].y - cy) * 0.2}; }

  const L = 150, kRep = 9000;
  for (let it = 0; it < 400; it++) {
    const f = Object.fromEntries(nodes.map(n => [n, {x: 0, y: 0}]));
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = pos[nodes[i]], b = pos[nodes[j]]; let dx = a.x - b.x, dy = a.y - b.y; let d2 = dx * dx + dy * dy;
      if (d2 < 1) { dx = 1; dy = 0.5; d2 = 1.25; }
      const d = Math.sqrt(d2), s = kRep / d2;
      f[nodes[i]].x += s * dx / d; f[nodes[i]].y += s * dy / d; f[nodes[j]].x -= s * dx / d; f[nodes[j]].y -= s * dy / d;
    }
    for (const [a, b] of edges) { if (a === b) continue;
      const p = pos[a], q = pos[b], dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy) || 1, s = 0.05 * (d - L);
      f[a].x += s * dx / d; f[a].y += s * dy / d; f[b].x -= s * dx / d; f[b].y -= s * dy / d; }
    const cool = 1 - it / 400;
    for (const n of nodes) {
      const g = core.includes(n) ? 0.02 : 0.004;                       // gravity to the middle
      f[n].x += (cx - pos[n].x) * g; f[n].y += (cy - pos[n].y) * g;
      const m = Math.hypot(f[n].x, f[n].y), lim = 20 * cool + 0.5;
      if (m > lim) { f[n].x *= lim / m; f[n].y *= lim / m; }
      pos[n].x += f[n].x; pos[n].y += f[n].y;
    }
  }
  // fit into the box with a margin
  const xs = nodes.map(n => pos[n].x), ys = nodes.map(n => pos[n].y), M = 70;
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.min((w - 2 * M) / Math.max(1, x1 - x0), (h - 2 * M) / Math.max(1, y1 - y0), 1.4);
  for (const n of nodes) pos[n] = {x: Math.round(w / 2 + (pos[n].x - (x0 + x1) / 2) * s), y: Math.round(h / 2 + (pos[n].y - (y0 + y1) / 2) * s)};
  return pos;
}
