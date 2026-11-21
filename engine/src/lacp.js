// Link aggregation (IEEE 802.3ad / 802.1AX LACP): several parallel cables between two switches act as one logical
// port (an EtherChannel / port-channel). Modeled on the Linux bonding driver in mode 802.3ad (drivers/net/bonding/
// bond_3ad.c), which the validators (validate/lacp) compare it with, cable by cable:
//   - a state machine per member cable, run every 100 ms like the kernel's: receive (expired / defaulted / current),
//     periodic transmit (fast = 1 s, slow = 30 s, as the *partner* asks), selection into an aggregator, mux
//     (detached -> waiting 2 s -> attached -> collecting/distributing) and a transmit machine that sends at most
//     3 LACPDUs a second;
//   - frames the switch sends out the channel go out ONE member chosen by the transmit hash (layer2: the last
//     bytes of the source and destination MAC and the EtherType, like bond xmit_hash_policy layer2);
//   - frames arriving on a member that is collecting are handled as arriving on the channel.
// Not modeled: partners other than a single peer switch (several aggregators compete only in the simplest way:
// the first partner heard wins, the rest wait in standby), LACP passive mode, min_links, layer2+3/layer3+4 hashing,
// spanning tree over a channel, per-port LACP priorities other than the default.

export const LACP_MAC = "01:80:c2:00:00:02";
export const ACT = 1, TIMEOUT = 2, AGG = 4, SYNC = 8, COLL = 16, DIST = 32, DEFAULTED = 64, EXPIRED = 128;
const TICK = 0.1, FAST = 10, SLOW = 300, SHORT_TO = 30, LONG_TO = 900, WAIT = 20, TX_GAP = 3;   // in ticks
const SYS_PRIO = 0xffff, PORT_PRIO = 0xff, KEY = 15;   // key 15 = full duplex at 10 Gb/s, what the kernel derives from a veth

const bytes = m => m.split(":").map(x => parseInt(x, 16));
/** Kernel bond xmit_hash_policy layer2 (bond_eth_hash): last byte of the destination MAC xor last byte of the source MAC
 *  xor the EtherType, modulo the number of distributing members. Checked against the kernel for unicast, broadcast,
 *  IPv4 and ARP frames (validate/lacp). */
export function hashLayer2(f, n) {
  const proto = {ipv4: 0x0800, arp: 0x0806, lacpdu: 0x8809}[f.type] ?? 0;
  return (bytes(f.dst)[5] ^ bytes(f.src)[5] ^ proto) % n;
}

const info = (sysPrio, sys, key, portPrio, port, state) => ({sysPrio, sys, key, portPrio, port, state});
const defaultPartner = () => info(SYS_PRIO, "00:00:00:00:00:00", 1, PORT_PRIO, 1, ACT | TIMEOUT);

/** A port-channel on a Switch: the logical port `name`, made of the cabled interfaces `ports`. */
export class Channel {
  constructor(sw, name, ports, {rate = "slow"} = {}) {
    this.sw = sw; this.net = sw.net; this.name = name; this.rate = rate; this.started = false;
    this.members = ports.map((p, i) => ({
      name: p, no: i + 1, up: false, enabled: false, begin: true, rx: "initialize", periodic: "none", mux: "detached",
      ntt: false, selected: false, matched: false, ready: false, readyN: false, standby: false,
      actor: ACT | AGG | (rate === "fast" ? TIMEOUT : 0), partner: defaultPartner(),
      rxTimer: 0, perTimer: 0, muxTimer: 0, txTimer: 0, txLast: 0,
    }));
    this.byName = new Map(this.members.map(m => [m.name, m]));
    this.agg = null;           // the active aggregator's partner {sys, key}; null until a port is selected
    this.gen = 0;
    const first = sw.ifaces[ports[0]];
    this.mac = first.mac;
    for (const p of ports) sw.ifaces[p].mac = this.mac;   // like a bond, every member uses the first member's MAC
    this.iface = {name, node: sw, mac: this.mac, channel: this, peer: null};
    Object.defineProperty(this.iface, "link", {get: () => this.distributing().length ? {up: true, delay: 0} : null, enumerable: true});
    sw.ifaces[name] = this.iface;
  }
  /** Members that are collecting and distributing, in port order. */
  distributing() { return this.members.filter(m => (m.actor & DIST) && m.up); }
  start() {
    this.started = true;
    for (const m of this.members) { const i = this.sw.ifaces[m.name]; if (i.link && i.link.up) this._up(m); }
    this._tick();
  }
  linkChange(p, up) {
    const m = this.byName.get(p); if (!m) return;
    // the kernel notices carrier within a miimon poll (100 ms); the next tick edge is a fair stand-in
    if (up) this._up(m); else this._down(m);
  }
  _up(m) {
    m.up = true; m.enabled = true; m.begin = true; m.rx = "initialize"; m.mux = "detached"; m.selected = false; m.matched = false;
    m.actor = ACT | AGG | (this.rate === "fast" ? TIMEOUT : 0); m.partner = defaultPartner(); m.ntt = false; m.txTimer = 0;
    m.perTimer = 0; m.muxTimer = 0; m.readyN = false; m.ready = false; m.standby = false; m.periodic = "none";
    m.ntt = true;   // the mux machine's first state (detached) asks for a LACPDU
  }
  _down(m) {
    m.up = false; m.enabled = false; m.selected = false; m.matched = false; m.actor &= ~(SYNC | COLL | DIST); m.rx = "port_disabled"; m.mux = "detached";
    m.periodic = "none"; m.perTimer = 0; m.muxTimer = 0; m.readyN = false; m.ready = false; m.ntt = false; m.partner = defaultPartner();
    if (this.agg && !this.members.some(x => x.selected)) this.agg = null;
  }

