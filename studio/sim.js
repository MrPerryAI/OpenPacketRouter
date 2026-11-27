// Studio simulation layer: runs a spec + actions on the engine and records what the page plays back.
// No DOM here, so Node can import it too (tests/studio/sim.test.mjs).
//
// Each recorded step is one frame put on a cable, with the engine's plain-English decisions that led to it
// and a snapshot of every device's tables at that moment. The run follows engine/src/spec.js runActions
// exactly (caches flushed before each action, `settle` after), so frame counts match the CLI.

import {loadSpec, validateActions, SpecError, ACTIONS} from "../engine/src/spec.js";
import {stormAnalysis} from "../engine/src/storm.js";
import {describeResult} from "../engine/src/report.js";
import {intToIp, inSubnet} from "../engine/src/addr.js";

export const MAX_STEPS = 4000;

const tcpName = t => ({S: "SYN", SA: "SYN+ACK", A: "ACK", PA: "PSH+ACK", FA: "FIN+ACK", R: "RST", RA: "RST+ACK"})[t.flags] || t.flags;
const icmpName = i => ({0: "echo reply", 8: "echo request", 11: "time exceeded", 3: ["net unreachable", "host unreachable", "protocol unreachable", "port unreachable"][i.code] || "unreachable"})[i.type] || `icmp ${i.type}`;

/** Short kind used for colors and filters: arp, icmp, tcp, udp, dhcp, dns, bpdu, lacp, rip, ospf, lldp. */
export function frameKind(f) {
  if (f.type === "ipv6" && f.ip6.proto === "udp" && [f.ip6.udp.sport, f.ip6.udp.dport].includes(521)) return "ripng";
  if (f.type === "ipv6") return f.ip6.icmp && (f.ip6.icmp.type === 135 || f.ip6.icmp.type === 136) ? "ndp" : f.ip6.proto === "icmp6" ? "icmp6" : f.ip6.proto;
  if (f.type === "bpdu") return "bpdu";
  if (f.type === "lacpdu") return "lacp";
  if (f.type === "arp") return "arp";
  if (f.type === "lldp") return "lldp";
  const p = f.ip;
  if (p.proto === "ospf") return "ospf";
  if (p.proto === "vrrp" || p.vrrp) return "vrrp";
  if (p.proto === "udp") { const ports = [p.udp.sport, p.udp.dport]; if (ports.includes(520)) return "rip"; return ports.includes(67) || ports.includes(68) ? "dhcp" : ports.includes(53) ? "dns" : "udp"; }
  if (p.proto === "tcp" && [p.tcp.sport, p.tcp.dport].includes(179) && p.tcp.data && p.tcp.data.bgp) return "bgp";   // a BGP message (a bare SYN or ACK on port 179 stays "tcp")
  return p.proto;
}

