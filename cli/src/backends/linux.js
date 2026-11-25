// Linux backend (renderer): the shell commands that build a device's configuration on a Linux box with iproute2,
// the kernel bridge, tc and dnsmasq. These are the same commands the validators in validate/ use, so a device
// rendered here behaves like the network those validators check against the engine.
//
//   linuxCommands(model, {kind, ports, labParity}) -> ["ip link add br0 type bridge stp_state 1 ...", ...]
//
// labParity: true adds what the validators set so the kernel sends exactly the frames the engine models: IPv6 off
// (no neighbour discovery or router solicitations), ICMP redirects off, ICMP rate limiting off, reverse-path
// filtering off. Without it the device is configured the same, but its frame counts can differ from the engine's.
//
// Assumes the interfaces already exist (cabled: veth pairs, or real ports) under the names in the model. A switch
// becomes one bridge, br0. Reading a configuration back from Linux is not done yet (see docs/cli-design.md).

import * as M from "../model.js";

const centis = s => String(Math.round(s * 100));

export function linuxCommands(model, {kind, ports = Object.keys(M.interfaces(model)), labParity = false} = {}) {
  ports = [...ports];
  const out = [];
  const ifs = M.interfaces(model);
  // VLAN subinterfaces (eth0.10) and SVIs (vlan10) are created by the commands below; their sysctls follow the creation.
  const logical = p => /^(.+)\.(\d+)$/.test(p) || (kind === "switch" && /^vlan\d+$/.test(p));
  const parity = p => { const d = p.replace(/\./g, "/"); return [`sysctl -w net.ipv6.conf.${d}.disable_ipv6=1`, `sysctl -w net.ipv4.conf.${d}.send_redirects=0`, `sysctl -w net.ipv4.conf.${d}.rp_filter=0`]; };
  if (labParity) {
    out.push("sysctl -w net.ipv6.conf.all.disable_ipv6=1", "sysctl -w net.ipv6.conf.default.disable_ipv6=1",
      "sysctl -w net.ipv4.conf.all.send_redirects=0", "sysctl -w net.ipv4.conf.default.send_redirects=0", "sysctl -w net.ipv4.icmp_ratelimit=0",
      "sysctl -w net.ipv4.conf.all.rp_filter=0", "sysctl -w net.ipv4.conf.default.rp_filter=0");
    for (const p of ports) if (!logical(p)) out.push(...parity(p));
  }
  const isSvi = p => /^vlan\d+$/.test(p);
  if (kind === "switch") {
    const svis = ports.filter(isSvi); ports = ports.filter(p => !isSvi(p));
    const g = M.stpGlobal(model), stp = M.stpEnabled(model);
    const vlanAware = ports.some(p => ifs[p] && M.switchedVlan(ifs[p], false)?.["interface-mode"]);
    const rstp = stp && g["enabled-protocol"][0] === "RSTP";   // Linux hands RSTP to the userspace daemon mstpd (stp_state 2, in the initial network namespace)
    const br = ["ip link add br0 type bridge", `stp_state ${rstp ? 2 : stp ? 1 : 0}`];
    if (stp && !rstp) br.push(`priority ${g["bridge-priority"] ?? 32768}`, `hello_time ${centis(g["hello-time"] ?? 2)}`,
      `max_age ${centis(g["max-age"] ?? 20)}`, `forward_delay ${centis(g["forwarding-delay"] ?? 15)}`);
    if (M.fdb(model)["mac-aging-time"] !== undefined) br.push(`ageing_time ${centis(M.fdb(model)["mac-aging-time"])}`);
    if (M.services(model).forwardLldp) br.push("group_fwd_mask 0x4000");   // let 01:80:c2:00:00:0e through the bridge
    if (vlanAware) br.push("vlan_filtering 1");
    out.push(br.join(" "));
    if (stp && g["openpacketrouter:bridge-address"]) out.push(`ip link set br0 address ${g["openpacketrouter:bridge-address"]}`);
    out.push("ip link set br0 up");
    if (rstp) out.push("mstpctl setforcevers br0 rstp", `mstpctl settreeprio br0 0 ${(g["bridge-priority"] ?? 32768) >> 12}`, `mstpctl sethello br0 ${g["hello-time"] ?? 2}`,
      `mstpctl setmaxage br0 ${g["max-age"] ?? 20}`, `mstpctl setfdelay br0 ${g["forwarding-delay"] ?? 15}`);
    // port-channels: a bond in 802.3ad mode is the bridge port; its member cables are enslaved to it (their MAC becomes the bond's)
    const bonds = [...new Set(ports.map(p => ifs[p] && M.lagOf(ifs[p])).filter(Boolean))];
    for (const b of bonds) {
      out.push(`ip link add ${b} type bond mode 802.3ad lacp_rate ${M.lacpInterval(model, b, false)?.interval === "FAST" ? "fast" : "slow"} xmit_hash_policy layer2 miimon 100`, `ip link set ${b} master br0`, `ip link set ${b} up`);
      if (labParity) out.push(...parity(b));
    }
    const monDest = new Set(Object.values(M.monitor(model, false)).map(x => x.destination).filter(Boolean));
    const hooks = new Set();
    for (const p of [...ports.filter(p => !(ifs[p] && M.lagOf(ifs[p]))), ...bonds]) {   // bridge ports: plain ports and channels
      const ifc = ifs[p];
      if (!bonds.includes(p) && !monDest.has(p)) out.push(`ip link set ${p} master br0`);   // a monitor destination leaves the bridge
      const sp = M.stpPort(model, p, false);
      // Always set the cost: the engine's default is 19 (802.1D, 100 Mbit/s), the kernel's depends on the link speed.
      // The kernel's port priority is 6 bits shifted by 10 in the port ID, the model's 8 bits shifted by 8: 128 -> 32.
      if (rstp) out.push(`mstpctl setportpathcost br0 ${p} ${sp?.cost ?? 20000}`, ...(sp?.["port-priority"] !== undefined ? [`mstpctl settreeportprio br0 ${p} 0 ${sp["port-priority"] >> 4}`] : []),
        ...(sp?.["edge-port"] === "EDGE_ENABLE" ? [`mstpctl setportadminedge br0 ${p} yes`] : []));
      else if (stp) out.push(`ip link set ${p} type bridge_slave cost ${sp?.cost ?? 19}${sp?.["port-priority"] !== undefined ? ` priority ${sp["port-priority"] >> 2}` : ""}`);
      const sv = ifc && M.switchedVlan(ifc, false);
      if (vlanAware) {
        const mode = sv?.["interface-mode"] || "ACCESS";
        out.push(`bridge vlan del dev ${p} vid 1`);
        if (mode === "ACCESS") out.push(`bridge vlan add dev ${p} vid ${sv?.["access-vlan"] ?? 1} pvid untagged`);
        else {
          for (const v of sv["trunk-vlans"]) out.push(`bridge vlan add dev ${p} vid ${v}`);
          if (sv["native-vlan"] !== undefined) out.push(`bridge vlan add dev ${p} vid ${sv["native-vlan"]} pvid untagged`);
        }
      }
      pushShaper(out, p, ifc);
      if (!bonds.includes(p)) out.push(`ip link set ${p} ${ifc && ifc.config.enabled === false ? "down" : "up"}`);
    }
    // port mirroring: a clsact qdisc on each source port, a matchall filter per direction with `mirred egress mirror` to the destination
    for (const s of Object.values(M.monitor(model, false))) for (const [p, d] of Object.entries(s.sources)) {
      if (!hooks.has(p)) { out.push(`tc qdisc add dev ${p} clsact`); hooks.add(p); }
      for (const h of {rx: ["ingress"], tx: ["egress"], both: ["ingress", "egress"]}[d])
        out.push(`tc filter add dev ${p} ${h} matchall action mirred egress mirror dev ${s.destination}`);
    }
    for (const p of ports) if (ifs[p] && M.lagOf(ifs[p])) out.push(`ip link set ${p} master ${M.lagOf(ifs[p])}`, `ip link set ${p} up`);
    // Layer 3 switch: each SVI is a VLAN device on the bridge itself (the bridge must carry that VLAN "self").
    if (svis.length) out.push("sysctl -w net.ipv4.ip_forward=1");
    for (const p of svis) {
      const v = p.slice(4), ifc = ifs[p];
      out.push(`bridge vlan add dev br0 vid ${v} self`, `ip link add link br0 name ${p} type vlan id ${v}`);
      for (const a of M.addressesOf(ifc || {})) out.push(`ip addr add ${a.ip}/${a.prefixLength} dev ${p}`);
      out.push(`ip link set ${p} ${ifc && ifc.config.enabled === false ? "down" : "up"}`);
      if (labParity) out.push(...parity(p));
    }
    for (const r of M.staticList(model)) out.push(`ip route add ${r.prefix === "0.0.0.0/0" ? "default" : r.prefix} via ${r.nextHop}`);
    return out;
  }

  out.push(`sysctl -w net.ipv4.ip_forward=${kind === "router" ? 1 : 0}`);
  // eth0.10 is an 802.1Q subinterface of eth0 (VLAN 10): create it on its parent, parents first.
  const sub = p => /^(.+)\.(\d+)$/.exec(p);
  const upParents = new Set();
  for (const p of [...ports].sort((a, b) => (sub(a) ? 1 : 0) - (sub(b) ? 1 : 0))) {
    const m = sub(p);
    if (m && !ports.includes(m[1]) && !upParents.has(m[1])) { upParents.add(m[1]); out.push(`ip link set ${m[1]} up`); }
    if (m) { out.push(`ip link add link ${m[1]} name ${p} type vlan id ${m[2]}`); if (labParity) out.push(...parity(p)); }
    const ifc = ifs[p]; if (!ifc) continue;
    for (const a of M.addressesOf(ifc)) out.push(`ip addr add ${a.ip}/${a.prefixLength} dev ${p}`);
    pushShaper(out, p, ifc);
    out.push(`ip link set ${p} ${ifc.config.enabled === false ? "down" : "up"}`);
    if (M.dhcpClientOf(ifc)) out.push(`busybox udhcpc -i ${p} -n -q`);
  }
  for (const r of M.staticList(model)) out.push(`ip route add ${r.prefix === "0.0.0.0/0" ? "default" : r.prefix} via ${r.nextHop}`);

  pushAcl(out, model);
  pushNat(out, model);
  const s = M.services(model);
  if (s.dns?.enabled) out.push(["dnsmasq --no-resolv --no-hosts", ...Object.entries(s.dns.hosts).map(([n, ip]) => `--host-record=${n},${ip}`)].join(" "));
  const pools = Object.values(s["dhcp-server"]?.pools || {}).filter(p => p.range);
  if (pools.length) {
    const own = Object.entries(ifs).map(([p, i]) => [p, M.addressesOf(i)[0]]).find(([, a]) => a);
    const mask = p => p.netmask || (own ? prefixMask(own[1].prefixLength) : "255.255.255.0");
    const args = ["dnsmasq --port=0 --no-resolv --no-hosts", ...(own ? [`--interface=${own[0]}`] : []),
      ...pools.map(p => `--dhcp-range=${p.range[0]},${p.range[1]},${mask(p)},${p.lease ?? 3600}`)];
    const first = pools[0];
    args.push(first["default-router"] ? `--dhcp-option=3,${first["default-router"]}` : "--dhcp-option=3");
    if (first["dns-server"]) args.push(`--dhcp-option=6,${first["dns-server"]}`);
    out.push(args.join(" "));
  }
  const relay = Object.entries(M.relayInterfaces(model)).filter(([, e]) => e.config["helper-address"].length);
  if (relay.length) {
    const args = ["dnsmasq --port=0 --no-resolv --no-hosts"];
    for (const [p, e] of relay) {
      const a = ifs[p] && M.addressesOf(ifs[p])[0];
      args.push(`--interface=${p}`);
      for (const h of e.config["helper-address"]) args.push(`--dhcp-relay=${a ? a.ip : "0.0.0.0"},${h}`);
    }
    out.push(args.join(" "));
  }
  if (s.lldp) {   // lldpd, configured the way validate/lldp does
    out.push("lldpd");
    if (s.lldp.txInterval !== undefined) out.push(`lldpcli configure lldp tx-interval ${s.lldp.txInterval}`);
    if (s.lldp.holdMultiplier !== undefined) out.push(`lldpcli configure lldp tx-hold ${s.lldp.holdMultiplier}`);
    if (typeof s.lldp.description === "string") out.push(`lldpcli configure system description '${s.lldp.description.replace(/'/g, "")}'`);
  }
  const vg = (s.vrrp || []).filter(x => x.ip);
  if (vg.length) {   // keepalived (vrrp only), one instance per group, written the way validate/vrrp does
    const conf = [];
    for (const g of vg) {
      const a = ifs[g.iface] && M.addressesOf(ifs[g.iface])[0];
      conf.push(`vrrp_instance VI_${g.iface}_${g.vrid} {`, "  state BACKUP", `  interface ${g.iface}`, `  virtual_router_id ${g.vrid}`, `  priority ${g.priority ?? 100}`,
        `  advert_int ${g.interval ?? 1}`, ...(g.preempt === false ? ["  nopreempt"] : []), ...(g.virtualMac ? ["  use_vmac"] : []),
        "  virtual_ipaddress {", `    ${g.ip}/${a ? a.prefixLength : 24} dev ${g.iface}`, "  }", "}");
    }
    out.push(`printf '%s\\n' ${conf.map(l => `'${l}'`).join(" ")} > /etc/keepalived/keepalived.conf`, "keepalived -P -f /etc/keepalived/keepalived.conf");
  }
  for (const [port, app] of Object.entries(s.tcp || {})) if (app === "echo") out.push(`socat TCP-LISTEN:${port},fork,reuseaddr EXEC:cat`);
  return out;
}

