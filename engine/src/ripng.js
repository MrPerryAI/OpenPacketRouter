// RIPng (RFC 2080) on a router, modeled on FRRouting's ripngd (ripngd/ripngd.c), which is what validate/ripng/ runs in Linux
// namespaces to check it. It is RIP (rip.js) for IPv6, so the timers, split horizon and triggered updates work the same way; the
// differences are the ones the protocol itself makes:
//
//   - Updates go to ff02::9 (Ethernet 33:33:00:00:00:09), UDP 521 → 521, hop limit 255, from the interface's link-local address.
//   - A route entry is a prefix, a prefix length, a tag and a metric (20 bytes); up to 72 fit in a 1500-byte frame.
//   - A route's next hop is the neighbour's link-local address (the packet's source), never a global one.
//   - Packets must come from a link-local source with hop limit 255, or they are ignored.
//   - Enabled interfaces: the `networks` list names an interface or a prefix that holds one of its global addresses. Each global
//     prefix on such an interface is a connected route, metric 1.
//
// Not modeled: next-hop entries on the sending side (ripngd sends none by default), route maps, redistribution, offset lists, ECMP,
// the update jitter (FRR moves each periodic update by up to ±update/4 at random; the engine is exact).
// Teaching knob, not in FRR: `triggered: false` turns triggered updates off.

import {intToIp6, ip6ToInt, parseCidr6, inSubnet6, maskOf6} from "./addr6.js";

export const RIPNG_GROUP = "ff02::9", RIPNG_MAC = "33:33:00:00:00:09", RIPNG_PORT = 521, INFINITY = 16, MAX_RTE = 72;
export const RIPNG_DEFAULTS = {update: 30, timeout: 180, garbage: 120, holdoff: 3};
const SPLIT = ["simple", "poisoned", "off"];

const key = (net, len) => `${intToIp6(net)}/${len}`;
const isLinkLocal = ip => { const v = ip6ToInt(ip); return (v >> 118n) === 0x3fan; };   // fe80::/10
/** Prefixes ripngd refuses to learn: multicast, link-local, loopback. */
const destOk = n => { const top = n >> 120n; return top !== 0xffn && (n >> 118n) !== 0x3fan && n !== 1n; };

export class RipNg {
  /** cfg: {networks: [ifname | "2001:db8::/32"], passive?: [ifname], splitHorizon?: "simple"|"poisoned"|"off",
   *        timers?: {update, timeout, garbage, holdoff}, triggered?: true} */
  constructor(node, cfg = {}) {
    this.node = node; this.net = node.net;
    this.networks = (cfg.networks || []).map(x => x.includes(":") ? parseCidr6(x) : x);
    this.passive = new Set(cfg.passive || []);
    this.split = cfg.splitHorizon ?? "simple";
    if (!SPLIT.includes(this.split)) throw new Error(`${node.name}: splitHorizon must be one of ${SPLIT.join(", ")}`);
    this.timers = {...RIPNG_DEFAULTS, ...(cfg.timers || {})};
    this.triggeredOn = cfg.triggered ?? true;
    this.table = new Map();            // "prefix/len" -> route
    this.ifs = new Map();              // ifname -> {running, wake}
    this.started = false; this.trigger = false; this.trigPending = null; this.trigInterval = null; this.tUpdate = null;
  }

  // ----- helpers -----
  get v6() { return this.node.v6; }
  log(ev, d) { this.node.log(ev, d); }
  _after(dt, fn) { const tok = {}; this.net._after(dt, () => { if (!tok.off) fn(); }, true); return tok; }
  _off(tok) { if (tok) tok.off = true; return null; }
  _up(ifname) { const i = this.node.ifaces[ifname]; return !!(i && i.link && i.link.up); }
  enabled(ifname) {
    const own = this.v6.addrs.filter(a => a.iface === ifname);
    if (!own.length) return false;
    return this.networks.some(n => typeof n === "string" ? n === ifname : own.some(a => a.prefix >= n.prefix && inSubnet6(a.ip, n.net, n.mask)));
  }
  /** Is this interface listening on ff02::9? (the NIC accepts the multicast frames only then) */
  joined(ifname) { const s = this.ifs.get(ifname); return !!(s && s.running); }
  sorted() { return [...this.table.values()].sort((a, b) => (a.net < b.net ? -1 : a.net > b.net ? 1 : 0) || a.len - b.len); }
  /** Usable learned routes for the forwarding table (Ip6.route). */
  fib() { return this.sorted().filter(r => r.type === "ripng" && r.metric < INFINITY); }
  /** The RIPng table as `show ipv6 ripng` lists it: [{network, nextHop, metric, type, iface}] */
  describe() {
    return this.sorted().map(r => ({network: r.cidr, nextHop: r.type === "ripng" ? r.gw : "::", metric: r.metric, type: r.type === "ripng" ? "R" : "C", iface: r.iface}));
  }

