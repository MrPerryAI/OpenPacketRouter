// OpenPacketRouter engine: a deterministic, packet-level network simulator.
//
// Devices:
//   Switch  - learning bridge: learns source MACs, forwards known unicast out one
//             port, floods broadcasts and unknown unicast. (No spanning tree here
//             yet; ports can be configured `blocked`.)
//   Router  - IPv4 forwarding: longest-prefix match over connected and static
//             routes, TTL decrement, ICMP time exceeded / unreachable. An interface
//             named "eth0.10" is an 802.1Q subinterface of eth0 in VLAN 10
//             (router-on-a-stick), like Linux `ip link add link eth0 name eth0.10 type vlan id 10`.
//   Host    - a client or server: one or more IPv4 interfaces, a default gateway,
//             ARP, ICMP echo, UDP services (e.g. DNS).
//
// Behaviour follows the Linux kernel's defaults where it affects which frames
// appear on which cable (validated frame-for-frame in validate/l3/):
//   - ARP: broadcast request, unicast reply; the target learns the sender from
//     the request; up to 3 requests one second apart before giving up.
//   - ICMP errors use the address of the interface that routes back to the
//     sender; no ICMP errors about ICMP errors; no ICMP redirects (Linux:
//     send_redirects=0 in the validation network).
//   - UDP to a closed port gets ICMP port unreachable from the destination.
//
// Every decision is written to `net.trace` with a plain-English reason.

import {Stp} from "./stp.js";
import {Rstp} from "./rstp.js";
import {Channel, LACP_MAC} from "./lacp.js";
import {dhcpServer, dhcpRelay} from "./dhcp.js";
import {tcpInput, tcpIcmpError} from "./tcp.js";
import {BROADCAST_MAC, ipToInt, intToIp, parseCidr, inSubnet, macFor} from "./addr.js";
import {shape, Police, lossModel} from "./link.js";
import {Ospf, OSPF_ALL_SPF, OSPF_ALL_SPF_MAC, OSPF_ALL_DR, OSPF_ALL_DR_MAC} from "./ospf.js";
import {Acl, ACL_REJECT} from "./acl.js";
import {Nat} from "./nat.js";
import {ntpServer} from "./apps.js";
import {RipNg} from "./ripng.js";
import {Rip, RIP_GROUP, RIP_MAC, RIP_PORT} from "./rip.js";
import {Vrrp, VRRP_GROUP} from "./vrrp.js";
import {Lldp, LLDP_MAC} from "./lldp.js";
import {Ip6} from "./ipv6.js";

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(x) { const a = this.a; a.push(x); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (Heap.lt(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; } }
  pop() { const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) { a[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && Heap.lt(a[l], a[m])) m = l; if (r < a.length && Heap.lt(a[r], a[m])) m = r;
        if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } }
    return top; }
  peek() { return this.a[0]; }
  static lt(x, y) { return x.t < y.t || (x.t === y.t && x.seq < y.seq); }
}

const tcpName = t => ({S: "SYN", SA: "SYN+ACK", A: "ACK", PA: "PSH+ACK", FA: "FIN+ACK", R: "RST", RA: "RST+ACK"})[t.flags] || t.flags;
const describe = f => f.type === "ipv6" ? `IPv6 ${f.ip6.src} → ${f.ip6.dst} ${f.ip6.proto === "icmp6" ? `ICMPv6 type ${f.ip6.icmp.type}` : f.ip6.proto}` : f.type === "lldp" ? `LLDP from ${f.lldp.sysName} (${f.lldp.portDescr})` : f.type === "bpdu" ? (f.bpdu.tcn ? "STP TCN" : `STP BPDU root ${f.bpdu.root[1]} cost ${f.bpdu.cost}${f.bpdu.tc ? " [topology change]" : ""}${f.bpdu.tca ? " [TC ack]" : ""}`) : f.ip?.udp?.payload?.rip ? `RIP ${f.ip.udp.payload.rip.command} ${f.ip.src} → ${f.ip.dst}` : f.ip?.vrrp ? `VRRP vrid ${f.ip.vrrp.vrid} priority ${f.ip.vrrp.priority} ${f.ip.src}` : f.ip?.ospf ? `OSPF ${f.ip.ospf.type} ${f.ip.src} → ${f.ip.dst}` : f.type === "arp"
  ? (f.arp.op === "request" ? `ARP who-has ${f.arp.tpa} tell ${f.arp.spa}` : `ARP ${f.arp.spa} is-at ${f.arp.sha}`)
  : `IPv4 ${f.ip.src} → ${f.ip.dst} ttl ${f.ip.ttl} ${f.ip.proto === "icmp" ? icmpName(f.ip.icmp) : f.ip.proto === "tcp" ? `TCP ${f.ip.tcp.sport}→${f.ip.tcp.dport} ${tcpName(f.ip.tcp)}${f.ip.tcp.len ? ` ${f.ip.tcp.len}B` : ""}` : `UDP ${f.ip.udp.sport}→${f.ip.udp.dport}`}`;
const icmpName = i => ({0: "echo reply", 8: "echo request", 11: "time exceeded", 3: {0: "net unreachable", 1: "host unreachable", 2: "protocol unreachable", 3: "port unreachable", 13: "administratively prohibited"}[i.code] || "unreachable"})[i.type] || `icmp ${i.type}`;

class Device {
  constructor(net, name, kind) { this.net = net; this.name = name; this.kind = kind; this.ifaces = {}; }
  addIface(name, extra = {}) { const i = {name, node: this, link: null, ...extra, mac: extra.mac ?? this.net._mac()}; this.ifaces[name] = i; return i; }
  send(ifname, frame) { this.net._transmit(this, ifname, frame); }
  log(event, detail) { this.net.log(this.name, event, detail); }
  flush() {}
  start() {}
  linkChange() {}
}

