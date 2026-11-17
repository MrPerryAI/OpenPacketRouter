// Switch: a learning bridge with optional 802.1D spanning tree and 802.1Q VLANs.
//
// Spanning tree follows the Linux kernel bridge (net/bridge/br_stp*.c), which is
// a direct implementation of IEEE 802.1D-1998 (classic STP, not RSTP):
//   - every bridge starts out believing it is the root; only the root sends
//     hello BPDUs; the others relay a BPDU out of their designated ports each
//     time one arrives on their root port;
//   - port roles: root port (best path to the root), designated port (best
//     bridge on that cable), everything else blocks;
//   - a port that may forward goes blocking → listening → learning → forwarding,
//     one forward delay per step; a port that loses its role blocks at once;
//   - topology changes travel to the root as TCN BPDUs; the root then sets the
//     TC flag for forward delay + max age, and every bridge shortens its MAC
//     ageing to 2 × forward delay meanwhile;
//   - if BPDUs stop arriving on a port for max age, its information is thrown
//     away and the bridge recomputes (the slow, classic 802.1D recovery);
//   - at most one BPDU per port per second (hold timer).
// One spanning tree for all VLANs (like Linux; Cisco's PVST+ would run one per VLAN).
//
// VLANs follow the kernel's VLAN-aware bridge (vlan_filtering 1): an access port
// carries one VLAN untagged; a trunk carries its VLANs tagged plus an optional
// native VLAN untagged. Untagged frames join the port's native/access VLAN;
// tagged frames for a VLAN the port doesn't carry are dropped. MAC tables are
// per VLAN. BPDUs are always untagged.

import {Device, Timer, describe, hex4} from "./device.js";

export const STP_MAC = "01:80:c2:00:00:00";
export const STP_DEFAULTS = {priority: 32768, hello: 2, forwardDelay: 15, maxAge: 20};
export const PORT_DEFAULTS = {cost: 19, priority: 128};   // cost 19 = 100 Mb/s (802.1D-1998 table)
const MESSAGE_AGE_INCR = 1 / 256;   // Linux adds about one 1/256 s tick per relay
const HOLD_TIME = 1;
const isMulticast = mac => (parseInt(mac.slice(0, 2), 16) & 1) === 1;
const ticks = s => Math.floor(s * 256 + 1e-9) / 256;   // BPDU times travel in 1/256 s units

export const bridgeId = (priority, mac) => priority.toString(16).padStart(4, "0") + "." + mac.replace(/:/g, "");

function portVlans(c) {
  if (c.trunk != null) {
    const native = c.native === undefined ? 1 : c.native;
    return {mode: "trunk", pvid: native, untagged: new Set(native != null ? [native] : []), tagged: new Set(c.trunk.filter(v => v !== native))};
  }
  const v = c.vlan ?? 1;
  return {mode: "access", pvid: v, untagged: new Set([v]), tagged: new Set()};
}

export class Switch extends Device {
  /**
   * opts.stp:   false (default), true, or {priority, hello, forwardDelay, maxAge} (seconds)
   * opts.ports: {portName: {cost, priority, vlan} | {trunk: [vlans], native: vlan|null, cost, priority}}
   * opts.vlans: true to make the switch VLAN-aware even with no port configured (every port access VLAN 1)
   */
  constructor(net, name, {blocked = [], stp = false, ports = {}, mac = null, vlans = false, ageing = 300} = {}) {
    super(net, name, "switch");
    this.mac = mac || net._mac();
    this.table = new Map();                 // `${vid}|${mac}` -> {port, at}
    this.blocked = new Set(blocked || []);
    this.portConf = ports || {};
    this.vlanAware = !!vlans || Object.values(this.portConf).some(c => c.vlan != null || c.trunk != null);
    this.ageing = ageing; this.ageingTime = ageing;
    this.portCount = 0;
    this.up = false;
    this.stp = stp ? new Stp(this, stp === true ? {} : stp) : null;
  }
  addIface(name) {
    const c = this.portConf[name] || {};
    const i = super.addIface(name, {no: ++this.portCount});
    i.vlan = this.vlanAware ? portVlans(c) : null;
    if (this.stp) this.stp.addPort(i, c);
    return i;
  }
  boot() { this.up = true; if (this.stp) this.stp.enableBridge(); }
  linkChanged(ifname, up) {
    const p = this.ifaces[ifname];
    if (!up) this.forgetPort(ifname);
    if (this.stp && this.up) up ? this.stp.enablePort(p) : this.stp.disablePort(p);
  }
  portState(p) {
    if (!p.link || !p.link.up) return "disabled";
    return this.stp ? p.stp.state : "forwarding";
  }
  carries(p, vid) { return !this.vlanAware || p.vlan.untagged.has(vid) || p.vlan.tagged.has(vid); }

