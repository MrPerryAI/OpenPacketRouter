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
    const br = ["ip link add br0 type bridge", `stp_state ${stp ? 1 : 0}`];
    if (stp) br.push(`priority ${g["bridge-priority"] ?? 32768}`, `hello_time ${centis(g["hello-time"] ?? 2)}`,
      `max_age ${centis(g["max-age"] ?? 20)}`, `forward_delay ${centis(g["forwarding-delay"] ?? 15)}`);
    if (vlanAware) br.push("vlan_filtering 1");
    out.push(br.join(" "));
    if (stp && g["openpacketrouter:bridge-address"]) out.push(`ip link set br0 address ${g["openpacketrouter:bridge-address"]}`);
    out.push("ip link set br0 up");
    for (const p of ports) {
      const ifc = ifs[p];
      out.push(`ip link set ${p} master br0`);
      const sp = M.stpPort(model, p, false);
      // Always set the cost: the engine's default is 19 (802.1D, 100 Mbit/s), the kernel's depends on the link speed.
      // The kernel's port priority is 6 bits shifted by 10 in the port ID, the model's 8 bits shifted by 8: 128 -> 32.
      if (stp) out.push(`ip link set ${p} type bridge_slave cost ${sp?.cost ?? 19}${sp?.["port-priority"] !== undefined ? ` priority ${sp["port-priority"] >> 2}` : ""}`);
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
      out.push(`ip link set ${p} ${ifc && ifc.config.enabled === false ? "down" : "up"}`);
    }
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
  for (const [port, app] of Object.entries(s.tcp || {})) if (app === "echo") out.push(`socat TCP-LISTEN:${port},fork,reuseaddr EXEC:cat`);
  return out;
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
