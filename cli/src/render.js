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
  if (sw && M.stpEnabled(model)) {
    out.push("spanning-tree");
    const g = M.stpGlobal(model);
    for (const [leaf, word] of STP_GLOBAL) if (g[leaf] !== undefined) out.push(`spanning-tree ${word} ${g[leaf]}`);
    out.push("!");
  }

  if (sw) {
    const vl = M.vlans(model), ids = Object.keys(vl).filter(i => vl[i].config?.name).sort((a, b) => a - b);
    for (const id of ids) out.push(`vlan ${id}`, ` name ${vl[id].config.name}`, "!");
  }

  const names = [...new Set([...ports, ...Object.keys(M.interfaces(model))])];
  for (const name of names) {
    const ifc = M.iface(model, name, false);
    out.push(`interface ${name}`);
    if (ifc) {
      if (ifc.config.description) out.push(` description ${ifc.config.description}`);
      for (const a of M.addressesOf(ifc)) out.push(` ip address ${a.ip}/${a.prefixLength}`);
      if (M.dhcpClientOf(ifc)) out.push(" ip address dhcp");
      for (const h of M.relayHelpers(model, name, false)) out.push(` ip helper-address ${h}`);
      const sv = M.switchedVlan(ifc, false);
      if (sv && sv["interface-mode"] === "ACCESS") {
        out.push(" switchport mode access");
        if (sv["access-vlan"] !== 1) out.push(` switchport access vlan ${sv["access-vlan"]}`);
      } else if (sv && sv["interface-mode"] === "TRUNK") {
        out.push(" switchport mode trunk", ` switchport trunk allowed vlan ${formatVlanList(sv["trunk-vlans"])}`);
        if (sv["native-vlan"] !== undefined) out.push(` switchport trunk native vlan ${sv["native-vlan"]}`);
      }
      const sp = M.stpPort(model, name, false);
      if (sp && sp.cost !== undefined) out.push(` spanning-tree cost ${sp.cost}`);
      if (sp && sp["port-priority"] !== undefined) out.push(` spanning-tree port-priority ${sp["port-priority"]}`);
      const sh = ifc["openpacketrouter:shaper"];
      if (sh) out.push(` shape rate ${sh.rate} burst ${sh.burst} limit ${sh.limit}`);
      if (ifc.config.enabled === false) out.push(" shutdown");
    }
    out.push("!");
  }

  const routes = M.staticList(model);
  for (const r of routes) out.push(`ip route ${r.prefix} ${r.nextHop}`);
  if (routes.length) out.push("!");

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
  if (s.rip) {
    out.push("router rip", " version 2");
    for (const n of s.rip.networks) out.push(` network ${n}`);
    for (const i of s.rip.passive || []) out.push(` passive-interface ${i}`);
    const t = s.rip.timers; if (t) out.push(` timers basic ${t.update} ${t.timeout} ${t.garbage}`);
    if (s.rip.splitHorizon) out.push(s.rip.splitHorizon === "off" ? " no split-horizon" : " split-horizon poisoned-reverse");
    if (s.rip.triggered === false) out.push(" no triggered-updates");
    out.push("!");
  }
  if (s.tcp) { for (const [port, app] of Object.entries(s.tcp)) if (app === "echo") out.push(`service tcp-echo ${port}`); out.push("!"); }
  out.push("end");
  return out;
}

export const runningConfig = (model, opts) => configLines(model, opts).join("\n");