export class Switch extends Device {
  /** opts: blocked: [ports]; stp: {priority, mac, hello, maxAge, forwardDelay, cost, portPriority} (spanning tree on);
   *  vlans: {port: {access: 10} | {trunk: [10, 20], native: 1}} (makes the switch VLAN-aware, like a kernel
   *  bridge with vlan_filtering; ports not listed are access ports in VLAN 1).
   *  ifaces: {"vlan10": "10.0.10.1/24"} gives a VLAN-aware switch switched virtual interfaces (SVIs) and makes it
   *  a Layer 3 switch: an IPv4 router whose interfaces sit inside the switch, like Linux vlan devices on a
   *  vlan_filtering bridge (`ip link add link br0 name vlan10 type vlan id 10`). routes/gw as for a router. */
  constructor(net, name, {blocked = [], stp = null, vlans = null, ifaces = null, routes = [], gw = null, agingTime = 300, forwardLldp = false, portSecurity = null, stormControl = null, monitor = null, dhcpSnooping = null} = {}) {
    super(net, name, "switch");
    /** portSecurity: {port: {max: N, violation: "protect"|"restrict"|"shutdown"}}. The first N source MACs heard on the port are secured for good
     *  (they never age); a frame from any other MAC is a violation: dropped before the switch learns it (protect, restrict) and counted;
     *  shutdown also takes the port down (err-disabled) until `clearPortSecurity`. Linux reference: nftables bridge prerouting + dynamic set (validate/portsec). */
    this.portSec = new Map(Object.entries(portSecurity || {}).map(([p, c]) => [p, {max: c.max, violation: c.violation || "protect", secure: new Set(), violations: 0, errdisabled: false}]));
    /** stormControl: {port: {broadcast: {rate: "100kbit", burst: 400}}}: a policer on the port's ingress for broadcast frames (a Linux
     *  `tc filter ... flower dst_mac ff:ff:ff:ff:ff:ff action police`, which runs before the bridge sees the frame). Frames over the rate are dropped. */
    this.storm = new Map(Object.entries(stormControl || {}).map(([p, c]) => [p, {broadcast: c.broadcast ? new Police(c.broadcast) : null}]));
    /** dhcpSnooping: {trusted: [ports]} turns DHCP snooping on: a DHCP server message (UDP source port 67, destination port 68) arriving on any port not
     *  listed as trusted is dropped before the switch learns or forwards it, and counted. Not modeled: the binding table, dynamic ARP inspection and IP
     *  source guard (Linux has no equivalent to validate against). Linux reference: nftables bridge prerouting `udp sport 67 udp dport 68 drop` (validate/dhcp-snooping). */
    this.snooping = dhcpSnooping ? {trusted: new Set(dhcpSnooping.trusted || []), dropped: new Map()} : null;
    this.forwardLldp = forwardLldp; this._setupMonitor(monitor); /* true: group_fwd_mask 0x4000, LLDP frames are forwarded like other multicast */ this.channels = new Map(); this.memberOf = new Map(); /* port-channels (lacp.js): name -> Channel, member port -> Channel */ this.table = new Map(); this.seen = new Map(); this.agingTime = agingTime; this.agingOverride = null; this.blocked = new Set(blocked);   // agingOverride: set while spanning tree has the topology-change flag
    this.stp = stp ? new (stp.mode === "rstp" ? Rstp : Stp)(this, {mac: net._mac(), ...stp}) : null;
    this.vlans = vlans;
    this.l3 = null;
    if (ifaces && Object.keys(ifaces).length) {
      const mac = net._mac();                       // every SVI uses the bridge's own MAC, as Linux vlan devices on br0 do
      this.l3 = new IpNode(net, name, "router", {routes, gw});
      for (const [n, cidr] of Object.entries(ifaces)) this.l3.addAddr(n, cidr, {svi: this, vid: +n.slice(4), mac});
      this.l3mac = mac;
    }
  }
  /** The SVI for a VLAN, if this is a Layer 3 switch with one. */
  /** Bundle cabled ports into a port-channel (LACP, lacp.js): call after the cables exist. The channel is a port named `name`. */
  addChannel(name, ports, opts = {}) {
    if (this.stp) throw new Error(`${this.name}: spanning tree over a port-channel is not modeled`);
    for (const p of ports) { if (!this.ifaces[p]) throw new Error(`${this.name}: channel ${name}: no port ${p} (cable it first)`); if (this.memberOf.has(p)) throw new Error(`${this.name}: port ${p} is already in a channel`); }
    const ch = new Channel(this, name, ports, opts); this.channels.set(name, ch); for (const p of ports) this.memberOf.set(p, ch);
    return ch;
  }
  /** Ports the bridge itself sees: every interface except the cables that belong to a channel (the channel stands for them). */
  bridgePorts() { return Object.keys(this.ifaces).filter(p => !this.memberOf.has(p) && !this.mirrorDest.has(p)); }
  /** Port mirroring (SPAN): `monitor` is {"1": {destination: "p3", sources: {p1: "both", p2: "rx"}}}. Modeled on Linux
   *  `tc filter add dev SRC ingress|egress matchall action mirred egress mirror dev DST`: every frame a source port receives (rx)
   *  or sends (tx) is also sent out the destination port, which is no longer a bridge port. The copy is taken at the port itself:
   *  before the bridge decides anything on receive (so it includes frames the bridge then drops), and for every frame sent. */
  _setupMonitor(monitor) {
    this.monitor = monitor || {}; this.mirrorDest = new Set(); this.mirrorIn = new Map(); this.mirrorOut = new Map();
    const add = (m, k, d) => { if (!m.has(k)) m.set(k, []); m.get(k).push(d); };
    for (const s of Object.values(this.monitor)) {
      this.mirrorDest.add(s.destination);
      for (const [port, dir] of Object.entries(s.sources || {})) { if (dir !== "tx") add(this.mirrorIn, port, s.destination); if (dir !== "rx") add(this.mirrorOut, port, s.destination); }
    }
  }
  send(ifname, frame) {
    const mir = this.mirrorOut.get(ifname); if (mir) for (const d of mir) { this.log("mirror", `${describe(frame)}: copy of what ${ifname} sends, out ${d}`); super.send(d, {...frame}); }
    const ch = this.channels.get(ifname); if (ch) return ch.transmit(frame); super.send(ifname, frame);
  }
  svi(vid) { return this.l3 ? Object.values(this.l3.ifaces).find(i => i.vid === vid) : null; }
  /** {pvid, member: Set, untagged: Set} for a port of a VLAN-aware switch. */
  vcfg(port) {
    const c = (this.vlans && this.vlans[port]) || {access: 1};
    if (c.access !== undefined) return {pvid: c.access, member: new Set([c.access]), untagged: new Set([c.access])};
    const native = c.native ?? null, member = new Set(c.trunk); if (native !== null) member.add(native);
    return {pvid: native, member, untagged: new Set(native !== null ? [native] : [])};
  }
  _fwd(p) { return !this.blocked.has(p) && (!this.stp || !this.stp.ports.get(p) || this.stp.ports.get(p).state === "forwarding"); }
  flushPort(p) { for (const [k, v] of this.table) if (v === p) { this.table.delete(k); this.seen.delete(k); } }
  /** MAC aging, modeled on the kernel bridge's garbage collector (br_fdb_cleanup): entries are NOT checked for expiry
   *  when a frame is forwarded; a collector removes those not refreshed for the aging time. It wakes when the
   *  earliest entry expires, or after one aging time if there is none, and never sooner than 10 ms. So an entry can
   *  outlive its aging time until the collector next runs (this matters when a topology change shortens the time). */
  /** Set the aging time (a kernel bridge's `ip link set br0 type bridge ageing_time`): also wakes the collector at once. */
  setAgingTime(seconds) { this.agingTime = seconds; this.agingOverride = null; this._gcArm(0); }
  _gcArm(delay) { const g = this._gcGen = (this._gcGen || 0) + 1; this.net._after(delay, () => { if (this._gcGen === g) this._gc(); }, true); }
  /** How long an entry lives without a frame from its MAC. Linux: while the topology-change flag is set, one forward delay. */
  holdTime() { return this.stp?.tc ? this.stp.curFwd : this.agingTime; }
  _gc() {
    const now = this.net.time, hold = this.holdTime(); let next = hold;
    for (const [k, t] of [...this.seen]) {
      if (t + hold > now) next = Math.min(next, t + hold - now);
      else { this.table.delete(k); this.seen.delete(k); this.log("age-out", `${k.split("|")[1]} aged out of the MAC table (not heard from for ${hold}s)`); }
    }
    this._gcArm(Math.max(next, 0.01));
  }
  /** The MAC address table: [{vlan, mac, port, age}] with age in seconds since the entry was last refreshed
   *  (entries past their aging time stay listed, marked `stale`, until the collector removes them, as `bridge fdb show` does). */
  macTable() {
    return [...this.table].map(([k, port]) => { const [vid, mac] = k.split("|"); return {vlan: +vid, mac, port, age: Math.round((this.net.time - this.seen.get(k)) * 1000) / 1000, stale: this.net.time - this.seen.get(k) >= this.holdTime()}; });
  }
  /** Send `f` out port p in VLAN vid, tagged or untagged as the port is configured. False if p isn't in vid. */
  _emit(p, f, vid) {
    if (!this.vlans) { this.send(p, f); return true; }
    const c = this.vcfg(p); if (!c.member.has(vid)) return false;
    const g = {...f}; if (c.untagged.has(vid)) delete g.vlan; else g.vlan = vid;
    this.send(p, g); return true;
  }
  /** A frame the switch's own IP stack sends from an SVI (Linux br_dev_xmit): known unicast goes out the
   *  learned port, anything else floods every forwarding port in the VLAN. */
  fromStack(vid, f) {
    const out = f.dst === BROADCAST_MAC ? null : this.table.get(vid + "|" + f.dst);
    if (out) { if (this._fwd(out)) this._emit(out, f, vid); return; }
    const ports = this.bridgePorts().filter(p => this._fwd(p) && this.ifaces[p].link && this.vcfg(p).member.has(vid));
    for (const p of ports) this._emit(p, f, vid);
  }
  linkChange(ifname, up) { const ch = this.memberOf.get(ifname); if (ch) ch.linkChange(ifname, up); if (this.stp) this.stp.linkChange(ifname, up); }
  start() { if (this.stp) this.stp.start(); for (const c of this.channels.values()) c.start(); this._gcArm(0.1); }   // the kernel starts the collector 0.1 s after the bridge comes up