  receive(ifname, f) {
    const p = this.ifaces[ifname];
    if (this.blocked.has(ifname)) return;
    const state = this.portState(p);
    if (state === "disabled") return;
    if (f.dst === STP_MAC && this.stp) { if (f.type === "bpdu") this.stp.receive(p, f); return; }
    let vid = 0;
    if (this.vlanAware) {
      vid = f.vlan ?? p.vlan.pvid;
      if (vid == null) { this.log("vlan-drop", `${describe(f)}: untagged frame on ${ifname}, which has no native VLAN`); return; }
      if (f.vlan != null && !this.carries(p, vid)) { this.log("vlan-drop", `${describe(f)}: ${ifname} doesn't carry VLAN ${vid}`); return; }
    }
    if (state !== "learning" && state !== "forwarding") { this.log("stp-discard", `${describe(f)}: ${ifname} is ${state}`); return; }
    if (!isMulticast(f.src)) this.table.set(`${vid}|${f.src}`, {port: ifname, at: this.net.time});
    if (state === "learning") { this.log("stp-discard", `${describe(f)}: ${ifname} is learning (learns ${f.src}, forwards nothing)`); return; }
    const inVlan = this.vlanAware ? ` in VLAN ${vid}` : "";
    const out = isMulticast(f.dst) ? null : this.lookup(vid, f.dst);
    if (out === ifname) { this.log("filter", `drop: ${f.dst} lives on the port it came in on (${ifname})`); return; }
    if (out) {
      const o = this.ifaces[out];
      if (this.portState(o) !== "forwarding" || this.blocked.has(out) || !this.carries(o, vid)) { this.log("drop", `${describe(f)}: ${f.dst} is on ${out}, which can't forward now`); return; }
      this.log("forward", `${describe(f)}: ${f.dst} learned on ${out}${inVlan}`);
      return this.egress(o, f, vid);
    }
    const ports = Object.values(this.ifaces).filter(o => o !== p && o.link && this.portState(o) === "forwarding" && !this.blocked.has(o.name) && this.carries(o, vid));
    const why = f.dst === "ff:ff:ff:ff:ff:ff" ? "broadcast" : isMulticast(f.dst) ? "multicast " + f.dst : "unknown destination " + f.dst;
    this.log("flood", `${describe(f)}: ${why}${inVlan} → ${ports.map(o => o.name).join(", ") || "nowhere"}`);
    for (const o of ports) this.egress(o, f, vid);
  }
  lookup(vid, mac) {
    const e = this.table.get(`${vid}|${mac}`);
    if (!e) return null;
    if (this.net.time - e.at >= this.ageingTime) { this.table.delete(`${vid}|${mac}`); return null; }
    return e.port;
  }
  egress(o, f, vid) {
    let g = f;
    if (this.vlanAware) {
      const tag = o.vlan.untagged.has(vid) ? null : vid;
      if ((f.vlan ?? null) !== tag) { g = {...f}; if (tag == null) delete g.vlan; else g.vlan = tag; }
    }
    this.send(o.name, g);
  }
  forgetPort(ifname) { for (const [k, e] of this.table) if (e.port === ifname) this.table.delete(k); }
  flush() { this.table.clear(); }
}

