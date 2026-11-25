// Network address translation on routers: source NAT with port overload ("PAT") and static 1:1 / port forwarding,
// with a connection-tracking table, modelled on Linux netfilter so the frames match.
//
//   "nat": {
//     "inside": ["eth0"], "outside": ["eth1"],
//     "overload": {"src": "10.1.0.0/24"},        // true or {src}: inside hosts share the address of the outside interface
//     "static": [{"inside": "10.1.0.10", "outside": "203.0.113.10"},                       // 1:1, both directions
//                {"proto": "tcp", "inside": "10.1.0.11", "insidePort": 80, "outside": "203.0.113.10", "outsidePort": 8080}]
//   }
//
// Where it acts (the hooks netfilter uses):
//   prerouting  (before the route lookup): replies to translated flows get their destination put back; packets that
//               arrive on an outside interface for a static outside address get their destination rewritten (dnat);
//   postrouting (after the route lookup, ACL out, TTL decrement): packets from an inside interface leaving an outside
//               interface get their source rewritten (snat: static first, then the overload address).
// Only forwarded packets are translated; packets the router sends or receives for itself are left alone, except that
// replies to translated flows are un-translated before the router decides whether they are for it.
//
// Connection tracking: the first packet of a flow (TCP, UDP, ICMP echo, keyed by the 5-tuple, or the echo id) creates an
// entry; its reply tuple is what the packet looks like after translation, reversed. Every later packet in either
// direction is translated from the entry. ICMP errors about a translated flow (time exceeded, unreachable) are
// matched to it through the packet they quote and get the same translation. Overload keeps the source port when it is
// free; on a clash it takes the next free port in the same range (Linux picks a random one: the port number differs,
// the frames do not). Idle timeouts follow Linux: UDP 30 s unanswered / 120 s, ICMP 30 s, TCP 120 s while opening or
// closing, 5 days established, 10 s after a reset.
//
// Not modelled: translating errors about flows that were destination-translated, hairpin NAT (an inside host reaching
// another inside host through the outside address), protocols other than TCP, UDP and ICMP.
import {parseCidr, inSubnet} from "./addr.js";

const tracked = p => p.proto === "tcp" || p.proto === "udp" || (p.proto === "icmp" && (p.icmp.type === 8 || p.icmp.type === 0));
const ports = p => p.proto === "tcp" ? [p.tcp.sport, p.tcp.dport] : p.proto === "udp" ? [p.udp.sport, p.udp.dport] : [p.icmp.id, p.icmp.id];

/** The packet as a flow tuple. */
export const tuple = p => { const [sport, dport] = ports(p); return {proto: p.proto, src: p.src, sport, dst: p.dst, dport}; };
const reverse = t => ({proto: t.proto, src: t.dst, sport: t.dport, dst: t.src, dport: t.sport});
const same = (a, b) => a.proto === b.proto && a.src === b.src && a.sport === b.sport && a.dst === b.dst && a.dport === b.dport;

/** A copy of p with the given part of tuple t written in: "dst" = destination address and port, "src" = source. */
function rewrite(p, t, part) {
  const q = {...p};
  if (part === "dst") q.dst = t.dst; else q.src = t.src;
  const f = part === "dst" ? "dport" : "sport";
  if (p.proto === "tcp") q.tcp = {...p.tcp, [f]: t[f]};
  else if (p.proto === "udp") q.udp = {...p.udp, [f]: t[f]};
  else q.icmp = {...p.icmp, id: t[f]};
  return q;
}

/** Idle timeout in seconds for a connection in its current state. */
function timeoutOf(c) {
  if (c.proto === "icmp") return 30;
  if (c.proto === "udp") return c.replied ? 120 : 30;
  if (c.closing) return c.closing === "R" ? 10 : 120;
  return c.replied ? 432000 : 120;
}

