// OSPFv2 (RFC 2328) on a router, with several areas and ABRs, written from the RFC and validated against FRRouting's ospfd in
// Linux namespaces (validate/ospf/). Nothing here is copied from any implementation.
//
//   - A router runs OSPF on the interfaces its `networks` list names (an interface name, or a prefix that holds
//     the interface's address). Its router ID is `routerId`, or its highest interface address.
//   - Every interface is a broadcast network (Ethernet) or, with `interfaces.<if>.type: "point-to-point"`, a
//     point-to-point one. Defaults: hello 10 s, dead 40 s, retransmit 5 s, priority 1, cost 10.
//   - Packets are IP protocol 89 with TTL 1. Hellos go to 224.0.0.5 (MAC 01:00:5e:00:00:05). On a broadcast
//     network Database Description, Link State Request and direct acknowledgments are unicast to the neighbor,
//     flooded updates go to 224.0.0.5 (from the DR and BDR) or to 224.0.0.6, the DR/BDR group (from the others);
//     on point-to-point everything goes to 224.0.0.5.
//   - Neighbor states Down, Init, 2-Way, ExStart, Exchange, Loading, Full; the master (higher router ID) and
//     slave exchange database summaries (RFC 2328 10.6), then request and flood what is missing (13).
//   - DR and BDR election on broadcast networks (9.4): the wait timer (the dead interval) delays the first
//     election, except that a hello naming a DR/BDR ends the wait at once. There is no preemption.
//   - Router LSAs (a point-to-point link and a stub for each point-to-point interface; a transit link to the DR
//     or a stub for each broadcast one) and network LSAs (from the DR, listing fully adjacent routers).
//     A changed LSA is reoriginated at most once every 5 s (MinLSInterval); a received copy newer than ours
//     that claims to be ours is superseded or flushed (13.4).
//   - SPF (16) over the LSDB with the usual back-link checks; routes cost the path plus the stub metric.
//     Equal-cost paths are kept in the table (`describe().routes`) but forwarding uses the lowest next hop.
//
//   - Areas: `networks` entries are an interface or prefix (area 0) or {network, area}. Every area has its own
//     database, flooding, DR elections and SPF; a router with interfaces up in the backbone and another area is an ABR
//     (B bit in its router LSAs). An ABR originates a type 3 summary LSA into each area for every prefix it reaches
//     outside that area (12.4.3: into the backbone only intra-area routes; not for a route whose way out is through
//     the target area) and computes inter-area routes (16.2) from the backbone's summaries.
//
// Not modeled: external LSAs, stub areas, area ranges, virtual links, authentication, 
// demand circuits, non-broadcast and point-to-multipoint networks, LSA aging out of the database (only the
// 30 minute refresh of our own LSAs), checksums (LSAs carry none), multi-packet LSUs, ECMP forwarding.

import {intToIp, ipToInt, parseCidr, inSubnet} from "./addr.js";

