// RIP version 2 (RFC 2453) on a router, modeled on FRRouting's ripd (ripd/ripd.c, rip_interface.c), which
// is what validate/rip/ runs in Linux namespaces to check it.
//
//   - A router runs RIP on the interfaces its `networks` list names (an interface name, or a prefix that
//     holds the interface's address). Their subnets are its own routes, metric 1.
//   - Updates go to 224.0.0.9 (MAC 01:00:5e:00:00:09), UDP 520 → 520, TTL 1: the whole table every
//     `update` seconds (the first one 2 s after start), at most 25 routes per packet.
//   - One second after an interface comes up, the router asks its neighbours for their tables (a Request
//     with one entry, family 0, metric 16); they answer by unicast.
//   - A route learned from a neighbour costs its metric + 1. 16 means unreachable ("infinity").
//   - Split horizon: a route is not sent back out of the interface it was learned on, nor a subnet out of
//     its own interface. With poisoned reverse those routes are sent anyway, with metric 16.
//   - A route that isn't refreshed for `timeout` seconds gets metric 16; `garbage` seconds later it is
//     deleted. While it waits it is still advertised, with metric 16, so neighbours drop it fast.
//   - Any change sends a triggered update at once, with only the changed routes; further changes in the
//     next 1-5 s (FRR picks at random; the engine uses `holdoff`, default 3 s) wait and go out together.
//   - Carrier loss: routes through that interface, and its own subnet, get metric 16 at once.
//
// Not modeled: RIPv1, authentication, ECMP, offset lists, distribute lists, route maps, redistribution,
// the update jitter (FRR moves each periodic update by up to ±update/4 at random; the engine is exact).
// Teaching knob, not in FRR: `triggered: false` turns triggered updates off (see count-to-infinity).

import {intToIp, ipToInt, maskOf, parseCidr, inSubnet} from "./addr.js";

export const RIP_GROUP = "224.0.0.9", RIP_MAC = "01:00:5e:00:00:09", RIP_PORT = 520, INFINITY = 16, MAX_RTE = 25;
export const RIP_DEFAULTS = {update: 30, timeout: 180, garbage: 120, holdoff: 3};
const SPLIT = ["simple", "poisoned", "off"];

const maskLen = m => { let n = 0; for (let x = ipToInt(m); x & 0x80000000; x = (x << 1) >>> 0) n++; return n; };
const key = (net, len) => `${intToIp(net)}/${len}`;
/** Valid RIP destinations (FRR rip_destination_check): class A/B/C, not net 127, not net 0 except 0.0.0.0. */
const destOk = n => { const a = n >>> 24; if (a === 127) return false; if (a === 0) return n === 0; return a < 224; };

export class Rip {
  /** cfg: {networks: [ifname | "a.b.c.d/len"], passive?: [ifname], splitHorizon?: "simple"|"poisoned"|"off",
   *        timers?: {update, timeout, garbage, holdoff}, triggered?: true} */
  constructor(node, cfg = {}) {
    this.node = node; this.net = node.net;
    this.networks = (cfg.networks || []).map(x => x.includes("/") || /^\d+\.\d+\.\d+\.\d+$/.test(x) ? parseCidr(x) : x);
    this.passive = new Set(cfg.passive || []);
    this.split = cfg.splitHorizon ?? "simple";
    if (!SPLIT.includes(this.split)) throw new Error(`${node.name}: splitHorizon must be one of ${SPLIT.join(", ")}`);
    this.timers = {...RIP_DEFAULTS, ...(cfg.timers || {})};
    this.triggeredOn = cfg.triggered ?? true;
    this.table = new Map();            // "a.b.c.d/len" -> route
    this.ifs = new Map();              // ifname -> {running, wake}
    this.started = false; this.trigger = false; this.trigPending = null; this.trigInterval = null; this.tUpdate = null;
  }

  // ----- helpers -----
  log(ev, d) { this.node.log(ev, d); }
  _after(dt, fn) { const tok = {}; this.net._after(dt, () => { if (!tok.off) fn(); }, true); return tok; }
  _off(tok) { if (tok) tok.off = true; return null; }
  _up(ifname) { const i = this.node.ifaces[ifname]; return !!(i && i.link && i.link.up); }
  enabled(ifname) {
    const i = this.node.ifaces[ifname]; if (!i || !i.ip) return false;
    return this.networks.some(n => typeof n === "string" ? n === ifname : i.prefix >= n.prefix && inSubnet(i.ip, n.net, n.mask));
  }
  /** Is this interface listening on 224.0.0.9? (the NIC and IP layer accept RIP multicast only then) */
  joined(ifname) { const s = this.ifs.get(ifname); return !!(s && s.running); }
  sorted() { return [...this.table.values()].sort((a, b) => a.net - b.net || a.len - b.len); }
  /** Usable learned routes for the forwarding table (IpNode.route). */
  fib() { return this.sorted().filter(r => r.type === "rip" && r.metric < INFINITY); }
  /** The RIP table as `show ip rip` lists it: [{network, nextHop, metric, type, iface}] */
  describe() {
    return this.sorted().map(r => ({network: r.cidr, nextHop: r.type === "rip" ? r.gw : "0.0.0.0", metric: r.metric, type: r.type === "rip" ? "R" : "C", iface: r.iface}));
  }

