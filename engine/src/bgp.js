// BGP-4 (RFC 4271) on a router: eBGP and iBGP sessions over TCP port 179, `network` statements, path selection,
// written from the RFC and validated against FRRouting's bgpd in Linux namespaces (validate/bgp/). Nothing here is
// copied from any implementation.
//
//   - cfg: {asn, routerId?, networks: ["10.1.0.0/24"], timers?: {keepalive, hold, connect},
//           neighbors: [{ip, remoteAs, localPref?, nextHopSelf?, timers?}]}. The router ID is `routerId`, or the
//           highest interface address. A neighbor in another AS is an eBGP peer, in our AS an iBGP peer.
//   - Messages (OPEN, KEEPALIVE, UPDATE, NOTIFICATION) ride the engine's TCP (tcp.js) as `tcp.data = {bgp: {...}}`.
//     Router k of the topology (in spec order) opens its connections 1 + 0.1 k seconds after start (and retries 0.1 k s late), so the first
//     router configured connects first and the others accept: no connection collisions in the usual case. A
//     failed or lost session is retried every `connect` seconds (default 120, like bgpd's ConnectRetry).
//   - Hold time is negotiated to the smaller of the two OPENs, keepalives go out every `keepalive` seconds (a third
//     of the hold time by default). An eBGP session over a directly connected cable ends at once when the cable
//     loses carrier; an iBGP one ends when the hold timer runs out.
//   - A `network` statement is advertised only while the router has that exact prefix in its table (connected,
//     static, OSPF or RIP). Origin IGP.
//   - Path selection (RFC 4271 9.1.2.2, with bgpd's tie-breaks): reachable next hop; highest local preference
//     (default 100); shortest AS path; lowest origin; eBGP over iBGP; if both are eBGP the older path; lowest router
//     ID; lowest peer address. MED, weight, communities and policy are not modeled.
//   - Advertising: the best path goes to every peer but the one it came from; a route learned from an iBGP peer
//     does not go to another iBGP peer. To an eBGP peer our AS is prepended, and the next hop becomes our address
//     on that cable unless it already is on the peer's subnet (third-party next hop). To an iBGP peer the next hop
//     and AS path stay, and the local preference is carried. A path whose AS path holds the receiver's AS is neither
//     sent nor accepted (loop prevention).
//   - Installed in the forwarding table: the best path of each prefix that is not locally originated, with its next
//     hop resolved through the other routes (distance 20 for eBGP, 200 for iBGP).
import {ipToInt, parseCidr, inSubnet} from "./addr.js";
import {tcpListen, tcpConnect, tcpWrite, tcpClose, tcpAbort} from "./tcp.js";

const PORT = 179, ORIGIN = {igp: 0, egp: 1, incomplete: 2};
const cmpIp = (a, b) => ipToInt(a) - ipToInt(b);
const MSG_LEN = m => ({open: 29 + 20, keepalive: 19, notification: 21, update: 23 + 4 * (m.nlri || []).length + 4 * (m.withdrawn || []).length + (m.attrs ? 20 + 4 * m.attrs.asPath.length : 0)})[m.type];

export class Bgp {
  constructor(node, cfg) {
    this.node = node; this.net = node.net; this.asn = cfg.asn; this.cfgRouterId = cfg.routerId || null; this.rid = null;
    this.networks = (cfg.networks || []).map(c => parseCidr(c));
    this.timers = {keepalive: null, hold: 180, connect: 120, ...(cfg.timers || {})};
    this.peers = new Map();
    for (const n of cfg.neighbors || []) {
      const t = {...this.timers, ...(n.timers || {})}; if (t.keepalive == null) t.keepalive = Math.floor(t.hold / 3);
      this.peers.set(n.ip, {ip: n.ip, remoteAs: n.remoteAs, ebgp: n.remoteAs !== cfg.asn, localPref: n.localPref ?? null, nextHopSelf: !!n.nextHopSelf, t,
        state: "Idle", conn: null, rid: null, hold: null, keepalive: null, adjIn: new Map(), adjOut: new Map(), gen: 0, timers: {}});
    }
    this.paths = new Map();   // cidr -> [path]; path {cidr, net, mask, len, from: peer ip | null, ebgp, rid, t, origin, asPath, nextHop, localPref}
    this.best = new Map();    // cidr -> best path
    this.started = false; this.advTimer = null;
  }
  log(ev, d) { this.node.log(ev, d); }
  _after(dt, fn) { const tok = {}; this.net._after(dt, () => { if (!tok.off) fn(); }, true); return tok; }
  _off(tok) { if (tok) tok.off = true; return null; }
  routerId() {
    if (this.rid) return this.rid;
    if (this.cfgRouterId) return (this.rid = this.cfgRouterId);
    const ips = Object.values(this.node.ifaces).filter(i => i.ip).map(i => i.ip).sort(cmpIp);
    return (this.rid = ips[ips.length - 1] || "0.0.0.0");
  }