export const OSPF_ALL_SPF = "224.0.0.5", OSPF_ALL_SPF_MAC = "01:00:5e:00:00:05";
export const OSPF_ALL_DR = "224.0.0.6", OSPF_ALL_DR_MAC = "01:00:5e:00:00:06";
export const OSPF_DEFAULTS = {hello: 10, dead: 40, retransmit: 5, priority: 1, cost: 10};
const TYPES = ["broadcast", "point-to-point"];
const MAX_AGE = 3600, MAX_AGE_DIFF = 900, MIN_LS_INTERVAL = 5, MIN_LS_ARRIVAL = 1, REFRESH = 1800, INITIAL_SEQ = 0x80000001;
const ST = {Down: 0, Init: 1, "2-Way": 2, ExStart: 3, Exchange: 4, Loading: 5, Full: 6};
const MAX_DD_HEADERS = 72;                   // (1500 MTU - 20 IP - 24 OSPF header - 8 DD fields) / 20 bytes per LSA header
const key = (area, type, id, adv) => `${type === 5 ? "-" : area}|${type}|${id}|${adv}`;       // type 5 (AS external) is flooded in every area; the rest belong to one
const AREA0 = "0.0.0.0", LS_INFINITY = 0xffffff;
const normArea = a => { if (typeof a === "number" || /^\d+$/.test(String(a))) { const n = +a; return [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join("."); } return String(a); };
const ipLt = (a, b) => ipToInt(a) < ipToInt(b);
const cmpIp = (a, b) => ipToInt(a) - ipToInt(b);
const lsaSize = l => 20 + (l.type === 1 ? 4 + 12 * l.body.links.length : l.type === 2 ? 4 + 4 * l.body.attached.length : l.type === 3 ? 8 : 12);

export class Ospf {
  /** cfg: {routerId?, networks: [ifname | "a.b.c.d/len"], passive?: [ifname], interfaces?: {ifname: {type, priority, cost, hello, dead, retransmit}}} */
  constructor(node, cfg = {}) {
    this.node = node; this.net = node.net;
    // networks: an interface name or prefix (area 0), or {network, area}
    this.networks = (cfg.networks || []).map(x => { const m = typeof x === "object" ? x.network : x; return {m: m.includes("/") ? parseCidr(m) : m, area: typeof x === "object" && x.area !== undefined ? normArea(x.area) : AREA0}; });
    this.opts = cfg.interfaces || {};
    this.passive = new Set(cfg.passive || []);
    for (const [n, o] of Object.entries(this.opts)) if (o.type !== undefined && !TYPES.includes(o.type)) throw new Error(`${node.name}: ${n} type must be one of ${TYPES.join(", ")}`);
    this.cfgRouterId = cfg.routerId || null;
    this.rid = null;
    this.ifs = new Map();                    // ifname -> interface state
    this.lsdb = new Map();                   // "type|id|adv" -> LSA {type, id, adv, seq, age0, t0, body, maxAge}
    this.originated = new Map();             // key -> {t, pending}
    this.routes = []; this.started = false; this.spfTimer = null; this.ddCounter = 0;
  }

  // ----- helpers -----
  log(ev, d) { this.node.log(ev, d); }
  _after(dt, fn) { const tok = {}; this.net._after(dt, () => { if (!tok.off) fn(); }, true); return tok; }
  _off(tok) { if (tok) tok.off = true; return null; }
  _linkUp(ifname) { const i = this.node.ifaces[ifname]; return !!(i && i.link && i.link.up); }
  /** The area an interface runs OSPF in (the first matching `networks` entry), or null. */
  areaOf(ifname) {
    const i = this.node.ifaces[ifname]; if (!i || !i.ip) return null;
    const n = this.networks.find(n => typeof n.m === "string" ? n.m === ifname : i.prefix >= n.m.prefix && inSubnet(i.ip, n.m.net, n.m.mask));
    return n ? n.area : null;
  }
  enabled(ifname) { return this.areaOf(ifname) !== null; }
  /** The areas this router is configured in: those of its OSPF interfaces, up or not (ospfd keeps an area, with an empty router LSA, while its cable is down). */
  areas() { return [...new Set(Object.keys(this.node.ifaces).map(n => this.areaOf(n)).filter(a => a !== null))].sort((a, b) => cmpIp(a, b)); }
  /** An area border router (3): configured in two or more areas, one of them the backbone. */
  isAbr() { const a = this.areas(); return a.length > 1 && a.includes(AREA0); }
  routerId() {
    if (this.rid) return this.rid;
    if (this.cfgRouterId) return (this.rid = this.cfgRouterId);
    const ips = Object.values(this.node.ifaces).filter(i => i.ip).map(i => i.ip).sort(cmpIp);
    return (this.rid = ips[ips.length - 1] || "0.0.0.0");
  }
  /** Is the NIC/IP layer to accept 224.0.0.5 (every running interface) or 224.0.0.6 (DR and BDR only)? */
  joined(ifname, group) {
    const i = this.ifs.get(ifname); if (!i || !i.running) return false;
    return group === OSPF_ALL_SPF || i.state === "DR" || i.state === "Backup";
  }

  // ----- lifecycle -----
  start() {
    if (this.started) return; this.started = true; this.routerId();
    for (const ifname of Object.keys(this.node.ifaces).sort()) if (this.enabled(ifname) && this._linkUp(ifname)) this._ifUp(ifname);
    this._lsas();
  }
  linkChange(ifname, up) {
    if (!this.started || !this.enabled(ifname)) return;
    if (up) { if (!this.ifs.has(ifname)) { this.log("ospf", `${ifname} is up: OSPF starts on it again`); this._ifUp(ifname); this._lsas(); } return; }
    const i = this.ifs.get(ifname); if (!i) return;
    this.log("ospf", `${ifname} lost carrier: its neighbors are gone and its link leaves our router LSA`);
    this._ifDown(i); this._lsas();
  }
  _ifUp(ifname) {
    const a = this.node.ifaces[ifname], o = this.opts[ifname] || {};
    const i = {name: ifname, area: this.areaOf(ifname), ip: a.ip, mask: intToIp(a.mask), net: a.net, prefix: a.prefix, type: o.type || "broadcast",
      priority: o.priority ?? OSPF_DEFAULTS.priority, cost: o.cost ?? OSPF_DEFAULTS.cost,
      hello: o.hello ?? OSPF_DEFAULTS.hello, dead: o.dead ?? (o.hello ? o.hello * 4 : OSPF_DEFAULTS.dead), rxmt: o.retransmit ?? OSPF_DEFAULTS.retransmit,
      passive: this.passive.has(ifname), state: "Down", dr: "0.0.0.0", bdr: "0.0.0.0", nbrs: new Map(), running: true, tHello: null, tWait: null, tAck: null, acks: [], changed: false};
    this.ifs.set(ifname, i);
    if (i.type === "point-to-point") i.state = "Point-To-Point";
    else if (i.priority === 0) i.state = "DROther";
    else if (i.passive) i.state = "Waiting";                 // nobody to wait for: the election below needs no timer
    else { i.state = "Waiting"; i.tWait = this._after(i.dead, () => { i.tWait = null; this.log("ospf", `${ifname}: wait timer over, electing the DR`); this._elect(i); }); }
    this.log("ospf", `${ifname} (${i.ip}/${i.prefix}) starts OSPF as ${i.type}: ${i.state}, cost ${i.cost}, hello ${i.hello} s, dead ${i.dead} s`);
    if (i.passive) { this.log("ospf", `${ifname} is passive: its subnet is advertised, but no Hellos are sent or accepted`); if (i.state === "Waiting") this._elect(i); return; }
    this._helloTick(i);                      // the first Hello goes out at once
  }
  _ifDown(i) {
    for (const n of [...i.nbrs.values()]) this._killNbr(i, n, false);
    i.tHello = this._off(i.tHello); i.tWait = this._off(i.tWait); i.tAck = this._off(i.tAck);
    i.running = false; i.state = "Down"; this.ifs.delete(i.name);
  }

  // ----- hello -----
  _helloTick(i) {
    if (!i.running) return;
    this._sendHello(i);
    i.tHello = this._after(i.hello, () => this._helloTick(i));
  }
  _sendHello(i) {
    const nb = [...i.nbrs.values()].filter(n => ST[n.state] >= ST.Init).map(n => n.rid).sort(cmpIp);
    this._send(i, OSPF_ALL_SPF, {type: "hello", mask: i.mask, helloInterval: i.hello, options: 2, priority: i.priority, deadInterval: i.dead,
      dr: i.dr, bdr: i.bdr, neighbors: nb}, 24 + 20 + 4 * nb.length);
  }
  _send(i, dst, body, size) {
    const a = this.node.ifaces[i.name], ospf = {version: 2, routerId: this.routerId(), area: i.area, ...body, size};
    const ip = {src: i.ip, dst, ttl: 1, proto: "ospf", ospf};
    if (dst === OSPF_ALL_SPF || dst === OSPF_ALL_DR)
      return this.node.send(i.name, {src: a.mac, dst: dst === OSPF_ALL_SPF ? OSPF_ALL_SPF_MAC : OSPF_ALL_DR_MAC, type: "ipv4", ip});
    this.node.out({iface: i.name, nextHop: dst}, ip, false);
  }
  /** Where an OSPF packet to neighbor n goes: its own address on a broadcast network, 224.0.0.5 on point-to-point. */
  _to(i, n) { return i.type === "point-to-point" ? OSPF_ALL_SPF : n.ip; }

  // ----- receiving -----
  /** An OSPF packet addressed to this router (unicast, 224.0.0.5, or 224.0.0.6 when DR/BDR). */
  receive(ifname, p) {
    const o = p.ospf, i = this.ifs.get(ifname);
    if (!o || !i || !i.running) return;
    if (this.node.owns(p.src)) return;
    if (i.passive) { this.log("ospf-drop", `${o.type} from ${p.src}: ${ifname} is passive`); return; }
    if (o.area !== i.area) { this.log("ospf-drop", `${o.type} from ${p.src}: area ${o.area}, ${ifname} is in area ${i.area}`); return; }
    if (i.type === "broadcast" && !inSubnet(p.src, i.net, ipToInt(i.mask))) { this.log("ospf-drop", `${o.type} from ${p.src}: not on ${ifname}'s subnet`); return; }
    if (o.routerId === this.routerId()) { this.log("ospf-drop", `${o.type} from ${p.src}: same router ID ${o.routerId} as mine`); return; }
    if (o.type === "hello") return this._onHello(i, p, o);
    const n = i.nbrs.get(p.src);
    if (!n) { this.log("ospf-drop", `${o.type} from ${p.src}: not a known neighbor`); return; }
    if (o.type === "dd") this._onDD(i, n, o);
    else if (o.type === "lsr") this._onLsr(i, n, o);
    else if (o.type === "lsu") this._onLsu(i, n, o);
    else if (o.type === "ack") this._onAck(i, n, o);
    this._settle(i);
  }
  _onHello(i, p, h) {
    if (i.type === "broadcast" && h.mask !== i.mask) { this.log("ospf-drop", `hello from ${p.src}: mask ${h.mask} ≠ ${i.mask}`); return; }
    if (h.helloInterval !== i.hello || h.deadInterval !== i.dead) { this.log("ospf-drop", `hello from ${p.src}: timers ${h.helloInterval}/${h.deadInterval} ≠ ${i.hello}/${i.dead}`); return; }
    let n = i.nbrs.get(p.src);
    if (!n) {
      n = {ip: p.src, rid: h.routerId, prio: h.priority, dr: h.dr, bdr: h.bdr, state: "Down", i, tInact: null, tRxmt: null, tDD: null,
        reqList: new Map(), rxmt: new Map(), summary: [], iAmMaster: false, ddSeq: 0, lastDD: null, lastRecv: null};
      i.nbrs.set(p.src, n);
    }
    const old = {prio: n.prio, isDr: n.dr === n.ip, isBdr: n.bdr === n.ip};
    n.rid = h.routerId; n.prio = h.priority; n.dr = h.dr; n.bdr = h.bdr;
    n.tInact = this._off(n.tInact);
    n.tInact = this._after(i.dead, () => { n.tInact = null; this.log("ospf-dead", `${n.rid} (${n.ip}) on ${i.name}: no hello for ${i.dead} s, neighbor is down`); this._killNbr(i, n, true); this._settle(i); });
    if (n.state === "Down") this._setState(n, "Init");
    if (h.neighbors.includes(this.routerId())) {
      if (n.state === "Init") { this._setState(n, "2-Way"); this._adjOk(i, n); }
    } else if (ST[n.state] >= ST["2-Way"]) { this.log("ospf", `${n.rid} no longer lists us: back to Init`); this._resetAdj(n); this._setState(n, "Init"); }
    if (i.type === "broadcast") {
      const isDr = n.dr === n.ip, isBdr = n.bdr === n.ip;
      if (i.state === "Waiting" && ((isDr && n.bdr === "0.0.0.0") || isBdr)) { this.log("ospf", `${n.rid} names a ${isBdr ? "BDR" : "DR"} on ${i.name}: the wait is over`); i.tWait = this._off(i.tWait); this._elect(i); }
      else if (n.prio !== old.prio || isDr !== old.isDr || isBdr !== old.isBdr) i.changed = true;
    }
    this._settle(i);
  }
  /** Events queued while a packet was processed: a neighbor change makes a new DR election. */
  _settle(i) { if (i.changed && i.running) { i.changed = false; if (i.state !== "Waiting" && i.state !== "Down") this._elect(i); } }

  // ----- neighbor state -----
  _setState(n, s) {
    const old = n.state; if (old === s) return;
    n.state = s;
    this.log("ospf-nbr", `${n.rid} (${n.ip}) on ${n.i.name}: ${old} → ${s}`);
    if (n.i.type === "broadcast" && (ST[old] >= 2) !== (ST[s] >= 2)) n.i.changed = true;
    if ((old === "Full") !== (s === "Full")) this._lsas();
  }
  _killNbr(i, n, notify) {
    this._resetAdj(n); n.tInact = this._off(n.tInact);
    n.state = "Down"; i.nbrs.delete(n.ip);
    if (notify) { if (i.type === "broadcast") i.changed = true; this._lsas(); }
  }
  _resetAdj(n) { n.reqList.clear(); n.rxmt.clear(); n.summary = []; n.tRxmt = this._off(n.tRxmt); n.tDD = this._off(n.tDD); n.lastDD = null; n.lastRecv = null; }
  _needAdj(i, n) { return i.type === "point-to-point" || i.state === "DR" || i.state === "Backup" || n.ip === i.dr || n.ip === i.bdr; }
  _adjOk(i, n) {
    if (n.state === "2-Way") { if (this._needAdj(i, n)) this._exStart(i, n); }
    else if (ST[n.state] >= ST.ExStart && !this._needAdj(i, n)) { this.log("ospf", `${n.rid}: no adjacency needed any more`); this._resetAdj(n); this._setState(n, "2-Way"); }
  }

  // ----- DR / BDR election (9.4) -----
  _elect(i) {
    if (!i.running || i.type !== "broadcast") return;
    i.tWait = this._off(i.tWait);
    const oldDr = i.dr, oldBdr = i.bdr, oldState = i.state;
    let dr = i.dr, bdr = i.bdr;
    const run = () => {
      const cands = [];
      if (i.priority > 0) cands.push({ip: i.ip, rid: this.routerId(), prio: i.priority, dr, bdr});
      for (const n of i.nbrs.values()) if (ST[n.state] >= ST["2-Way"] && n.prio > 0) cands.push({ip: n.ip, rid: n.rid, prio: n.prio, dr: n.dr, bdr: n.bdr});
      const best = list => list.reduce((a, b) => !a || b.prio > a.prio || (b.prio === a.prio && ipLt(a.rid, b.rid)) ? b : a, null);
      const notDr = cands.filter(c => c.dr !== c.ip);
      const claimB = notDr.filter(c => c.bdr === c.ip);
      const nb = best(claimB.length ? claimB : notDr);
      const claimD = cands.filter(c => c.dr === c.ip);
      const nd = best(claimD);
      bdr = nb ? nb.ip : "0.0.0.0";
      dr = nd ? nd.ip : bdr;                      // nobody claims DR: the BDR is promoted
    };
    run();
    const was = {dr: oldDr === i.ip, bdr: oldBdr === i.ip}, now = {dr: dr === i.ip, bdr: bdr === i.ip};
    if (was.dr !== now.dr || was.bdr !== now.bdr) { i.dr = dr; i.bdr = bdr; run(); }   // our own claim changed: elect again with it (step 4)
    i.dr = dr; i.bdr = bdr;
    i.state = dr === i.ip ? "DR" : bdr === i.ip ? "Backup" : "DROther";
    if (i.state !== oldState || i.dr !== oldDr || i.bdr !== oldBdr) {
      this.log("ospf-dr", `${i.name}: DR ${i.dr}, BDR ${i.bdr}; this router is ${i.state}`);
      for (const n of [...i.nbrs.values()]) if (ST[n.state] >= ST["2-Way"]) this._adjOk(i, n);
      this._lsas();
    }
  }

  // ----- database exchange (10.6 - 10.9) -----
  _exStart(i, n) {
    this._resetAdj(n); this._setState(n, "ExStart");
    n.iAmMaster = true; n.ddSeq = 1 + (this.ddCounter++);
    this._sendInitDD(i, n);
  }
  _sendInitDD(i, n) {
    n.lastDD = {flags: {i: true, m: true, ms: true}, seq: n.ddSeq, headers: []};
    this._emitDD(i, n); this._armDD(i, n);
  }
  _emitDD(i, n) {
    const d = n.lastDD;
    this._send(i, this._to(i, n), {type: "dd", mtu: 1500, options: 2, flags: {...d.flags}, seq: d.seq, headers: d.headers.map(h => ({...h}))}, 24 + 8 + 20 * d.headers.length);
  }
  /** Until the neighbor answers, the initial DD (ExStart) and, on the master, every DD (Exchange) is resent each retransmit interval. */
  _armDD(i, n) {
    n.tDD = this._off(n.tDD);
    n.tDD = this._after(i.rxmt, () => {
      n.tDD = null;
      if (n.state === "ExStart" || (n.state === "Exchange" && n.iAmMaster)) { this._emitDD(i, n); this._armDD(i, n); }
    });
  }
  _hdr(l) { return {type: l.type, id: l.id, adv: l.adv, seq: l.seq, age: this._age(l)}; }
  _nextDD(i, n, ms) {
    const chunk = n.summary.splice(0, MAX_DD_HEADERS);
    n.lastDD = {flags: {i: false, m: n.summary.length > 0, ms}, seq: n.ddSeq, headers: chunk};
    this._emitDD(i, n);
    if (ms) this._armDD(i, n);
  }
  _seqMismatch(i, n, why) { this.log("ospf-nbr", `${n.rid}: ${why}: back to ExStart`); this._exStart(i, n); }
  _onDD(i, n, d) {
    if (n.state === "Init") { this._setState(n, "2-Way"); this._adjOk(i, n); }
    if (ST[n.state] < ST.ExStart) return;
    if (n.state === "ExStart") {
      const f = d.flags;
      if (f.i && f.m && f.ms && d.headers.length === 0 && ipLt(this.routerId(), n.rid)) { n.iAmMaster = false; n.ddSeq = d.seq; }
      else if (!f.i && !f.ms && d.seq === n.ddSeq && ipLt(n.rid, this.routerId())) n.iAmMaster = true;
      else return;
      n.tDD = this._off(n.tDD);
      n.summary = [...this.lsdb.values()].filter(l => !this._isMaxAge(l) && this._inScope(l, i)).sort((a, b) => a.type - b.type || cmpIp(a.id, b.id) || cmpIp(a.adv, b.adv)).map(l => this._hdr(l));
      this.log("ospf-nbr", `${n.rid}: ${n.iAmMaster ? "we are the master" : "the neighbor is the master"}, exchanging ${n.summary.length} LSA header(s)`);
      this._setState(n, "Exchange");
      return this._exchange(i, n, d, true);
    }
    this._exchange(i, n, d, false);
  }
  _exchange(i, n, d, first) {
    const f = d.flags;
    if (!first) {
      const dup = n.lastRecv && n.lastRecv.seq === d.seq && n.lastRecv.i === f.i && n.lastRecv.m === f.m && n.lastRecv.ms === f.ms;
      if (dup) { if (!n.iAmMaster && n.lastDD) this._emitDD(i, n); return; }
      if (f.ms === n.iAmMaster) return this._seqMismatch(i, n, "master/slave bit mismatch");
      if (f.i) return this._seqMismatch(i, n, "unexpected initialize bit");
      if (n.iAmMaster ? d.seq !== n.ddSeq : d.seq !== n.ddSeq + 1) return this._seqMismatch(i, n, `DD sequence ${d.seq} out of order`);
      if (n.state !== "Exchange") return this._seqMismatch(i, n, "DD packet after the exchange finished");
    }
    n.lastRecv = {seq: d.seq, i: f.i, m: f.m, ms: f.ms};
    for (const h of d.headers) {
      const k = key(i.area, h.type, h.id, h.adv), mine = this.lsdb.get(k);
      if (!mine || this._cmp(h, this._hdr(mine)) > 0) n.reqList.set(k, h);
    }
    if (n.iAmMaster) {
      if (!n.lastDD.flags.m && !f.m) return this._exchangeDone(i, n);
      n.ddSeq++; this._nextDD(i, n, true);
    } else {
      n.ddSeq = d.seq; this._nextDD(i, n, false);
      if (!f.m && !n.lastDD.flags.m) this._exchangeDone(i, n);
    }
  }
  _exchangeDone(i, n) {
    n.tDD = this._off(n.tDD);
    if (n.reqList.size === 0) { this.log("ospf-nbr", `${n.rid}: databases are in sync`); return this._setState(n, "Full"); }
    this._setState(n, "Loading"); this._sendLsr(i, n);
  }
  _sendLsr(i, n) {
    if (n.state !== "Loading") return;
    const reqs = [...n.reqList.values()].map(h => ({type: h.type, id: h.id, adv: h.adv}));
    for (let k = 0; k < reqs.length; k += 100) { const part = reqs.slice(k, k + 100); this._send(i, this._to(i, n), {type: "lsr", requests: part}, 24 + 12 * part.length); }
    n.tDD = this._off(n.tDD); n.tDD = this._after(i.rxmt, () => this._sendLsr(i, n));
  }
  _onLsr(i, n, r) {
    if (ST[n.state] < ST.Exchange) return;
    const out = [];
    for (const q of r.requests) {
      const l = this.lsdb.get(key(i.area, q.type, q.id, q.adv));
      if (!l) { this.log("ospf-nbr", `${n.rid} asks for an LSA we don't have`); return this._seqMismatch(i, n, "bad LS request"); }
      out.push(l);
    }
    this._sendLsu(i, this._to(i, n), out);
  }
  _sendLsu(i, dst, lsas) {
    if (!lsas.length) return;
    this._send(i, dst, {type: "lsu", lsas: lsas.map(l => ({type: l.type, id: l.id, adv: l.adv, seq: l.seq, age: Math.min(MAX_AGE, this._age(l) + 1), body: l.body}))},
      24 + 4 + lsas.reduce((s, l) => s + lsaSize(l), 0));
  }

  // ----- flooding (13) -----
  _onLsu(i, n, u) {
    if (ST[n.state] < ST.Exchange) return;
    for (const rl of u.lsas) {
      const k = key(i.area, rl.type, rl.id, rl.adv), mine = this.lsdb.get(k);
      const rMax = rl.age >= MAX_AGE;
      if (rMax && !mine && ![...this.ifs.values()].some(x => [...x.nbrs.values()].some(m => m.state === "Exchange" || m.state === "Loading"))) { this._ack(i, n, rl); continue; }
      const c = mine ? this._cmp(rl, this._hdr(mine)) : 1;
      if (c > 0) {
        if (mine && !mine.self && this.net.time - mine.t0 < MIN_LS_ARRIVAL && !mine.maxAge) continue;    // MinLSArrival: too soon after the last copy
        for (const x of this.ifs.values()) for (const m of x.nbrs.values()) m.rxmt.delete(k);       // the old instance needs no more retransmitting
        const req = n.reqList.get(k); if (req && this._cmp(rl, req) >= 0) n.reqList.delete(k);
        const self = this._isSelf(rl);
        const inst = this._install({...rl, area: i.area}, false);
        const back = this._flood(inst, n);
        this.log("ospf-lsa", `${this._name(rl)} from ${n.rid}: ${mine ? "newer, seq " + rl.seq.toString(16) : "new"}`);
        if (!back && !(i.state === "Backup" && n.ip !== i.dr)) this._delayAck(i, rl);
        if (self) this._fightBack(inst);
      } else if (c === 0) {
        if (n.rxmt.has(k)) { n.rxmt.delete(k); if (i.state === "Backup" && n.ip === i.dr) this._delayAck(i, rl); }
        else this._ack(i, n, rl);
        const req = n.reqList.get(k); if (req && this._cmp(rl, req) >= 0) n.reqList.delete(k);
      } else {
        const req = n.reqList.get(k);
        if (req) { this._seqMismatch(i, n, "bad LS request (older LSA than asked for)"); return; }
        if (!(mine.maxAge && mine.seq === 0xffffffff)) this._sendLsu(i, this._to(i, n), [mine]);
      }
    }
    if (n.state === "Loading" && n.reqList.size === 0) { n.tDD = this._off(n.tDD); this.log("ospf-nbr", `${n.rid}: everything requested has arrived`); this._setState(n, "Full"); }
    this._gcMaxAge();
  }
  /** Flood lsa out of the interfaces (13.3). Returns true when it went back out the interface it arrived on. */
  _flood(lsa, from) {
    const k = key(lsa.area, lsa.type, lsa.id, lsa.adv); let back = false;
    for (const i of this.ifs.values()) {
      if (lsa.type !== 5 && i.area !== lsa.area) continue;
      let added = false;
      for (const n of i.nbrs.values()) {
        if (ST[n.state] < ST.Exchange) continue;
        if (n.state === "Exchange" || n.state === "Loading") {
          const req = n.reqList.get(k);
          if (req) { const c = this._cmp(lsa, req); if (c < 0) continue; n.reqList.delete(k); if (c === 0) continue; }
        }
        if (from && n === from) continue;
        n.rxmt.set(k, lsa); added = true; this._armRxmt(i, n);
      }
      if (!added) continue;
      const here = from && from.i === i;
      if (here && (i.dr === from.ip || i.bdr === from.ip)) continue;
      if (here && i.state === "Backup") continue;
      this._sendLsu(i, i.type === "point-to-point" || i.state === "DR" || i.state === "Backup" ? OSPF_ALL_SPF : OSPF_ALL_DR, [lsa]);
      if (here) back = true;
    }
    return back;
  }
  _armRxmt(i, n) {
    if (n.tRxmt) return;
    n.tRxmt = this._after(i.rxmt, () => {
      n.tRxmt = null;
      if (ST[n.state] < ST.Exchange || !n.rxmt.size) return;
      this._sendLsu(i, this._to(i, n), [...n.rxmt.values()]);
      this._armRxmt(i, n);
    });
  }
  _ack(i, n, l) { this._send(i, this._to(i, n), {type: "ack", headers: [this._hdr(l)]}, 24 + 20); }
  _delayAck(i, l) {
    i.acks.push(this._hdr(l));
    if (!i.tAck) i.tAck = this._after(1, () => {
      i.tAck = null; const hs = i.acks; i.acks = [];
      if (!i.running || !hs.length) return;
      this._send(i, i.type === "point-to-point" || i.state === "DR" || i.state === "Backup" ? OSPF_ALL_SPF : OSPF_ALL_DR, {type: "ack", headers: hs}, 24 + 20 * hs.length);
    });
  }
  _onAck(i, n, a) {
    if (ST[n.state] < ST.Exchange) return;
    for (const h of a.headers) { const k = key(n.i.area, h.type, h.id, h.adv), l = n.rxmt.get(k); if (l && this._cmp(h, this._hdr(l)) === 0) n.rxmt.delete(k); }
    this._gcMaxAge();
  }
  /** A flushed LSA leaves the database once no neighbor still has to acknowledge it (14). */
  _gcMaxAge() {
    const busy = [...this.ifs.values()].some(x => [...x.nbrs.values()].some(m => m.state === "Exchange" || m.state === "Loading"));
    if (busy) return;
    for (const [k, l] of this.lsdb) if (this._isMaxAge(l) && ![...this.ifs.values()].some(x => [...x.nbrs.values()].some(m => m.rxmt.has(k)))) { this.lsdb.delete(k); this._spf(); }
  }

  // ----- the database -----
  _age(l) { return l.maxAge ? MAX_AGE : Math.min(MAX_AGE, Math.floor(l.age0 + (this.net.time - l.t0))); }
  _isMaxAge(l) { return l.maxAge || this._age(l) >= MAX_AGE; }
  _name(l) { return l.type === 1 ? `router LSA of ${l.adv}` : l.type === 2 ? `network LSA ${l.id} (DR ${l.adv})` : l.type === 3 ? `summary LSA ${l.id} of ${l.adv}` : `external LSA ${l.id} of ${l.adv}`; }
  /** Does an LSA belong in the database exchange with a neighbor on interface i? */
  _inScope(l, i) { return l.type === 5 || l.area === i.area; }
  /** >0 if a is the more recent instance (13.1). Both need seq and age. */
  _cmp(a, b) {
    if (a.seq !== b.seq) return a.seq > b.seq ? 1 : -1;
    const aa = a.age ?? this._age(a), ba = b.age ?? this._age(b);      // headers and LSUs carry an age; database entries compute it
    const am = aa >= MAX_AGE, bm = ba >= MAX_AGE;
    if (am !== bm) return am ? 1 : -1;
    if (Math.abs(aa - ba) > MAX_AGE_DIFF) return aa < ba ? 1 : -1;
    return 0;
  }
  _install(r, self) {
    const k = key(r.area, r.type, r.id, r.adv), old = this.lsdb.get(k);
    const l = {type: r.type, area: r.type === 5 ? null : r.area, id: r.id, adv: r.adv, seq: r.seq, age0: r.age, t0: this.net.time, body: r.body, maxAge: r.age >= MAX_AGE, self};
    if (old && old.tRefresh) old.tRefresh = this._off(old.tRefresh);
    this.lsdb.set(k, l);
    if (self && !l.maxAge) l.tRefresh = this._after(REFRESH, () => { l.tRefresh = null; this._reoriginate(l, true); });
    if (!old || JSON.stringify(old.body) !== JSON.stringify(l.body) || old.maxAge !== l.maxAge) this._spf();
    return l;
  }
  _isSelf(l) {
    if (l.adv === this.routerId()) return true;
    return l.type === 2 && [...this.ifs.values()].some(i => i.ip === l.id);
  }
  /** We received a copy of an LSA we originated that is newer than ours (13.4): supersede or flush it. */
  _fightBack(r) {
    const k = key(r.area, r.type, r.id, r.adv), got = this.lsdb.get(k);
    const want = this._wantBody(got);
    if (!want) { this.log("ospf-lsa", `${this._name(r)}: a stale copy of one of ours came back, flushing it`); got.maxAge = true; this._flood(got, null); return; }
    got.self = true; this._reoriginate(got, true, Math.max(got.seq + 1, r.seq + 1));
  }
  /** What we'd put in our own LSA `l` now, or null if we would not originate it. */
  _wantBody(l) {
    if (l.type === 1) return this._routerBody(l.area);
    if (l.type === 2) return this._networkBody(l.id);
    if (l.type === 3) return this.summaries.get(`${l.area}|${l.id}`) || null;
    return null;
  }

  // ----- originating our LSAs (12.4) -----
  /** Something happened that makes a router originate its LSAs (an interface or neighbor changed state, a DR was
   *  elected): coalesced into one pass. Like FRRouting, and unlike RFC 2328's "when the contents change", the router
   *  LSA (and the network LSA, as DR) gets a new instance even if its contents are the same. */
  _lsas() { if (!this.started) return; this.lsaTrigger = true; if (this.lsaPass) return; this.lsaPass = this._after(0, () => { this.lsaPass = null; const t = this.lsaTrigger; this.lsaTrigger = false; this._originateAll(t); }); }
  _originateAll(trigger) {
    for (const a of this.areas()) this._originate(1, this.routerId(), this._routerBody(a), trigger, a);
    const seen = new Set();
    for (const i of this.ifs.values()) if (i.type === "broadcast") { const b = this._networkBody(i.ip); if (b) { seen.add(i.ip); this._originate(2, i.ip, b, trigger, i.area); } }
    for (const l of [...this.lsdb.values()]) if (l.type === 2 && l.adv === this.routerId() && !seen.has(l.id) && !l.maxAge) {
      this.log("ospf-lsa", `${this._name(l)}: no longer the DR with neighbors: flushing it`);
      l.maxAge = true; if (l.tRefresh) l.tRefresh = this._off(l.tRefresh); this._flood(l, null); this._spf();
    }
    this._originateSummaries();
    this._gcMaxAge();
  }
  /** As an ABR, one summary LSA (type 3) per prefix the table reaches outside the area, in every area (12.4.3). */
  _originateSummaries() {
    const want = new Map();
    if (this.isAbr()) for (const t of this.areas()) for (const r of this.table || []) {
      if (r.cost >= LS_INFINITY) continue;
      if (r.kind === "intra" ? r.area === t : t === AREA0) continue;             // not into its own area; into the backbone only intra-area routes
      if (!r.direct && r.hops.length && r.hops.every(h => this.ifs.get(h.iface)?.area === t)) continue;   // its way out is through this very area
      const k = `${t}|${r.net}`; const cur = want.get(k);
      if (!cur || r.cost < cur.metric) want.set(k, {mask: r.mask, metric: r.cost});
    }
    this.summaries = want;
    for (const [k, body] of want) { const [area, id] = k.split("|"); this._originate(3, id, body, false, area); }
    for (const l of [...this.lsdb.values()]) if (l.type === 3 && l.adv === this.routerId() && !l.maxAge && !want.has(`${l.area}|${l.id}`)) {
      this.log("ospf-lsa", `${this._name(l)}: no longer reachable outside area ${l.area}: flushing it`);
      l.maxAge = true; if (l.tRefresh) l.tRefresh = this._off(l.tRefresh); this._flood(l, null); this._spf();
    }
  }
  _routerBody(area) {
    const links = [];
    for (const name of [...this.ifs.keys()].sort()) {
      const i = this.ifs.get(name);
      if (i.state === "Down" || i.area !== area) continue;
      if (i.type === "point-to-point") {
        const n = [...i.nbrs.values()].find(m => m.state === "Full");
        if (n) links.push({type: "p2p", id: n.rid, data: i.ip, metric: i.cost});
        links.push({type: "stub", id: intToIp(i.net), data: i.mask, metric: i.cost});
        continue;
      }
      const dn = i.dr === i.ip ? null : i.nbrs.get(i.dr);
      const transit = i.state === "DR" ? [...i.nbrs.values()].some(m => m.state === "Full") : (i.state === "Backup" || i.state === "DROther") && dn && dn.state === "Full";
      if (transit) links.push({type: "transit", id: i.dr, data: i.ip, metric: i.cost});
      else links.push({type: "stub", id: intToIp(i.net), data: i.mask, metric: i.cost});
    }
    return {abr: this.isAbr(), links};
  }
  /** Body of the network LSA we'd originate for interface address `id`, or null (not the DR, or alone). */
  _networkBody(id) {
    const i = [...this.ifs.values()].find(x => x.ip === id);
    if (!i || i.state !== "DR") return null;
    const full = [...i.nbrs.values()].filter(m => m.state === "Full").map(m => m.rid);
    if (!full.length) return null;
    return {mask: i.mask, attached: [this.routerId(), ...full].sort(cmpIp)};
  }
  _originate(type, id, body, trigger, area) {
    const k = key(area, type, id, this.routerId()), cur = this.lsdb.get(k), rec = this.originated.get(k) || {t: -Infinity, timer: null, pending: false};
    this.originated.set(k, rec);
    const differs = !cur || cur.maxAge || JSON.stringify(cur.body) !== JSON.stringify(body);
    if (!(trigger || rec.pending || differs)) return;
    const wait = rec.t + MIN_LS_INTERVAL - this.net.time;                     // MinLSInterval: at most one new instance every 5 s
    if (wait > 0) { rec.pending = true; if (!rec.timer) rec.timer = this._after(wait, () => { rec.timer = null; this._originateAll(false); }); return; }
    rec.pending = false;
    this._emit(type, id, body, cur ? cur.seq + 1 : INITIAL_SEQ, area);
    rec.t = this.net.time;
  }
  _emit(type, id, body, seq, area) {
    const l = this._install({type, area, id, adv: this.routerId(), seq, age: 0, body}, true);
    this.log("ospf-lsa", `originate ${this._name(l)} in area ${area}, seq ${seq.toString(16)}: ${type === 1 ? l.body.links.map(x => `${x.type} ${x.id}${x.type === "stub" ? "/" + x.data : ""} cost ${x.metric}`).join(", ") : type === 2 ? "attached " + l.body.attached.join(", ") : `${l.body.mask} metric ${l.body.metric}`}`);
    this._flood(l, null);
  }
  _reoriginate(l, force, seq) {
    const body = this._wantBody(l);
    if (!body) return;
    this._emit(l.type, l.id, body, seq ?? l.seq + 1, l.area);
    const rec = this.originated.get(key(l.area, l.type, l.id, l.adv)); if (rec) rec.t = this.net.time;
  }

  // ----- SPF (16) -----
  _spf() { if (this.spfTimer || !this.started) return; this.spfTimer = this._after(0.05, () => { this.spfTimer = null; this._runSpf(); }); }
  /** Dijkstra over one area's router and network LSAs. Returns {routes: Map "net/mask" -> route, routers: Map routerId -> {dist, hops}}. */
  _spfArea(area) {
    const me = this.routerId(), rl = new Map(), nl = new Map();
    const routes = new Map(), routers = new Map();
    for (const l of this.lsdb.values()) { if (l.area !== area || this._isMaxAge(l)) continue; if (l.type === 1) rl.set(l.adv, l); else if (l.type === 2) nl.set(l.id, l); }
    const root = rl.get(me);
    if (!root) return {routes, routers};
    const done = new Set(), cand = new Map();
    const vkey = (t, id) => `${t}:${id}`;
    const ifOf = ip => [...this.ifs.values()].find(x => x.ip === ip && x.area === area);
    const nhFor = (V, W, link) => {
      if (V.root) {
        if (W.type === "net") { const i = ifOf(link.data); return {direct: true, hops: i ? [{iface: i.name, gw: null}] : []}; }
        const back = rl.get(W.id).body.links.find(x => x.type === "p2p" && x.id === me), i = ifOf(link.data);
        return {direct: false, hops: i && back ? [{iface: i.name, gw: back.data}] : []};
      }
      if (V.type === "net" && V.direct) {
        const l2 = rl.get(W.id).body.links.find(x => x.type === "transit" && x.id === V.id);
        return {direct: false, hops: V.hops.map(h => ({iface: h.iface, gw: l2 ? l2.data : null}))};
      }
      return {direct: false, hops: V.hops};
    };
    const addRoute = (net, mask, cost, hops, direct) => {
      const k = `${net}/${mask}`, cur = routes.get(k);
      if (!cur || cost < cur.cost) routes.set(k, {net, mask, cost, hops: [...hops], direct, kind: "intra", area});
      else if (cost === cur.cost) { for (const h of hops) if (!cur.hops.some(x => x.iface === h.iface && x.gw === h.gw)) cur.hops.push(h); cur.direct = cur.direct || direct; }
    };
    const start = {type: "rtr", id: me, dist: 0, root: true, hops: [], direct: false};
    cand.set(vkey("r", me), start);
    while (cand.size) {
      let V = null;
      for (const c of cand.values()) if (!V || c.dist < V.dist || (c.dist === V.dist && c.type === "net" && V.type !== "net")) V = c;
      cand.delete(vkey(V.type === "net" ? "n" : "r", V.id)); done.add(vkey(V.type === "net" ? "n" : "r", V.id));
      if (V.type === "rtr") routers.set(V.id, {dist: V.dist, hops: V.hops});
      const consider = (W, cost, link) => {
        const wk = vkey(W.type === "net" ? "n" : "r", W.id);
        if (done.has(wk)) return;
        const nh = nhFor(V, W, link), d = V.dist + cost, cur = cand.get(wk);
        if (cur && cur.dist < d) return;
        if (cur && cur.dist === d) { for (const h of nh.hops) if (!cur.hops.some(x => x.iface === h.iface && x.gw === h.gw)) cur.hops.push(h); return; }
        cand.set(wk, {type: W.type, id: W.id, dist: d, root: false, hops: [...nh.hops], direct: nh.direct});
      };
      if (V.type === "rtr") {
        for (const link of rl.get(V.id).body.links) {
          if (link.type === "stub") { const nh = V.root ? {hops: [], direct: true} : {hops: V.hops, direct: false}; addRoute(link.id, link.data, V.dist + link.metric, nh.hops, nh.direct); continue; }
          if (link.type === "p2p") { const w = rl.get(link.id); if (w && w.body.links.some(x => x.type === "p2p" && x.id === V.id)) consider({type: "rtr", id: link.id}, link.metric, link); continue; }
          const n = nl.get(link.id); if (n && n.body.attached.includes(V.id)) consider({type: "net", id: link.id}, link.metric, link);
        }
      } else {
        const n = nl.get(V.id);
        addRoute(intToIp(ipToInt(V.id) & ipToInt(n.body.mask)), n.body.mask, V.dist, V.hops, V.direct);
        for (const rid of n.body.attached) { const w = rl.get(rid); if (w && w.body.links.some(x => x.type === "transit" && x.id === V.id)) consider({type: "rtr", id: rid}, 0, null); }
      }
    }
    return {routes, routers};
  }
  _runSpf() {
    const me = this.routerId(), table = new Map(), perArea = new Map();
    const better = (cur, cost, kind) => !cur || (cur.kind === "inter" && kind === "intra") || (cur.kind === kind && cost < cur.cost);
    const merge = (k, r) => {
      const cur = table.get(k);
      if (better(cur, r.cost, r.kind)) table.set(k, {...r, hops: [...r.hops]});
      else if (cur.kind === r.kind && cur.cost === r.cost) { for (const h of r.hops) if (!cur.hops.some(x => x.iface === h.iface && x.gw === h.gw)) cur.hops.push(h); cur.direct = cur.direct || r.direct; }
    };
    for (const a of this.areas()) { const r = this._spfArea(a); perArea.set(a, r); for (const [k, v] of r.routes) merge(k, v); }
    // inter-area routes (16.2): from the summary LSAs of the backbone only, when we are an ABR
    const abr = this.isAbr();
    for (const l of this.lsdb.values()) {
      if (l.type !== 3 || this._isMaxAge(l) || l.adv === me || !perArea.has(l.area) || (abr && l.area !== AREA0)) continue;
      const via = perArea.get(l.area).routers.get(l.adv); if (!via || !via.hops.length) continue;
      if (l.body.metric >= LS_INFINITY) continue;
      const cost = via.dist + l.body.metric;
      const net = intToIp(ipToInt(l.id) & ipToInt(l.body.mask));
      merge(`${net}/${l.body.mask}`, {net, mask: l.body.mask, cost, hops: via.hops, direct: false, kind: "inter", area: l.area});
    }
    const all = [...table.values()];
    const out = all.filter(r => !r.direct && r.hops.length).map(r => {
      r.hops.sort((a, b) => cmpIp(a.gw || "0.0.0.0", b.gw || "0.0.0.0") || a.iface.localeCompare(b.iface));
      const len = [...r.mask.split(".")].reduce((n, o) => n + (+o).toString(2).replace(/0/g, "").length, 0);
      return {cidr: `${r.net}/${len}`, net: ipToInt(r.net), len, mask: ipToInt(r.mask), cost: r.cost, hops: r.hops, kind: r.kind, area: r.area};
    }).sort((a, b) => a.net - b.net || a.len - b.len);
    const sig = t => JSON.stringify(t.map(r => [r.net, r.mask, r.cost, r.kind, r.area, r.direct, r.hops]));
    const tableChanged = sig(this.table || []) !== sig(all);
    this.table = all;
    const before = JSON.stringify(this.routes.map(r => [r.cidr, r.cost, r.hops]));
    this.routes = out;
    if (before !== JSON.stringify(out.map(r => [r.cidr, r.cost, r.hops]))) this.log("ospf-spf", `SPF: ${out.length} route(s): ${out.map(r => `${r.cidr} ${r.kind === "inter" ? "IA " : ""}via ${r.hops.map(h => h.gw).join("/")} cost ${r.cost}`).join(", ") || "none"}`);
    if (tableChanged && (this.isAbr() || this.summaries?.size)) this._originateSummaries();
  }

  // ----- views -----
  /** Routes for the forwarding table (IpNode.route): the lowest next hop of every OSPF route. */
  fib() { return this.routes.map(r => ({cidr: r.cidr, net: r.net, len: r.len, mask: r.mask, metric: r.cost, iface: r.hops[0].iface, gw: r.hops[0].gw})); }
  /** The neighbors as `show ip ospf neighbor` lists them: [{routerId, address, iface, state, role}] */
  neighbors() {
    const out = [];
    for (const i of [...this.ifs.values()].sort((a, b) => a.name.localeCompare(b.name))) for (const n of [...i.nbrs.values()].sort((a, b) => cmpIp(a.rid, b.rid)))
      out.push({routerId: n.rid, address: n.ip, iface: i.name, state: n.state, role: i.type === "point-to-point" ? "-" : n.ip === i.dr ? "DR" : n.ip === i.bdr ? "Backup" : "DROther"});
    return out;
  }
  /** [{iface, area, state, type, cost, priority, dr, bdr, passive}]  (dr, bdr: addresses, "0.0.0.0" when none) */
  interfaces() {
    return [...this.ifs.values()].sort((a, b) => a.name.localeCompare(b.name)).map(i => ({iface: i.name, area: i.area, state: i.state, type: i.type, cost: i.cost, priority: i.priority, dr: i.dr, bdr: i.bdr, passive: i.passive}));
  }
  /** [{network, cost, via: [{gw, iface}], type: "intra" | "inter"}] */
  describe() {
    return this.routes.map(r => ({network: r.cidr, cost: r.cost, type: r.kind, via: r.hops.map(h => ({gw: h.gw, iface: h.iface}))}));
  }
  /** The link state database: [{type, area, id, adv, seq, links | attached | mask+metric}] sorted by area, type, ID, advertising router. */
  database() {
    const T = {1: "router", 2: "network", 3: "summary", 5: "external"};
    return [...this.lsdb.values()].filter(l => !this._isMaxAge(l)).sort((a, b) => cmpIp(a.area || AREA0, b.area || AREA0) || a.type - b.type || cmpIp(a.id, b.id) || cmpIp(a.adv, b.adv))
      .map(l => ({type: T[l.type], area: l.area, id: l.id, adv: l.adv, seq: l.seq,
        ...(l.type === 1 ? {abr: !!l.body.abr, links: l.body.links.map(x => ({...x}))} : l.type === 2 ? {mask: l.body.mask, attached: [...l.body.attached]} : {mask: l.body.mask, metric: l.body.metric})}));
  }
}
