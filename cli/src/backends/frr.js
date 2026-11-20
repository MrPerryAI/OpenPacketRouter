// FRRouting backend (renderer stub): the routing part of a model as frr.conf text, for `vtysh -f`.
// Today: interface addresses and static routes. RIP and OSPF are added with their commands (see docs/cli-design.md).
// Written from the model; no FRRouting code or text is used.

import * as M from "../model.js";

export function frrConfig(model, {ports = Object.keys(M.interfaces(model))} = {}) {
  const out = [`hostname ${M.hostname(model)}`, "!"];
  for (const p of ports) {
    const ifc = M.iface(model, p, false); if (!ifc) continue;
    const addrs = M.addressesOf(ifc);
    if (!addrs.length && ifc.config.enabled !== false) continue;
    out.push(`interface ${p}`, ...addrs.map(a => ` ip address ${a.ip}/${a.prefixLength}`), ...(ifc.config.enabled === false ? [" shutdown"] : []), "exit", "!");
  }
  for (const r of M.staticList(model)) out.push(`ip route ${r.prefix} ${r.nextHop}`);
  out.push("!", "end");
  return out.join("\n");
}

export function frrBackend(source) {
  return {name: "frr", render: device => frrConfig(source.getConfig(device), {ports: source.ports(device)})};
}
