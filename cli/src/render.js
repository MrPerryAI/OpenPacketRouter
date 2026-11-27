// show running-config: the commands that rebuild the model when replayed in configuration mode.
// cli/test/roundtrip.test.js replays this for every device of every spec in the repository.

import * as M from "./model.js";
import {formatVlanList} from "./types.js";

const STP_GLOBAL = [["bridge-priority", "priority"], ["hello-time", "hello-time"], ["max-age", "max-age"],
  ["forwarding-delay", "forward-time"], ["openpacketrouter:bridge-address", "bridge-address"]];

/** Lines of configuration (no "!" separators); `ports` lists every interface to print, in order. */
export function configLines(model, {kind, ports}) {
  const out = [`hostname ${M.hostname(model)}`, "!"];
  const sw = kind === "switch";

  if (sw && M.fdb(model)["mac-aging-time"] !== undefined) out.push(`mac address-table aging-time ${M.fdb(model)["mac-aging-time"]}`, "!");
  if (sw && M.services(model).forwardLldp) out.push("lldp forward", "!");
  if (sw) for (const [n, s] of Object.entries(M.monitor(model, false))) {
    if (s.destination) out.push(`monitor session ${n} destination interface ${s.destination}`);
    for (const [p, d] of Object.entries(s.sources)) out.push(`monitor session ${n} source interface ${p} ${d}`);
    out.push("!");
  }
  if (sw && M.services(model).dhcpSnooping) out.push("ip dhcp snooping", "!");
  if (sw && M.stpEnabled(model)) {
    out.push("spanning-tree");
    const g = M.stpGlobal(model);
    if (g["enabled-protocol"][0] === "RSTP") out.push("spanning-tree mode rstp");
    for (const [leaf, word] of STP_GLOBAL) if (g[leaf] !== undefined) out.push(`spanning-tree ${word} ${g[leaf]}`);
    out.push("!");
  }

  if (sw) {
    const vl = M.vlans(model), ids = Object.keys(vl).filter(i => vl[i].config?.name).sort((a, b) => a - b);
    for (const id of ids) out.push(`vlan ${id}`, ` name ${vl[id].config.name}`, "!");
  }

  // access lists come before the interfaces that apply them, so replaying the text finds each list
  const acls = M.services(model).acl;
  if (acls) for (const [name, rules] of Object.entries(acls.lists)) out.push(`ip access-list ${name}`, ...rules.map(r => ` ${ruleText(r)}`), "!");
  const og = M.ospf(model);
  // Networks and passive interfaces that name an interface come after the interface blocks: replaying the text, the
  // interface must have its address before the router process can refer to it.
  const ospfNets = og ? og["openpacketrouter:networks"].map(e => typeof e === "object" ? e : {network: e}) : [];
  const ospfLate = [], lateNets = ospfNets.some(e => !/^\d/.test(e.network));   // all networks stay together, so their order survives
  if (og) {
    out.push("router ospf");
    if (og.global.config["router-id"]) out.push(` router-id ${og.global.config["router-id"]}`);
    for (const e of ospfNets) {
      const text = ` network ${/^\d/.test(e.network) ? "" : "interface "}${e.network}${e.area !== undefined ? ` area ${e.area}` : ""}`;
      (lateNets ? ospfLate : out).push(text);
    }
    for (const r of og["openpacketrouter:redistribute"] || []) out.push(` redistribute ${r.source}${r.metric !== undefined ? ` metric ${r.metric}` : ""}${r.metricType !== undefined ? ` metric-type ${r.metricType}` : ""}`);
    for (const [p, e] of Object.entries(og.areas.area["0"].interfaces.interface)) if (e.config.passive) (lateNets ? ospfLate : out).push(` passive-interface ${p}`);
    out.push("!");
  }

  const nat = M.services(model).nat;
  if (nat) {
    if (nat.overload) out.push(`ip nat inside source overload${nat.overload.src ? " " + nat.overload.src : ""}`);
    for (const s of nat.static || []) out.push(`ip nat inside source static ${s.proto ? `${s.proto} ${s.inside} ${s.insidePort} ${s.outside} ${s.outsidePort}` : `${s.inside} ${s.outside}`}`);
    out.push("!");
  }

  const names = [...new Set([...ports, ...Object.keys(M.interfaces(model))])];
  for (const name of names) {
    const ifc = M.iface(model, name, false);
    out.push(`interface ${name}`);
    if (ifc) {
      if (ifc.config.description) out.push(` description ${ifc.config.description}`);
      for (const a of M.addressesOf(ifc)) out.push(` ip address ${a.ip}/${a.prefixLength}`);
      if (M.dhcpClientOf(ifc)) out.push(" ip address dhcp");
      for (const a of M.addressesOf6(ifc)) out.push(` ipv6 address ${a.ip}/${a.prefixLength}`);
      for (const h of M.relayHelpers(model, name, false)) out.push(` ip helper-address ${h}`);
      if (M.lagOf(ifc)) out.push(` channel-group ${M.lagOf(ifc).slice(2)} mode active`);
      if (M.lacpInterval(model, name, false)?.interval === "FAST") out.push(" lacp rate fast");
      if (ifc["openpacketrouter:dhcp-snooping-trust"]) out.push(" ip dhcp snooping trust");
      const sv = M.switchedVlan(ifc, false);
      if (sv && sv["interface-mode"] === "ACCESS") {
        out.push(" switchport mode access");
        if (sv["access-vlan"] !== 1) out.push(` switchport access vlan ${sv["access-vlan"]}`);
      } else if (sv && sv["interface-mode"] === "TRUNK") {
        out.push(" switchport mode trunk", ` switchport trunk allowed vlan ${formatVlanList(sv["trunk-vlans"])}`);
        if (sv["native-vlan"] !== undefined) out.push(` switchport trunk native vlan ${sv["native-vlan"]}`);
      }
      const ps = ifc["openpacketrouter:port-security"];
      if (ps) { out.push(` switchport port-security maximum ${ps.max}`); if (ps.violation) out.push(` switchport port-security violation ${ps.violation}`); }
      const sc = ifc["openpacketrouter:storm-control"]?.broadcast;
      if (sc) out.push(` storm-control broadcast rate ${sc.rate} burst ${sc.burst}`);
      const sp = M.stpPort(model, name, false);
      if (sp && sp.cost !== undefined) out.push(` spanning-tree cost ${sp.cost}`);
      if (sp && sp["port-priority"] !== undefined) out.push(` spanning-tree port-priority ${sp["port-priority"]}`);
      if (sp && sp["edge-port"] === "EDGE_ENABLE") out.push(" spanning-tree portfast");
      if (ifc["openpacketrouter:nat"]) out.push(` ip nat ${ifc["openpacketrouter:nat"]}`);
      for (const d of ["in", "out"]) if (ifc["openpacketrouter:acl"]?.[d]) out.push(` ip access-group ${ifc["openpacketrouter:acl"][d]} ${d}`);
      for (const g of (M.services(model).vrrp || []).filter(x => x.iface === name)) {
        if (g.ip) out.push(` vrrp ${g.vrid} address ${g.ip}`);
        if (g.priority !== undefined) out.push(` vrrp ${g.vrid} priority ${g.priority}`);
        if (g.interval !== undefined) out.push(` vrrp ${g.vrid} interval ${g.interval}`);
        if (g.preempt === false) out.push(` no vrrp ${g.vrid} preempt`);
        if (g.virtualMac) out.push(` vrrp ${g.vrid} virtual-mac`);
      }
      const oi = M.ospfIf(model, name, false);
      if (oi) {
        const c = oi.config, t = oi.timers.config;
        if (c["network-type"]) out.push(` ospf network ${c["network-type"] === "POINT_TO_POINT_NETWORK" ? "point-to-point" : "broadcast"}`);
        if (c.metric !== undefined) out.push(` ospf cost ${c.metric}`);
        if (c.priority !== undefined) out.push(` ospf priority ${c.priority}`);
        if (t["hello-interval"] !== undefined) out.push(` ospf hello-interval ${t["hello-interval"]}`);
        if (t["dead-interval"] !== undefined) out.push(` ospf dead-interval ${t["dead-interval"]}`);
        if (t["retransmission-interval"] !== undefined) out.push(` ospf retransmit-interval ${t["retransmission-interval"]}`);
      }
      const sh = ifc["openpacketrouter:shaper"];
      if (sh) out.push(` shape rate ${sh.rate} burst ${sh.burst} limit ${sh.limit}`);
      if (ifc["openpacketrouter:delay"] !== undefined) out.push(` delay ${ifc["openpacketrouter:delay"]}`);
      const ls = ifc["openpacketrouter:loss"];
      if (ls) out.push(` loss pattern ${ls.toBad} ${ls.toGood} ${ls.inBad} ${ls.inGood}`);
      if (ifc.config.enabled === false) out.push(" shutdown");
    }
    out.push("!");
  }

  if (ospfLate.length) out.push("router ospf", ...ospfLate, "!");

  const routes = M.staticList(model);
  for (const r of routes) out.push(`ip route ${r.prefix} ${r.nextHop}`);
  if (routes.length) out.push("!");
  const routes6 = M.staticList6(model);
  for (const r of routes6) out.push(`ipv6 route ${r.prefix} ${r.nextHop}`);
  if (routes6.length) out.push("!");

  const s = M.services(model);
  if (s.dns) {
    if (s.dns.enabled) out.push("ip dns server");
    for (const [name, ip] of Object.entries(s.dns.hosts)) out.push(`ip host ${name} ${ip}`);
    out.push("!");
  }
  if (s["dhcp-server"]) for (const [name, p] of Object.entries(s["dhcp-server"].pools)) {
    out.push(`ip dhcp pool ${name}`);
    if (p.range) out.push(` range ${p.range[0]} ${p.range[1]}`);
    if (p.netmask) out.push(` netmask ${p.netmask}`);
    if (p["default-router"]) out.push(` default-router ${p["default-router"]}`);
    if (p["dns-server"]) out.push(` dns-server ${p["dns-server"]}`);
    if (p.lease !== undefined) out.push(` lease ${p.lease}`);
    out.push("!");
  }
  if (s.ripng) {
    out.push("router ripng");
    for (const n of s.ripng.networks) out.push(` network ${n}`);
    for (const i of s.ripng.passive || []) out.push(` passive-interface ${i}`);
    const t = s.ripng.timers; if (t) out.push(` timers basic ${t.update} ${t.timeout} ${t.garbage}`);
    if (s.ripng.splitHorizon) out.push(s.ripng.splitHorizon === "off" ? " no split-horizon" : " split-horizon poisoned-reverse");
    if (s.ripng.triggered === false) out.push(" no triggered-updates");
    out.push("!");
  }
  if (s.rip) {
    out.push("router rip", " version 2");
    for (const n of s.rip.networks) out.push(` network ${n}`);
    for (const i of s.rip.passive || []) out.push(` passive-interface ${i}`);
    const t = s.rip.timers; if (t) out.push(` timers basic ${t.update} ${t.timeout} ${t.garbage}`);
    if (s.rip.splitHorizon) out.push(s.rip.splitHorizon === "off" ? " no split-horizon" : " split-horizon poisoned-reverse");
    if (s.rip.triggered === false) out.push(" no triggered-updates");
    out.push("!");
  }
  if (s.lldp) {
    out.push("lldp run");
    if (s.lldp.txInterval !== undefined) out.push(`lldp timer ${s.lldp.txInterval}`);
    if (s.lldp.holdMultiplier !== undefined) out.push(`lldp hold-multiplier ${s.lldp.holdMultiplier}`);
    if (typeof s.lldp.description === "string" && /^[A-Za-z][\w.-]*$/.test(s.lldp.description)) out.push(`lldp description ${s.lldp.description}`);
    out.push("!");
  }
  if (s.tcp) { for (const [port, app] of Object.entries(s.tcp)) if (["echo", "discard", "http", "slow"].includes(app)) out.push(`service tcp-${app} ${port}`); for (const [path, text] of Object.entries(s.http || {})) out.push(`http page ${path} ${encodeURIComponent(text)}`); out.push("!"); }
  if (s.ntp) out.push(`service ntp ${s.ntp}`, "!");
  if (s.syslog) out.push("service syslog", "!");
  out.push("end");
  return out;
}

/** One access-list rule as a command: "permit tcp 10.1.0.0/24 10.2.0.10:80 established". */
export function ruleText(r) {
  const end = (a, p) => `${a ?? "any"}${p !== undefined ? ":" + p : ""}`;
  return [r.action, r.proto || "ip", end(r.src, r.sport), end(r.dst, r.dport), ...(r.icmpType !== undefined ? ["type", r.icmpType] : []), ...(r.established ? ["established"] : [])].join(" ");
}

export const runningConfig = (model, opts) => configLines(model, opts).join("\n");