  // ---- the 100 ms state machines -------------------------------------------------------------------------------
  _tick() {
    const g = ++this.gen;
    this.net._after(TICK, () => { if (this.gen === g) this._tick(); }, true);
    for (const m of this.members) {
      if (!m.up) continue;
      this._rxMachine(m, null); this._periodic(m); this._select(m); this._mux(m); this._tx(m);
    }
  }
  _record(m, a) {   // the actor information of a received LACPDU becomes the partner information (record_pdu)
    m.partner = info(a.sysPrio, a.sys, a.key, a.portPrio, a.port, a.state);
  }
  _rxMachine(m, pdu) {
    if (m.begin) { m.begin = false; m.rx = "initialize"; }
    if (m.rx === "initialize") {   // record_default: no partner known yet
      m.partner = defaultPartner(); m.actor |= DEFAULTED; m.actor &= ~EXPIRED; m.selected = false; m.matched = false;
      m.rx = "port_disabled";
    }
    if (m.rx === "port_disabled") {
      if (m.enabled) { m.rx = "expired"; m.matched = false; m.partner.state &= ~SYNC; m.partner.state |= TIMEOUT; m.rxTimer = SHORT_TO; m.actor |= EXPIRED; }
      else return;
    }
    if (pdu) {
      const a = pdu.actor, p = pdu.partner;
      const same = m.partner.sys === a.sys && m.partner.key === a.key && m.partner.port === a.port && m.partner.sysPrio === a.sysPrio && m.partner.portPrio === a.portPrio && (m.partner.state & AGG) === (a.state & AGG);
      if (!same) m.selected = false;                                                                                       // update_selected
      const mine = this._actorInfo(m), keep = ACT | TIMEOUT | SYNC | AGG;
      if (!(p.sys === mine.sys && p.key === mine.key && p.port === mine.port && p.sysPrio === mine.sysPrio && p.portPrio === mine.portPrio && (p.state & keep) === (mine.state & keep))) m.ntt = true;   // update_ntt
      m.matched = (p.sys === mine.sys && p.key === mine.key && p.port === mine.port && p.sysPrio === mine.sysPrio && p.portPrio === mine.portPrio && (p.state & AGG) === (mine.state & AGG)) || !(a.state & AGG);
      this._record(m, a);
      m.actor &= ~DEFAULTED;
      if (m.matched && (a.state & SYNC)) m.partner.state |= SYNC; else m.partner.state &= ~SYNC;
      m.rx = "current"; m.rxTimer = (m.actor & TIMEOUT) ? SHORT_TO : LONG_TO; m.actor &= ~EXPIRED;
      return;
    }
    if (m.rxTimer && !--m.rxTimer) {
      if (m.rx === "current") { m.rx = "expired"; m.matched = false; m.partner.state &= ~SYNC; m.partner.state |= TIMEOUT; m.rxTimer = SHORT_TO; m.actor |= EXPIRED; }
      else if (m.rx === "expired") {   // defaulted: forget the partner
        m.rx = "defaulted"; m.partner = defaultPartner(); m.actor |= DEFAULTED; m.actor &= ~EXPIRED; m.selected = false; m.matched = false;
      }
    }
  }
  _periodic(m) {   // bond_3ad's ad_periodic_machine, tick for tick
    const last = m.periodic, pt = !!(m.partner.state & TIMEOUT);
    if (!m.enabled || !((m.actor & ACT) || (m.partner.state & ACT))) m.periodic = "none";
    else if (m.perTimer) {
      if (!--m.perTimer) m.periodic = "tx";
      else if (m.periodic === "fast" && !pt) m.periodic = "slow";
      else if (m.periodic === "slow" && pt) { m.perTimer = 0; m.periodic = "tx"; }
    } else if (m.periodic === "none") m.periodic = "fast";
    else if (m.periodic === "tx") m.periodic = pt ? "fast" : "slow";
    if (m.periodic !== last) {
      if (m.periodic === "none") m.perTimer = 0;
      else if (m.periodic === "fast") m.perTimer = FAST - 1;
      else if (m.periodic === "slow") m.perTimer = SLOW - 1;
      else if (m.periodic === "tx") m.ntt = true;
    }
  }
  _select(m) {   // simplified ad_port_selection_logic: ports whose partner is known and equal share the aggregator
    if (m.selected || !m.up) return;
    const real = m.partner.sys !== "00:00:00:00:00:00";
    if (!real) { if (m.partner.state & DEFAULTED) { /* individual until a partner is heard */ } return; }
    if (!this.agg) this.agg = {sys: m.partner.sys, key: m.partner.key};
    if (this.agg.sys === m.partner.sys && this.agg.key === m.partner.key) { m.selected = true; m.standby = false; }
    else { m.selected = true; m.standby = true; }
  }
  _aggPorts() { return this.members.filter(x => x.selected && !x.standby && this.agg && x.partner.sys === this.agg.sys && x.partner.key === this.agg.key); }
  _mux(m) {
    const isSel = m.selected;
    const ports = this._aggPorts();
    const readyAll = ports.length > 0 && ports.every(x => x.readyN);
    switch (m.mux) {
      case "detached": if (isSel) { m.mux = "waiting"; m.muxTimer = WAIT; m.readyN = false; } break;
      case "waiting":
        if (!isSel) { m.mux = "detached"; m.actor &= ~(SYNC | COLL | DIST); m.ntt = true; break; }
        if (m.muxTimer && !--m.muxTimer) m.readyN = true;
        if (m.readyN && readyAll && !m.standby) { m.mux = "attached"; m.actor |= SYNC; m.actor &= ~(COLL | DIST); m.ntt = true; }
        break;
      case "attached":
        if (!isSel || m.standby) { m.mux = "detached"; m.actor &= ~(SYNC | COLL | DIST); m.ntt = true; }
        else if (m.partner.state & SYNC) { m.mux = "collecting"; m.actor |= COLL | DIST | SYNC; m.ntt = true; }
        break;
      case "collecting":
        if (!isSel || m.standby) { m.mux = "detached"; m.actor &= ~(SYNC | COLL | DIST); m.ntt = true; }
        else if (!(m.partner.state & SYNC)) { m.mux = "attached"; m.actor &= ~(COLL | DIST); m.ntt = true; }
        break;
    }
  }
  _actorInfo(m) { return info(SYS_PRIO, this.mac, KEY, PORT_PRIO, m.no, m.actor); }
  _tx(m) {
    if (m.txTimer && !--m.txTimer) {
      if (m.ntt) { this._send(m); m.ntt = false; }
      m.txTimer = TX_GAP;
    } else if (!m.txTimer && m.ntt) { this._send(m); m.ntt = false; m.txTimer = TX_GAP; }   // idle: a PDU leaves at once, then the 3-per-second gate closes
  }
  _send(m) {
    const f = {src: this.mac, dst: LACP_MAC, type: "lacpdu", lacpdu: {actor: this._actorInfo(m), partner: {...m.partner}}};
    this.sw.send(m.name, f);
  }
  /** A LACPDU came in on member `p`. */
  receivePdu(p, f) { const m = this.byName.get(p); if (m && m.up) this._rxMachine(m, f.lacpdu); }
  /** Send a frame out the channel: one member, by the transmit hash over the distributing members. */
  transmit(f) {
    const up = this.distributing(); if (!up.length) return false;
    this.sw.send(up[hashLayer2(f, up.length)].name, f); return true;
  }
  /** Can a data frame arriving on member `p` be accepted? Only collecting members deliver. */
  collecting(p) { const m = this.byName.get(p); return !!(m && m.up && (m.actor & COLL)); }
  describe() {
    return {name: this.name, rate: this.rate, mac: this.mac, members: this.members.map(m => ({port: m.name, number: m.no, up: m.up, state: m.actor, partner: {...m.partner}, mux: m.mux, rx: m.rx, aggregated: !!(m.actor & DIST)}))};
  }
}