/** nftables commands for the access lists (same translation validate/acl/run_kernel_acl.py checks against the engine):
 *  in lists -> prerouting (iifname), out lists -> forward (oifname); permit = accept, deny and the implicit deny = reject admin-prohibited. */
function pushAcl(out, model) {
  const acl = M.services(model).acl; if (!acl) return;
  const bound = Object.entries(M.interfaces(model)).filter(([, i]) => i["openpacketrouter:acl"]);
  if (!bound.length) return;
  const REJECT = "reject with icmp type admin-prohibited";
  const match = r => {
    const w = [], proto = r.proto || "ip";
    if (r.src) w.push(`ip saddr ${r.src}`); if (r.dst) w.push(`ip daddr ${r.dst}`);
    if (proto === "tcp" || proto === "udp") {
      if (r.sport !== undefined) w.push(`${proto} sport ${r.sport}`); if (r.dport !== undefined) w.push(`${proto} dport ${r.dport}`);
      if (!w.some(x => x.startsWith(proto))) w.unshift(`meta l4proto ${proto}`);
      if (r.established) w.push("tcp flags & (ack | rst) != 0");
    } else if (proto === "icmp") w.unshift(r.icmpType !== undefined ? `icmp type ${r.icmpType}` : "meta l4proto icmp");
    return w.join(" ");
  };
  const chains = {acl_in: [], acl_out: []};
  for (const [ifn, ifc] of bound) for (const [d, chain, sel] of [["in", "acl_in", "iifname"], ["out", "acl_out", "oifname"]]) {
    const name = ifc["openpacketrouter:acl"][d]; if (!name) continue;
    for (const r of acl.lists[name] || []) chains[chain].push(`${sel} "${ifn}" ${match(r)} ${r.action === "permit" ? "accept" : REJECT}`.replace(/  +/g, " "));
    chains[chain].push(`${sel} "${ifn}" ${REJECT}`);
  }
  out.push("nft add table ip opr_acl",
    "nft 'add chain ip opr_acl acl_in { type filter hook prerouting priority -150; policy accept; }'",
    "nft 'add chain ip opr_acl acl_out { type filter hook forward priority 0; policy accept; }'",
    "nft add rule ip opr_acl acl_in ip daddr 224.0.0.0/4 accept", "nft add rule ip opr_acl acl_in ip daddr 255.255.255.255 accept");
  for (const [c, rules] of Object.entries(chains)) for (const r of rules) out.push(`nft add rule ip opr_acl ${c} ${r}`);
}