/** 802.1D spanning tree for one switch, after the Linux kernel's br_stp.c. */
class Stp {
  constructor(sw, c) {
    this.sw = sw; this.net = sw.net;
    const o = {...STP_DEFAULTS, ...c};
    this.priority = o.priority;
    this.bridgeId = bridgeId(o.priority, sw.mac);
    this.bMaxAge = this.maxAge = o.maxAge;
    this.bHello = this.hello = o.hello;
    this.bFd = this.fd = o.forwardDelay;
    this.dRoot = this.bridgeId; this.rootCost = 0; this.rootPort = 0;
    this.tc = false; this.tcDetected = false;
    this.helloTimer = new Timer(this.net); this.tcnTimer = new Timer(this.net); this.tcTimer = new Timer(this.net);
    this.ports = [];   // newest first, like the kernel's port_list
  }
  log(e, d) { this.sw.log(e, d); }
  addPort(i, c) {
    const prio = c.priority ?? PORT_DEFAULTS.priority;
    if (prio % 16 || prio < 0 || prio > 240) throw new Error(`${this.sw.name}:${i.name}: port priority must be 0–240 in steps of 16`);
    i.stp = {no: i.no, prio, cost: c.cost ?? PORT_DEFAULTS.cost, id: (prio << 8) | i.no, state: "disabled",
      dRoot: null, dCost: 0, dBridge: null, dPort: 0, dAgeAt: 0, tcAck: false, configPending: false, role: "disabled",
      ageTimer: new Timer(this.net), fdTimer: new Timer(this.net), holdTimer: new Timer(this.net)};
    this.becomeDesignated(i);
    this.ports.unshift(i);
  }
  port(no) { return this.ports.find(p => p.stp.no === no); }
  isRoot() { return this.dRoot === this.bridgeId; }
  isDesignated(p) { return p.stp.dBridge === this.bridgeId && p.stp.dPort === p.stp.id; }
  role(p) { return p.stp.state === "disabled" ? "disabled" : p.stp.no === this.rootPort ? "root" : this.isDesignated(p) ? "designated" : "blocked"; }
  setState(p, s) { if (p.stp.state !== s) { p.stp.state = s; this.log("stp-state", `${p.name} → ${s}`); } }

  // --- bringing bridges and ports up and down (br_stp_if.c) ---
  enableBridge() {
    this.helloTimer.start(this.hello, () => this.helloExpired());
    this.configBpduGeneration();
    for (const p of this.ports) if (p.link && p.link.up) this.enablePort(p);
  }
  enablePort(p) {
    const s = p.stp;
    this.becomeDesignated(p); this.setState(p, "blocking"); s.tcAck = false; s.configPending = false;
    this.portStateSelection();
  }
  disablePort(p) {
    const s = p.stp, wasRoot = this.isRoot();
    this.becomeDesignated(p); this.setState(p, "disabled"); s.tcAck = false; s.configPending = false;
    s.ageTimer.stop(); s.fdTimer.stop(); s.holdTimer.stop();
    this.configurationUpdate(); this.portStateSelection();
    if (this.isRoot() && !wasRoot) this.becomeRootBridge();
  }

  // --- choosing the root port and designated ports (br_stp.c) ---
  becomeDesignated(p) { const s = p.stp; s.dRoot = this.dRoot; s.dCost = this.rootCost; s.dBridge = this.bridgeId; s.dPort = s.id; }
  shouldBecomeRootPort(p, rootNo) {
    const s = p.stp;
    if (this.isDesignated(p) || s.state === "disabled" || this.bridgeId <= s.dRoot) return false;
    if (!rootNo) return true;
    const r = this.port(rootNo).stp;
    if (s.dRoot !== r.dRoot) return s.dRoot < r.dRoot;
    if (s.dCost + s.cost !== r.dCost + r.cost) return s.dCost + s.cost < r.dCost + r.cost;
    if (s.dBridge !== r.dBridge) return s.dBridge < r.dBridge;
    if (s.dPort !== r.dPort) return s.dPort < r.dPort;
    return s.id < r.id;
  }
  rootSelection() {
    let rootNo = 0;
    for (const p of this.ports) if (this.shouldBecomeRootPort(p, rootNo)) rootNo = p.stp.no;
    const oldRoot = this.dRoot;
    this.rootPort = rootNo;
    if (!rootNo) { this.dRoot = this.bridgeId; this.rootCost = 0; }
    else { const s = this.port(rootNo).stp; this.dRoot = s.dRoot; this.rootCost = s.dCost + s.cost; }
    if (this.dRoot !== oldRoot) this.log("stp-root", this.isRoot() ? `I am the root bridge (${this.bridgeId})` :
      `root bridge is ${this.dRoot}, ${this.rootCost} away through ${this.port(rootNo).name}`);
  }
  shouldBecomeDesignated(p) {
    const s = p.stp;
    if (this.isDesignated(p)) return true;
    if (s.dRoot !== this.dRoot) return true;
    if (this.rootCost !== s.dCost) return this.rootCost < s.dCost;
    if (this.bridgeId !== s.dBridge) return this.bridgeId < s.dBridge;
    return s.id < s.dPort;
  }
  designatedPortSelection() { for (const p of this.ports) if (p.stp.state !== "disabled" && this.shouldBecomeDesignated(p)) this.becomeDesignated(p); }
  configurationUpdate() { this.rootSelection(); this.designatedPortSelection(); }

