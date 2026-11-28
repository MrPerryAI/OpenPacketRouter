// FRRouting backend (renderer stub): the routing part of a model as frr.conf text, for `vtysh -f`.
// Today: interface addresses and static routes. RIP and OSPF are added with their commands (see docs/cli-design.md).
// Written from the model; no FRRouting code or text is used.

import * as M from "../model.js";

const netOf = (ip, len) => { const n = ip.split(".").reduce((a, o) => a * 256 + +o, 0), size = 2 ** (32 - len), b = Math.floor(n / size) * size;
  return [24, 16, 8, 0].map(s => Math.floor(b / 2 ** s) % 256).join("."); };
function ospfIfLines(oi) {
  if (!oi) return [];
  const c = oi.config, t = oi.timers.config, l = [];
  if (c["network-type"]) l.push(` ip ospf network ${c["network-type"] === "POINT_TO_POINT_NETWORK" ? "point-to-point" : "broadcast"}`);
  if (c.metric !== undefined) l.push(` ip ospf cost ${c.metric}`);
  if (c.priority !== undefined) l.push(` ip ospf priority ${c.priority}`);
  if (t["hello-interval"] !== undefined) l.push(` ip ospf hello-interval ${t["hello-interval"]}`);
  if (t["dead-interval"] !== undefined) l.push(` ip ospf dead-interval ${t["dead-interval"]}`);
  if (t["retransmission-interval"] !== undefined) l.push(` ip ospf retransmit-interval ${t["retransmission-interval"]}`);
  return l;
}

const RIPNG_SPLIT = {simple: " ipv6 ripng split-horizon", poisoned: " ipv6 ripng split-horizon poisoned-reverse", off: " no ipv6 ripng split-horizon"};
const RIP_SPLIT = {simple: " ip rip split-horizon", poisoned: " ip rip split-horizon poisoned-reverse", off: " no ip rip split-horizon"};

export function frrConfig(model, {ports = Object.keys(M.interfaces(model))} = {}) {
  const out = [`hostname ${M.hostname(model)}`, "!"];
  const rip = M.services(model).rip, ripng = M.services(model).ripng, bgp = M.services(model).bgp;
  for (const p of ports) {
    const ifc = M.iface(model, p, false); if (!ifc) continue;
    const addrs = M.addressesOf(ifc), addrs6 = M.addressesOf6(ifc);
    const oi = M.ospfIf(model, p, false);
    if (!addrs.length && !addrs6.length && ifc.config.enabled !== false && !oi) continue;
    out.push(`interface ${p}`, ...addrs.map(a => ` ip address ${a.ip}/${a.prefixLength}`), ...addrs6.map(a => ` ipv6 address ${a.ip}/${a.prefixLength}`), ...(ifc.config.enabled === false ? [" shutdown"] : []), ...ospfIfLines(oi), ...(rip && rip.splitHorizon && RIP_SPLIT[rip.splitHorizon] ? [RIP_SPLIT[rip.splitHorizon]] : []), ...(ripng && addrs6.length && ripng.splitHorizon && RIPNG_SPLIT[ripng.splitHorizon] ? [RIPNG_SPLIT[ripng.splitHorizon]] : []), "exit", "!");
  }
  for (const r of M.staticList(model)) out.push(`ip route ${r.prefix} ${r.nextHop}`);
  for (const r of M.staticList6(model)) out.push(`ipv6 route ${r.prefix} ${r.nextHop}`);
  const og = M.ospf(model);
  if (og && og["openpacketrouter:networks"].length) {
    out.push("router ospf");
    if (og.global.config["router-id"]) out.push(` ospf router-id ${og.global.config["router-id"]}`);
    for (const e of og["openpacketrouter:networks"]) {
      const x = typeof e === "object" ? e.network : e, area = typeof e === "object" ? e.area : "0";
      if (x.includes("/")) { out.push(` network ${x} area ${area}`); continue; }       // an interface name: its own network
      const ifc = M.iface(model, x, false);
      for (const a of ifc ? M.addressesOf(ifc) : []) out.push(` network ${netOf(a.ip, a.prefixLength)}/${a.prefixLength} area ${area}`);
    }
    for (const [p, e] of Object.entries(og.areas.area["0"].interfaces.interface)) if (e.config.passive) out.push(` passive-interface ${p}`);
    for (const r of og["openpacketrouter:redistribute"] || []) out.push(` redistribute ${r.source} metric ${r.metric ?? 20} metric-type ${r.metricType ?? 2}`);   // ospfd's own defaults, written out
    out.push("exit");
  }
  if (rip) {   // `triggered: false` is a teaching switch of the engine; ripd has no such setting, so it is not rendered
    out.push("router rip", " version 2");
    if (rip.timers) out.push(` timers basic ${rip.timers.update} ${rip.timers.timeout} ${rip.timers.garbage}`);
    for (const n of rip.networks) out.push(` network ${n}`);
    for (const i of rip.passive || []) out.push(` passive-interface ${i}`);
    out.push("exit");
  }
  if (ripng) {   // `triggered: false` is a teaching switch of the engine; ripngd has no such setting, so it is not rendered
    out.push("router ripng");
    if (ripng.timers) out.push(` timers basic ${ripng.timers.update} ${ripng.timers.timeout} ${ripng.timers.garbage}`);
    for (const n of ripng.networks) out.push(` network ${n}`);
    for (const i of ripng.passive || []) out.push(` passive-interface ${i}`);
    out.push("exit");
  }
  if (bgp) {   // neighbor ... local-preference is a short form of an inbound route-map that sets it
    const t = bgp.timers || {};
    out.push(`router bgp ${bgp.asn}`);
    if (bgp.routerId) out.push(` bgp router-id ${bgp.routerId}`);
    out.push(" no bgp ebgp-requires-policy");
    if (t.keepalive !== undefined) out.push(` timers bgp ${t.keepalive} ${t.hold}`);
    for (const x of bgp.neighbors) {
      out.push(` neighbor ${x.ip} remote-as ${x.remoteAs}`);
      if (t.connect !== undefined) out.push(` neighbor ${x.ip} timers connect ${t.connect}`);
    }
    out.push(" address-family ipv4 unicast");
    for (const n of bgp.networks) out.push(`  network ${n}`);
    for (const x of bgp.neighbors) {
      if (x.nextHopSelf) out.push(`  neighbor ${x.ip} next-hop-self`);
      if (x.localPref !== undefined) out.push(`  neighbor ${x.ip} route-map LP${x.localPref} in`);
    }
    out.push(" exit-address-family", "exit");
    for (const v of [...new Set(bgp.neighbors.filter(x => x.localPref !== undefined).map(x => x.localPref))].sort((a, b) => a - b)) out.push(`route-map LP${v} permit 10`, ` set local-preference ${v}`, "exit");
  }
  out.push("!", "end");
  return out.join("\n");
}

export function frrBackend(source) {
  return {name: "frr", render: device => frrConfig(source.getConfig(device), {ports: source.ports(device)})};
}
