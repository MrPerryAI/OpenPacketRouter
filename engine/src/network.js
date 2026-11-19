// OpenPacketRouter engine: a deterministic, packet-level network simulator.
//
// Devices:
//   Switch  - learning bridge: learns source MACs, forwards known unicast out one
//             port, floods broadcasts and unknown unicast. (No spanning tree here
//             yet; ports can be configured `blocked`.)
//   Router  - IPv4 forwarding: longest-prefix match over connected and static
//             routes, TTL decrement, ICMP time exceeded / unreachable.
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
import {dhcpServer, dhcpRelay} from "./dhcp.js";
import {tcpInput} from "./tcp.js";
import {BROADCAST_MAC, ipToInt, intToIp, parseCidr, inSubnet, macFor} from "./addr.js";
import {shape} from "./link.js";

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
const describe = f => f.type === "bpdu" ? `STP BPDU root ${f.bpdu.root[1]} cost ${f.bpdu.cost}` : f.type === "arp"
  ? (f.arp.op === "request" ? `ARP who-has ${f.arp.tpa} tell ${f.arp.spa}` : `ARP ${f.arp.spa} is-at ${f.arp.sha}`)
  : `IPv4 ${f.ip.src} → ${f.ip.dst} ttl ${f.ip.ttl} ${f.ip.proto === "icmp" ? icmpName(f.ip.icmp) : f.ip.proto === "tcp" ? `TCP ${f.ip.tcp.sport}→${f.ip.tcp.dport} ${tcpName(f.ip.tcp)}${f.ip.tcp.len ? ` ${f.ip.tcp.len}B` : ""}` : `UDP ${f.ip.udp.sport}→${f.ip.udp.dport}`}`;
const icmpName = i => ({0: "echo reply", 8: "echo request", 11: "time exceeded", 3: ["net unreachable", "host unreachable", "protocol unreachable", "port unreachable"][i.code] || "unreachable"})[i.type] || `icmp ${i.type}`;

class Device {
  constructor(net, name, kind) { this.net = net; this.name = name; this.kind = kind; this.ifaces = {}; }
  addIface(name, extra = {}) { const i = {name, node: this, mac: this.net._mac(), link: null, ...extra}; this.ifaces[name] = i; return i; }
  send(ifname, frame) { this.net._transmit(this, ifname, frame); }
  log(event, detail) { this.net.log(this.name, event, detail); }
  flush() {}
  start() {}
  linkChange() {}
}

export class Switch extends Device {
  /** opts: blocked: [ports]; stp: {priority, mac, hello, maxAge, forwardDelay, cost, portPriority} (spanning tree on);
   *  vlans: {port: {access: 10} | {trunk: [10, 20], native: 1}} (makes the switch VLAN-aware, like a kernel
   *  bridge with vlan_filtering; ports not listed are access ports in VLAN 1). */
  constructor(net, name, {blocked = [], stp = null, vlans = null} = {}) {
    super(net, name, "switch"); this.table = new Map(); this.blocked = new Set(blocked);
    this.stp = stp ? new Stp(this, {mac: net._mac(), ...stp}) : null;
    this.vlans = vlans;
  }
  /** {pvid, member: Set, untagged: Set} for a port of a VLAN-aware switch. */
  vcfg(port) {
    const c = (this.vlans && this.vlans[port]) || {access: 1};
    if (c.access !== undefined) return {pvid: c.access, member: new Set([c.access]), untagged: new Set([c.access])};
    const native = c.native ?? null, member = new Set(c.trunk); if (native !== null) member.add(native);
    return {pvid: native, member, untagged: new Set(native !== null ? [native] : [])};
  }
  _fwd(p) { return !this.blocked.has(p) && (!this.stp || !this.stp.ports.get(p) || this.stp.ports.get(p).state === "forwarding"); }
  flushPort(p) { for (const [k, v] of this.table) if (v === p) this.table.delete(k); }
  linkChange(ifname, up) { if (this.stp) this.stp.linkChange(ifname, up); }
  start() { if (this.stp) this.stp.start(); }