  /** DHCP snooping state: {trusted: [ports], dropped: {port: count}}, or null when snooping is off. */
  dhcpSnoopingState() { return this.snooping && {trusted: [...this.snooping.trusted].sort(), dropped: Object.fromEntries([...this.snooping.dropped].sort())}; }
  receive(ifname, f) {
    if (this.mirrorDest.has(ifname)) return;   // a monitor port is not a bridge port: nothing it hears is switched
    const mir = this.mirrorIn.get(ifname); if (mir) for (const d of mir) { this.log("mirror", `${describe(f)}: copy of what ${ifname} receives, out ${d}`); super.send(d, {...f}); }
    const sc = this.storm.get(ifname);
    if (sc?.broadcast && f.dst === BROADCAST_MAC && !sc.broadcast.admit(this.net, f)) { this.log("storm-control", `${describe(f)}: broadcast over the limit on ${ifname}, dropped`); return; }
    const ch = this.memberOf.get(ifname);
    if (ch) { if (f.type === "lacpdu") return ch.receivePdu(ifname, f); if (!ch.collecting(ifname)) return; ifname = ch.name; }   // a collecting member delivers as the channel
    else if (f.type === "lacpdu") return;   // slow-protocol frames are never bridged
    if (this.blocked.has(ifname)) return;
    if (this.snooping && !this.snooping.trusted.has(ifname) && f.type === "ipv4" && f.ip.proto === "udp" && f.ip.udp.sport === 67 && f.ip.udp.dport === 68) {
      this.snooping.dropped.set(ifname, (this.snooping.dropped.get(ifname) || 0) + 1); this.log("dhcp-snooping", `${describe(f)}: DHCP server message on untrusted port ${ifname}, dropped`); return;
    }
    if (f.type === "lldp" && !this.forwardLldp) {   // link-local: never forwarded (Linux still learns the sender, br_handle_local_finish)
      const state = this.stp && this.stp.ports.get(ifname) ? this.stp.ports.get(ifname).state : "forwarding";
      const vid = this.vlans ? this.vcfg(ifname).pvid : 0;
      if ((state === "learning" || state === "forwarding") && vid !== null) { this.table.set(vid + "|" + f.src, ifname); this.seen.set(vid + "|" + f.src, this.net.time); }
      return;
    }
    if (this.stp && f.type === "bpdu") {   // STP-enabled bridges consume BPDUs; others flood them like any multicast
      const state = this.stp.ports.get(ifname)?.state;   // Linux still learns the sender's MAC from a BPDU (br_handle_local_finish), in the port's VLAN
      const vid = this.vlans ? this.vcfg(ifname).pvid : 0;
      if ((state === "learning" || state === "forwarding") && vid !== null) { this.table.set(vid + "|" + f.src, ifname); this.seen.set(vid + "|" + f.src, this.net.time); }
      return this.stp.receive(ifname, f);
    }
    const st = this.stp && this.stp.ports.get(ifname) ? this.stp.ports.get(ifname).state : "forwarding";
    if (st === "disabled" || st === "listening" || st === "blocking") return;
    const ps = this.portSec.get(ifname);
    if (ps && !ps.secure.has(f.src)) {   // (a broadcast source is never legal; kernel: the set is keyed on the source address as is)
      if (ps.secure.size < ps.max && f.src !== BROADCAST_MAC) ps.secure.add(f.src);
      else {
        ps.violations++; this.log("port-security", `${describe(f)}: ${f.src} is not one of the ${ps.max} secured address(es) on ${ifname} (${ps.violation})`);
        if (ps.violation === "shutdown" && !ps.errdisabled) { ps.errdisabled = true; this.net.setLink(`${this.name}:${ifname}`, false); }
        return;
      }
    }
    // VLAN classification
    let vid = 0;
    if (this.vlans) {
      const c = this.vcfg(ifname);
      vid = f.vlan !== undefined ? f.vlan : c.pvid;
      if (vid === null || !c.member.has(vid)) { this.log("vlan-drop", `${describe(f)}: VLAN ${f.vlan ?? "untagged"} not allowed in on ${ifname}`); return; }
    }
    const key = m => vid + "|" + m;
    if (f.src !== BROADCAST_MAC) { this.table.set(key(f.src), ifname); this.seen.set(key(f.src), this.net.time); }
    if (st === "learning") return;
    const svi = this.vlans && this.l3 ? this.svi(vid) : null;
    if (svi && f.dst === this.l3mac) { const g = {...f}; delete g.vlan; return this.l3.receive(svi.name, g); }   // for the switch itself
    const out = f.dst === BROADCAST_MAC ? null : this.table.get(key(f.dst));
    if (out === ifname) { this.log("filter", `drop: ${f.dst} lives on the port it came in on (${ifname})`); return; }
    const emit = p => this._emit(p, f, vid);
    const vtag = this.vlans ? ` [VLAN ${vid}]` : "";
    if (out && !this._fwd(out)) { this.log("filter", `drop: ${f.dst} is learned on ${out}, which is not forwarding`); return; }   // Linux drops these; it does not flood them
    if (out && this._fwd(out)) { if (emit(out)) this.log("forward", `${describe(f)}${vtag}: ${f.dst} learned on ${out}`); else this.log("vlan-drop", `${describe(f)}: VLAN ${vid} not allowed out ${out}`); return; }
    const ports = this.bridgePorts().filter(p => p !== ifname && this._fwd(p) && this.ifaces[p].link && (!this.vlans || this.vcfg(p).member.has(vid)));
    this.log("flood", `${describe(f)}${vtag}: ${f.dst === BROADCAST_MAC ? "broadcast" : "unknown destination " + f.dst} → ${ports.join(", ") || "nowhere"}`);
    for (const p of ports) emit(p);
    if (svi && f.dst === BROADCAST_MAC) { const g = {...f}; delete g.vlan; this.l3.receive(svi.name, g); }   // and up to the SVI
  }
  /** Port-security state per port: [{port, max, violation, secured: [mac], violations, errdisabled}]. */
  portSecurity() { return [...this.portSec].map(([port, c]) => ({port, max: c.max, violation: c.violation, secured: [...c.secure], violations: c.violations, errdisabled: c.errdisabled})); }
  /** Forget a port's secured addresses and violation count; bring an err-disabled port back up. */
  clearPortSecurity(port) { const c = this.portSec.get(port); if (!c) return; c.secure.clear(); c.violations = 0; if (c.errdisabled) { c.errdisabled = false; this.net.setLink(`${this.name}:${port}`, true); } }
  /** Storm control per port: [{port, broadcast: {rate, burst, passed, dropped}}]. */
  stormControl() { return [...this.storm].map(([port, c]) => ({port, ...(c.broadcast ? {broadcast: {rate: c.broadcast.rateSpec, burst: c.broadcast.burstBytes, passed: c.broadcast.passed, dropped: c.broadcast.dropped}} : {})})); }
  flush() { this.table.clear(); this.seen.clear(); if (this.l3) this.l3.flush(); }
}