export class Nat {
  constructor(node, cfg) {
    this.node = node;
    this.inside = new Set(cfg.inside || []);
    this.outside = new Set(cfg.outside || []);
    const ov = cfg.overload === true ? {} : cfg.overload;
    this.overload = ov ? {src: ov.src && ov.src !== "any" ? (c => ({net: c.net, mask: c.mask}))(parseCidr(String(ov.src).includes("/") ? ov.src : `${ov.src}/32`)) : null} : null;
    this.static = (cfg.static || []).map(s => ({proto: s.proto || null, inside: s.inside, outside: s.outside,
      insidePort: s.insidePort ?? null, outsidePort: s.outsidePort ?? null}));
    this.conns = [];
    this.hits = 0; this.misses = 0;
  }

  now() { return this.node.net.time; }
  alive(c) { return !c.dead && this.now() - c.last < timeoutOf(c); }
  /** Live entries, oldest first (expired ones are dropped here). */
  table() { this.conns = this.conns.filter(c => this.alive(c)); return this.conns; }
  clear() { this.conns = []; }

  /** Does the router answer ARP on outside interface `ifname` for this static outside address? */
  proxies(ifname, ip) { return this.outside.has(ifname) && this.static.some(s => s.outside === ip); }

  find(t) {
    for (const c of this.table()) {
      if (same(c.orig, t)) return {c, dir: "orig"};
      if (same(c.reply, t)) return {c, dir: "reply"};
    }
    return null;
  }

  touch(c, dir, p) {
    // Linux kills the entry when the very first answer to the opening SYN is a reset (a refused connection leaves nothing behind).
    if (dir === "reply" && c.proto === "tcp" && !c.replied && /R/.test(p.tcp.flags)) c.dead = true;
    c.last = this.now();
    if (dir === "reply") c.replied = true;
    if (c.proto === "tcp") { const f = p.tcp.flags; if (/R/.test(f)) c.closing = "R"; else if (/F/.test(f) && c.closing !== "R") c.closing = "F"; }
  }

  /** Prerouting. Returns {p, ct}: the packet to route and the tracking entry it belongs to (or null). */
  pre(ifname, p) {
    if (p.proto === "icmp" && (p.icmp.type === 3 || p.icmp.type === 11) && p.icmp.orig) return {p: this.preError(p), ct: null};
    if (!tracked(p)) return {p, ct: null};
    const t = tuple(p), hit = this.find(t);
    if (hit) {
      this.hits++; this.touch(hit.c, hit.dir, p);
      const target = hit.dir === "orig" ? reverse(hit.c.reply) : reverse(hit.c.orig);
      return {p: target.dst !== p.dst || target.dport !== t.dport ? rewrite(p, target, "dst") : p, ct: {c: hit.c, dir: hit.dir}};
    }
    this.misses++;
    if (!this.outside.has(ifname)) return {p, ct: null};
    const s = this.static.find(x => x.outside === p.dst && (!x.proto || (x.proto === p.proto && (x.outsidePort === null || x.outsidePort === t.dport))));
    if (!s) return {p, ct: null};
    const toPort = s.insidePort !== null && s.outsidePort !== null ? s.insidePort : t.dport;
    const reply = {proto: t.proto, src: s.inside, sport: toPort, dst: t.src, dport: t.sport};
    const c = {proto: p.proto, kind: "dnat", orig: t, reply, last: this.now(), replied: false, closing: null, static: true};
    this.conns.push(c); this.node.log("nat", `new ${p.proto} flow ${t.src}:${t.sport} → ${t.dst}:${t.dport}: destination becomes ${reply.src}:${reply.sport}`);
    return {p: rewrite(p, reverse(reply), "dst"), ct: {c, dir: "orig"}};
  }

  /** An ICMP error that quotes a translated packet: put the quoted packet and the destination back. */
  preError(p) {
    const o = p.icmp.orig, op = o.proto === "icmp" ? [o.id, o.id] : [o.sport, o.dport];
    if (!["tcp", "udp", "icmp"].includes(o.proto)) return p;
    const t = {proto: o.proto, src: o.src, sport: op[0], dst: o.dst, dport: op[1]};
    for (const c of this.table()) {
      if (c.kind !== "snat" || !same(reverse(c.reply), t)) continue;
      const back = c.orig;
      this.node.log("nat", `ICMP error about ${t.src}:${t.sport} → ${t.dst}:${t.dport}: translated back to ${back.src}:${back.sport}`);
      const quote = {...o, src: back.src};
      if (o.proto === "icmp") quote.id = back.sport; else { quote.sport = back.sport; }
      return {...p, dst: back.src, icmp: {...p.icmp, orig: quote}};
    }
    return p;
  }