  receive(ifname, f) {
    if (this.blocked.has(ifname)) return;
    if (this.stp && f.type === "bpdu") return this.stp.receive(ifname, f);   // STP-enabled bridges consume BPDUs; others flood them like any multicast
    const st = this.stp && this.stp.ports.get(ifname) ? this.stp.ports.get(ifname).state : "forwarding";
    if (st === "disabled" || st === "listening" || st === "blocking") return;
    // VLAN classification
    let vid = 0;
    if (this.vlans) {
      const c = this.vcfg(ifname);
      vid = f.vlan !== undefined ? f.vlan : c.pvid;
      if (vid === null || !c.member.has(vid)) { this.log("vlan-drop", `${describe(f)}: VLAN ${f.vlan ?? "untagged"} not allowed in on ${ifname}`); return; }
    }
    const key = m => vid + "|" + m;
    if (f.src !== BROADCAST_MAC && this.table.get(key(f.src)) !== ifname) { this.table.set(key(f.src), ifname); }
    if (st === "learning") return;
    const out = f.dst === BROADCAST_MAC ? null : this.table.get(key(f.dst));
    if (out === ifname) { this.log("filter", `drop: ${f.dst} lives on the port it came in on (${ifname})`); return; }
    const emit = p => {
      if (!this.vlans) { this.send(p, f); return true; }
      const c = this.vcfg(p); if (!c.member.has(vid)) return false;
      const g = {...f}; if (c.untagged.has(vid)) delete g.vlan; else g.vlan = vid;
      this.send(p, g); return true;
    };
    const vtag = this.vlans ? ` [VLAN ${vid}]` : "";
    if (out && this._fwd(out)) { if (emit(out)) this.log("forward", `${describe(f)}${vtag}: ${f.dst} learned on ${out}`); else this.log("vlan-drop", `${describe(f)}: VLAN ${vid} not allowed out ${out}`); return; }
    const ports = Object.keys(this.ifaces).filter(p => p !== ifname && this._fwd(p) && this.ifaces[p].link && (!this.vlans || this.vcfg(p).member.has(vid)));
    this.log("flood", `${describe(f)}${vtag}: ${f.dst === BROADCAST_MAC ? "broadcast" : "unknown destination " + f.dst} → ${ports.join(", ") || "nowhere"}`);
    for (const p of ports) emit(p);
  }
  flush() { this.table.clear(); }
}

export class IpNode extends Device {
  constructor(net, name, kind, {ifaces = {}, gw = null, routes = [], services = {}} = {}) {
    super(net, name, kind);
    this.forwarding = kind === "router";
    for (const [n, cidr] of Object.entries(ifaces)) {
      if (cidr === "dhcp") { this.addIface(n, {dhcp: true}); continue; }                 // address comes from DHCP (dhcp.js)
      const c = parseCidr(cidr); this.addIface(n, {ip: c.ip, prefix: c.prefix, net: c.net, mask: c.mask}); }
    this.routes = routes.map(([dst, via]) => ({...parseCidr(dst), via}));
    if (gw) this.routes.push({...parseCidr("0.0.0.0/0"), via: gw});
    this.services = services;          // {dns: {"name": "ip"}, udp: {port: fn(payload) -> reply}}
    this.arp = new Map();              // ip -> {mac, iface}
    this.pending = new Map();          // next-hop ip -> {iface, frames: [ip packets], tries}
    this.nextPort = 33000;
    this.sockets = new Set();         // UDP ports a client app has open (no "port unreachable" for these)
  }
  owns(ip) { return Object.values(this.ifaces).some(i => i.ip === ip); }
  flush() { this.arp.clear(); this.pending.clear(); }

  /** Longest-prefix match over connected subnets and static routes. */
  route(dst) {
    let best = null;
    for (const i of Object.values(this.ifaces)) if (i.ip && inSubnet(dst, i.net, i.mask) && (!best || i.prefix > best.prefix))
      best = {prefix: i.prefix, iface: i.name, nextHop: dst, why: `connected ${intToIp(i.net)}/${i.prefix} on ${i.name}`};
    for (const r of this.routes) if (inSubnet(dst, r.net, r.mask) && (!best || r.prefix > best.prefix)) {
      const out = Object.values(this.ifaces).find(i => i.ip && inSubnet(r.via, i.net, i.mask));
      if (out) best = {prefix: r.prefix, iface: out.name, nextHop: r.via, why: `route ${r.cidr} via ${r.via}`};
    }
    return best;
  }

  receive(ifname, f) {
    const i = this.ifaces[ifname];
    if (f.dst !== i.mac && f.dst !== BROADCAST_MAC) return;            // NIC filter
    if (this.rawHook && this.rawHook(ifname, f)) return;              // a raw-socket client (DHCP, dhcp.js)
    if (f.type === "arp") return this.onArp(ifname, f.arp);
    if (f.type === "ipv4") return this.onIp(ifname, f.ip);
  }

  onArp(ifname, a) {
    const i = this.ifaces[ifname];
    if (a.op === "request") {
      if (a.tpa !== i.ip) { if (this.arp.has(a.spa)) this.learn(a.spa, a.sha, ifname); return; }
      this.learn(a.spa, a.sha, ifname);
      this.log("arp-reply", `${a.spa} asked who has ${i.ip}: answering with ${i.mac}`);
      this.send(ifname, {src: i.mac, dst: a.sha, type: "arp", arp: {op: "reply", sha: i.mac, spa: i.ip, tha: a.sha, tpa: a.spa}});
    } else if (a.op === "reply" && (a.tpa === i.ip || this.owns(a.tpa))) this.learn(a.spa, a.sha, ifname);
  }
  learn(ip, mac, ifname) {
    this.arp.set(ip, {mac, iface: ifname});
    const p = this.pending.get(ip);
    if (p) { this.pending.delete(ip); for (const pkt of p.frames) this.frameOut(ifname, mac, pkt); }
  }

