// IPv6 basics for hosts and routers: addresses, neighbor discovery (NS/NA), ICMPv6 echo, static routes, forwarding.
//
// Behaviour follows the Linux kernel (validated frame for frame in validate/ipv6/):
//   - Resolving a next hop: a neighbor solicitation to the solicited-node multicast address (Ethernet 33:33:ff:xx:xx:xx),
//     up to 3 of them one second apart; the target answers with a unicast neighbor advertisement and learns the asker
//     from the solicitation's source link-layer option, so the echo reply needs no solicitation of its own.
//   - A packet the router cannot deliver after 3 solicitations gets "address unreachable" (ICMPv6 type 1 code 3) back.
//   - Hop limit is decremented when forwarding; at 1 the router answers "time exceeded" (type 3); no route: type 1 code 0.
//   - No ICMPv6 errors about ICMPv6 errors.
// Not modelled (the validators pin Linux to match): duplicate address detection (nodad), router solicitations,
// MLD reports, router advertisements, redirects, link-local addresses.
import {ip6ToInt, intToIp6, parseCidr6, inSubnet6, solicitedNode, multicastMac} from "./addr6.js";

export const ICMP6 = {unreach: 1, timeExceeded: 3, echoRequest: 128, echoReply: 129, ns: 135, na: 136};
const ERR_NAME = {1: {0: "no route", 1: "administratively prohibited", 3: "address unreachable"}, 3: "time exceeded"};
export const errName6 = i => i.type === 3 ? ERR_NAME[3] : (ERR_NAME[1][i.code] || "unreachable");

export class Ip6 {
  /** node: the IpNode; ifaces6: {eth0: "2001:db8::1/64"}; routes6: [["2001:db8:2::/64", "2001:db8::2"]]; gw6: default gateway. */
  constructor(node, {ifaces6 = {}, routes6 = [], gw6 = null} = {}) {
    this.node = node;
    this.addrs = Object.entries(ifaces6).map(([iface, cidr]) => ({iface, ...parseCidr6(cidr)}));
    this.routes = routes6.map(([dst, via]) => ({...parseCidr6(dst), via}));
    if (gw6) this.routes.push({...parseCidr6("::/0"), via: gw6});
    this.cache = new Map();     // next-hop address -> {mac, iface}
    this.pending = new Map();   // next-hop address -> {iface, packets, tries, forwarded}
  }
  owns(ip) { return this.addrs.some(a => a.ip === ip); }
  ownsOn(iface, ip) { return this.addrs.some(a => a.iface === iface && a.ip === ip); }
  /** Does the NIC on `iface` accept frames to this multicast MAC (a solicited-node group we have joined)? */
  joined(iface, mac) { return this.addrs.some(a => a.iface === iface && multicastMac(solicitedNode(a.ip)) === mac); }
  flush() { this.cache.clear(); this.pending.clear(); }

  /** Longest-prefix match over connected prefixes and static routes. */
  route(dst) {
    let best = null;
    const v = ip6ToInt(dst);
    for (const a of this.addrs) if ((v & a.mask) === a.net && (!best || a.prefix > best.prefix))
      best = {prefix: a.prefix, iface: a.iface, nextHop: dst, why: `connected ${intToIp6(a.net)}/${a.prefix} on ${a.iface}`};
    for (const r of this.routes) if ((v & r.mask) === r.net && (!best || r.prefix > best.prefix)) {
      const out = this.addrs.find(a => inSubnet6(r.via, a.net, a.mask));
      if (out) best = {prefix: r.prefix, iface: out.iface, nextHop: r.via, why: `route ${r.cidr} via ${r.via}`};
    }
    return best;
  }

  frameOut(iface, mac, p) { const i = this.node.ifaces[iface]; this.node.send(iface, {src: i.mac, dst: mac, type: "ipv6", ip6: p}); }