export class IpNode extends Device {
  constructor(net, name, kind, {ifaces = {}, gw = null, routes = [], services = {}, ospf = null, rip = null, ripng = null, acl = null, nat = null, lldp = null, vrrp = null, ifaces6 = null, routes6 = [], gw6 = null} = {}) {
    super(net, name, kind);
    this.forwarding = kind === "router";
    for (const [n, cidr] of Object.entries(ifaces)) this.addAddr(n, cidr);
    this.routes = routes.map(([dst, via]) => ({...parseCidr(dst), via}));
    if (gw) this.routes.push({...parseCidr("0.0.0.0/0"), via: gw});
    this.services = services;          // {dns: {"name": "ip"}, udp: {port: fn(payload) -> reply}}
    this.arp = new Map();              // ip -> {mac, iface}
    this.pending = new Map();          // next-hop ip -> {iface, frames: [ip packets], tries}
    this.nextPort = 33000;
    this.sockets = new Set();         // UDP ports a client app has open (no "port unreachable" for these)
    this.ospf = ospf ? new Ospf(this, ospf) : null;   // OSPFv2 (ospf.js)
    this.rip = rip ? new Rip(this, rip) : null;   // RIPv2 (rip.js)
    this.acl = acl ? new Acl(acl) : null;         // access lists (acl.js)
    this.nat = nat ? new Nat(this, nat) : null;   // address translation (nat.js)
    this.lldp = lldp ? new Lldp(this, lldp) : null;   // LLDP (lldp.js)
    this.v6 = ifaces6 ? new Ip6(this, {ifaces6, routes6, gw6}) : null;   // IPv6 (ipv6.js)
    if (this.v6) for (const a of this.v6.addrs) if (!this.ifaces[a.iface]) this.addIface(a.iface);
    this.vrrp = vrrp ? new Vrrp(this, vrrp) : null;   // VRRP (vrrp.js)
    this.ripng = ripng && this.v6 ? new RipNg(this, ripng) : null;   // RIPng (ripng.js)
  }
  start() { if (this.ospf) this.ospf.start(); if (this.rip) this.rip.start(); if (this.ripng) this.ripng.start(); if (this.lldp) this.lldp.start(); if (this.vrrp) this.vrrp.start(); }
  linkChange(ifname, up) {
    // The Linux kernel deletes the static routes whose next hop is on an interface that loses carrier, and does not bring them back with it.
    // Only routers running OSPF model this so far: it is what the ospf-redist validation against ospfd covers, and hosts, RIP and static-only
    // scenarios keep their routes across a flap until they are validated the same way.
    // zebra (ospf-redist: R3's LAN restored) keeps one of them: a static route whose prefix also had an OSPF route when the carrier went
    // is only deactivated (the SPF table, which still holds the route OSPF did not install), and it comes back, and again beats OSPF, when the carrier does (so ospfd re-advertises it). Without an OSPF
    // route to the same prefix it is gone for good.
    if (this.ospf) {
      const i = this.ifaces[ifname];
      if (!up && i && i.ip) {
        const dead = this.routes.filter(r => r.via && inSubnet(r.via, i.net, i.mask));
        this.routes = this.routes.filter(r => !dead.includes(r));
        this.parkedStatic = [...(this.parkedStatic || []), ...dead.filter(r => (this.ospf.table || []).some(o => ipToInt(o.net) === r.net && ipToInt(o.mask) === r.mask))];
      } else if (up && i && i.ip && this.parkedStatic) {
        const back = this.parkedStatic.filter(r => inSubnet(r.via, i.net, i.mask));
        this.parkedStatic = this.parkedStatic.filter(r => !back.includes(r));
        for (const r of back) if (!this.routes.some(x => x.net === r.net && x.mask === r.mask && x.via === r.via)) this.routes.push(r);
      }
    }
    if (this.ospf) this.ospf.linkChange(ifname, up); if (this.rip) this.rip.linkChange(ifname, up); if (this.ripng) this.ripng.linkChange(ifname, up); if (this.lldp) this.lldp.linkChange(ifname, up); if (this.vrrp) this.vrrp.linkChange(ifname, up);
  }
  /** Add interface n with address cidr ("dhcp": the address comes from DHCP, dhcp.js). "eth0.10" is an
   *  802.1Q subinterface: it shares eth0's MAC and cable, and sends and receives VLAN 10 tagged frames. */
  addAddr(n, cidr, extra = {}) {
    const addr = cidr === "dhcp" ? {dhcp: true} : (c => ({ip: c.ip, prefix: c.prefix, net: c.net, mask: c.mask}))(parseCidr(cidr));
    const m = !extra.svi && n.match(/^([^.]+)\.(\d+)$/);
    if (m) { const parent = this.ifaces[m[1]] || this.addIface(m[1]); extra = {...extra, parent: m[1], vid: +m[2], mac: parent.mac}; }
    else if (this.ifaces[n]) return Object.assign(this.ifaces[n], addr);   // a parent created earlier for its subinterface
    return this.addIface(n, {...extra, ...addr});
  }
  /** Out a logical interface: subinterfaces tag onto their parent's cable; SVIs go into their switch. */
  send(ifname, f) {
    const i = this.ifaces[ifname];
    if (i.svi) return i.svi.fromStack(i.vid, f);
    if (i.parent) return super.send(i.parent, {...f, vlan: i.vid});
    super.send(ifname, f);
  }
  owns(ip) { return Object.values(this.ifaces).some(i => i.ip === ip) || !!(this.vrrp && this.vrrp.owns(ip)); }
  flush() { this.arp.clear(); this.pending.clear(); if (this.v6) this.v6.flush(); }   // conntrack (nat.js) survives, like Linux

