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
// the same.
//
// Topology changes follow the kernel too: a bridge that sees a port start or stop carrying traffic sends a
// TCN BPDU up its root port, repeating every hello until the designated bridge acknowledges it in a config
// BPDU. The root then sets the topology-change flag in its config BPDUs for forward-delay + max-age seconds.
// While a bridge has the flag, its MAC entries expire after one forward delay instead of the aging time (it
// does not flush its table; Linux ages entries faster). Config BPDUs leave a port at most once a second (the kernel's hold timer). Not modeled: RSTP, per-VLAN trees.

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
    this.tc = false; this.tcd = false;       // topology_change flag (in force) and topology_change_detected (our TCN not yet acknowledged)
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
    this._cancel("fd:" + p.name); this._cancel("age:" + p.name); this._cancel("hold:" + p.name); p.hold = false; p.configPending = false; p.tcAck = false;
    this._configUpdate(); this._portStateSelection();
    if (!wasRoot && this.isRoot()) this._becomeRoot();
  }
  _becomeRoot() {
    this.curMaxAge = this.maxAge; this.curHello = this.hello; this.curFwd = this.forwardDelay;
    this._topologyChange(); this._cancel("tcn");
    this._configGeneration(); this._startHello();
  }
  _maybeRootHello() { if (this.isRoot()) this._configGeneration(); }

  _setState(p, state) {
    if (p.state === state) return;
    this.sw.log("stp", `port ${p.name}: ${p.state} → ${state}`);
    p.state = state;
    if (state === DISABLED) this.sw.flushPort(p.name);    // Linux deletes a port's learned entries only when the port goes down
  }

  // ----- topology changes (802.1D 8.6.14, the kernel's br_topology_change_detection) -----
  /** The topology_change flag. While set, Linux reports its ageing_time as 2 x forward delay (`agingOverride`, what
   *  sysfs shows) and its MAC collector expires entries after one forward delay (Switch._gc). */
  _setTc(v) {
    if (this.tc === v) return;
    this.tc = v; this.sw.agingOverride = v ? 2 * this.curFwd : null;
    this.sw.log("stp", v ? `topology change: MAC entries now last ${this.curFwd}s` : "topology change over: MAC aging time back to normal");
  }
  _topologyChange() {
    if (this.isRoot()) {
      this._setTc(true);
      this._timer("tc", this.forwardDelay + this.maxAge, () => { this.tcd = false; this._setTc(false); });
      this.sw.log("stp", "topology change detected: I am the root, so the flag goes into my BPDUs");
    } else if (!this.tcd) {
      this._sendTcn(); this._timer("tcn", this.hello, () => this._tcnTimer());
    }
    this.tcd = true;
  }
  _sendTcn() {
    const p = this.ports.get(this.rootPort); if (!p) return;
    this.sw.log("stp", `topology change detected: sending a TCN up root port ${p.name}`);
    this.sw.send(p.name, {src: this.sw.ifaces[p.name].mac, dst: STP_MAC, type: "bpdu", bpdu: {tcn: true}});
  }
  _tcnTimer() { if (!this.isRoot()) { this._sendTcn(); this._timer("tcn", this.hello, () => this._tcnTimer()); } }

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
      if (p.name === this.rootPort) { p.role = "root"; p.tcAck = false; p.configPending = false; this._makeForwarding(p); }
      else if (this._isDesignated(p)) { p.role = "designated"; this._cancel("age:" + p.name); this._makeForwarding(p); }
      else {
        p.role = "blocked"; p.tcAck = false; p.configPending = false;
        if (p.state === FORWARDING || p.state === LEARNING) this._topologyChange();   // a port that carried traffic stops
        this._setState(p, BLOCKING); this._cancel("fd:" + p.name);
      }
    }
  }
  _makeForwarding(p) {
    if (p.state !== BLOCKING) return;
    this._setState(p, LISTENING);
    this._timer("fd:" + p.name, this.curFwd, () => this._fdExpired(p));
  }
  _fdExpired(p) {
    if (p.state === LISTENING) { this._setState(p, LEARNING); this._timer("fd:" + p.name, this.curFwd, () => this._fdExpired(p)); }
    else if (p.state === LEARNING) {
      this._setState(p, FORWARDING);
      if ([...this.ports.values()].some(q => q.state !== DISABLED && this._isDesignated(q))) this._topologyChange();
    }
  }

  // ----- BPDUs -----
  /** How long the hold timer runs. Exactly 1 s, unless the network models the kernel's jiffy rounding (`net.jiffyHolds`,
   *  a number: the engine clock's offset in seconds from a jiffies-second boundary). Linux arms the timer with
   *  `round_jiffies(jiffies + 1 s)` (br_transmit_config), and round_jiffies rounds the absolute jiffies counter to a whole
   *  multiple of HZ (a jiffies second, not a wall-clock second: the counter starts at 2^32 - 300 HZ at boot): down when the fraction is under a quarter second, up otherwise. So a pending config BPDU leaves at a
   *  whole jiffies second, 0.75-1.75 s after the previous one, not exactly 1 s after it. The validator (validate/tcn)
   *  starts the kernel's bridges half a second after a jiffies-second boundary (measured, see jiffy_boundary) and keeps every step on that schedule, which is
   *  `jiffyHolds = 0.5` here; half a second keeps every event 0.25 s clear of the rounding threshold. */
  _holdTime() {
    if (this.net.jiffyHolds === undefined || this.net.jiffyHolds === false) return 1;
    const now = this.net.time + this.net.jiffyHolds, t = now + 1, frac = t - Math.floor(t + 1e-9);
    const end = frac < 0.25 ? t - frac : t - frac + 1;
    return Math.max(end - now, 0.001);
  }
  /** Send a config BPDU out p. At most one per second per port (the kernel's 1 s hold timer): an earlier request is
   *  remembered and sent when the timer runs out. */
  _transmit(p) {
    if (p.state === DISABLED) return;
    if (p.hold) { p.configPending = true; return; }
    const root = this.isRoot();
    const age = root ? 0 : (this.ports.get(this.rootPort).recAge ?? 0) + 1;
    if (age >= this.curMaxAge) return;
    const iface = this.sw.ifaces[p.name];
    this.sw.send(p.name, {src: iface.mac, dst: STP_MAC, type: "bpdu",
      bpdu: {root: this.rootId, cost: this.rootCost, bridge: this.bid, port: p.id, age, maxAge: this.curMaxAge, hello: this.curHello, fwd: this.curFwd,
        tc: this.tc, tca: !!p.tcAck}});
    p.tcAck = false; p.configPending = false; p.hold = true;
    this._timer("hold:" + p.name, this._holdTime(), () => { p.hold = false; if (p.state !== DISABLED && p.configPending) this._transmit(p); });
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
    if (b.tcn) {
      if (this._isDesignated(p)) { this.sw.log("stp", `TCN on ${ifname}: acknowledging it`); this._topologyChange(); p.tcAck = true; this._transmit(p); }
      return;
    }
    if (cmpId(b.bridge, this.bid) === 0) { this.sw.log("stp", `BPDU from myself on ${ifname}: loop or reflection, ignored`); return; }
    if (this._supersedes(p, b)) {
      const wasRoot = this.isRoot();
      p.desRoot = b.root; p.desCost = b.cost; p.desBridge = b.bridge; p.desPort = b.port;
      p.recAge = b.age; p.recMaxAge = b.maxAge; p.recHello = b.hello; p.recFwd = b.fwd;
      this._timer("age:" + p.name, Math.max(b.maxAge - b.age, 0.001), () => this._ageExpired(p));
      this._configUpdate(); this._portStateSelection();
      if (!this.isRoot() && wasRoot) {
        this._cancel("hello");
        if (this.tcd) { this._cancel("tc"); this._sendTcn(); this._timer("tcn", this.hello, () => this._tcnTimer()); }
      }
      this.sw.log("stp", `BPDU on ${ifname}: root ${idStr(b.root)} cost ${b.cost}; I am ${this.isRoot() ? "root" : "not root"}, root port ${this.rootPort ?? "-"}`);
      if (p.name === this.rootPort) {
        this._setTc(!!b.tc);
        this._configGeneration();
        if (b.tca) { this.tcd = false; this._cancel("tcn"); }
      }
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
    return {bridgeId: idStr(this.bid), root: idStr(this.rootId), isRoot: this.isRoot(), topologyChange: this.tc, topologyChangeDetected: this.tcd, rootCost: this.rootCost, rootPort: this.rootPort,
      ports: Object.fromEntries([...this.ports.values()].map(p => [p.name, {role: p.role, state: p.state, no: p.no, id: p.id, cost: p.cost,
        designatedRoot: idStr(p.desRoot ?? this.bid), designatedCost: p.desCost, designatedBridge: idStr(p.desBridge ?? this.bid), designatedPort: p.desPort}]))};
  }
}