  onIp(ifname, p) {
    if (this.owns(p.dst) || p.dst === "255.255.255.255") return this.deliver(ifname, p);
    if (!this.forwarding) { this.log("drop", `${describe({type: "ipv4", ip: p})}: not for me and I don't route`); return; }
    if (p.ttl <= 1) { this.log("ttl-expired", `${describe({type: "ipv4", ip: p})}: TTL ran out here`); return this.icmpError(p, 11, 0); }
    const r = this.route(p.dst);
    if (!r) { this.log("no-route", `no route to ${p.dst}`); return this.icmpError(p, 3, 0); }
    this.log("route", `${p.src} → ${p.dst}: ${r.why} (TTL ${p.ttl} → ${p.ttl - 1})`);
    this.out(r, {...p, ttl: p.ttl - 1}, true);
  }

  deliver(ifname, p) {
    this.net._local(this, p);
    if (p.proto === "icmp" && p.icmp.type === 8) {
      this.log("echo-reply", `answering ping from ${p.src}`);
      return this.sendIp({src: p.dst, dst: p.src, ttl: 64, proto: "icmp", icmp: {type: 0, code: 0, id: p.icmp.id, seq: p.icmp.seq}});
    }
    if (p.proto === "tcp") return tcpInput(this, p);
    if (p.proto === "udp") {
      if (this.sockets.has(p.udp.dport)) return;   // an app is waiting on this port
      const svc = this.udpService(p.udp.dport);
      if (!svc && p.dst === "255.255.255.255") return;                // no ICMP errors for broadcasts
      if (!svc) { this.log("port-closed", `nothing listens on UDP ${p.udp.dport}`); return this.icmpError(p, 3, 3, p.dst); }
      const reply = svc(p.udp.payload, p, ifname);
      if (reply !== undefined) this.sendIp({src: p.dst, dst: p.src, ttl: 64, proto: "udp", udp: {sport: p.udp.dport, dport: p.udp.sport, payload: reply}});
    }
  }
  udpService(port) {
    if (port === 67 && this.services.dhcp) return this._dhcpd ||= dhcpServer(this, this.services.dhcp);
    if (port === 67 && this.services.dhcpRelay) return this._dhcpRelay ||= dhcpRelay(this, this.services.dhcpRelay);
    if (port === 53 && this.services.dns) return payload => { const a = this.services.dns[payload.q] ?? null;
      this.log("dns", `query ${payload.q} → ${a ?? "not found"}`); return {q: payload.q, a}; };
    return this.services.udp && this.services.udp[port];
  }

  icmpError(orig, type, code, src = null) {
    if (orig.proto === "icmp" && ![0, 8].includes(orig.icmp.type)) return;   // never an error about an error
    const back = this.route(orig.src); if (!back) return;
    const from = src || this.ifaces[back.iface].ip;
    this.sendIp({src: from, dst: orig.src, ttl: 64, proto: "icmp",
      icmp: {type, code, orig: {src: orig.src, dst: orig.dst, proto: orig.proto, id: orig.icmp?.id, seq: orig.icmp?.seq, sport: orig.udp?.sport, dport: orig.udp?.dport}}});
  }

  /** Originate a packet from this node. Returns false if there is no route. */
  sendIp(p) {
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
    const spa = !forwarded && p.src && this.owns(p.src) ? p.src : this.ifaces[r.iface].ip;
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
    this.live = 0; this.started = false; this.counters = new Map(); this.trace = []; this.traceLimit = 50000; this.events = 0; this.listeners = new Set();
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
  run(until = Infinity, stop = null, maxEvents = 5e6) {
    let n = 0; this._start();
    while (this.q.size && this.q.peek().t <= until && (until !== Infinity || this.live > 0)) {
      const e = this.q.pop(); this.time = e.t; if (!e.daemon) this.live--; e.fn(); this.events++;
      if (++n >= maxEvents) throw new Error("event limit reached (a loop that never ends?)");
      if (stop && stop()) return true;
    }
    if (until !== Infinity && this.time < until && !this.q.size) this.time = until;
    return stop ? !!stop() : true;
  }
  /** Let every frame in flight land (bounded so loops can't hang). */
  settle(maxSeconds = 3) { this.run(this.time + maxSeconds); }
  flushCaches() { for (const n of this.nodes.values()) n.flush(); }
  snapshot() { return new Map(this.counters); }
  diff(before) { const d = {}; for (const [k, v] of this.counters) { const x = v - (before.get(k) || 0); if (x) d[k] = x; } return d; }

  /** Build from a plain spec (see validate/l3/fti-routed.json). */
  static fromSpec(spec) {
    const net = new Network();
    for (const n of spec.nodes) {
      const opts = {ifaces: n.ifaces, gw: n.gw, routes: n.routes || [], services: n.services || {}, blocked: n.blocked, stp: n.stp, vlans: n.vlans};
      ({switch: () => net.addSwitch(n.name, opts), router: () => net.addRouter(n.name, opts), host: () => net.addHost(n.name, opts), server: () => net.addServer(n.name, opts)})[n.kind]();
    }
    for (const [a, b, ms, opts] of spec.links) {
      net.link(a, b, {delay: (ms ?? 1) / 1000});
      if (opts && opts.shape) shape(net, a, opts.shape);                      // egress of the first end (link.js)
      if (opts && opts.shapeBack) shape(net, b, opts.shapeBack);              // egress of the second end
    }
    return net;
  }
}