  /** Postrouting: p left the ACL and routing; `out` is the egress interface. Returns the packet to send. */
  post(ct, ifname, out, p) {
    if (ct) {
      const target = ct.dir === "orig" ? reverse(ct.c.reply) : reverse(ct.c.orig);
      return target.src !== p.src || target.sport !== ports(p)[0] ? rewrite(p, target, "src") : p;
    }
    if (!tracked(p) || !this.inside.has(ifname) || !this.outside.has(out)) return p;
    const t = tuple(p);
    let to = null;
    const st = this.static.find(x => !x.proto && x.inside === p.src);
    if (st) to = st.outside;
    else if (this.overload && (!this.overload.src || inSubnet(p.src, this.overload.src.net, this.overload.src.mask))) to = this.node.ifaces[out].ip;
    if (!to) return p;
    const gp = this.freePort(t, to);
    const reply = {proto: t.proto, src: t.dst, sport: t.dport, dst: to, dport: gp};
    const c = {proto: p.proto, kind: "snat", orig: t, reply, last: this.now(), replied: false, closing: null, static: !!st};
    this.conns.push(c);
    this.node.log("nat", `new ${p.proto} flow ${t.src}:${t.sport} → ${t.dst}:${t.dport}: source becomes ${to}:${gp}`);
    return rewrite(p, reverse(reply), "src");
  }

  /** The source port to use: the original one if the reply tuple is free, else the next free one in its range. */
  freePort(t, to) {
    const busy = port => this.conns.some(c => same(c.reply, {proto: t.proto, src: t.dst, sport: t.dport, dst: to, dport: port}));
    if (!busy(t.sport)) return t.sport;
    const [lo, hi] = t.sport < 512 ? [1, 511] : t.sport < 1024 ? [600, 1023] : [1024, 65535];
    for (let k = 1; k <= hi - lo; k++) {
      const port = lo + ((t.sport - lo + k) % (hi - lo + 1));
      if (!busy(port)) return port;
    }
    return t.sport;
  }

  /** The live entries as Linux conntrack lists them: original and reply tuples (validate/nat compares them with /proc/net/nf_conntrack). */
  conntrack() { return this.table().map(c => ({proto: c.proto, orig: {...c.orig}, reply: {...c.reply}})); }

  /** `show ip nat translations`: one row per live entry. */
  translations() {
    const rows = this.static.filter(s => !s.proto).map(s => ({proto: "---", insideGlobal: s.outside, insideLocal: s.inside, outsideLocal: "---", outsideGlobal: "---", static: true}));
    for (const s of this.static.filter(x => x.proto)) rows.push({proto: s.proto, insideGlobal: `${s.outside}:${s.outsidePort ?? "*"}`, insideLocal: `${s.inside}:${s.insidePort ?? "*"}`, outsideLocal: "---", outsideGlobal: "---", static: true});
    const ep = (ip, port) => `${ip}:${port}`;
    for (const c of this.table()) {
      const o = c.orig, r = c.reply;
      const left = Math.max(0, Math.round(timeoutOf(c) - (this.now() - c.last)));
      if (c.kind === "snat") rows.push({proto: c.proto, insideGlobal: ep(r.dst, r.dport), insideLocal: ep(o.src, o.sport), outsideLocal: ep(o.dst, o.dport), outsideGlobal: ep(r.src, r.sport), secondsLeft: left});
      else rows.push({proto: c.proto, insideGlobal: ep(o.dst, o.dport), insideLocal: ep(r.src, r.sport), outsideLocal: ep(o.src, o.sport), outsideGlobal: ep(o.src, o.sport), secondsLeft: left});
    }
    return rows;
  }
}
