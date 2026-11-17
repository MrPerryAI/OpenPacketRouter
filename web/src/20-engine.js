/* ========================================================================
   3. SPANNING TREE (simplified 802.1D: root, root ports, designated ports)
   Switches with STP off either pass BPDUs through like a hub (real Cisco)
   or drop them, depending on S.bpduPass.
   ======================================================================== */
const portId = p => { const m = /^(Fa|Gi)0\/(\d+)$/.exec(p); return m ? (m[1] === "Gi" ? 24 : 0) + +m[2] : 99; };
const cost = l => l.cap >= GE ? 4 : 19;
function activeLinks() {
  return LINKS.filter(l => S.link[l.id] === "up" && (!DEV[l.a].routedOnly || S.routed) && (!DEV[l.b].routedOnly || S.routed));
}
function computeSTP(active) {
  const isStp = d => DEV[d].kind === "switch" && S.stp[d];
  const isHubSw = d => DEV[d].kind === "switch" && !S.stp[d];
  // union-find hub groups of STP-off switches (only if they pass BPDUs)
  const parent = {}; const find = x => parent[x] === x ? x : (parent[x] = find(parent[x]));
  for (const d in DEV) parent[d] = d;
  if (S.bpduPass) for (const l of active) if (isHubSw(l.a) && isHubSw(l.b)) parent[find(l.a)] = find(l.b);
  // segments: list of STP ports attached
  const segs = {}; const add = (k, port) => (segs[k] = segs[k] || []).push(port);
  for (const l of active) {
    const ends = [[l.a, l.ap, l.b], [l.b, l.bp, l.a]];
    for (const [d, p, other] of ends) {
      if (!isStp(d)) continue;
      const port = {dev: d, port: p, link: l};
      if (isStp(other)) add("L:" + l.id, port);
      else if (isHubSw(other) && S.bpduPass) add("H:" + find(other), port);
      else add("E:" + d + p, port);           // edge: host, router, or BPDU-dropping switch
    }
  }
  // Dijkstra from the best bridge in each BPDU-connected component
  const stpDevs = Object.keys(DEV).filter(d => isStp(d) && DEV[d].kind === "switch");
  const bid = d => [DEV[d].prio, DEV[d].mac];
  const lessArr = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
  const best = {};     // dev -> {cost, root, via:{senderBid,senderPort,port}}
  const portsOf = {};
  for (const [k, ports] of Object.entries(segs)) for (const p of ports) (portsOf[p.dev] = portsOf[p.dev] || []).push({...p, seg: k});
  const unvisited = new Set(stpDevs);
  while (unvisited.size) {
    let root = [...unvisited].sort((a, b) => lessArr(bid(a), bid(b)) ? -1 : 1)[0];
    const dist = {[root]: {key: [0], rootPort: null}};
    const pq = [[0, root]]; const done = new Set();
    while (pq.length) {
      pq.sort((a, b) => a[0] - b[0]); const [, u] = pq.shift();
      if (done.has(u)) continue; done.add(u); unvisited.delete(u);
      for (const pu of portsOf[u] || []) for (const pv of segs[pu.seg]) {
        if (pv.dev === u || done.has(pv.dev)) continue;
        const key = [dist[u].key[0] + cost(pv.link), ...bid(u), portId(pu.port), portId(pv.port)];
        if (!dist[pv.dev] || lessArr(key, dist[pv.dev].key)) {
          dist[pv.dev] = {key, rootPort: pv.port}; pq.push([key[0], pv.dev]);
        }
      }
    }
    for (const d of done) best[d] = dist[d];
  }
  // port roles
  const blocked = new Set();
  for (const ports of Object.values(segs)) {
    let des = null, desKey = null;
    for (const p of ports) {
      const k = [best[p.dev].key[0], ...bid(p.dev), portId(p.port)];
      if (!desKey || lessArr(k, desKey)) { des = p; desKey = k; }
    }
    for (const p of ports) {
      if (p === des) continue;
      if (best[p.dev].rootPort === p.port) continue;
      blocked.add(p.dev + "|" + p.port);
    }
  }
  return blocked;
}

/* ========================================================================
   4. THE STORM MATH  (ported from poc/storm-math/stormmath/analysis.py)
   Frames are counted per directed link. One hop later a frame on edge e
   becomes a frame on every edge leaving e's head switch over another link:
   the non-backtracking matrix B. Its spectral radius rho classifies loops.
   ======================================================================== */
