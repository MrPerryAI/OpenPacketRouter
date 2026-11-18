// Spanning tree (IEEE 802.1D, the classic STP the Linux kernel runs with stp_state 1).
//
// Real configuration BPDUs travel between bridges. Each bridge keeps, per port, the
// best (root, cost, bridge, port) it has heard, and from that picks:
//   - the root bridge (lowest bridge id = priority, then MAC),
//   - its root port (best path to the root),
//   - which ports are designated (they send the best BPDU on their segment),
//   - which ports are blocked (alternate: someone else has a better BPDU).
// Ports move blocking -> listening -> learning -> forwarding, each step one
// forward-delay apart. A port that stops hearing BPDUs times out after max-age.
//
// The structure follows the kernel's net/bridge/br_stp*.c, so port roles come out
// the same. Not modeled: topology-change notifications (a state change just flushes
// the local MAC table), RSTP, per-VLAN trees.

export const STP_MAC = "01:80:c2:00:00:00";
export const BLOCKING = "blocking", LISTENING = "listening", LEARNING = "learning", FORWARDING = "forwarding", DISABLED = "disabled";

// bridge ids and port ids compare as arrays/numbers; ids are [priority, mac] pairs
const cmpId = (a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
const idStr = id => `${id[0].toString(16).padStart(4, "0")}.${id[1].replace(/:/g, "")}`;

export class Stp {
  /** sw: the Switch. opts: {priority, mac, hello, maxAge, forwardDelay, cost: {port: n}, portPriority: {port: n}} */
  constructor(sw, opts = {}) {
    this.sw = sw; this.net = sw.net;
    this.priority = opts.priority ?? 0x8000;
    this.mac = opts.mac;
    this.hello = opts.hello ?? 2; this.maxAge = opts.maxAge ?? 20; this.forwardDelay = opts.forwardDelay ?? 15;
    this.costOf = opts.cost || {}; this.prioOf = opts.portPriority || {};
    this.started = false; this.ports = new Map(); this.gen = {};
  }
  get bid() { return [this.priority, this.mac]; }
  isRoot() { return cmpId(this.rootId, this.bid) === 0; }

  /** Called once the switch's ports exist (first run) — brings every cabled, up port in. */
  start() {
    if (this.started) return; this.started = true;
    let no = 0;
    for (const [name, iface] of Object.entries(this.sw.ifaces)) {
      no++;
      this.ports.set(name, {name, no, id: ((this.prioOf[name] ?? 128) << 8) | no, cost: this.costOf[name] ?? 19, state: DISABLED,
        desRoot: null, desCost: 0, desBridge: null, desPort: 0, role: "disabled", ageAt: 0});
    }
    this.rootId = this.bid; this.rootCost = 0; this.rootPort = null;
    this.curMaxAge = this.maxAge; this.curHello = this.hello; this.curFwd = this.forwardDelay;
    for (const p of this.ports.values()) { if (this._up(p)) this._enable(p, true); }
    this._configUpdate(); this._portStateSelection();
    if (this.isRoot()) this._startHello();
  }
  _up(p) { const i = this.sw.ifaces[p.name]; return !!(i.link && i.link.up); }

  // ----- timers (a restart or cancel invalidates the pending event) -----
  _timer(key, dt, fn) { const g = this.gen[key] = (this.gen[key] || 0) + 1; this.net._after(dt, () => { if (this.gen[key] === g) fn(); }, true); }
  _cancel(key) { this.gen[key] = (this.gen[key] || 0) + 1; }
  _startHello() { this._timer("hello", this.curHello, () => { this._configGeneration(); this._startHello(); }); }

  // ----- port lifecycle -----
  linkChange(name, up) {
    if (!this.started) return;
    const p = this.ports.get(name);
    if (up && p.state === DISABLED) this._enable(p);
    else if (!up && p.state !== DISABLED) this._disable(p);
  }
  _enable(p, quiet) {
    p.state = BLOCKING; this._becomeDesignated(p); p.role = "designated";
    if (!quiet) { this._configUpdate(); this._portStateSelection(); this._maybeRootHello(); }
  }
  _disable(p) {
    const wasRoot = this.isRoot();
    this._becomeDesignated(p); this._setState(p, DISABLED); p.role = "disabled";
    this._cancel("fd:" + p.name); this._cancel("age:" + p.name);
    this._configUpdate(); this._portStateSelection();
    if (!wasRoot && this.isRoot()) this._becomeRoot();
  }
  _becomeRoot() {
    this.curMaxAge = this.maxAge; this.curHello = this.hello; this.curFwd = this.forwardDelay;
    this._configGeneration(); this._startHello();
  }
  _maybeRootHello() { if (this.isRoot()) this._configGeneration(); }

  _setState(p, state) {
    if (p.state === state) return;
    this.sw.log("stp", `port ${p.name}: ${p.state} → ${state}`);
    p.state = state;
    if (state === BLOCKING || state === DISABLED) this.sw.flushPort(p.name);
  }

  // ----- the algorithm (802.1D 8.6) -----
  _becomeDesignated(p) { p.desRoot = this.rootId; p.desCost = this.rootCost; p.desBridge = this.bid; p.desPort = p.id; }
  _isDesignated(p) { return cmpId(p.desBridge, this.bid) === 0 && p.desPort === p.id; }

  _configUpdate() {
    let best = null;
    for (const p of this.ports.values()) {
      if (p.state === DISABLED || this._isDesignated(p) || cmpId(p.desRoot, this.bid) >= 0) continue;
      if (!best || this._betterRoot(p, best)) best = p;
    }
    if (!best) { this.rootId = this.bid; this.rootCost = 0; this.rootPort = null; }
    else { this.rootId = best.desRoot; this.rootCost = best.desCost + best.cost; this.rootPort = best.name;
      this.curMaxAge = best.recMaxAge ?? this.maxAge; this.curHello = best.recHello ?? this.hello; this.curFwd = best.recFwd ?? this.forwardDelay; }
    for (const p of this.ports.values()) {
      if (p.state === DISABLED) continue;
      if (this._isDesignated(p) || cmpId(p.desRoot, this.rootId) !== 0 || this.rootCost < p.desCost ||
          (this.rootCost === p.desCost && (cmpId(this.bid, p.desBridge) < 0 || (cmpId(this.bid, p.desBridge) === 0 && p.id < p.desPort))))
        this._becomeDesignated(p);
    }
  }
  _betterRoot(a, b) {
    const x = [cmpId(a.desRoot, b.desRoot), (a.desCost + a.cost) - (b.desCost + b.cost), cmpId(a.desBridge, b.desBridge), a.desPort - b.desPort, a.id - b.id];
    for (const v of x) if (v) return v < 0; return false;
  }
  _portStateSelection() {
    for (const p of this.ports.values()) {
      if (p.state === DISABLED) continue;
      if (p.name === this.rootPort) { p.role = "root"; this._makeForwarding(p); }
      else if (this._isDesignated(p)) { p.role = "designated"; this._cancel("age:" + p.name); this._makeForwarding(p); }
      else { p.role = "blocked"; this._setState(p, BLOCKING); this._cancel("fd:" + p.name); }
    }
  }
  _makeForwarding(p) {
    if (p.state !== BLOCKING) return;
    this._setState(p, LISTENING);
    this._timer("fd:" + p.name, this.curFwd, () => this._fdExpired(p));
  }
  _fdExpired(p) {
    if (p.state === LISTENING) { this._setState(p, LEARNING); this._timer("fd:" + p.name, this.curFwd, () => this._fdExpired(p)); }
    else if (p.state === LEARNING) this._setState(p, FORWARDING);
  }

  // ----- BPDUs -----
  _transmit(p) {
    if (p.state === DISABLED) return;
    const root = this.isRoot();
    const age = root ? 0 : (this.ports.get(this.rootPort).recAge ?? 0) + 1;
    if (age >= this.curMaxAge) return;
    const iface = this.sw.ifaces[p.name];
    this.sw.send(p.name, {src: iface.mac, dst: STP_MAC, type: "bpdu",
      bpdu: {root: this.rootId, cost: this.rootCost, bridge: this.bid, port: p.id, age, maxAge: this.curMaxAge, hello: this.curHello, fwd: this.curFwd}});
  }
  _configGeneration() {
    for (const p of this.ports.values()) if (this._isDesignated(p) && p.state !== DISABLED) this._transmit(p);
  }
  _supersedes(p, b) {
    let t = cmpId(b.root, p.desRoot); if (t) return t < 0;
    t = b.cost - p.desCost; if (t) return t < 0;
    t = cmpId(b.bridge, p.desBridge); if (t) return t < 0;
    if (cmpId(p.desBridge, this.bid) !== 0) return true;       // same sender refreshing its info
    return b.port <= p.desPort;
  }
  receive(ifname, f) {
    const p = this.ports.get(ifname); if (!p || p.state === DISABLED) return;
    const b = f.bpdu;
    if (cmpId(b.bridge, this.bid) === 0) { this.sw.log("stp", `BPDU from myself on ${ifname}: loop or reflection, ignored`); return; }
    if (this._supersedes(p, b)) {
      const wasRoot = this.isRoot();
      p.desRoot = b.root; p.desCost = b.cost; p.desBridge = b.bridge; p.desPort = b.port;
      p.recAge = b.age; p.recMaxAge = b.maxAge; p.recHello = b.hello; p.recFwd = b.fwd;
      this._timer("age:" + p.name, Math.max(b.maxAge - b.age, 0.001), () => this._ageExpired(p));
      this._configUpdate(); this._portStateSelection();
      if (!this.isRoot() && wasRoot) this._cancel("hello");
      this.sw.log("stp", `BPDU on ${ifname}: root ${idStr(b.root)} cost ${b.cost}; I am ${this.isRoot() ? "root" : "not root"}, root port ${this.rootPort ?? "-"}`);
      if (p.name === this.rootPort) this._configGeneration();
    } else if (this._isDesignated(p)) this._transmit(p);          // answer an inferior BPDU with ours
  }
  _ageExpired(p) {
    if (p.state === DISABLED || this._isDesignated(p)) return;
    this.sw.log("stp", `no BPDU on ${p.name} for max-age: its information expired`);
    const wasRoot = this.isRoot();
    this._becomeDesignated(p); this._configUpdate(); this._portStateSelection();
    if (this.isRoot() && !wasRoot) this._becomeRoot();
  }

  /** What an engineer would read off `show spanning-tree`. */
  describe() {
    return {bridgeId: idStr(this.bid), root: idStr(this.rootId), isRoot: this.isRoot(), rootCost: this.rootCost, rootPort: this.rootPort,
      ports: Object.fromEntries([...this.ports.values()].map(p => [p.name, {role: p.role, state: p.state, no: p.no, id: p.id, cost: p.cost,
        designatedRoot: idStr(p.desRoot ?? this.bid), designatedCost: p.desCost, designatedBridge: idStr(p.desBridge ?? this.bid), designatedPort: p.desPort}]))};
  }
}
