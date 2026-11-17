// OpenPacketRouter engine: a deterministic, packet-level network simulator.
//
// Devices:
//   Switch  - learning bridge with optional 802.1D spanning tree and 802.1Q
//             VLANs (see switch.js).
//   Router  - IPv4 forwarding: longest-prefix match over connected and static
//             routes, TTL decrement, ICMP time exceeded / unreachable.
//   Host    - a client or server: one or more IPv4 interfaces, a default gateway,
//             ARP, ICMP echo, UDP services (e.g. DNS).
// Routers and hosts can have VLAN subinterfaces ("eth0.10": tagged VLAN 10 on
// eth0, sharing eth0's MAC, like a Linux VLAN device): router-on-a-stick.
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

import {BROADCAST_MAC, intToIp, parseCidr, inSubnet, macFor} from "./addr.js";
import {Device, describe} from "./device.js";
import {Switch} from "./switch.js";

export {Switch};

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

export class IpNode extends Device {
  constructor(net, name, kind, {ifaces = {}, gw = null, routes = [], services = {}} = {}) {
    super(net, name, kind);
    this.forwarding = kind === "router";
    for (const [n, cidr] of Object.entries(ifaces)) {
      const c = cidr ? parseCidr(cidr) : {};
      const addr = cidr ? {ip: c.ip, prefix: c.prefix, net: c.net, mask: c.mask} : {};
      const dot = n.indexOf(".");
      if (dot < 0) { if (this.ifaces[n]) Object.assign(this.ifaces[n], addr); else this.addIface(n, addr); continue; }
      const parent = n.slice(0, dot), vlan = Number(n.slice(dot + 1));
      if (!Number.isInteger(vlan) || vlan < 1 || vlan > 4094) throw new Error(`${name}: bad VLAN subinterface ${n}`);
      const phys = this.ifaces[parent] || this.addIface(parent);
      this.ifaces[n] = {name: n, node: this, mac: phys.mac, parent, vlan, ...addr};   // a VLAN device shares its parent's MAC
    }
    this.routes = routes.map(([dst, via]) => ({...parseCidr(dst), via}));
    if (gw) this.routes.push({...parseCidr("0.0.0.0/0"), via: gw});
    this.services = services;          // {dns: {"name": "ip"}, udp: {port: fn(payload) -> reply}}
    this.arp = new Map();              // ip -> {mac, iface}
    this.pending = new Map();          // next-hop ip -> {iface, frames: [ip packets], tries}
    this.nextPort = 33000;
    this.sockets = new Set();         // UDP ports a client app has open (no "port unreachable" for these)
  }
  send(ifname, frame) {
    const i = this.ifaces[ifname];
    if (i.parent) return this.net._transmit(this, i.parent, {...frame, vlan: i.vlan});
    this.net._transmit(this, ifname, frame);
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
    let i = this.ifaces[ifname];
    if (f.vlan != null) {                                               // tagged: only a VLAN subinterface takes it
      i = Object.values(this.ifaces).find(s => s.parent === ifname && s.vlan === f.vlan);
      if (!i) return;
    }
    if (f.dst !== i.mac && f.dst !== BROADCAST_MAC) return;            // NIC filter
    if (f.type === "arp") return this.onArp(i.name, f.arp);
    if (f.type === "ipv4") return this.onIp(i.name, f.ip);
  }

  onArp(ifname, a) {
    const i = this.ifaces[ifname];
    if (a.op === "request") {
      if (a.tpa !== i.ip) { if (this.arp.has(a.spa)) this.learn(a.spa, a.sha, ifname); return; }
      this.learn(a.spa, a.sha, ifname);
      this.log("arp-reply", `${a.spa} asked who has ${i.ip}: answering with ${i.mac}`);
      this.send(ifname, {src: i.mac, dst: a.sha, type: "arp", arp: {op: "reply", sha: i.mac, spa: i.ip, tha: a.sha, tpa: a.spa}});
    } else if (a.op === "reply" && a.tpa === i.ip) this.learn(a.spa, a.sha, ifname);
  }
  learn(ip, mac, ifname) {
    this.arp.set(ip, {mac, iface: ifname});
    const p = this.pending.get(ip);
    if (p) { this.pending.delete(ip); for (const pkt of p.frames) this.frameOut(ifname, mac, pkt); }
  }

  onIp(ifname, p) {
    if (this.owns(p.dst)) return this.deliver(ifname, p);
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
    if (p.proto === "udp") {
      if (this.sockets.has(p.udp.dport)) return;   // an app is waiting on this port
      const svc = this.udpService(p.udp.dport);
      if (!svc) { this.log("port-closed", `nothing listens on UDP ${p.udp.dport}`); return this.icmpError(p, 3, 3, p.dst); }
      const reply = svc(p.udp.payload, p);
      if (reply !== undefined) this.sendIp({src: p.dst, dst: p.src, ttl: 64, proto: "udp", udp: {sport: p.udp.dport, dport: p.udp.sport, payload: reply}});
    }
  }
  udpService(port) {
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
    q = {iface: r.iface, frames: [p], tries: 0, forwarded};
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
    this.send(q.iface, {src: i.mac, dst: BROADCAST_MAC, type: "arp", arp: {op: "request", sha: i.mac, spa: i.ip, tha: "00:00:00:00:00:00", tpa: ip}});
    this.net._after(1.0, () => this.arpRequest(ip, q));
  }
  frameOut(ifname, mac, p) { this.send(ifname, {src: this.ifaces[ifname].mac, dst: mac, type: "ipv4", ip: p}); }
  linkChanged(ifname, up) { if (!up) for (const [ip, e] of this.arp) if (this.ifaces[e.iface].parent === ifname || e.iface === ifname) this.arp.delete(ip); }
}

