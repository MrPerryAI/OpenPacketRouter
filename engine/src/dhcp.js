// DHCP (RFC 2131), the four-message exchange: DISCOVER → OFFER → REQUEST → ACK, modeled on the frames a
// dnsmasq server and a busybox udhcpc client put on the wire (validated in validate/dhcp/):
//   - the client has no address yet: it sends from 0.0.0.0:68 to 255.255.255.255:67, Ethernet broadcast;
//   - the client doesn't set the broadcast flag, so the server answers OFFER and ACK by unicast to the
//     client's MAC (dnsmasq writes the ARP entry itself: no ARP request on the wire);
//   - no answer: the client sends up to `tries` DISCOVERs, `interval` seconds apart, then gives up;
//   - broadcasts nobody listens to are dropped silently (no ICMP for broadcast, like Linux).
// Leases outlive cache flushes: they are server state, not caches.

import {BROADCAST_MAC, ipToInt, intToIp, parseCidr, inSubnet} from "./addr.js";

const BCAST_IP = "255.255.255.255";

/** The DHCP server service on a node: services.dhcp = {range: [first, last], lease?: s, router?, dns?}. */
export function dhcpServer(node, cfg) {
  const first = ipToInt(cfg.range[0]), last = ipToInt(cfg.range[1]);
  const iface = Object.values(node.ifaces).find(i => i.ip && inSubnet(cfg.range[0], i.net, i.mask));
  if (!iface) throw new Error(`${node.name}: DHCP range ${cfg.range.join("-")} is on none of its subnets`);
  const leases = node.dhcpLeases || (node.dhcpLeases = new Map());   // chaddr -> ip
  const pick = mac => {
    if (leases.has(mac)) return leases.get(mac);
    const used = new Set(leases.values());
    for (let a = first; a <= last; a++) if (!used.has(intToIp(a))) return intToIp(a);
    return null;
  };
  const reply = (kind, req, yiaddr) => {
    node.log("dhcp", `${kind.toUpperCase()} ${yiaddr} to ${req.chaddr}`);
    node.send(iface.name, {src: iface.mac, dst: req.chaddr, type: "ipv4", ip: {src: iface.ip, dst: yiaddr, ttl: 64, proto: "udp",
      udp: {sport: 67, dport: 68, payload: {dhcp: kind, xid: req.xid, chaddr: req.chaddr, yiaddr, server: iface.ip,
        mask: intToIp(iface.mask), router: cfg.router ?? null, dns: cfg.dns ?? null, lease: cfg.lease ?? 3600}}}});
  };
  return payload => {
    if (!payload || !payload.dhcp) return undefined;
    if (payload.dhcp === "discover") {
      const ip = pick(payload.chaddr);
      if (!ip) { node.log("dhcp", `DISCOVER from ${payload.chaddr}: no address available`); return undefined; }
      reply("offer", payload, ip);
    } else if (payload.dhcp === "request" && payload.server === iface.ip) {
      const ip = pick(payload.chaddr);
      if (ip !== payload.requested) { node.log("dhcp", `REQUEST for ${payload.requested} from ${payload.chaddr}: not offered`); return undefined; }
      leases.set(payload.chaddr, ip); reply("ack", payload, ip);
    }
    return undefined;
  };
}

/**
 * Client action: get an address for `src`'s interface (default the first one marked "dhcp").
 * Returns {ok, ip, server, lease} and configures the interface, or {ok: false, error: "no offer"}.
 */
export function dhcp(net, src, {iface, tries = 3, interval = 1} = {}) {
  const node = net.node(src);
  const i = iface ? node.ifaces[iface] : Object.values(node.ifaces).find(x => x.dhcp) || Object.values(node.ifaces)[0];
  const xid = net._dhcpXid = ((net._dhcpXid || 0x1000) + 1);
  let state = "discovering", res = null, sent = 0;
  const bcast = payload => node.send(i.name, {src: i.mac, dst: BROADCAST_MAC, type: "ipv4",
    ip: {src: "0.0.0.0", dst: BCAST_IP, ttl: 64, proto: "udp", udp: {sport: 68, dport: 67, payload}}});
  const discover = () => {
    if (state !== "discovering") return;
    if (sent >= tries) { state = "failed"; node.log("dhcp", `no offer after ${tries} DISCOVERs`); return; }
    sent++; node.log("dhcp", `DISCOVER (try ${sent})`);
    bcast({dhcp: "discover", xid, chaddr: i.mac});
    net._after(interval, discover);
  };
  node.rawHook = (ifname, f) => {
    const p = f.type === "ipv4" && f.ip.proto === "udp" && f.ip.udp.dport === 68 && f.ip.udp.payload;
    if (ifname !== i.name || !p || p.xid !== xid || f.dst !== i.mac && f.dst !== BROADCAST_MAC) return false;
    if (p.dhcp === "offer" && state === "discovering") {
      state = "requesting"; node.log("dhcp", `OFFER ${p.yiaddr} from ${p.server}: requesting it`);
      bcast({dhcp: "request", xid, chaddr: i.mac, requested: p.yiaddr, server: p.server});
    } else if (p.dhcp === "ack" && state === "requesting") {
      state = "bound"; const prefix = parseCidr(`${p.yiaddr}/${maskLen(p.mask)}`);
      Object.assign(i, {ip: p.yiaddr, prefix: prefix.prefix, net: prefix.net, mask: prefix.mask});
      if (p.router) node.routes.push({...parseCidr("0.0.0.0/0"), via: p.router});
      node.log("dhcp", `ACK: ${p.yiaddr}/${prefix.prefix} from ${p.server}, lease ${p.lease} s`);
      res = {ok: true, ip: p.yiaddr, server: p.server, lease: p.lease};
    }
    return true;
  };
  try {
    discover();
    net.run(net.time + tries * interval + 0.5, () => res);
    return res || {ok: false, error: "no offer"};
  } finally { node.rawHook = null; }
}

const maskLen = m => ipToInt(m).toString(2).replace(/0/g, "").length;
