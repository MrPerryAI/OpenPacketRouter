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

/** Short kind used for colors: arp, icmp, tcp, udp, dhcp, dns, bpdu, lacp. */
export function frameKind(f) {
  if (f.type === "bpdu") return "bpdu";
  if (f.type === "lacpdu") return "lacp";
  if (f.type === "arp") return "arp";
  const p = f.ip;
  if (p.proto === "udp") { const ports = [p.udp.sport, p.udp.dport]; return ports.includes(67) || ports.includes(68) ? "dhcp" : ports.includes(53) ? "dns" : "udp"; }
  return p.proto;
}

/** One line for a frame, in the engine's trace wording. */
export function describeFrame(f) {
  const tag = f.vlan !== undefined ? ` [VLAN ${f.vlan}]` : "";
  if (f.type === "bpdu") return f.bpdu.tcn ? `STP topology change notice${tag}` : `STP BPDU: root ${f.bpdu.root[1]}, cost ${f.bpdu.cost}${f.bpdu.tc ? ", topology change" : ""}${f.bpdu.tca ? ", change acknowledged" : ""}${tag}`;
  if (f.type === "lacpdu") return `LACPDU: port ${f.lacpdu.actor.port} state 0x${f.lacpdu.actor.state.toString(16)}, partner state 0x${f.lacpdu.partner.state.toString(16)}${tag}`;
  if (f.type === "arp") return (f.arp.op === "request" ? `ARP: who has ${f.arp.tpa}? tell ${f.arp.spa}` : `ARP: ${f.arp.spa} is at ${f.arp.sha}`) + tag;
  const p = f.ip;
  const l4 = p.proto === "icmp" ? `ICMP ${icmpName(p.icmp)}` : p.proto === "tcp" ? `TCP ${p.tcp.sport}→${p.tcp.dport} ${tcpName(p.tcp)}${p.tcp.len ? ` ${p.tcp.len} B` : ""}`
    : `UDP ${p.udp.sport}→${p.udp.dport}${frameKind(f) === "dhcp" ? " (DHCP)" : frameKind(f) === "dns" ? " (DNS)" : ""}`;
  return `IPv4 ${p.src} → ${p.dst} ${l4}, TTL ${p.ttl}${tag}`;
}

/** Seconds spanning tree needs to settle (0 without STP): blocking → listening → learning → forwarding, plus max age. */
export function convergeTime(spec) {
  let t = 0;
  for (const n of spec.nodes || []) if (n.kind === "switch" && n.stp) t = Math.max(t, 2 * (n.stp.forwardDelay ?? 15) + (n.stp.maxAge ?? 20) + 1);
  for (const n of spec.nodes || []) if (n.kind === "switch" && n.channels) t = Math.max(t, 6);   // LACP bundles the cables about 3 s after the switches start
  return t;
}

/** Plain copy of every device's tables (what the side panels show). */
export function snapshotDevices(net) {
  const out = {};
  for (const n of net.nodes.values()) {
    if (n.kind === "switch") {
      const mac = n.macTable().map(({vlan, mac: m, port}) => ({vlan, mac: m, port}));
      out[n.name] = {mac, stp: n.stp && n.stp.started ? n.stp.describe() : null};
    } else {
      out[n.name] = {
        arp: [...n.arp].map(([ip, e]) => ({ip, mac: e.mac, iface: e.iface})),
        leases: n.dhcpLeases ? [...n.dhcpLeases].map(([mac, ip]) => ({mac, ip})) : [],
        ifaces: Object.values(n.ifaces).map(i => ({name: i.name, ip: i.ip ? `${i.ip}/${i.prefix}` : i.dhcp ? "dhcp (none yet)" : "", mac: i.mac})),
      };
    }
  }
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
  const net = loadSpec(spec); cutLinks(net, cut);
  const t = convergeTime(spec); net._start(); if (t) net.run(t);
  return {ports: portStates(net), storm: stormAnalysis(net), converged: t, devices: snapshotDevices(net)};
}

/**
 * Run the actions and record each frame. Returns
 * {actions: [{action, summary, result, first, last, frames}], steps: [...], truncated, routes, ports}.
 * A step: {i, action, t, arrive, link, from, fromIf, to, toIf, desc, kind, notes: [{t, node, event, detail}], state}.
 */
export function simulate(spec, actions, {cut = [], maxSteps = MAX_STEPS} = {}) {
  const net = loadSpec(spec); cutLinks(net, cut);
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
    const first = steps.length, before = net.snapshot();
    const result = ACTIONS[a.do].run(net, a);
    net.settle(a.settle ?? 1);
    const tail = notes();
    out.push({action: a, result, summary: describeResult(a, result), first, last: steps.length - 1, frames: net.diff(before), tail});
  }
  const routes = {}; for (const n of net.nodes.values()) routes[n.name] = routingTable(n);
  return {actions: out, steps, truncated, routes, final: snapshotDevices(net)};
}