/** One line for a frame, in the engine's trace wording. */
export function describeFrame(f) {
  const tag = f.vlan !== undefined ? ` [VLAN ${f.vlan}]` : "";
  if (f.type === "bpdu") return f.bpdu.tcn ? `STP topology change notice${tag}` : `STP BPDU: root ${f.bpdu.root[1]}, cost ${f.bpdu.cost}${f.bpdu.tc ? ", topology change" : ""}${f.bpdu.tca ? ", change acknowledged" : ""}${tag}`;
  if (f.type === "lacpdu") return `LACPDU: port ${f.lacpdu.actor.port} state 0x${f.lacpdu.actor.state.toString(16)}, partner state 0x${f.lacpdu.partner.state.toString(16)}${tag}`;
  if (f.type === "lldp") return `LLDP: ${f.lldp.sysName} port ${f.lldp.portDescr}, TTL ${f.lldp.ttl} s${tag}`;
  if (f.type === "arp") return (f.arp.op === "request" ? `ARP: who has ${f.arp.tpa}? tell ${f.arp.spa}` : `ARP: ${f.arp.spa} is at ${f.arp.sha}`) + tag;
  if (f.type === "ipv6") {
    const p = f.ip6, i = p.icmp || {};
    if (frameKind(f) === "ripng") { const r = (p.udp.payload || {}).ripng || {}; return `RIPng ${r.command || "message"}${r.entries ? `, ${r.entries.length} route(s)` : ""}: ${p.src} → ${p.dst}, hop limit ${p.hl}${tag}`; }
    if (p.proto === "udp") return `IPv6 ${p.src} → ${p.dst} UDP ${p.udp.sport}→${p.udp.dport}, hop limit ${p.hl}${tag}`;
    const what = i.type === 135 ? `neighbor solicitation: who has ${i.target || "?"}?` : i.type === 136 ? `neighbor advertisement: ${i.target || "?"} is at ${i.tlla || "its MAC"}`
      : i.type === 128 ? "echo request" : i.type === 129 ? "echo reply" : i.type === 1 ? "destination unreachable" : i.type === 3 ? "time exceeded" : `type ${i.type}`;
    return `IPv6 ${p.src} → ${p.dst} ICMPv6 ${what}, hop limit ${p.hl}${tag}`;
  }
  const p = f.ip;
  if (p.proto === "ospf") return `OSPF ${p.ospf.type} from ${p.ospf.routerId}: ${p.src} → ${p.dst}${p.ospf.neighbors ? `, ${p.ospf.neighbors.length} neighbor(s) listed` : ""}${tag}`;
  if (frameKind(f) === "vrrp") return `VRRP advert vrid ${p.vrrp ? p.vrrp.vrid : "?"} priority ${p.vrrp ? p.vrrp.priority : "?"}: ${p.src} → ${p.dst}${tag}`;
  if (frameKind(f) === "bgp") { const m = p.tcp.data.bgp; return `BGP ${String(m.type).toUpperCase()}${m.nlri && m.nlri.length ? ` announces ${m.nlri.join(", ")}` : ""}${m.withdrawn && m.withdrawn.length ? ` withdraws ${m.withdrawn.join(", ")}` : ""}: ${p.src} → ${p.dst}${tag}`; }
  if (frameKind(f) === "rip") { const r = p.udp.rip || p.udp.payload || {}; return `RIP ${r.command || "message"}${r.entries ? `, ${r.entries.length} route(s)` : ""}: ${p.src} → ${p.dst}${tag}`; }
  const http = p.proto === "tcp" && typeof p.tcp.data === "string" && /^(GET |HTTP\/1\.)/.test(p.tcp.data) ? ` (${p.tcp.data.split("\r\n")[0]})` : "";
  const l4 = p.proto === "icmp" ? `ICMP ${icmpName(p.icmp)}` : p.proto === "tcp" ? `TCP ${p.tcp.sport}→${p.tcp.dport} ${tcpName(p.tcp)}${p.tcp.len ? ` ${p.tcp.len} B` : ""}${p.tcp.win !== undefined ? `, window ${p.tcp.win} B${p.tcp.win === 0 ? " (full: the sender must wait)" : ""}` : ""}${http}`
    : `UDP ${p.udp.sport}→${p.udp.dport}${frameKind(f) === "dhcp" ? " (DHCP)" : frameKind(f) === "dns" ? " (DNS)" : ""}`;
  return `IPv4 ${p.src} → ${p.dst} ${l4}, TTL ${p.ttl}${tag}`;
}

/** Seconds the network needs to settle at rest: spanning tree (0 without STP), then OSPF, RIP and LLDP: blocking → listening → learning → forwarding, plus max age. */
export function convergeTime(spec) {
  let t = 0;
  for (const n of spec.nodes || []) if (n.kind === "switch" && n.stp) t = Math.max(t, 2 * (n.stp.forwardDelay ?? 15) + (n.stp.maxAge ?? 20) + 1);
  for (const n of spec.nodes || []) if (n.kind === "switch" && n.channels) t = Math.max(t, 6);   // LACP bundles the cables about 3 s after the switches start
  for (const n of spec.nodes || []) { if (n.ospf) t = Math.max(t, 50); if (n.rip || n.ripng) t = Math.max(t, 40); if (n.lldp) t = Math.max(t, 3); if (n.bgp) t = Math.max(t, 20); }   // adjacencies, first RIP updates, first LLDPDUs
  return t;
}