/** nftables for NAT (same translation validate/nat/run_kernel_nat.py checks against the engine): static entries -> dnat in prerouting
 *  and snat in postrouting, overload -> masquerade; the static outside addresses become secondary addresses on the outside interface (the engine answers ARP for them). */
function pushNat(out, model) {
  const nat = M.services(model).nat, ifs = M.interfaces(model); if (!nat) return;
  const side = s => Object.keys(ifs).filter(n => ifs[n]["openpacketrouter:nat"] === s);
  const ins = side("inside"), outs = side("outside"); if (!ins.length || !outs.length) return;
  const set = xs => `{ ${xs.map(x => `"${x}"`).join(", ")} }`;
  const pre = [], post = [];
  for (const s of nat.static || []) {
    if (s.proto) pre.push(`iifname ${set(outs)} ip daddr ${s.outside} ${s.proto} dport ${s.outsidePort} dnat to ${s.inside}:${s.insidePort}`);
    else { pre.push(`iifname ${set(outs)} ip daddr ${s.outside} dnat to ${s.inside}`); post.push(`iifname ${set(ins)} oifname ${set(outs)} ip saddr ${s.inside} snat to ${s.outside}`); }
  }
  if (nat.overload) post.push(`iifname ${set(ins)} oifname ${set(outs)} ${nat.overload.src ? `ip saddr ${nat.overload.src} ` : ""}masquerade`);
  out.push("nft add table ip opr_nat",
    "nft 'add chain ip opr_nat pre { type nat hook prerouting priority -100; policy accept; }'",
    "nft 'add chain ip opr_nat post { type nat hook postrouting priority 100; policy accept; }'");
  for (const r of pre) out.push(`nft add rule ip opr_nat pre ${r}`);
  for (const r of post) out.push(`nft add rule ip opr_nat post ${r}`);
  const own = new Set(Object.values(ifs).flatMap(i => M.addressesOf(i).map(a => a.ip)));
  const plen = M.addressesOf(ifs[outs[0]])[0]?.prefixLength ?? 24;
  for (const ip of new Set((nat.static || []).map(s => s.outside))) if (!own.has(ip)) out.push(`ip addr add ${ip}/${plen} dev ${outs[0]}`);
}

function pushShaper(out, p, ifc) {
  const sh = ifc && ifc["openpacketrouter:shaper"];
  if (sh) out.push(`tc qdisc add dev ${p} root tbf rate ${sh.rate} burst ${sh.burst} limit ${sh.limit}`);
}
const prefixMask = p => { const n = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0; return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."); };

/** A render-only backend over another backend's models (the device list and ports come from `source`). */
export function linuxBackend(source) {
  return {
    name: "linux",
    render: device => linuxCommands(source.getConfig(device), {kind: source.kind(device), ports: source.ports(device)}),
  };
}