  // ----- lifecycle -----
  start() {
    if (this.started) return; this.started = true;
    for (const ifname of Object.keys(this.node.ifaces).sort()) if (this.enabled(ifname) && this._up(ifname)) this._ifUp(ifname);
    this.tUpdate = this._after(2, () => this._periodic());
  }
  _ifUp(ifname) {
    const s = {running: false, wake: null}; this.ifs.set(ifname, s);
    s.wake = this._after(1, () => { s.wake = null; s.running = true; this._request(ifname); });
    for (const a of this.v6.addrs.filter(a => a.iface === ifname)) this._connected(ifname, a);
  }
  linkChange(ifname, up) {
    if (!this.started || !this.enabled(ifname)) return;
    if (up) { if (!this.joined(ifname)) { this.log("ripng", `${ifname} is up: RIPng starts on it again`); this._ifUp(ifname); } return; }
    const s = this.ifs.get(ifname); if (!s) return;
    this.log("ripng", `${ifname} lost carrier: routes through it and its own prefixes now have metric 16`);
    s.wake = this._off(s.wake);
    for (const r of this.sorted()) if (r.iface === ifname && r.metric < INFINITY) this._delete(r);
    s.running = false;
  }

  // ----- the table -----
  _connected(ifname, a) {
    const k = key(a.net, a.prefix), old = this.table.get(k);
    if (old && old.type === "connected" && old.metric !== INFINITY) return;
    const r = {cidr: k, net: a.net, len: a.prefix, mask: a.mask, type: "connected", metric: 1, gw: null, from: null, iface: ifname, changed: false};
    if (old) { old.tTimeout = this._off(old.tTimeout); old.tGarbage = this._off(old.tGarbage); }
    this.table.set(k, r); this.log("ripng", `${k} is connected on ${ifname}: advertising it with metric 1`);
    this._changed(r);
  }
  _set(r) {
    const old = this.table.get(r.cidr);
    if (old) { old.tTimeout = this._off(old.tTimeout); old.tGarbage = this._off(old.tGarbage); }
    this.table.set(r.cidr, r); this._refresh(r); this._changed(r);
  }
  _refresh(r) {
    if (r.type !== "ripng" || r.metric === INFINITY) return;
    r.tTimeout = this._off(r.tTimeout);
    r.tTimeout = this._after(this.timers.timeout, () => {
      r.tTimeout = null; this.log("ripng-timeout", `${r.cidr} via ${r.gw}: nothing heard for ${this.timers.timeout} s, metric → 16`); this._delete(r);
    });
  }
  _delete(r) {                                             // keep it at 16 until garbage collection
    r.tTimeout = this._off(r.tTimeout);
    r.metric = INFINITY;
    r.tGarbage = this._off(r.tGarbage);
    r.tGarbage = this._after(this.timers.garbage, () => {
      if (this.table.get(r.cidr) === r) { this.table.delete(r.cidr); this.log("ripng-garbage", `${r.cidr} deleted (garbage collection after ${this.timers.garbage} s)`); }
    });
    this._changed(r);
  }
  _changed(r) { r.changed = true; this._event(); }

  // ----- sending -----
  _event() {
    if (!this.triggeredOn) return;
    if (this.trigInterval) { this.trigger = true; return; }
    if (!this.trigPending) this.trigPending = this._after(0, () => { this.trigPending = null; this._triggered(); });
  }
  _triggered() {
    this.trigInterval = this._off(this.trigInterval); this.trigger = false;
    this._updateAll("changed");
    for (const r of this.table.values()) r.changed = false;
    this.trigInterval = this._after(this.timers.holdoff, () => { this.trigInterval = null; if (this.trigger) { this.trigger = false; this._triggered(); } });
  }
  _periodic() {
    this._updateAll("all");
    this.trigInterval = this._off(this.trigInterval); this.trigger = false;
    this.tUpdate = this._after(this.timers.update, () => this._periodic());
  }
  _updateAll(kind) {
    for (const ifname of [...this.ifs.keys()].sort()) {
      if (!this._up(ifname) || this.passive.has(ifname) || !this.joined(ifname)) continue;
      this._output(ifname, null, kind);
    }
  }
  /** The routes to send out of `ifname`, after split horizon. */
  entries(ifname, kind = "all") {
    const out = [];
    for (const r of this.sorted()) {
      if (kind === "changed" && !r.changed) continue;
      // ripngd applies split horizon only to routes learned from a neighbour on that interface; the interface's own
      // (connected) prefix is always advertised with its real metric, even with poisoned reverse (checked against ripngd).
      const back = r.type === "ripng" && r.iface === ifname;
      if (this.split === "simple" && back) continue;
      out.push({prefix: intToIp6(r.net), len: r.len, tag: 0, metric: this.split === "poisoned" && back ? INFINITY : r.metric});
    }
    return out;
  }
  _output(ifname, to, kind) {
    const all = this.entries(ifname, kind);
    // ripngd starts every response with a next-hop RTE (RFC 2080 2.1.1): the sender's own link-local address, prefix length 0, metric 255.
    const hop = {prefix: this.v6.linkLocal(ifname), len: 0, tag: 0, metric: 255};
    for (let k = 0; k < all.length; k += MAX_RTE - 1) this._send(ifname, to, {command: "response", version: 1, entries: [hop, ...all.slice(k, k + MAX_RTE - 1)]});
  }
  _send(ifname, to, ripng) {
    const i = this.node.ifaces[ifname], src = this.v6.linkLocal(ifname);
    const udp = {sport: RIPNG_PORT, dport: to ? to.port : RIPNG_PORT, payload: {ripng}, size: 4 + 20 * ripng.entries.length};
    const what = ripng.command === "request" ? "Request (send me your whole table)"
      : `${ripng.entries.length} route(s): ${ripng.entries.map(e => `${e.prefix}/${e.len} m${e.metric}`).join(", ")}`;
    if (!to) {
      this.log("ripng-send", `${ifname} → ${RIPNG_GROUP}: ${what}`);
      return this.node.send(ifname, {src: i.mac, dst: RIPNG_MAC, type: "ipv6", ip6: {src, dst: RIPNG_GROUP, hl: 255, proto: "udp", udp}});
    }
    this.log("ripng-send", `${ifname} → ${to.ip}: ${what}`);
    this.v6.out({iface: ifname, nextHop: to.ip}, {src, dst: to.ip, hl: 255, proto: "udp", udp}, false);
  }
  _request(ifname) {
    this.log("ripng", `${ifname} joins ${RIPNG_GROUP} and asks the neighbours for their routes`);
    this._send(ifname, null, {command: "request", version: 1, entries: [{prefix: "::", len: 0, tag: 0, metric: INFINITY}]});
  }