  portStateSelection() {
    for (const p of this.ports) {
      const s = p.stp;
      if (s.state === "disabled") continue;
      if (s.no === this.rootPort) { s.configPending = false; s.tcAck = false; this.makeForwarding(p); }
      else if (this.isDesignated(p)) { s.ageTimer.stop(); this.makeForwarding(p); }
      else { s.configPending = false; s.tcAck = false; this.makeBlocking(p); }
    }
    for (const p of this.ports) {
      const r = this.role(p);
      if (r !== p.stp.role) {
        p.stp.role = r;
        if (r === "root") this.log("stp-role", `${p.name} is the root port: best path to root ${this.dRoot} (cost ${this.rootCost})`);
        else if (r === "designated") this.log("stp-role", `${p.name} is designated: I am the best bridge on this cable for reaching the root`);
        else if (r === "blocked") this.log("stp-role", `${p.name} blocks: ${p.stp.dBridge} port ${hex4(p.stp.dPort)} offers this cable a better path to the root`);
      }
    }
  }
  makeBlocking(p) {
    const s = p.stp;
    if (s.state === "disabled" || s.state === "blocking") return;
    if (s.state === "forwarding" || s.state === "learning") this.topologyChangeDetection();
    this.setState(p, "blocking"); s.fdTimer.stop();
  }
  makeForwarding(p) {
    const s = p.stp;
    if (s.state !== "blocking") return;
    if (this.fd === 0) { this.setState(p, "forwarding"); this.topologyChangeDetection(); s.fdTimer.stop(); return; }
    this.setState(p, "listening");
    s.fdTimer.start(this.fd, () => this.fdExpired(p));
  }
  fdExpired(p) {
    const s = p.stp;
    if (s.state === "listening") { this.setState(p, "learning"); s.fdTimer.start(this.fd, () => this.fdExpired(p)); }
    else if (s.state === "learning") {
      this.setState(p, "forwarding");
      if (this.ports.some(q => q.stp.state !== "disabled" && q.stp.dBridge === this.bridgeId)) this.topologyChangeDetection();
    }
  }
  becomeRootBridge() {
    this.maxAge = this.bMaxAge; this.hello = this.bHello; this.fd = this.bFd;
    this.topologyChangeDetection();
    this.tcnTimer.stop();
    this.configBpduGeneration();
    this.helloTimer.start(this.hello, () => this.helloExpired());
  }

  // --- sending BPDUs ---
  transmitConfig(p) {
    const s = p.stp;
    if (s.holdTimer.active) { s.configPending = true; return; }
    const age = this.isRoot() ? 0 : ticks(this.net.time - this.port(this.rootPort).stp.dAgeAt + MESSAGE_AGE_INCR);
    if (age >= this.maxAge) return;
    this.sw.send(p.name, {src: p.mac, dst: STP_MAC, type: "bpdu", bpdu: {type: "config", tc: this.tc, tca: s.tcAck,
      root: this.dRoot, cost: this.rootCost, bridge: this.bridgeId, port: s.id, age, maxAge: this.maxAge, hello: this.hello, fwdDelay: this.fd}});
    s.tcAck = false; s.configPending = false;
    s.holdTimer.start(HOLD_TIME, () => { if (s.configPending) this.transmitConfig(p); });
  }
  configBpduGeneration() { for (const p of this.ports) if (p.stp.state !== "disabled" && this.isDesignated(p)) this.transmitConfig(p); }
  helloExpired() { this.configBpduGeneration(); this.helloTimer.start(this.hello, () => this.helloExpired()); }
  transmitTcn() {
    const p = this.port(this.rootPort);
    if (!p) return;
    this.log("stp-tcn", `telling the root about a topology change (TCN out ${p.name})`);
    this.sw.send(p.name, {src: p.mac, dst: STP_MAC, type: "bpdu", bpdu: {type: "tcn"}});
  }

