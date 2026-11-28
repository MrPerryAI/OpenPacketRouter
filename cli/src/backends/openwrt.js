// OpenWrt backend (renderer stub): interface addresses (IPv4 and IPv6) and static routes (IPv4 and IPv6) as UCI batch commands (`uci batch`).
// Switch VLANs (bridge-vlan sections), DHCP pools and the rest follow with their working proof (docs/cli-design.md).

import * as M from "../model.js";

const mask = p => { const n = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0; return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."); };
const sec = p => p.replace(/[^A-Za-z0-9_]/g, "_");

export function uciCommands(model, {ports = Object.keys(M.interfaces(model))} = {}) {
  const out = [];
  for (const p of ports) {
    const ifc = M.iface(model, p, false); if (!ifc) continue;
    const a = M.addressesOf(ifc)[0], dhcp = M.dhcpClientOf(ifc), a6 = M.addressesOf6(ifc);
    if (!a && !dhcp && !a6.length) continue;
    out.push(`set network.${sec(p)}=interface`, `set network.${sec(p)}.device='${p}'`);
    if (dhcp) out.push(`set network.${sec(p)}.proto='dhcp'`);
    else out.push(`set network.${sec(p)}.proto='static'`);
    if (a && !dhcp) out.push(`set network.${sec(p)}.ipaddr='${a.ip}'`, `set network.${sec(p)}.netmask='${mask(a.prefixLength)}'`);
    for (const x of a6) out.push(`add_list network.${sec(p)}.ip6addr='${x.ip}/${x.prefixLength}'`);   // UCI keeps the IPv6 addresses as a list
    if (ifc.config.enabled === false) out.push(`set network.${sec(p)}.disabled='1'`);
  }
  M.staticList(model).forEach((r, i) => {
    const [net, len] = r.prefix.split("/");
    out.push(`set network.route${i}=route`, `set network.route${i}.target='${net}'`, `set network.route${i}.netmask='${mask(+len)}'`, `set network.route${i}.gateway='${r.nextHop}'`);
  });
  M.staticList6(model).forEach((r, i) => {
    out.push(`set network.route6_${i}=route6`, `set network.route6_${i}.target='${r.prefix}'`, `set network.route6_${i}.gateway='${r.nextHop}'`);
  });
  // Switch VLANs: one bridge device, one bridge-vlan section per VLAN; a port is "name:u*" (untagged, the port VLAN) or "name:t" (tagged).
  const sw = ports.filter(p => { const i = M.iface(model, p, false); return i && M.switchedVlan(i, false)?.["interface-mode"]; });
  if (sw.length) {
    out.push("set network.br0=device", "set network.br0.name='br0'", "set network.br0.type='bridge'", ...sw.map(p => `add_list network.br0.ports='${p}'`));
    const byVlan = {};
    for (const p of sw) {
      const c = M.switchedVlan(M.iface(model, p, false), false);
      if (c["interface-mode"] === "ACCESS") (byVlan[c["access-vlan"] ?? 1] ||= []).push(`${p}:u*`);
      else {
        for (const v of c["trunk-vlans"]) if (v !== c["native-vlan"]) (byVlan[v] ||= []).push(`${p}:t`);
        if (c["native-vlan"] !== undefined) (byVlan[c["native-vlan"]] ||= []).push(`${p}:u*`);
      }
    }
    for (const [v, members] of Object.entries(byVlan)) out.push(`set network.vlan${v}=bridge-vlan`, `set network.vlan${v}.device='br0'`, `set network.vlan${v}.vlan='${v}'`, ...members.map(m => `add_list network.vlan${v}.ports='${m}'`));
  }
  out.push("commit network");
  return out;
}

export function openwrtBackend(source) {
  return {name: "openwrt", render: device => uciCommands(source.getConfig(device), {ports: source.ports(device)})};
}