  // ----- lifecycle -----
  start() {
    if (this.started) return; this.started = true; this.routerId();
    tcpListen(this.node, PORT, conn => this._accept(conn));
    for (const p of this.peers.values()) this._arm(p, "connect", 1 + this._stagger(), () => this._connect(p));
    this._scan();
  }
  /** Router k of the topology waits 0.1 k s longer than the first, for every connection attempt: two routers never open their connections at the same instant. */
  _stagger() { return 0.1 * [...this.net.nodes.values()].filter(n => n.bgp).indexOf(this.node); }
  _arm(p, name, dt, fn) { this._off(p.timers[name]); p.timers[name] = this._after(dt, fn); }
  _disarm(p, name) { p.timers[name] = this._off(p.timers[name]); }
  /** Every second: does a `network` prefix come or go, does a next hop become reachable or not. */
  _scan() { if (!this.started) return; this._originate(); this._after(1, () => this._scan()); }
  linkChange(ifname, up) {
    if (!this.started || up) return;
    const i = this.node.ifaces[ifname]; if (!i || !i.ip) return;
    for (const p of this.peers.values()) if (p.ebgp && p.state !== "Idle" && inSubnet(p.ip, i.net, i.mask)) { this.log("bgp", `${ifname} lost carrier: session with ${p.ip} ends`); this._down(p, false); }
    this._originate();
  }

  // ----- sessions -----
  _setState(p, s) { if (p.state !== s) { this.log("bgp", `neighbor ${p.ip} (AS ${p.remoteAs}): ${p.state} → ${s}`); p.state = s; } }
  _connect(p) {
    if (p.state === "Established" || p.conn) return;
    p.gen++; const gen = p.gen;
    const conn = tcpConnect(this.node, p.ip, PORT, (ev, n, data) => { if (p.conn === conn && gen === p.gen) this._event(p, conn, ev, data); });
    if (!conn) { this._setState(p, "Active"); this._arm(p, "connect", p.t.connect + this._stagger(), () => this._connect(p)); return; }
    p.conn = conn; this._setState(p, "Connect");
    this._arm(p, "connect", p.t.connect + this._stagger(), () => { if (p.state === "Connect" || p.state === "Active") { tcpAbort(p.conn); p.conn = null; this._connect(p); } });
  }
  _accept(conn) {
    const p = this.peers.get(conn.raddr);
    if (!p || p.state === "Established" || p.state === "OpenSent" || p.state === "OpenConfirm") return false;
    if (p.conn) tcpAbort(p.conn);                 // our own attempt gives way to the incoming connection
    p.gen++; const gen = p.gen; p.conn = conn; this._disarm(p, "connect");
    conn.onEvent = (ev, n, data) => { if (p.conn === conn && gen === p.gen) this._event(p, conn, ev, data); };
    this._setState(p, "Connect");
    return true;
  }
  _event(p, conn, ev, data) {
    if (ev === "connected") { this._disarm(p, "connect"); this._send(p, {type: "open", as: this.asn, hold: p.t.hold, routerId: this.routerId()}); this._setState(p, "OpenSent"); }
    else if (ev === "data") { if (data && data.bgp) this._recv(p, data.bgp); }
    else if (ev === "eof" || ev === "reset") this._down(p, false);
    else if (ev === "refused" || ev === "icmp") { p.conn = null; this._setState(p, "Active"); this._arm(p, "connect", p.t.connect + this._stagger(), () => this._connect(p)); }
  }
  _send(p, m) { if (!p.conn) return; this.log("bgp", `to ${p.ip}: ${m.type}${m.nlri && m.nlri.length ? " " + m.nlri.join(",") : ""}${m.withdrawn && m.withdrawn.length ? " withdraw " + m.withdrawn.join(",") : ""}`); tcpWrite(p.conn, MSG_LEN(m), {bgp: m}); }
  _recv(p, m) {
    this.log("bgp", `from ${p.ip}: ${m.type}`);
    if (m.type === "notification") return this._down(p, false);
    if (m.type === "open") {
      if (p.state !== "OpenSent") return;
      if (m.as !== p.remoteAs) { this._send(p, {type: "notification", code: 2, sub: 2}); return this._down(p, true); }
      p.rid = m.routerId; p.hold = Math.min(p.t.hold, m.hold); p.keepalive = Math.min(p.t.keepalive, Math.floor(p.hold / 3)) || 0;
      this._send(p, {type: "keepalive"}); this._setState(p, "OpenConfirm"); this._armHold(p); this._armKeepalive(p);
    } else if (m.type === "keepalive") {
      if (p.state === "OpenConfirm") { this._setState(p, "Established"); this._armHold(p); this._sendAll(p); }
      else if (p.state === "Established") this._armHold(p);
    } else if (m.type === "update") {
      if (p.state !== "Established") return;
      this._armHold(p); this._update(p, m);
    }
  }
  _armHold(p) { if (p.hold) this._arm(p, "hold", p.hold, () => { this.log("bgp", `neighbor ${p.ip}: hold timer expired`); this._send(p, {type: "notification", code: 4, sub: 0}); this._down(p, true); }); }
  _armKeepalive(p) { if (p.keepalive) this._arm(p, "keepalive", p.keepalive, () => { this._send(p, {type: "keepalive"}); this._armKeepalive(p); }); }
  /** End a session: forget its routes, close the connection (FIN if the cable lets it out), retry later. */
  _down(p, close) {
    const had = p.state === "Established";
    for (const n of ["hold", "keepalive"]) this._disarm(p, n);
    if (p.conn) { const c = p.conn; p.conn = null; const up = this._cableUp(p); if (close && up) tcpClose(c); else tcpAbort(c); }
    p.adjOut.clear(); p.rid = null;
    const lost = [...p.adjIn.keys()]; p.adjIn.clear();
    for (const cidr of lost) this._removePath(cidr, p.ip);
    this._setState(p, "Idle");
    this._arm(p, "connect", p.t.connect + this._stagger(), () => this._connect(p));
    if (had || lost.length) this._decide();
  }
  _cableUp(p) { const r = this.node.route(p.ip, true); const i = r && this.node.ifaces[r.iface]; return !!(i && i.link && i.link.up); }