export class Network {
  constructor() {
    this.nodes = new Map(); this.links = []; this.time = 0; this.q = new Heap(); this.seq = 0; this.macN = 0;
    // Frames sent per cable direction ("A:eth0>B:p1"). BPDUs are counted apart from
    // everything else; `tagged` counts 802.1Q-tagged frames per direction and VLAN.
    this.counters = new Map(); this.bpdus = new Map(); this.tagged = new Map();
    this.trace = []; this.traceLimit = 50000; this.events = 0; this.listeners = new Set(); this.taps = new Set();
    this.booted = false;
  }
  _mac() { return macFor(++this.macN); }
  _add(node) {
    if (this.nodes.has(node.name)) throw new Error(`duplicate device ${node.name}`);
    this.nodes.set(node.name, node); if (this.booted) node.boot(); return node;
  }
  /** Power everything on (switches start spanning tree). Happens on the first run() by itself. */
  boot() { if (this.booted) return; this.booted = true; for (const n of this.nodes.values()) n.boot(); }
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
    a.link = b.link = l; a.peer = b; b.peer = a; this.links.push(l);
    if (this.booted) { a.node.linkChanged(a.name, true); b.node.linkChanged(b.name, true); }
    return l;
  }
  /** Unplug (up = false) or plug back in the cable at "Device:iface". Both ends notice at once. */
  setLink(aRef, up) {
    const [n, i] = aRef.split(":"); const l = this.node(n).ifaces[i].link;
    if (!l) throw new Error(`${aRef} has no cable`);
    if (l.up === up) return;
    l.up = up;
    this.log(n, up ? "link-up" : "link-down", `cable ${l.name} ${up ? "plugged in" : "unplugged"}`);
    l.a.node.linkChanged(l.a.name, up); l.b.node.linkChanged(l.b.name, up);
  }

  _transmit(node, ifname, frame) {
    const i = node.ifaces[ifname]; const l = i.link;
    if (!l || !l.up) return;
    const key = `${node.name}:${ifname}>${i.peer.node.name}:${i.peer.name}`;
    const m = frame.type === "bpdu" ? this.bpdus : this.counters;
    m.set(key, (m.get(key) || 0) + 1);
    if (frame.vlan != null) { const t = `${key}#${frame.vlan}`; this.tagged.set(t, (this.tagged.get(t) || 0) + 1); }
    for (const fn of this.taps) fn(key, frame);
    const peer = i.peer;
    this._after(l.delay, () => peer.node.receive(peer.name, frame));
  }
  _after(dt, fn) { this.q.push({t: this.time + dt, seq: ++this.seq, fn}); }
  _local(node, p) { for (const fn of this.listeners) fn(node, p); }
  log(node, event, detail) { if (this.trace.length < this.traceLimit) this.trace.push({t: this.time, node, event, detail}); }

  /** Process events until `until` (seconds), the queue empties, or `stop()` returns true. */
  run(until = Infinity, stop = null, maxEvents = 5e6) {
    this.boot();
    let n = 0;
    while (this.q.size && this.q.peek().t <= until) {
      const e = this.q.pop(); this.time = e.t; e.fn(); this.events++;
      if (++n >= maxEvents) throw new Error("event limit reached (a loop that never ends?)");
      if (stop && stop()) return true;
    }
    if (until !== Infinity && this.time < until) this.time = until;
    return stop ? !!stop() : true;
  }
  /** Let every frame in flight land (bounded so loops can't hang). */
  settle(maxSeconds = 3) { this.run(this.time + maxSeconds); }
  flushCaches() { for (const n of this.nodes.values()) n.flush(); }
  /** Run the clock to absolute time t (seconds since boot). */
  runTo(t) { if (t > this.time) this.run(t); else this.boot(); }
  snapshot() { return {frames: new Map(this.counters), bpdus: new Map(this.bpdus), tagged: new Map(this.tagged)}; }
  /** Frames sent per cable direction since `before`; which = "frames" (all but BPDUs), "bpdus" or "tagged" ("cable#vlan"). */
  diff(before, which = "frames") {
    const now = which === "frames" ? this.counters : this[which], was = before instanceof Map ? before : before[which], d = {};
    for (const [k, v] of now) { const x = v - (was.get(k) || 0); if (x) d[k] = x; }
    return d;
  }
  /** Spanning-tree state of every STP switch. */
  stpReport() { const r = {}; for (const n of this.nodes.values()) if (n.stp) r[n.name] = n.stp.report(); return r; }

  /** Build from a plain spec (see validate/l3/fti-routed.json). */
  static fromSpec(spec) {
    const net = new Network();
    for (const n of spec.nodes) {
      const opts = {ifaces: n.ifaces, gw: n.gw, routes: n.routes || [], services: n.services || {}, blocked: n.blocked,
        stp: n.stp, ports: n.ports, mac: n.mac, vlans: n.vlans};
      ({switch: () => net.addSwitch(n.name, opts), router: () => net.addRouter(n.name, opts), host: () => net.addHost(n.name, opts), server: () => net.addServer(n.name, opts)})[n.kind]();
    }
    for (const [a, b, ms] of spec.links) net.link(a, b, {delay: (ms ?? 1) / 1000});
    return net;
  }
}