  /** Originate a packet from this node. Returns false when there is no route. */
  sendIp(p) {
    const r = this.route(p.dst);
    if (!r) { this.node.log("no-route", `no route to ${p.dst}`); return false; }
    if (!p.src) p = {...p, src: this.addrs.find(a => a.iface === r.iface).ip};
    this.out(r, p, false);
    return true;
  }
  out(r, p, forwarded) {
    const e = this.cache.get(r.nextHop);
    if (e && e.iface === r.iface) return this.frameOut(r.iface, e.mac, p);
    let q = this.pending.get(r.nextHop);
    if (q) { q.packets.push(p); return; }
    q = {iface: r.iface, packets: [p], tries: 0, forwarded};
    this.pending.set(r.nextHop, q);
    this.solicit(r.nextHop, q);
  }
  solicit(target, q) {
    if (this.pending.get(target) !== q) return;
    if (q.tries >= 3) {
      this.pending.delete(target);
      this.node.log("ndp-failed", `no neighbor advertisement from ${target} after 3 tries: dropping ${q.packets.length} packet(s)`);
      for (const p of q.packets) if (q.forwarded) this.icmpError(p, ICMP6.unreach, 3);
      return;
    }
    q.tries++;
    const i = this.node.ifaces[q.iface], first = q.packets[0];
    const spa = first.src && this.ownsOn(q.iface, first.src) ? first.src : this.addrs.find(a => a.iface === q.iface).ip;   // the packet's own source when it is ours
    const group = solicitedNode(target);
    this.node.log("ns", `who has ${target}? (try ${q.tries})`);
    this.node.send(q.iface, {src: i.mac, dst: multicastMac(group), type: "ipv6",
      ip6: {src: spa, dst: group, hl: 255, proto: "icmp6", icmp: {type: ICMP6.ns, code: 0, target, slla: i.mac}}});
    this.node.net._after(1.0, () => this.solicit(target, q));
  }
  learn(ip, mac, iface) {
    this.cache.set(ip, {mac, iface});
    const q = this.pending.get(ip);
    if (q) { this.pending.delete(ip); for (const p of q.packets) this.frameOut(iface, mac, p); }
  }

  /** A frame of type "ipv6" arrived on `iface`. */
  receive(iface, p) {
    if (p.proto === "icmp6" && p.icmp.type === ICMP6.ns) return this.onNs(iface, p);
    if (p.proto === "icmp6" && p.icmp.type === ICMP6.na) return this.onNa(iface, p);
    if (this.owns(p.dst)) return this.deliver(iface, p);
    if (p.dst.startsWith("ff")) return;   // multicast we did not ask for
    if (!this.node.forwarding) { this.node.log("drop", `${p.src} → ${p.dst}: not for me and I don't route`); return; }
    if (p.hl <= 1) { this.node.log("ttl-expired", `${p.src} → ${p.dst}: hop limit ran out here`); return this.icmpError(p, ICMP6.timeExceeded, 0); }
    const r = this.route(p.dst);
    if (!r) { this.node.log("no-route", `no route to ${p.dst}`); return this.icmpError(p, ICMP6.unreach, 0); }
    this.node.log("route", `${p.src} → ${p.dst}: ${r.why} (hop limit ${p.hl} → ${p.hl - 1})`);
    this.out(r, {...p, hl: p.hl - 1}, true);
  }
  onNs(iface, p) {
    const c = p.icmp;
    if (!this.ownsOn(iface, c.target)) return;
    const i = this.node.ifaces[iface];
    if (c.slla && p.src !== "::") this.cache.set(p.src, {mac: c.slla, iface});   // the asker is learned from the solicitation
    this.node.log("na", `${p.src} asked who has ${c.target}: answering with ${i.mac}`);
    this.node.send(iface, {src: i.mac, dst: c.slla, type: "ipv6",
      ip6: {src: c.target, dst: p.src, hl: 255, proto: "icmp6", icmp: {type: ICMP6.na, code: 0, target: c.target, tlla: i.mac, flags: {R: this.node.forwarding, S: true, O: true}}}});
  }
  onNa(iface, p) {
    const c = p.icmp;
    if (!this.ownsOn(iface, p.dst) || !c.tlla) return;
    if (this.pending.has(c.target) || this.cache.has(c.target)) this.learn(c.target, c.tlla, iface);
  }
  deliver(iface, p) {
    this.node.net._local(this.node, p);
    if (p.proto === "icmp6" && p.icmp.type === ICMP6.echoRequest) {
      this.node.log("echo-reply", `answering ping from ${p.src}`);
      this.sendIp({src: p.dst, dst: p.src, hl: 64, proto: "icmp6", icmp: {type: ICMP6.echoReply, code: 0, id: p.icmp.id, seq: p.icmp.seq}});
    }
  }
  icmpError(orig, type, code) {
    if (orig.proto === "icmp6" && orig.icmp.type < 128) return;   // never an error about an error
    const back = this.route(orig.src); if (!back) return;
    this.sendIp({src: this.addrs.find(a => a.iface === back.iface).ip, dst: orig.src, hl: 64, proto: "icmp6",
      icmp: {type, code, orig: {src: orig.src, dst: orig.dst, proto: orig.proto, id: orig.icmp?.id, seq: orig.icmp?.seq}}});
  }
}