/**
 * ACL hit counts: the engine's Acl has no counters, so wrap each router's `check` (this instance only) and count
 * which rule decided each packet. Counts: node.aclHits = {"LIST:0": n, "LIST:deny": n}.
 */
export function countAclHits(net) {
  for (const n of net.nodes.values()) {
    if (!n.acl || n.acl._counted) continue;
    const check = n.acl.check.bind(n.acl); n.aclHits = {}; n.acl._counted = true;
    n.acl.check = (dir, ifname, p) => { const r = check(dir, ifname, p);
      if (r.list && r.rule !== null) { const k = `${r.list}:${r.rule === -1 ? "deny" : r.rule}`; n.aclHits[k] = (n.aclHits[k] || 0) + 1; }
      return r; };
  }
}

/** Plain copy of every device's tables (what the side panels show). */
export function snapshotDevices(net) {
  const out = {};
  for (const n of net.nodes.values()) {
    if (n.kind === "switch") {
      const mac = n.macTable().map(({vlan, mac: m, port, age, stale}) => ({vlan, mac: m, port, age, stale}));
      out[n.name] = {mac, stp: n.stp && n.stp.started ? n.stp.describe() : null, aging: {time: n.agingTime, hold: n.holdTime()},
        channels: [...n.channels.values()].map(c => c.describe()), snooping: n.dhcpSnoopingState ? n.dhcpSnoopingState() : null};
    } else {
      out[n.name] = {
        arp: [...n.arp].map(([ip, e]) => ({ip, mac: e.mac, iface: e.iface})),
        leases: n.dhcpLeases ? [...n.dhcpLeases].map(([mac, ip]) => ({mac, ip})) : [],
        ifaces: Object.values(n.ifaces).map(i => ({name: i.name, ip: i.ip ? `${i.ip}/${i.prefix}` : i.dhcp ? "dhcp (none yet)" : "", mac: i.mac})),
      };
      if (n.v6) out[n.name].v6 = {addrs: n.v6.addrs.map(a => ({iface: a.iface, ip: `${a.ip}/${a.prefix}`})), routes: n.v6.routes.map(r => ({dst: r.cidr, via: r.via})),
        neighbors: [...n.v6.cache].map(([ip, e]) => ({ip, mac: e.mac, iface: e.iface}))};
      if (n.bgp && n.bgp.started) out[n.name].bgp = {asn: n.bgp.asn, peers: n.bgp.neighbors(), table: n.bgp.describe()};
      if (n.ripng && n.ripng.started) out[n.name].ripng = n.ripng.describe();
      if (n.rip && n.rip.started) out[n.name].rip = n.rip.describe();
      if (n.ospf && n.ospf.started) out[n.name].ospf = {neighbors: n.ospf.neighbors(), interfaces: n.ospf.interfaces(), routes: n.ospf.describe(), areas: n.ospf.areas(), abr: n.ospf.isAbr()};
      const sv = n.services || {};
      if (sv.syslog || sv.ntp) out[n.name].services = {...(sv.syslog ? {syslog: [...(n.syslogLog || [])]} : {}), ...(sv.ntp ? {ntp: {stratum: sv.ntp, queries: (n.ntpLog || []).length}} : {})};
      if (n.vrrp) out[n.name].vrrp = n.vrrp.describe();
      if (n.nat) out[n.name].nat = n.nat.translations();
      if (n.aclHits) out[n.name].aclHits = {...n.aclHits};
    }
  }
  for (const n of net.nodes.values()) if (n.lldp && out[n.name]) out[n.name].lldp = n.lldp.neighbors();
  return out;
}