  // ----- tables -----
  _removePath(cidr, from) {
    const l = (this.paths.get(cidr) || []).filter(x => x.from !== from);
    if (l.length) this.paths.set(cidr, l); else this.paths.delete(cidr);
  }
  _addPath(path) {
    // an unchanged re-advertisement keeps the path's age (it still counts as the oldest for the tie-break), as in bgpd
    const old = (this.paths.get(path.cidr) || []).find(x => x.from === path.from);
    if (old && old.origin === path.origin && old.nextHop === path.nextHop && old.localPref === path.localPref && old.ebgp === path.ebgp && old.rid === path.rid && JSON.stringify(old.asPath) === JSON.stringify(path.asPath)) path.t = old.t;
    this._removePath(path.cidr, path.from); this.paths.set(path.cidr, [...(this.paths.get(path.cidr) || []), path]); }
  /** A prefix with the exact length is in the router's table (not through BGP). */
  _inTable(n) {
    for (const i of Object.values(this.node.ifaces)) if (i.ip && i.net === n.net && i.mask === n.mask && i.link && i.link.up) return true;
    for (const r of this.node.routes) if (r.net === n.net && r.mask === n.mask && this.node.route(r.via, true)) return true;
    for (const t of [this.node.ospf, this.node.rip]) if (t) for (const r of t.fib()) if (r.net === n.net && r.mask === n.mask) return true;
    return false;
  }
  _originate() {
    let changed = false;
    for (const n of this.networks) {
      const have = (this.paths.get(n.cidr) || []).some(x => x.from === null), want = this._inTable(n);
      if (want && !have) { this._addPath({cidr: n.cidr, net: n.net, mask: n.mask, len: n.prefix, from: null, ebgp: false, rid: this.routerId(), t: this.net.time, origin: "igp", asPath: [], nextHop: "0.0.0.0", localPref: 100}); changed = true; }
      if (!want && have) { this._removePath(n.cidr, null); changed = true; }
    }
    // a path whose next hop became (un)reachable changes validity
    if (changed || this._validityChanged()) this._decide();
  }
  _reachable(p) { return p.from === null || !!this.node.route(p.nextHop, true); }
  _validityChanged() { for (const [cidr, b] of this.best) if (!this._reachable(b)) return true; for (const l of this.paths.values()) for (const p of l) if (this._reachable(p) !== (p.valid !== false)) return true; return false; }
  _update(p, m) {
    let changed = false;
    for (const cidr of m.withdrawn || []) if (p.adjIn.delete(cidr)) { this._removePath(cidr, p.ip); changed = true; }
    if (m.nlri && m.nlri.length) {
      const a = m.attrs;
      for (const cidr of m.nlri) {
        if (a.asPath.includes(this.asn)) {                  // our own AS in the path: a loop, treated as a withdrawal
          if (p.adjIn.delete(cidr)) { this._removePath(cidr, p.ip); changed = true; } continue;
        }
        const c = parseCidr(cidr); p.adjIn.set(cidr, true);
        this._addPath({cidr, net: c.net, mask: c.mask, len: c.prefix, from: p.ip, ebgp: p.ebgp, rid: p.rid, t: this.net.time, origin: a.origin, asPath: [...a.asPath],
          nextHop: a.nextHop, localPref: p.ebgp ? (p.localPref ?? 100) : (a.localPref ?? 100)});
        changed = true;
      }
    }
    if (changed) this._decide();
  }
  /** RFC 4271 9.1.2.2 with bgpd's tie-breaks: negative when a is better than b. */
  _cmp(a, b) {
    return (b.localPref - a.localPref) || (a.asPath.length - b.asPath.length) || (ORIGIN[a.origin] - ORIGIN[b.origin]) || ((a.ebgp ? 0 : 1) - (b.ebgp ? 0 : 1))
      || ((a.ebgp && b.ebgp) ? a.t - b.t : 0) || cmpIp(a.rid, b.rid) || (a.from === null ? -1 : b.from === null ? 1 : cmpIp(a.from, b.from));
  }
  _decide() {
    const before = new Map(this.best); this.best = new Map();
    for (const [cidr, l] of this.paths) {
      for (const p of l) p.valid = this._reachable(p);
      const ok = l.filter(p => p.valid).sort((a, b) => this._cmp(a, b));
      if (ok.length) this.best.set(cidr, ok[0]);
    }
    let diff = before.size !== this.best.size;
    for (const [cidr, b] of this.best) if (before.get(cidr) !== b) diff = true;
    if (diff) { this.log("bgp", `best paths: ${[...this.best.keys()].sort().join(", ") || "none"}`); this._scheduleAdv(); }
  }