  /** Longest-prefix match over connected subnets and static routes. */
  route(dst) {
    let best = null;
    for (const i of Object.values(this.ifaces)) if (i.ip && inSubnet(dst, i.net, i.mask) && (!best || i.prefix > best.prefix))
      best = {prefix: i.prefix, iface: i.name, nextHop: dst, why: `connected ${intToIp(i.net)}/${i.prefix} on ${i.name}`};
    for (const r of this.routes) if (inSubnet(dst, r.net, r.mask) && (!best || r.prefix > best.prefix)) {
      const out = Object.values(this.ifaces).find(i => i.ip && inSubnet(r.via, i.net, i.mask));
      if (out) best = {prefix: r.prefix, iface: out.name, nextHop: r.via, why: `route ${r.cidr} via ${r.via}`};
    }
    if (this.ospf) for (const r of this.ospf.fib()) if (inSubnet(dst, r.net, r.mask) && (!best || r.len > best.prefix))   // connected and static win a tie
      best = {prefix: r.len, iface: r.iface, nextHop: r.gw, why: `OSPF route ${r.cidr} via ${r.gw} (cost ${r.metric})`};
    if (this.rip) for (const r of this.rip.fib()) if (inSubnet(dst, r.net, r.mask) && (!best || r.len > best.prefix))   // static beats RIP on a tie
      best = {prefix: r.len, iface: r.iface, nextHop: r.gw, why: `RIP route ${r.cidr} via ${r.gw} (metric ${r.metric})`};
    return best;
  }

