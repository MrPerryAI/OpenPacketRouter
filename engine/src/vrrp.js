// VRRP version 2 (RFC 3768) first-hop redundancy on a router, modeled on what keepalived does.
//
//   - A router joins a group per interface: virtual router id (`vrid`), the shared virtual address (`ip`),
//     a `priority` (default 100, 1-255), an advertisement `interval` in seconds (default 1) and `preempt`
//     (default true). Priority 255 means "I own the address" and starts as master at once.
//   - Everyone else starts as BACKUP and waits for the master's advertisement. Silence for
//     3 x interval + skew, with skew = (256 - priority) / 256 x interval, makes the backup the master, so the
//     highest priority speaks first. (A tie goes to the higher interface address.)
//   - The master owns the virtual address: it answers ARP and ping for it, and sends an advertisement
//     (IP protocol 112, TTL 255, to 224.0.0.18, MAC 01:00:5e:00:00:12) every interval. On becoming master
//     it sends one right away plus a gratuitous ARP so hosts and switches learn the new place.
//   - A master that hears an advertisement with a higher priority (or an equal one from a higher address)
//     steps down to backup. A backup with preempt on that hears a lower priority takes over at once
//     (keepalived does not wait). A priority-0 advertisement (the master is shutting down) makes backups
//     take over after only the skew time.
//   - The virtual address answers with the interface's own MAC, as keepalived does by default. With
//     `virtualMac: true` it uses the RFC address 00:00:5e:00:01:<vrid> instead.
//   - Carrier loss on the interface: the group goes to FAULT (no address, no advertisements); when carrier
//     returns it starts again as BACKUP.
//
// Not modeled: VRRPv3 and IPv6, authentication, several virtual addresses per group, tracking scripts,
// preempt delay, unicast peers, the repeated gratuitous ARPs keepalived sends.

export const VRRP_GROUP = "224.0.0.18", VRRP_MAC = "01:00:5e:00:00:12", VRRP_PROTO = 112;
export const VRRP_DEFAULTS = {priority: 100, interval: 1, preempt: true, virtualMac: false};

const vmacOf = vrid => `00:00:5e:00:01:${vrid.toString(16).padStart(2, "0")}`;
const ipNum = ip => ip.split(".").reduce((a, b) => a * 256 + +b, 0);

export class Vrrp {
  /** cfg: [{iface, vrid, ip, priority?, interval?, preempt?, virtualMac?}] */
  constructor(node, cfg = []) {
    this.node = node; this.net = node.net;
    this.groups = cfg.map(g => ({...VRRP_DEFAULTS, ...g, state: "init", timer: null, masterIp: null}));
    this.started = false;
  }
  log(ev, d) { this.node.log(ev, d); }
  _after(dt, fn) { const tok = {}; this.net._after(dt, () => { if (!tok.off) fn(); }, true); return tok; }
  _off(tok) { if (tok) tok.off = true; return null; }
  _iface(g) { return this.node.ifaces[g.iface]; }
  _up(g) { const i = this._iface(g); return !!(i && i.link && i.link.up); }
  _mac(g) { return g.virtualMac ? vmacOf(g.vrid) : this._iface(g).mac; }
  _skew(g) { return (256 - g.priority) / 256 * g.interval; }
  _down(g) { return 3 * g.interval + this._skew(g); }
  _tag(g) { return `${g.iface} vrid ${g.vrid}`; }

  /** Does the master here use virtual address `ip` on `ifname`? Returns the group (with its MAC via macOf) or null. */
  masterOf(ifname, ip) { return this.groups.find(g => g.state === "master" && g.iface === ifname && g.ip === ip) || null; }
  macOf(g) { return this._mac(g); }
  owns(ip) { return this.groups.some(g => g.state === "master" && g.ip === ip); }
  joined(ifname) { return this.groups.some(g => g.iface === ifname && g.state !== "init" && g.state !== "fault"); }
  /** NIC filter: the group multicast MAC while running, the virtual MAC while master. */
  accepts(ifname, mac) {
    return this.groups.some(g => g.iface === ifname && ((mac === VRRP_MAC && g.state !== "fault" && g.state !== "init") || (g.virtualMac && g.state === "master" && mac === vmacOf(g.vrid))));
  }