  // ----- advertising -----
  // Updates go out 0.01 s after the best paths change (batching, and so every route changed in the same event is sent together). The advertisement interval itself is 0, as in recent FRR for eBGP and iBGP.
  _scheduleAdv() { if (this.advTimer) return; this.advTimer = this._after(0.01, () => { this.advTimer = null; for (const p of this.peers.values()) if (p.state === "Established") this._sendAll(p); }); }
  _export(p, b) {
    if (b.from === p.ip) return null;
    if (!p.ebgp && b.from !== null && !b.ebgp && this.peers.get(b.from) && !this.peers.get(b.from).ebgp) return null;   // iBGP to iBGP: no
    if (p.ebgp && b.asPath.includes(p.remoteAs)) return null;
    const r = this.node.route(p.ip, true); if (!r) return null;
    const mine = this.node.ifaces[r.iface].ip, i = this.node.ifaces[r.iface];
    if (p.ebgp) {
      const third = b.from !== null && !p.nextHopSelf && inSubnet(b.nextHop, i.net, i.mask);
      return {origin: b.origin, asPath: [this.asn, ...b.asPath], nextHop: third ? b.nextHop : mine};
    }
    return {origin: b.origin, asPath: [...b.asPath], nextHop: b.from === null || p.nextHopSelf ? mine : b.nextHop, localPref: b.localPref};
  }
  _sendAll(p) {
    const want = new Map();
    for (const [cidr, b] of this.best) { const a = this._export(p, b); if (a) want.set(cidr, JSON.stringify(a)); }
    const withdrawn = [...p.adjOut.keys()].filter(c => !want.has(c)).sort();
    if (withdrawn.length) { for (const c of withdrawn) p.adjOut.delete(c); this._send(p, {type: "update", withdrawn, nlri: []}); }
    const groups = new Map();
    for (const [cidr, sig] of [...want].sort()) if (p.adjOut.get(cidr) !== sig) { p.adjOut.set(cidr, sig); (groups.get(sig) || groups.set(sig, []).get(sig)).push(cidr); }
    for (const [sig, nlri] of groups) this._send(p, {type: "update", withdrawn: [], attrs: JSON.parse(sig), nlri});
  }

  // ----- forwarding table and reports -----
  fib() {
    const out = [];
    for (const b of this.best.values()) {
      if (b.from === null) continue;
      const r = this.node.route(b.nextHop, true); if (!r) continue;
      out.push({cidr: b.cidr, net: b.net, len: b.len, mask: b.mask, iface: r.iface, gw: r.nextHop, ebgp: b.ebgp, asPath: b.asPath});
    }
    return out;
  }
  neighbors() {
    return [...this.peers.values()].sort((a, b) => cmpIp(a.ip, b.ip)).map(p => ({ip: p.ip, remoteAs: p.remoteAs, state: p.state, routerId: p.rid, received: p.adjIn.size}));
  }
  describe() {
    const out = [];
    for (const [cidr, l] of this.paths) for (const p of l)
      out.push({prefix: cidr, from: p.from || "local", best: this.best.get(cidr) === p, valid: p.valid !== false, nextHop: p.nextHop, asPath: p.asPath.join(" "), origin: p.origin, localPref: p.localPref});
    return out.sort((a, b) => ipToInt(a.prefix.split("/")[0]) - ipToInt(b.prefix.split("/")[0]) || (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0) || (a.from < b.from ? -1 : 1));
  }
}