  receive(ifname, f) {
    if (f.type === "lldp") { if (this.lldp && f.vlan === undefined) this.lldp.receive(ifname, f); return; }   // link-local, untagged only
    if (f.vlan !== undefined) {                       // 802.1Q tagged: only a subinterface for that VLAN takes it
      const sub = Object.values(this.ifaces).find(s => s.parent === ifname && s.vid === f.vlan);
      if (!sub) { this.log("vlan-drop", `${describe(f)}: tagged VLAN ${f.vlan}, no subinterface ${ifname}.${f.vlan}`); return; }
      f = {...f}; delete f.vlan; ifname = sub.name;
    }
    const i = this.ifaces[ifname];
    if (f.dst !== i.mac && f.dst !== BROADCAST_MAC && !(this.vrrp && this.vrrp.accepts(ifname, f.dst)) && !(this.v6 && f.type === "ipv6" && this.v6.joined(ifname, f.dst)) && !(f.dst === RIP_MAC && this.rip && this.rip.joined(ifname)) && !(this.ospf && ((f.dst === OSPF_ALL_SPF_MAC && this.ospf.joined(ifname, OSPF_ALL_SPF)) || (f.dst === OSPF_ALL_DR_MAC && this.ospf.joined(ifname, OSPF_ALL_DR))))) return;   // NIC filter
    if (this.rawHook && this.rawHook(ifname, f)) return;              // a raw-socket client (DHCP, dhcp.js)
    if (f.type === "arp") return this.onArp(ifname, f.arp);
    if (f.type === "ipv4") return this.onIp(ifname, f.ip);
    if (f.type === "ipv6" && this.v6) return this.v6.receive(ifname, f.ip6);
  }

  onArp(ifname, a) {
    const i = this.ifaces[ifname];
    if (a.op === "request") {
      if (a.tpa !== i.ip && this.nat && this.nat.proxies(ifname, a.tpa)) {   // a static outside address: answer as if it were ours (Linux: a secondary address on the interface)
        this.learn(a.spa, a.sha, ifname);
        this.log("arp-reply", `${a.spa} asked who has ${a.tpa} (NAT static address): answering with ${i.mac}`);
        return this.send(ifname, {src: i.mac, dst: a.sha, type: "arp", arp: {op: "reply", sha: i.mac, spa: a.tpa, tha: a.sha, tpa: a.spa}});
      }
      const vg = this.vrrp && this.vrrp.masterOf(ifname, a.tpa);
      if (vg) {   // we are the VRRP master for this address (vrrp.js)
        const mac = this.vrrp.macOf(vg);
        this.learn(a.spa, a.sha, ifname);
        this.log("arp-reply", `${a.spa} asked who has ${a.tpa} (VRRP virtual address): answering with ${mac}`);
        return this.send(ifname, {src: mac, dst: a.sha, type: "arp", arp: {op: "reply", sha: mac, spa: a.tpa, tha: a.sha, tpa: a.spa}});
      }
      if (a.tpa !== i.ip) { if (this.arp.has(a.spa)) this.learn(a.spa, a.sha, ifname); return; }
      this.learn(a.spa, a.sha, ifname);
      this.log("arp-reply", `${a.spa} asked who has ${i.ip}: answering with ${i.mac}`);
      this.send(ifname, {src: i.mac, dst: a.sha, type: "arp", arp: {op: "reply", sha: i.mac, spa: i.ip, tha: a.sha, tpa: a.spa}});
    } else if (a.op === "reply" && (a.tpa === i.ip || this.owns(a.tpa) || (this.nat && this.nat.proxies(ifname, a.tpa)))) this.learn(a.spa, a.sha, ifname);
  }
  learn(ip, mac, ifname) {
    this.arp.set(ip, {mac, iface: ifname});
    const p = this.pending.get(ip);
    if (p) { this.pending.delete(ip); for (const pkt of p.frames) this.frameOut(ifname, mac, pkt); }
  }

  onIp(ifname, p) {
    if (this.acl && !this.aclAllows("in", ifname, p)) return;
    let ct = null;
    if (this.nat) ({p, ct} = this.nat.pre(ifname, p));
    if (this.owns(p.dst) || p.dst === "255.255.255.255") return this.deliver(ifname, p);
    if (p.dst === OSPF_ALL_SPF || p.dst === OSPF_ALL_DR) { if (this.ospf && this.ospf.joined(ifname, p.dst)) this.ospf.receive(ifname, p); return; }   // link-local multicast: never routed
    if (p.dst === VRRP_GROUP) { if (this.vrrp && this.vrrp.joined(ifname)) this.deliver(ifname, p); return; }   // link-local multicast: never routed
    if (p.dst === RIP_GROUP) { if (this.rip && this.rip.joined(ifname)) this.deliver(ifname, p); return; }   // link-local multicast: never routed
    if (!this.forwarding) { this.log("drop", `${describe({type: "ipv4", ip: p})}: not for me and I don't route`); return; }
    if (p.ttl <= 1) { this.log("ttl-expired", `${describe({type: "ipv4", ip: p})}: TTL ran out here`); return this.icmpError(p, 11, 0); }
    const r = this.route(p.dst);
    if (!r) { this.log("no-route", `no route to ${p.dst}`); return this.icmpError(p, 3, 0); }
    if (this.acl && !this.aclAllows("out", r.iface, p)) return;
    this.log("route", `${p.src} → ${p.dst}: ${r.why} (TTL ${p.ttl} → ${p.ttl - 1})`);
    if (this.nat) p = this.nat.post(ct, ifname, r.iface, p);
    this.out(r, {...p, ttl: p.ttl - 1}, true);
  }

  /** Access lists (acl.js): false after dropping the packet and answering the sender with ICMP administratively prohibited. */
  aclAllows(dir, ifname, p) {
    const v = this.acl.check(dir, ifname, p);
    if (v.permit) return true;
    this.log("acl-deny", `${describe({type: "ipv4", ip: p})}: ${v.list} ${dir} on ${ifname} ${v.rule === -1 ? "implicit deny" : `denied by rule ${v.rule + 1}`}`);
    this.icmpError(p, ACL_REJECT.type, ACL_REJECT.code);
    return false;
  }

