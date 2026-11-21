// LLDP (IEEE 802.1AB) on routers, hosts and servers, modeled on what lldpd sends and keeps (validate/lldp/ runs
// lldpd in Linux namespaces to check it).
//
//   - Every cabled interface with carrier sends an LLDPDU to the nearest-bridge address 01:80:c2:00:00:0e every
//     `txInterval` seconds (default 30). The first one goes out 1 s after carrier comes up (lldpd's minimum
//     gap between two LLDPDUs); after that the timer restarts from it. A router that is started with the
//     network sends its first one 1 s after start.
//   - An LLDPDU carries: Chassis ID (the MAC of the node's first interface, subtype 4), Port ID (the interface's
//     MAC, subtype 3), TTL (`txInterval` × `holdMultiplier`, default 30 × 4 = 120 s), Port Description (the
//     interface name), System Name (the node name), System Description and System Capabilities (router,
//     or station for hosts and servers). Not modeled: Management Address and organizationally specific TLVs
//     (IEEE 802.3 and LLDP-MED), which lldpd also sends.
//   - Received LLDPDUs fill a neighbor table, one entry per local interface (a second sender on the same
//     interface, behind a switch that forwards LLDP, replaces the first). An entry lives for the TTL in the
//     last frame; TTL 0 deletes it. A new neighbor does not make the receiver send early.
//   - Carrier loss on an interface empties its entry at once and stops its timer.
//
// LLDP is link-local: a bridge never forwards it (Linux drops 01:80:c2:00:00:0e unless the bridge's
// group_fwd_mask has bit 14, the `forwardLldp` switch key).

export const LLDP_MAC = "01:80:c2:00:00:0e";
export const LLDP_DEFAULTS = {txInterval: 30, holdMultiplier: 4};
export const SYS_DESCR = "OpenPacketRouter";
const FIRST_GAP = 1;

export class Lldp {
  /** cfg: {txInterval?: seconds, holdMultiplier?: n, description?: text} */
  constructor(node, cfg = {}) {
    this.node = node; this.net = node.net;
    this.txInterval = cfg.txInterval ?? LLDP_DEFAULTS.txInterval;
    this.holdMultiplier = cfg.holdMultiplier ?? LLDP_DEFAULTS.holdMultiplier;
    this.description = cfg.description ?? `${SYS_DESCR} ${node.kind}`;
    this.ports = new Map();            // ifname -> {timer, nbr: {..., expires, token}}
    this.started = false;
  }
  log(ev, d) { this.node.log(ev, d); }
  _after(dt, fn) { const tok = {}; this.net._after(dt, () => { if (!tok.off) fn(); }, true); return tok; }
  _off(tok) { if (tok) tok.off = true; return null; }
  _physical() { return Object.values(this.node.ifaces).filter(i => !i.parent && i.link); }
  _up(i) { return !!(i && i.link && i.link.up); }
  chassisId() { return Object.values(this.node.ifaces).find(i => !i.parent && i.mac)?.mac ?? null; }
  ttl() { return Math.min(65535, this.txInterval * this.holdMultiplier); }

  start() {
    this.started = true;
    for (const i of this._physical()) if (this._up(i)) this._arm(i.name, FIRST_GAP);
  }
  linkChange(ifname, up) {
    if (!this.started) return;
    const i = this.node.ifaces[ifname]; if (!i || i.parent || !i.link) return;
    const p = this.ports.get(ifname);
    if (p) { p.timer = this._off(p.timer); if (p.nbr) { this._drop(ifname, "carrier lost"); } }
    if (up) this._arm(ifname, FIRST_GAP);
  }
  _arm(ifname, dt) {
    const p = this.ports.get(ifname) || {timer: null, nbr: null}; this.ports.set(ifname, p);
    p.timer = this._off(p.timer);
    p.timer = this._after(dt, () => { this._send(ifname); this._arm(ifname, this.txInterval); });
  }
  _send(ifname) {
    const i = this.node.ifaces[ifname]; if (!this._up(i)) return;
    this.node.send(ifname, {type: "lldp", src: i.mac, dst: LLDP_MAC, lldp: {
      chassisId: this.chassisId(), portId: i.mac, portDescr: ifname, ttl: this.ttl(), sysName: this.node.name,
      sysDescr: this.description, caps: this.node.kind === "router" ? ["router"] : ["station"]}});
  }

  receive(ifname, f) {
    const l = f.lldp, p = this.ports.get(ifname) || {timer: null, nbr: null}; this.ports.set(ifname, p);
    if (!l || l.chassisId === this.chassisId()) return;   // our own frame looped back
    if (p.nbr) p.nbr.token && (p.nbr.token.off = true);
    if (l.ttl === 0) { if (p.nbr) this._drop(ifname, "TTL 0"); return; }
    const token = this._after(l.ttl, () => this._drop(ifname, "TTL expired"));
    const fresh = !p.nbr;
    p.nbr = {chassisId: l.chassisId, portId: l.portId, portDescr: l.portDescr, sysName: l.sysName, sysDescr: l.sysDescr, caps: [...(l.caps || [])], ttl: l.ttl, token, since: this.net.time};
    if (fresh) this.log("lldp", `${ifname}: new neighbor ${l.sysName} (${l.portDescr})`);
  }
  _drop(ifname, why) {
    const p = this.ports.get(ifname); if (!p || !p.nbr) return;
    p.nbr.token.off = true; this.log("lldp", `${ifname}: neighbor ${p.nbr.sysName} gone (${why})`); p.nbr = null;
  }

  /** The neighbor table, sorted by interface: [{iface, chassisId, portId, portDescr, sysName, sysDescr, caps, ttl}]. */
  neighbors() {
    return [...this.ports].filter(([, p]) => p.nbr).map(([iface, p]) => ({iface, ...Object.fromEntries(Object.entries(p.nbr).filter(([k]) => !["token", "since"].includes(k)))}))
      .sort((a, b) => a.iface < b.iface ? -1 : a.iface > b.iface ? 1 : 0);
  }
}