  // ----- lifecycle -----
  start() {
    if (this.started) return; this.started = true;
    for (const ifname of Object.keys(this.node.ifaces).sort()) if (this.enabled(ifname) && this._up(ifname)) this._ifUp(ifname);
    this.tUpdate = this._after(2, () => this._periodic());          // FRR: first update 2 s after the instance starts
  }
  _ifUp(ifname) {
    const s = {running: false, wake: null}; this.ifs.set(ifname, s);
    s.wake = this._after(1, () => { s.wake = null; s.running = true; this._request(ifname); });
    const i = this.node.ifaces[ifname];
    this._connected(ifname, parseCidr(`${i.ip}/${i.prefix}`));
  }
  linkChange(ifname, up) {
    if (!this.started || !this.enabled(ifname)) return;
    if (up) { if (!this.joined(ifname)) { this.log("rip", `${ifname} is up: RIP starts on it again`); this._ifUp(ifname); } return; }
    const s = this.ifs.get(ifname); if (!s) return;
    this.log("rip", `${ifname} lost carrier: routes through it and its own subnet now have metric 16`);
    s.wake = this._off(s.wake);
    for (const r of this.sorted()) if (r.iface === ifname && r.metric < INFINITY) this._delete(r);
    s.running = false;
  }

  // ----- the table (FRR: rip_redistribute_add, rip_ecmp_add / replace / delete, timers) -----
  _connected(ifname, c) {
    const k = key(c.net, c.prefix), old = this.table.get(k);
    if (old && old.type === "connected" && old.metric !== INFINITY) return;
    const r = {cidr: k, net: c.net, len: c.prefix, mask: c.mask, type: "connected", metric: 1, gw: null, from: null, iface: ifname, changed: false};
    if (old) { old.tTimeout = this._off(old.tTimeout); old.tGarbage = this._off(old.tGarbage); }
    this.table.set(k, r); this.log("rip", `${k} is connected on ${ifname}: advertising it with metric 1`);
    this._changed(r);
  }
  _set(r) {                                                // add or replace (rip_ecmp_add / rip_ecmp_replace)
    const old = this.table.get(r.cidr);
    if (old) { old.tTimeout = this._off(old.tTimeout); old.tGarbage = this._off(old.tGarbage); }
    this.table.set(r.cidr, r); this._refresh(r); this._changed(r);
  }
  _refresh(r) {                                            // rip_timeout_update
    if (r.type !== "rip" || r.metric === INFINITY) return;
    r.tTimeout = this._off(r.tTimeout);
    r.tTimeout = this._after(this.timers.timeout, () => {
      r.tTimeout = null; this.log("rip-timeout", `${r.cidr} via ${r.gw}: nothing heard for ${this.timers.timeout} s, metric → 16`); this._delete(r);
    });
  }
  _delete(r) {                                             // rip_ecmp_delete: keep it at 16 until garbage collection
    r.tTimeout = this._off(r.tTimeout);
    r.metric = INFINITY;
    r.tGarbage = this._off(r.tGarbage);
    r.tGarbage = this._after(this.timers.garbage, () => {
      if (this.table.get(r.cidr) === r) { this.table.delete(r.cidr); this.log("rip-garbage", `${r.cidr} deleted (garbage collection after ${this.timers.garbage} s)`); }
    });
    this._changed(r);
  }
  _changed(r) { r.changed = true; this._event(); }