  deliver(ifname, p) {
    this.net._local(this, p);
    if (p.proto === "icmp" && p.icmp.type === 8) {
      this.log("echo-reply", `answering ping from ${p.src}`);
      return this.sendIp({src: p.dst, dst: p.src, ttl: 64, proto: "icmp", icmp: {type: 0, code: 0, id: p.icmp.id, seq: p.icmp.seq}});
    }
    if (p.proto === "icmp" && p.icmp.type === 3) tcpIcmpError(this, p);
    if (p.proto === "vrrp") { if (this.vrrp) this.vrrp.receive(ifname, p); return; }
    if (p.proto === "ospf") { if (this.ospf) this.ospf.receive(ifname, p); return; }
    if (p.proto === "tcp") return tcpInput(this, p);
    if (p.proto === "udp") {
      if (this.sockets.has(p.udp.dport)) return;   // an app is waiting on this port
      if (p.udp.dport === RIP_PORT && this.rip) return this.rip.receive(ifname, p);
      const svc = this.udpService(p.udp.dport);
      if (!svc && p.dst === "255.255.255.255") return;                // no ICMP errors for broadcasts
      if (!svc) { this.log("port-closed", `nothing listens on UDP ${p.udp.dport}`); return this.icmpError(p, 3, 3, p.dst); }
      const reply = svc(p.udp.payload, p, ifname);
      if (reply !== undefined) this.sendIp({src: p.dst, dst: p.src, ttl: 64, proto: "udp", udp: {sport: p.udp.dport, dport: p.udp.sport, payload: reply, ...(reply && reply.wireSize ? {size: reply.wireSize} : {})}});
    }
  }
  udpService(port) {
    if (port === 67 && this.services.dhcp) return this._dhcpd ||= dhcpServer(this, this.services.dhcp);
    if (port === 67 && this.services.dhcpRelay) return this._dhcpRelay ||= dhcpRelay(this, this.services.dhcpRelay);
    if (port === 53 && this.services.dns) return payload => { const a = this.services.dns[payload.q] ?? null;
      this.log("dns", `query ${payload.q} → ${a ?? "not found"}`); return {q: payload.q, a}; };
    if (port === 514 && this.services.syslog) return payload => { (this.syslogLog ||= []).push(String(payload)); this.log("syslog", `received: ${payload}`); };
    if (port === 123 && this.services.ntp) return this._ntpd ||= ntpServer(this, this.services.ntp);
    return this.services.udp && this.services.udp[port];
  }

  icmpError(orig, type, code, src = null) {
    if (orig.proto === "icmp" && ![0, 8].includes(orig.icmp.type)) return;   // never an error about an error
    const back = this.route(orig.src); if (!back) return;
    const from = src || this.ifaces[back.iface].ip;
    this.sendIp({src: from, dst: orig.src, ttl: 64, proto: "icmp",
      icmp: {type, code, orig: {src: orig.src, dst: orig.dst, proto: orig.proto, id: orig.icmp?.id, seq: orig.icmp?.seq, sport: orig.udp?.sport ?? orig.tcp?.sport, dport: orig.udp?.dport ?? orig.tcp?.dport}}});
  }

  /** Originate a packet from this node. Returns false if there is no route. */
  sendIp(p) {
    if (p.dst === "255.255.255.255") {   // limited broadcast: out the first addressed interface (a Linux socket bound to that device), no route or ARP
      const i = Object.values(this.ifaces).find(x => x.ip && x.link); if (!i) return false;
      this.send(i.name, {src: i.mac, dst: BROADCAST_MAC, type: "ipv4", ip: {...p, src: p.src || i.ip}}); return true;
    }
    const r = this.route(p.dst);
    if (!r) { this.log("no-route", `no route to ${p.dst}`); return false; }
    if (!p.src) p = {...p, src: this.ifaces[r.iface].ip};
    this.out(r, p, false);
    return true;
  }
  out(r, p, forwarded) {
    const e = this.arp.get(r.nextHop);
    if (e && e.iface === r.iface) return this.frameOut(r.iface, e.mac, p);
    let q = this.pending.get(r.nextHop);
    if (q) { q.frames.push(p); return; }
    // The ARP request names the packet's own source address when it is one of ours (Linux arp_announce 0), else the
    // address of the outgoing interface: a relay sending from its client-side address asks "who-has X tell <that address>".
    const spa = p.src && ((!forwarded && this.owns(p.src)) || (this.nat && this.nat.proxies(r.iface, p.src))) ? p.src : this.ifaces[r.iface].ip;   // a NAT static outside address counts as ours
    q = {iface: r.iface, frames: [p], tries: 0, forwarded, spa};
    this.pending.set(r.nextHop, q);
    this.arpRequest(r.nextHop, q);
  }
  arpRequest(ip, q) {
    if (this.pending.get(ip) !== q) return;
    if (q.tries >= 3) {
      this.pending.delete(ip); this.log("arp-failed", `no answer for ${ip} after 3 tries: dropping ${q.frames.length} packet(s)`);
      for (const p of q.frames) if (q.forwarded) this.icmpError(p, 3, 1);
      return;
    }
    q.tries++;
    const i = this.ifaces[q.iface];
    this.log("arp-request", `who has ${ip}? (try ${q.tries})`);
    this.send(q.iface, {src: i.mac, dst: BROADCAST_MAC, type: "arp", arp: {op: "request", sha: i.mac, spa: q.spa ?? i.ip, tha: "00:00:00:00:00:00", tpa: ip}});
    this.net._after(1.0, () => this.arpRequest(ip, q));
  }
  frameOut(ifname, mac, p) { this.send(ifname, {src: this.ifaces[ifname].mac, dst: mac, type: "ipv4", ip: p}); }
}