  // ----- receiving -----
  /** A RIPng datagram for this router (multicast, or unicast to its link-local address) on UDP 521. */
  receive(ifname, p) {
    const m = p.udp.payload && p.udp.payload.ripng;
    if (!m || this.v6.ownsOn(ifname, p.src)) return;
    if (!this.joined(ifname)) { this.log("ripng-drop", `RIPng from ${p.src} on ${ifname}: RIPng is not running there`); return; }
    if (p.hl !== 255) { this.log("ripng-drop", `from ${p.src}: hop limit ${p.hl}, not 255`); return; }
    if (!isLinkLocal(p.src)) { this.log("ripng-drop", `from ${p.src}: not a link-local source`); return; }
    if (m.command === "request") return this._onRequest(ifname, p, m);
    if (m.command !== "response") return;
    if (p.udp.sport !== RIPNG_PORT) { this.log("ripng-drop", `response from ${p.src} not from port 521`); return; }
    let nh = null;
    for (const e of m.entries) {
      if (e.metric === 0xff) { nh = e.prefix === "::" || !isLinkLocal(e.prefix) ? null : e.prefix; continue; }   // next-hop entry (RFC 2080 2.1.1)
      this._rte(ifname, p.src, nh, e);
    }
  }
  _onRequest(ifname, p, m) {
    if (this.passive.has(ifname) || !m.entries.length) return;
    const e = m.entries;
    if (e.length === 1 && e[0].len === 0 && e[0].metric === INFINITY && e[0].prefix === "::") {
      this.log("ripng", `${p.src} asked for the whole table: answering on ${ifname}`);
      return this._output(ifname, {ip: p.src, port: p.udp.sport}, "all");
    }
    const ans = e.map(x => { const r = this.table.get(key(ip6ToInt(x.prefix) & maskOf6(x.len), x.len)); return {...x, metric: r ? r.metric : INFINITY}; });
    this._send(ifname, {ip: p.src, port: p.udp.sport}, {command: "response", version: 1, entries: ans});
  }
  /** One route entry. */
  _rte(ifname, from, hop, e) {
    if (!(e.len >= 0 && e.len <= 128) || !(e.metric >= 1 && e.metric <= INFINITY)) return;
    const net = ip6ToInt(e.prefix) & maskOf6(e.len);
    if (!destOk(net)) return;
    const gw = hop || from, metric = Math.min(e.metric + 1, INFINITY);
    const k = key(net, e.len), cur = this.table.get(k);
    const nu = {cidr: k, net, len: e.len, mask: maskOf6(e.len), type: "ripng", metric, gw, from, iface: ifname, changed: false};
    if (!cur) {
      if (metric === INFINITY) return;
      this.log("ripng-learn", `${k} via ${gw} metric ${metric} (new)`);
      return this._set(nu);
    }
    if (cur.type === "connected") {
      if (cur.metric !== INFINITY) return;
      if (metric < INFINITY) { this.log("ripng-learn", `${k} via ${gw} metric ${metric} (own prefix is down)`); this._set(nu); }
      return;
    }
    const same = cur.from === from && cur.gw === gw && cur.iface === ifname;
    if (!same && metric >= cur.metric) return;
    if (same && metric === cur.metric) return this._refresh(cur);
    if (metric === INFINITY) { this.log("ripng-learn", `${k}: ${gw} says unreachable (metric 16)`); return this._delete(cur); }
    this.log("ripng-learn", `${k} via ${gw} metric ${metric}` + (same ? ` (was ${cur.metric})` : ` (better than ${cur.metric} via ${cur.gw})`));
    this._set(nu);
  }
}
