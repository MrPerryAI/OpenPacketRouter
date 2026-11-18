// Storm math on the engine's live topology: what would one broadcast do here?
//
// Same model as poc/storm-math (stormmath/analysis.py), computed from a Network instead of a hand-built
// Topology. Flooding is a non-backtracking walk over directed cables ("edges"): a frame arriving at a
// switch on edge e leaves on every forwarding edge f out of that switch except e's reverse. That is the
// matrix B[e,f]. Its spectral radius rho classifies the network:
//   rho = 0  TREE         every broadcast dies out
//   rho = 1  CIRCULATING  frames loop forever without multiplying (each broadcast adds load)
//   rho > 1  AMPLIFYING   frames multiply by ~rho per hop: a broadcast storm
// For AMPLIFYING networks the growth rate r (1/s) solves rho(diag(exp(-r d)) B) = 1, where d is the hop
// delay of each edge (serialization + propagation + switch lookup).
//
// The result is the "loop-risk score" the detail-level scheduler uses: which cables and devices a loop
// would reach, and how fast it would grow. Nothing here sends frames; it reads the topology only.

const TOL = 1e-6;
export const STORM_DEFAULTS = {frameBits: 84 * 8, switchLatency: 5e-6, capacity: 100e6};

/** Can this switch port carry data frames? (STP state when the switch has one, else the `blocked` list.) */
function forwards(node, port) {
  if (node.kind !== "switch") return true;
  if (typeof node.forwards === "function") return node.forwards(port);
  return !(node.blocked && node.blocked.has(port));
}

/** Directed edges that can carry a data frame, with hop delays, in the engine's counter naming. */
export function stormEdges(net, opts = {}) {
  const o = {...STORM_DEFAULTS, ...opts}; const edges = [];
  for (const l of net.links) {
    if (!l.up || !forwards(l.a.node, l.a.name) || !forwards(l.b.node, l.b.name)) continue;
    for (const [t, h] of [[l.a, l.b], [l.b, l.a]]) {
      // capacity of this direction: a token-bucket shaper on the sending interface (link.js) sets it
      const delay = o.frameBits / (t.shaper?.rate ?? l.capacity ?? o.capacity) + l.delay + o.switchLatency;
      edges.push({link: l.id, tail: t.node.name, head: h.node.name, headIsSwitch: h.node.kind === "switch",
        label: `${t.node.name}:${t.name}>${h.node.name}:${h.name}`, delay});
    }
  }
  return edges;
}

/** Sparse non-backtracking matrix: out[i] = edges j that a frame on edge i is flooded onto. */
function nbAdjacency(edges) {
  const byTail = new Map();
  edges.forEach((f, j) => { if (!byTail.has(f.tail)) byTail.set(f.tail, []); byTail.get(f.tail).push(j); });
  return edges.map(e => e.headIsSwitch ? (byTail.get(e.head) || []).filter(j => edges[j].link !== e.link) : []);
}

/** Tarjan's strongly connected components (iterative). */
function sccs(adj) {
  const n = adj.length, index = new Array(n).fill(-1), low = new Array(n), on = new Array(n).fill(false);
  const stack = [], out = []; let counter = 0;
  for (let v = 0; v < n; v++) {
    if (index[v] >= 0) continue;
    const work = [[v, 0]]; index[v] = low[v] = counter++; stack.push(v); on[v] = true;
    while (work.length) {
      const top = work[work.length - 1], [node, i] = top;
      if (i < adj[node].length) {
        top[1]++; const w = adj[node][i];
        if (index[w] < 0) { index[w] = low[w] = counter++; stack.push(w); on[w] = true; work.push([w, 0]); }
        else if (on[w]) low[node] = Math.min(low[node], index[w]);
      } else {
        work.pop();
        if (work.length) { const p = work[work.length - 1][0]; low[p] = Math.min(low[p], low[node]); }
        if (low[node] === index[node]) { const comp = []; let w;
          do { w = stack.pop(); on[w] = false; comp.push(w); } while (w !== node); out.push(comp); }
      }
    }
  }
  return out;
}