export class Network {
  constructor() {
    this.nodes = new Map(); this.links = []; this.time = 0; this.q = new Heap(); this.seq = 0; this.macN = 0;
    this.live = 0; this.started = false; this.counters = new Map(); this.trace = []; this.traceLimit = 50000; this.events = 0; this.listeners = new Set(); this.taps = new Set();
  }
  _mac() { return macFor(++this.macN); }
  _add(node) { if (this.nodes.has(node.name)) throw new Error(`duplicate device ${node.name}`); this.nodes.set(node.name, node); return node; }
  addSwitch(name, opts) { return this._add(new Switch(this, name, opts)); }
  addRouter(name, opts) { return this._add(new IpNode(this, name, "router", opts)); }
  addHost(name, opts) { return this._add(new IpNode(this, name, "host", opts)); }
  addServer(name, opts) { return this._add(new IpNode(this, name, "server", opts)); }
  node(name) { const n = this.nodes.get(name); if (!n) throw new Error(`no device ${name}`); return n; }

  /** link("R1:eth0", "SW1:p1", {delay}) — switch ports are created on demand. */
  link(aRef, bRef, {delay = 0.001} = {}) {
    const end = ref => { const [n, i] = ref.split(":"); const node = this.node(n);
      const iface = node.ifaces[i] || (node.kind === "switch" ? node.addIface(i) : null);
      if (!iface) throw new Error(`${n} has no interface ${i}`); if (iface.link) throw new Error(`${ref} is already cabled`); return iface; };
    const a = end(aRef), b = end(bRef);
    const l = {id: this.links.length, a, b, delay, up: true, name: `${aRef}—${bRef}`};
    a.link = b.link = l; a.peer = b; b.peer = a; this.links.push(l); return l;
  }
  setLink(aRef, up) {
    const [n, i] = aRef.split(":"); const iface = this.node(n).ifaces[i]; iface.link.up = up;
    for (const e of [iface, iface.peer]) e.node.linkChange(e.name, up);   // switches running STP react to carrier
  }

  _transmit(node, ifname, frame) {
    const i = node.ifaces[ifname]; const l = i.link;
    if (!l || !l.up) return;
    if (i.shaper) return i.shaper.enqueue(this, frame, f => this._wire(node, ifname, f), node.name);   // link.js
    this._wire(node, ifname, frame);
  }
  _wire(node, ifname, frame) {
    const i = node.ifaces[ifname]; const l = i.link;
    if (!l || !l.up) return;
    const key = `${node.name}:${ifname}>${i.peer.node.name}:${i.peer.name}`;
    this.counters.set(key, (this.counters.get(key) || 0) + 1);
    const peer = i.peer;
    if (this.taps) for (const t of this.taps) t(node, ifname, frame);
    this._after(l.delay, () => peer.node.receive(peer.name, frame));
  }
  /** daemon events (protocol timers) don't keep run() going when nothing else is pending. */
  _after(dt, fn, daemon = false) { if (!daemon) this.live++; this.q.push({t: this.time + dt, seq: ++this.seq, fn, daemon}); }
  _start() { if (this.started) return; this.started = true; for (const n of this.nodes.values()) n.start(); }
  _local(node, p) { for (const fn of this.listeners) fn(node, p); }
  log(node, event, detail) { if (this.trace.length < this.traceLimit) this.trace.push({t: this.time, node, event, detail}); }

  /** Process events until `until` (seconds), the queue empties, or `stop()` returns true. */
  run(until = Infinity, stop = null, maxEvents = 5e6, pad = true) {
    let n = 0; this._start();
    while (this.q.size && this.q.peek().t <= until && (until !== Infinity || this.live > 0)) {
      const e = this.q.pop(); this.time = e.t; if (!e.daemon) this.live--; e.fn(); this.events++;
      if (++n >= maxEvents) throw new Error("event limit reached (a loop that never ends?)");
      if (stop && stop()) return true;
    }
    if (until !== Infinity && this.time < until && (pad ? (!this.q.size || this.q.peek().t > until) : !this.q.size)) this.time = until;   // pad: land on `until` even with timers pending (settle() does not: it only lets traffic finish)
    return stop ? !!stop() : true;
  }
  /** Let every frame in flight land (bounded so loops can't hang). */
  settle(maxSeconds = 3) { this.run(this.time + maxSeconds, null, 5e6, false); }
  flushCaches() { for (const n of this.nodes.values()) n.flush(); }
  snapshot() { return new Map(this.counters); }
  diff(before) { const d = {}; for (const [k, v] of this.counters) { const x = v - (before.get(k) || 0); if (x) d[k] = x; } return d; }

  /** Build from a plain spec (see validate/l3/fti-routed.json). */
  static fromSpec(spec) {
    const net = new Network();
    for (const n of spec.nodes) {
      const opts = {ifaces: n.ifaces, channels: n.channels, gw: n.gw, routes: n.routes || [], services: n.services || {}, ospf: n.ospf, rip: n.rip, ripng: n.ripng, acl: n.acl, nat: n.nat, vrrp: n.vrrp, ifaces6: n.ifaces6, routes6: n.routes6 || [], gw6: n.gw6, lldp: n.lldp, forwardLldp: n.forwardLldp, monitor: n.monitor, blocked: n.blocked, stp: n.stp, vlans: n.vlans, agingTime: n.agingTime, portSecurity: n.portSecurity, stormControl: n.stormControl, dhcpSnooping: n.dhcpSnooping};
      ({switch: () => net.addSwitch(n.name, opts), router: () => net.addRouter(n.name, opts), host: () => net.addHost(n.name, opts), server: () => net.addServer(n.name, opts)})[n.kind]();
    }
    for (const [a, b, ms, opts] of spec.links) {
      net.link(a, b, {delay: (ms ?? 1) / 1000});
      if (opts && opts.shape) shape(net, a, opts.shape);                      // egress of the first end (link.js)
      if (opts && opts.shapeBack) shape(net, b, opts.shapeBack);              // egress of the second end
      if (opts && opts.loss) lossModel(net, a, opts.loss);                     // deterministic loss (link.js LossModel)
      if (opts && opts.lossBack) lossModel(net, b, opts.lossBack);
    }
    for (const n of spec.nodes) if (n.kind === "switch") for (const [name, c] of Object.entries(n.channels || {})) net.node(n.name).addChannel(name, c.ports, {rate: c.rate});
    return net;
  }
}