/** Routing table of an IP node: connected subnets, then static routes (the default route last). */
export function routingTable(node) {
  if (node.kind === "switch") return [];
  const rows = [];
  for (const i of Object.values(node.ifaces)) if (i.ip) rows.push({dst: `${intToIp(i.net)}/${i.prefix}`, via: "connected", iface: i.name});
  for (const r of node.routes) {
    const out = Object.values(node.ifaces).find(i => i.ip && inSubnet(r.via, i.net, i.mask));
    rows.push({dst: r.cidr, via: r.via, iface: out ? out.name : "?"});
  }
  return rows;
}

/** Port forwarding state of a switch: "blocked" (spec), STP state, or "forwarding". */
export function portStates(net) {
  const out = {};
  for (const n of net.nodes.values()) if (n.kind === "switch") for (const p of Object.keys(n.ifaces))
    out[`${n.name}:${p}`] = n.blocked.has(p) ? "blocked" : n.stp && n.stp.ports.get(p) ? n.stp.ports.get(p).state : "forwarding";
  return out;
}

function cutLinks(net, cut) {
  for (const id of cut || []) if (net.links[id]) net.links[id].up = false;   // before start: STP sees the carrier down
}

/**
 * The network at rest (spanning tree converged, no traffic): port states and storm math.
 * cut: link indexes (order of spec.links) that are unplugged.
 */
export function analyse(spec, {cut = []} = {}) {
  const net = loadSpec(spec); cutLinks(net, cut); countAclHits(net);
  const t = convergeTime(spec); net._start(); if (t) net.run(t);
  return {ports: portStates(net), storm: stormAnalysis(net), converged: t, devices: snapshotDevices(net)};
}

/**
 * Run the actions and record each frame. Returns
 * {actions: [{action, summary, result, first, last, frames}], steps: [...], truncated, routes, ports}.
 * A step: {i, action, t, arrive, link, from, fromIf, to, toIf, desc, kind, notes: [{t, node, event, detail}], state}.
 */
export function simulate(spec, actions, {cut = [], maxSteps = MAX_STEPS} = {}) {
  const net = loadSpec(spec); cutLinks(net, cut); countAclHits(net);
  const va = validateActions(actions, spec);
  if (!va.ok) throw new SpecError("actions", va.errors);
  const steps = []; let traceAt = 0, current = 0, truncated = false;
  const notes = () => { const n = net.trace.slice(traceAt); traceAt = net.trace.length; return n; };
  net.taps = new Set([(node, ifname, f) => {
    if (steps.length >= maxSteps) { truncated = true; return; }
    const i = node.ifaces[ifname], peer = i.peer;
    steps.push({i: steps.length, action: current, t: net.time, arrive: net.time + i.link.delay, link: i.link.id,
      from: node.name, fromIf: ifname, to: peer.node.name, toIf: peer.name, desc: describeFrame(f), kind: frameKind(f),
      vlan: f.vlan, notes: notes(), state: snapshotDevices(net)});   // tables as they are when the frame leaves
  }]);
  const out = [];
  for (let k = 0; k < actions.length; k++) {
    current = k; const a = actions[k];
    net.flushCaches(); notes();
    const first = steps.length, before = net.snapshot(), traceFrom = net.trace.length;
    const result = ACTIONS[a.do].run(net, a);
    net.settle(a.settle ?? 1);
    const tail = notes();
    const lost = net.trace.slice(traceFrom).filter(e => e.event === "netem-loss").length;   // frames a lossy cable dropped (they never reach the wire, so no step)
    out.push({action: a, result, summary: describeResult(a, result), first, last: steps.length - 1, frames: net.diff(before), tail, lost});
  }
  const routes = {}; for (const n of net.nodes.values()) routes[n.name] = routingTable(n);
  return {actions: out, steps, truncated, routes, final: snapshotDevices(net)};
}