  start() { this.started = true; for (const g of this.groups) this._begin(g); }
  linkChange(ifname, up) {
    if (!this.started) return;
    for (const g of this.groups) if (g.iface === ifname) {
      if (up) { this._begin(g); if (g.state === "backup" && g.preempt) g.deaf = true; }   // keepalived: after carrier returns it hears nothing until its own timer fires (validated: vrrp-preempt "cable back")
      else { g.timer = this._off(g.timer); if (g.state !== "fault") { this.log("vrrp", `${this._tag(g)}: carrier lost, fault`); g.state = "fault"; g.masterIp = null; } }
    }
  }
  _begin(g) {
    if (!this._up(g)) { g.state = "fault"; return; }
    if (g.priority === 255) return this._toMaster(g, "address owner");
    this._toBackup(g, "starting");
  }
  _toBackup(g, why, dt) {
    g.timer = this._off(g.timer);
    if (g.state !== "backup") this.log("vrrp", `${this._tag(g)}: backup (${why})`);
    g.state = "backup";
    g.timer = this._after(dt ?? this._down(g), () => this._toMaster(g, "master down timer expired"));
  }
  _toMaster(g, why) {
    g.timer = this._off(g.timer);
    this.log("vrrp", `${this._tag(g)}: master (${why})`);
    g.state = "master"; g.deaf = false; g.masterIp = this._iface(g).ip;
    this._advert(g);
    const i = this._iface(g);
    this.node.send(g.iface, {src: this._mac(g), dst: "ff:ff:ff:ff:ff:ff", type: "arp", arp: {op: "request", sha: this._mac(g), spa: g.ip, tha: "00:00:00:00:00:00", tpa: g.ip}});
    this._tick(g);
  }
  _tick(g) { g.timer = this._after(g.interval, () => { if (g.state === "master") { this._advert(g); this._tick(g); } }); }
  _advert(g, priority = g.priority) {
    const i = this._iface(g); if (!this._up(g)) return;
    this.node.send(g.iface, {src: this._mac(g), dst: VRRP_MAC, type: "ipv4", ip: {src: i.ip, dst: VRRP_GROUP, ttl: 255, proto: "vrrp",
      vrrp: {version: 2, vrid: g.vrid, priority, interval: g.interval, ips: [g.ip]}}});
  }

  receive(ifname, p) {
    const v = p.vrrp; if (!v) return;
    if (p.ttl !== 255) { this.log("vrrp-drop", `advertisement from ${p.src}: TTL ${p.ttl}, must be 255`); return; }
    const g = this.groups.find(x => x.iface === ifname && x.vrid === v.vrid);
    if (!g || g.state === "fault" || g.state === "init" || g.deaf) return;
    if (v.interval !== g.interval) { this.log("vrrp-drop", `${this._tag(g)}: advertisement from ${p.src} has interval ${v.interval}, ours is ${g.interval}`); return; }
    const mine = this._iface(g).ip;
    if (g.state === "master") {
      if (v.priority === 0) return this._advert(g);   // someone asks to be told who is master
      if (v.priority > g.priority || (v.priority === g.priority && ipNum(p.src) > ipNum(mine))) {
        this._toBackup(g, `${p.src} has priority ${v.priority}`); g.masterIp = p.src;
      }
      return;
    }
    // backup
    if (v.priority === 0) { this.log("vrrp", `${this._tag(g)}: master ${p.src} is leaving`); g.timer = this._off(g.timer); g.timer = this._after(this._skew(g), () => this._toMaster(g, "master resigned")); return; }
    g.masterIp = p.src;
    if (g.preempt && v.priority < g.priority) return this._toMaster(g, `preempting ${p.src} (priority ${v.priority} < ${g.priority})`);
    g.timer = this._off(g.timer); g.timer = this._after(this._down(g), () => this._toMaster(g, "master down timer expired"));
  }

  /** [{iface, vrid, ip, priority, interval, preempt, state, masterIp}] in configuration order. */
  describe() {
    return this.groups.map(g => ({iface: g.iface, vrid: g.vrid, ip: g.ip, priority: g.priority, interval: g.interval, preempt: g.preempt,
      virtualMac: g.virtualMac, state: g.state, masterIp: g.masterIp}));
  }
}