let M = null; // current model
function buildModel() {
  const active = activeLinks();
  const blocked = computeSTP(active);
  const fwd = (d, p) => !blocked.has(d + "|" + p);
  const edges = [];
  for (const l of active) {
    if (!fwd(l.a, l.ap) || !fwd(l.b, l.bp)) continue;
    for (const [t, tp, h, hp] of [[l.a, l.ap, l.b, l.bp], [l.b, l.bp, l.a, l.ap]]) {
      const d = FRAME_BITS / l.cap + l.prop + SWITCH_LAT;
      edges.push({link: l.id, tail: t, tp, head: h, hp, d, cap: l.cap / FRAME_BITS});
    }
  }
  const n = edges.length, out = edges.map(() => []), byTail = {};
  edges.forEach((f, j) => (byTail[f.tail] = byTail[f.tail] || []).push(j));
  edges.forEach((e, i) => { if (DEV[e.head].kind === "switch")
    for (const j of byTail[e.head] || []) if (edges[j].link !== e.link) out[i].push(j); });
  // strongly connected components (iterative Tarjan)
  const idx = new Array(n).fill(-1), low = new Array(n).fill(0), on = new Array(n).fill(false), st = [], comps = [];
  let c = 0;
  for (let s = 0; s < n; s++) {
    if (idx[s] >= 0) continue;
    const work = [[s, 0]]; idx[s] = low[s] = c++; st.push(s); on[s] = true;
    while (work.length) {
      const top = work[work.length - 1], v = top[0];
      if (top[1] < out[v].length) {
        const w = out[v][top[1]++];
        if (idx[w] < 0) { idx[w] = low[w] = c++; st.push(w); on[w] = true; work.push([w, 0]); }
        else if (on[w]) low[v] = Math.min(low[v], idx[w]);
      } else {
        work.pop();
        if (work.length) { const p = work[work.length - 1][0]; low[p] = Math.min(low[p], low[v]); }
        if (low[v] === idx[v]) { const comp = []; let w; do { w = st.pop(); on[w] = false; comp.push(w); } while (w !== v); comps.push(comp); }
      }
    }
  }
  const loops = comps.filter(cp => cp.length > 1 || out[cp[0]].includes(cp[0]));
  const inComp = new Int32Array(n).fill(-1);
  loops.forEach((cp, k) => cp.forEach(i => inComp[i] = k));
  // a loop component is a simple cycle iff every member has exactly one successor inside it -> rho = 1
  const isCycle = loops.map((cp, k) => cp.every(i => out[i].filter(j => inComp[j] === k).length === 1));
  const rhoComp = (k, w) => {          // power iteration on (B_k^T W + I), irreducible -> converges
    const cp = loops[k]; const pos = new Map(cp.map((i, a) => [i, a]));
    let v = new Float64Array(cp.length).fill(1), lam = 1;
    for (let it = 0; it < 3000; it++) {
      const nv = Float64Array.from(v);
      cp.forEach((i, a) => { const wi = w ? w[i] : 1; for (const j of out[i]) if (inComp[j] === k) nv[pos.get(j)] += wi * v[a]; });
      let mx = 0; for (const x of nv) mx = Math.max(mx, x);
      for (let a = 0; a < nv.length; a++) nv[a] /= mx;
      const prev = lam; lam = mx; v = nv;
      if (it > 50 && Math.abs(lam - prev) < 1e-12) break;
    }
    return lam - 1;
  };
  const rhos = loops.map((cp, k) => isCycle[k] ? 1 : rhoComp(k, null));
  const rho = rhos.length ? Math.max(...rhos) : 0;
  const regime = !loops.length ? "TREE" : rhos.some((r, k) => !isCycle[k]) ? "AMPLIFYING" : "CIRCULATING";
  // growth rate r: rho(diag(e^{-r d}) B) = 1   (only for amplifying components)
  let r = 0;
  if (regime === "AMPLIFYING") {
    const g = rr => { const w = edges.map(e => Math.exp(-rr * e.d));
      return Math.max(...loops.map((cp, k) => isCycle[k] ? 0 : rhoComp(k, w))) - 1; };
    let lo = 0, hi = 1; while (g(hi) > 0) hi *= 2;
    for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (g(mid) > 0) lo = mid; else hi = mid; }
    r = (lo + hi) / 2;
  }
  // storm reach: everything downstream of a loop
  const reach = new Uint8Array(n); const stack = [];
  loops.forEach(cp => cp.forEach(i => { reach[i] = 1; stack.push(i); }));
  while (stack.length) { const i = stack.pop(); for (const j of out[i]) if (!reach[j]) { reach[j] = 1; stack.push(j); } }
  // hotspot shares (amplifying): Perron vector of (diag(w) B)^T
  let share = null;
  if (regime === "AMPLIFYING") {
    const w = edges.map(e => Math.exp(-r * e.d)); let u = new Float64Array(n).fill(1);
    for (let it = 0; it < 4000; it++) {
      const nu = Float64Array.from(u);
      for (let i = 0; i < n; i++) for (const j of out[i]) nu[j] += w[i] * u[i];
      let s = 0; for (const x of nu) s += x; for (let i = 0; i < n; i++) nu[i] /= s; u = nu;
    }
    share = u;
  }
  M = {edges, out, n, loops, isCycle, rho, regime, r, reach, share, blocked, inComp};
  M.reachDevs = new Set(); edges.forEach((e, i) => { if (reach[i]) { M.reachDevs.add(e.tail); M.reachDevs.add(e.head); } });
  M.perHost = {};
  return M;
}
function step(x) { const y = new Float64Array(M.n); for (let i = 0; i < M.n; i++) if (x[i]) for (const j of M.out[i]) y[j] += x[i]; return y; }
function inject(host) { const x = new Float64Array(M.n); M.edges.forEach((e, i) => { if (e.tail === host) x[i] = 1; }); return x; }
// circulating: long-run frames/s on every edge after one broadcast from host
function steadyRates(host) {
  if (M.perHost[host]) return M.perHost[host];
  let x = inject(host);
  for (let k = 0; k < 4 * M.n + 4; k++) x = step(x);
  const rates = new Float64Array(M.n), onCyc = new Uint8Array(M.n);
  M.loops.forEach(cp => { let N = 0, L = 0; for (const i of cp) { N += x[i]; L += M.edges[i].d; onCyc[i] = 1; }
    for (const i of cp) rates[i] = N / L; });
  let y = Float64Array.from(rates);
  for (let k = 0; k < 4 * M.n; k++) { const ny = step(y); for (let i = 0; i < M.n; i++) if (onCyc[i]) ny[i] = rates[i]; y = ny; }
  // when does the first copy reach a loop? (earliest arrival, for the live clock)
  const t = new Float64Array(M.n).fill(Infinity); const q = [];
  M.edges.forEach((e, i) => { if (e.tail === host) { t[i] = e.d; q.push(i); } });
  while (q.length) { const i = q.shift(); for (const j of M.out[i]) if (t[i] + M.edges[j].d < t[j]) { t[j] = t[i] + M.edges[j].d; q.push(j); } }
  let arrive = Infinity; M.loops.forEach(cp => cp.forEach(i => arrive = Math.min(arrive, t[i])));
  return (M.perHost[host] = {y, arrive: isFinite(arrive) ? arrive : 0});
}

/* ========================================================================
   5. LIVE LOAD  (what the network feels, second by second)
   ======================================================================== */
function now() { return (performance.now() - S.t0) / 1000; }
function linkLoads(t) {
  const R = new Float64Array(M.n);
  if (M.regime === "CIRCULATING") {
    for (const b of S.broadcasts) { const {y, arrive} = steadyRates(b.host); if (t >= b.t + arrive) for (let i = 0; i < M.n; i++) R[i] += y[i]; }
  } else if (M.regime === "AMPLIFYING") {
    let loopD = 0, cnt = 0; M.loops.forEach(cp => cp.forEach(i => { loopD += M.edges[i].d; cnt++; }));
    const A = cnt / loopD;                        // order-of-magnitude starting rate
    for (const b of S.broadcasts) { const {arrive} = steadyRates(b.host); const dt = t - b.t - arrive;
      if (dt >= 0) { const g = A * Math.exp(Math.min(700, M.r * dt)); for (let i = 0; i < M.n; i++) R[i] += g * M.share[i]; } }
  }
  const load = new Float64Array(M.n);
  for (let i = 0; i < M.n; i++) load[i] = Math.min(1, R[i] / M.edges[i].cap);
  return {R, load};
}