/**
 * Spectral radius of the weighted matrix W[i,j] = weight[i] for j in adj[i], restricted to one strongly
 * connected component. Power iteration on (W + I) — irreducible plus identity is primitive, so it
 * converges even when W is periodic (a plain cycle) — then subtract the shift.
 */
function compRadius(comp, adj, weight) {
  const pos = new Map(comp.map((v, k) => [v, k]));
  const sub = comp.map(v => adj[v].filter(j => pos.has(j)).map(j => pos.get(j)));
  if (comp.length === 1 && !sub[0].length) return 0;
  let x = new Float64Array(comp.length).fill(1 / comp.length), lambda = 0;
  for (let it = 0; it < 100000; it++) {
    const y = Float64Array.from(x);                      // the identity shift
    for (let k = 0; k < sub.length; k++) { const w = weight(comp[k]) * x[k]; for (const j of sub[k]) y[j] += w; }
    let s = 0; for (const v of y) s += v;
    const next = s - 1;                                  // x sums to 1, so sum(y) = rho(W) + 1 at convergence
    for (let k = 0; k < y.length; k++) y[k] /= s;
    let diff = 0; for (let k = 0; k < y.length; k++) diff = Math.max(diff, Math.abs(y[k] - x[k]));
    x = y;
    if (it > 10 && Math.abs(next - lambda) < 1e-13 && diff < 1e-12) return next;
    lambda = next;
  }
  return lambda;
}

const regimeOf = rho => rho < TOL ? "TREE" : Math.abs(rho - 1) < TOL ? "CIRCULATING" : rho > 1 ? "AMPLIFYING" : "DECAYING";

/**
 * Analyse the network as it is now (links up/down, blocked or STP-blocked ports, link capacities).
 * Returns {rho, regime, growthRate (1/s), doublingTime (s or null), loopEdges, reachEdges (labels),
 * devicesReached, hostsReached (non-switch devices), edges}.
 */
export function stormAnalysis(net, opts = {}) {
  const edges = stormEdges(net, opts), adj = nbAdjacency(edges);
  const loops = sccs(adj).filter(c => c.length > 1 || adj[c[0]].includes(c[0]));
  const radius = weight => loops.reduce((m, c) => Math.max(m, compRadius(c, adj, weight)), 0);
  const rho = radius(() => 1);
  const regime = regimeOf(rho);

  let growthRate = 0;
  if (rho > 1 + TOL) {
    const f = r => radius(i => Math.exp(-r * edges[i].delay)) - 1;
    let lo = 0, hi = 1; while (f(hi) > 0) hi *= 2;
    for (let k = 0; k < 200; k++) { const mid = (lo + hi) / 2; if (f(mid) > 0) lo = mid; else hi = mid; }
    growthRate = (lo + hi) / 2;
  }

  const loopSet = new Set(loops.flat()), reach = new Set(loopSet), frontier = [...loopSet];
  while (frontier.length) for (const j of adj[frontier.pop()]) if (!reach.has(j)) { reach.add(j); frontier.push(j); }
  const devices = new Set(); for (const i of reach) { devices.add(edges[i].tail); devices.add(edges[i].head); }
  const sortIdx = s => [...s].sort((a, b) => a - b);
  return {
    rho, regime, growthRate, doublingTime: growthRate > 0 ? Math.LN2 / growthRate : null,
    loopEdges: sortIdx(loopSet).map(i => edges[i].label),
    reachEdges: sortIdx(reach).map(i => edges[i].label),
    devicesReached: [...devices].sort(),
    hostsReached: [...devices].filter(d => net.node(d).kind !== "switch").sort(),
    edges: edges.map(({label, delay}) => ({label, delay})),
  };
}