  // --- receiving BPDUs ---
  receive(p, f) {
    if (!this.sw.up) return;
    const b = f.bpdu;
    if (b.type === "tcn") return this.receivedTcn(p);
    if (b.age > b.maxAge) { this.log("stp-discard", `BPDU on ${p.name} is older than its max age`); return; }
    const s = p.stp, wasRoot = this.isRoot();
    if (this.supersedes(p, b)) {
      s.dRoot = b.root; s.dCost = b.cost; s.dBridge = b.bridge; s.dPort = b.port; s.dAgeAt = this.net.time - b.age;
      s.ageTimer.start(b.maxAge - b.age, () => this.ageExpired(p));
      this.configurationUpdate(); this.portStateSelection();
      if (!this.isRoot() && wasRoot) {
        this.helloTimer.stop();
        if (this.tcDetected) { this.tcTimer.stop(); this.transmitTcn(); this.tcnTimer.start(this.bHello, () => this.tcnExpired()); }
      }
      if (s.no === this.rootPort) {
        this.maxAge = b.maxAge; this.hello = b.hello; this.fd = b.fwdDelay; this.setTopologyChange(b.tc);
        this.configBpduGeneration();
        if (b.tca) { this.tcDetected = false; this.tcnTimer.stop(); }
      }
    } else if (this.isDesignated(p)) this.transmitConfig(p);   // a worse BPDU on my cable: answer with mine
  }
  supersedes(p, b) {
    const s = p.stp;
    if (b.root !== s.dRoot) return b.root < s.dRoot;
    if (b.cost !== s.dCost) return b.cost < s.dCost;
    if (b.bridge !== s.dBridge) return b.bridge < s.dBridge;
    if (b.bridge !== this.bridgeId) return true;
    return b.port <= s.dPort;
  }
  receivedTcn(p) {
    if (!this.isDesignated(p)) return;
    this.log("stp-tcn", `topology change notice on ${p.name}${this.isRoot() ? "" : ": passing it towards the root"}`);
    this.topologyChangeDetection();
    p.stp.tcAck = true; this.transmitConfig(p);
  }
  ageExpired(p) {
    if (p.stp.state === "disabled") return;
    this.log("stp-maxage", `no BPDU on ${p.name} for max age (${this.maxAge}s): forgetting ${p.stp.dBridge}`);
    const wasRoot = this.isRoot();
    this.becomeDesignated(p); this.configurationUpdate(); this.portStateSelection();
    if (this.isRoot() && !wasRoot) this.becomeRootBridge();
  }

  // --- topology change ---
  topologyChangeDetection() {
    if (this.isRoot()) { this.setTopologyChange(true); this.tcTimer.start(this.bFd + this.bMaxAge, () => { this.tcDetected = false; this.setTopologyChange(false); }); }
    else if (!this.tcDetected) { this.transmitTcn(); this.tcnTimer.start(this.bHello, () => this.tcnExpired()); }
    this.tcDetected = true;
  }
  tcnExpired() { if (!this.isRoot()) { this.transmitTcn(); this.tcnTimer.start(this.bHello, () => this.tcnExpired()); } }
  setTopologyChange(v) {
    if (this.tc !== v) {
      this.sw.ageingTime = v ? 2 * this.fd : this.sw.ageing;
      this.log("stp-tc", v ? `topology change: MAC entries now age out after ${2 * this.fd}s` : `topology change over: MAC ageing back to ${this.sw.ageing}s`);
    }
    this.tc = v;
  }

  report() {
    const ports = {};
    for (const p of [...this.ports].reverse()) {
      const s = p.stp;
      ports[p.name] = {no: s.no, id: hex4(s.id), cost: s.cost, state: s.state, role: this.role(p),
        designatedRoot: s.dRoot, designatedBridge: s.dBridge, designatedPort: hex4(s.dPort), designatedCost: s.dCost};
    }
    const rp = this.port(this.rootPort);
    return {bridge: this.bridgeId, root: this.dRoot, rootPort: rp ? rp.name : null, rootCost: this.rootCost, topologyChange: this.tc, ports};
  }
}
