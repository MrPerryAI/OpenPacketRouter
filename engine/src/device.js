// Shared pieces for every device: the base class and frame descriptions for the trace.

export const icmpName = i => ({0: "echo reply", 8: "echo request", 11: "time exceeded", 3: ["net unreachable", "host unreachable", "protocol unreachable", "port unreachable"][i.code] || "unreachable"})[i.type] || `icmp ${i.type}`;

export const describe = f => {
  const tag = f.vlan != null ? ` [VLAN ${f.vlan}]` : "";
  if (f.type === "bpdu") return f.bpdu.type === "tcn" ? "BPDU topology change notice" :
    `BPDU root ${f.bpdu.root} cost ${f.bpdu.cost} from ${f.bpdu.bridge} port ${hex4(f.bpdu.port)}${f.bpdu.tc ? " TC" : ""}${f.bpdu.tca ? " TCA" : ""}`;
  if (f.type === "arp") return (f.arp.op === "request" ? `ARP who-has ${f.arp.tpa} tell ${f.arp.spa}` : `ARP ${f.arp.spa} is-at ${f.arp.sha}`) + tag;
  return `IPv4 ${f.ip.src} → ${f.ip.dst} ttl ${f.ip.ttl} ${f.ip.proto === "icmp" ? icmpName(f.ip.icmp) : `UDP ${f.ip.udp.sport}→${f.ip.udp.dport}`}` + tag;
};
export const hex4 = n => "0x" + n.toString(16).padStart(4, "0");

export class Device {
  constructor(net, name, kind) { this.net = net; this.name = name; this.kind = kind; this.ifaces = {}; }
  addIface(name, extra = {}) { const i = {name, node: this, mac: this.net._mac(), link: null, ...extra}; this.ifaces[name] = i; return i; }
  send(ifname, frame) { this.net._transmit(this, ifname, frame); }
  log(event, detail) { this.net.log(this.name, event, detail); }
  flush() {}
  boot() {}
  linkChanged() {}
}

/** A restartable one-shot timer on the simulation clock. */
export class Timer {
  constructor(net) { this.net = net; this.gen = 0; this.active = false; this.due = 0; }
  start(dt, fn) {
    const g = ++this.gen; this.active = true; this.due = this.net.time + dt;
    this.net._after(dt, () => { if (this.gen === g) { this.active = false; fn(); } });
  }
  stop() { this.gen++; this.active = false; }
  get remaining() { return this.active ? Math.max(0, this.due - this.net.time) : 0; }
}