  // ----- sending -----
  _event() {                                               // RIP_TRIGGERED_UPDATE
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
  /** The routes to send out of `ifname`, after split horizon (rip_output_process). */
  entries(ifname, kind = "all") {
    const i = this.node.ifaces[ifname], out = [];
    const ownSubnet = r => r.type === "connected" && inSubnet(i.ip, r.net, r.mask);
    for (const r of this.sorted()) {
      if (kind === "changed" && !r.changed) continue;
      const back = r.type === "rip" && r.iface === ifname;
      if (this.split === "simple" && (back || ownSubnet(r))) continue;
      let metric = r.metric;
      if (this.split === "poisoned" && (back || ownSubnet(r))) metric = INFINITY;
      out.push({net: intToIp(r.net), mask: intToIp(r.mask), nextHop: r.iface === ifname && r.gw ? r.gw : "0.0.0.0", metric, tag: 0});
    }
    return out;
  }
  _output(ifname, to, kind) {
    const all = this.entries(ifname, kind);
    for (let k = 0; k < all.length; k += MAX_RTE) this._send(ifname, to, {command: "response", version: 2, entries: all.slice(k, k + MAX_RTE)});
  }
  _send(ifname, to, rip) {
    const i = this.node.ifaces[ifname];
    const udp = {sport: RIP_PORT, dport: to ? to.port : RIP_PORT, payload: {rip}, size: 4 + 20 * rip.entries.length};
    const what = rip.command === "request" ? "Request (send me your whole table)"
      : `${rip.entries.length} route(s): ${rip.entries.map(e => `${e.net}/${maskLen(e.mask)} m${e.metric}`).join(", ")}`;
    if (!to) {
      this.log("rip-send", `${ifname} → ${RIP_GROUP}: ${what}`);
      return this.node.send(ifname, {src: i.mac, dst: RIP_MAC, type: "ipv4", ip: {src: i.ip, dst: RIP_GROUP, ttl: 1, proto: "udp", udp}});
    }
    this.log("rip-send", `${ifname} → ${to.ip}: ${what}`);
    this.node.out({iface: ifname, nextHop: to.ip}, {src: i.ip, dst: to.ip, ttl: 64, proto: "udp", udp}, false);
  }
  _request(ifname) {
    this.log("rip", `${ifname} joins ${RIP_GROUP} and asks the neighbours for their routes`);
    this._send(ifname, null, {command: "request", version: 2, entries: [{family: 0, net: "0.0.0.0", mask: "0.0.0.0", nextHop: "0.0.0.0", metric: INFINITY, tag: 0}]});
  }

  // ----- receiving -----
  /** A RIP datagram for this router (multicast or unicast to UDP 520). */
  receive(ifname, p) {
    const rip = p.udp.payload && p.udp.payload.rip;
    if (!rip || this.node.owns(p.src)) return;
    if (!this.joined(ifname)) { this.log("rip-drop", `RIP from ${p.src} on ${ifname}: RIP is not running there`); return; }
    if (rip.command === "request") return this._onRequest(ifname, p, rip);
    if (rip.command !== "response") return;
    if (p.udp.sport !== RIP_PORT) { this.log("rip-drop", `response from ${p.src} not from port 520`); return; }
    if (!Object.values(this.node.ifaces).some(i => i.ip && inSubnet(p.src, i.net, i.mask))) { this.log("rip-drop", `${p.src} is not a neighbour`); return; }
    for (const e of rip.entries) this._rte(ifname, p.src, e);
  }
  _onRequest(ifname, p, rip) {
    if (this.passive.has(ifname) || !rip.entries.length) return;
    const e = rip.entries;
    if (e.length === 1 && e[0].family === 0 && e[0].metric === INFINITY) {
      this.log("rip", `${p.src} asked for the whole table: answering on ${ifname}`);
      return this._output(ifname, {ip: p.src, port: p.udp.sport}, "all");
    }
    const ans = e.map(x => { const r = this.table.get(key(ipToInt(x.net) & ipToInt(x.mask), maskLen(x.mask))); return {...x, metric: r ? r.metric : INFINITY}; });
    this._send(ifname, {ip: p.src, port: p.udp.sport}, {command: "response", version: 2, entries: ans});
  }
  /** One route entry (rip_response_process + rip_rte_process). */
  _rte(ifname, from, e) {
    const len = maskLen(e.mask), net = (ipToInt(e.net) & maskOf(len)) >>> 0;
    if (!destOk(ipToInt(e.net)) || !(e.metric >= 1 && e.metric <= INFINITY)) return;
    let nh = e.nextHop && e.nextHop !== "0.0.0.0" ? e.nextHop : null;
    if (nh && !Object.values(this.node.ifaces).some(i => i.ip && inSubnet(nh, i.net, i.mask))) nh = null;   // not on-link: use the sender
    const gw = nh || from;
    if (this.node.owns(gw)) return;                        // "next hop is myself" (e.g. a poisoned-reverse entry naming us)
    const metric = Math.min(e.metric + 1, INFINITY);
    const k = key(net, len), cur = this.table.get(k);
    const nu = {cidr: k, net, len, mask: maskOf(len), type: "rip", metric, gw, from, iface: ifname, changed: false};
    if (!cur) {
      if (metric === INFINITY) return;
      this.log("rip-learn", `${k} via ${gw} metric ${metric} (new)`);
      return this._set(nu);
    }
    if (cur.type === "connected") {
      if (cur.metric !== INFINITY) return;                 // own subnets beat anything learned
      if (metric < INFINITY) { this.log("rip-learn", `${k} via ${gw} metric ${metric} (own subnet is down)`); this._set(nu); }
      return;
    }
    const same = cur.from === from && cur.gw === gw && cur.iface === ifname;
    if (!same && metric >= cur.metric) return;             // worse or equal from someone else: ignore (no ECMP)
    if (same && metric === cur.metric) return this._refresh(cur);
    if (metric === INFINITY) { this.log("rip-learn", `${k}: ${gw} says unreachable (metric 16)`); return this._delete(cur); }
    this.log("rip-learn", `${k} via ${gw} metric ${metric}` + (same ? ` (was ${cur.metric})` : ` (better than ${cur.metric} via ${cur.gw})`));
    this._set(nu);
  }
}
