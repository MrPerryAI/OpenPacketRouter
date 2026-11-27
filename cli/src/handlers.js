// Configuration handlers. Each gets a context {model, s (session selection: iface, pool …), kind} and the parsed
// argument values, edits ctx.model (a copy) and may return {out}. Throwing an Error refuses the command with its
// message. A handler name may carry a parameter after a colon ("stp.set:hello-time"), so one function serves a
// family of commands.

import * as M from "./model.js";
import {parseCidr6, intToIp6, ip6ToInt} from "../../engine/src/addr6.js";
import {maskToPrefix, networkOf, isPrefix, prefixToMask, aclEndpoint} from "./types.js";

const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const cidrOf = (args) => {   // [prefix] or [ip, mask]
  if (args.length === 1 || isPrefix(args[0])) { const [ip, p] = args[0].split("/"); return {ip, p: +p, rest: args.slice(1)}; }
  return {ip: args[0], p: maskToPrefix(args[1]), rest: args.slice(2)};
};
const ospfG = ctx => { need(M.ospf(ctx.model), "OSPF is not running: use router ospf first"); return M.ospf(ctx.model); };
const TIMERS = new Set(["hello-interval", "dead-interval", "retransmission-interval"]);
const ospfIfCtx = ctx => { need(M.ospf(ctx.model), "OSPF is not running: use router ospf first"); return M.ospfIf(ctx.model, curIface(ctx).config.name); };
const curIface = ctx => { need(ctx.s.iface, "No interface selected"); return M.iface(ctx.model, ctx.s.iface); };
const ripng = ctx => { need(ctx.s.router === "ripng" && M.services(ctx.model).ripng, "Not in RIPng configuration"); return M.services(ctx.model).ripng; };
const rip = ctx => { need(ctx.s.router === "rip" && M.services(ctx.model).rip, "Not in RIP configuration"); return M.services(ctx.model).rip; };
const vrrpGroup = (ctx, id, make = false) => {
  const ifn = curIface(ctx).config.name, list = (M.services(ctx.model).vrrp ||= []);
  let g = list.find(x => x.iface === ifn && x.vrid === +id);
  if (!g && make) { g = {iface: ifn, vrid: +id}; list.push(g); }
  need(g, `VRRP group ${id} is not set up on ${ifn}`);
  return g;
};
const lldp = ctx => { need(M.services(ctx.model).lldp, "LLDP is not running: use \"lldp run\" first"); return M.services(ctx.model).lldp; };
const acl = ctx => { need(ctx.s.acl && M.services(ctx.model).acl?.lists[ctx.s.acl], "Not in access-list configuration"); return M.services(ctx.model).acl.lists[ctx.s.acl]; };
const natSame = (a, b) => ["proto", "inside", "insidePort", "outside", "outsidePort"].every(k => a[k] === b[k]);
function natStatic(ctx, e) {
  const n = (M.services(ctx.model).nat ||= {}), list = (n.static ||= []);
  need(!list.some(x => natSame(x, e)), "That mapping already exists");
  need(!list.some(x => x.proto === e.proto && x.outside === e.outside && x.outsidePort === e.outsidePort), `${e.outside}${e.outsidePort ? ":" + e.outsidePort : ""} is already mapped to another host`);
  need(e.proto || !list.some(x => !x.proto && x.inside === e.inside), `${e.inside} already has a fixed outside address`);
  list.push(e);
}
function natUnstatic(ctx, e) {
  const n = M.services(ctx.model).nat, i = n && n.static ? n.static.findIndex(x => natSame(x, e)) : -1;
  need(i >= 0, "No such fixed mapping");
  n.static.splice(i, 1); if (!n.static.length) delete n.static; if (!n.static && !n.overload) delete M.services(ctx.model).nat;
}
const pool = ctx => { need(ctx.s.pool, "No DHCP pool selected"); return M.services(ctx.model)["dhcp-server"].pools[ctx.s.pool]; };
const STP_LEAVES = {"bridge-priority": 1, "hello-time": 1, "max-age": 1, "forwarding-delay": 1, "openpacketrouter:bridge-address": 1};

const netName = x => typeof x === "object" ? x.network : x;
function ospfNet(ctx, p, area) {
  const l = ospfG(ctx)["openpacketrouter:networks"], e = area && area !== "0.0.0.0" ? {network: p, area} : p;
  const at = l.findIndex(x => netName(x) === p);
  if (at < 0) l.push(e); else l[at] = e;       // naming it again moves it to the new area
}
function ospfNoNet(ctx, p) {
  const g = ospfG(ctx), l = g["openpacketrouter:networks"]; need(l.some(x => netName(x) === p), `OSPF is not running on ${p}`);
  g["openpacketrouter:networks"] = l.filter(x => netName(x) !== p);
}
export const HANDLERS = {
  "system.hostname": (ctx, [name]) => { ctx.model.system.config.hostname = name; },

  // ---- interfaces
  "interface.select": (ctx, [name]) => { M.iface(ctx.model, name); ctx.s.iface = name; },
  "interface.shutdown": ctx => { curIface(ctx).config.enabled = false; },
  "interface.no-shutdown": ctx => { curIface(ctx).config.enabled = true; },
  "interface.description": (ctx, [text]) => { curIface(ctx).config.description = text; },
  "interface.no-description": ctx => { delete curIface(ctx).config.description; },

  "ipv4.address.set": (ctx, args) => {
    const {ip, p} = cidrOf(args);
    need(p !== null, "That is not a valid network mask");
    need(networkOf(ip, p) !== ip || p >= 31, `${ip}/${p} is the network itself, not a host address on it`);
    const v4 = M.ipv4(curIface(ctx));
    v4.addresses.address = {[ip]: {config: {ip, "prefix-length": p}}};
    v4.config["dhcp-client"] = false;
  },
  "ipv6.address.set": (ctx, [prefix]) => {
    const c = parseCidr6(prefix);
    need(ip6ToInt(c.ip) !== ip6ToInt(c.cidr.split("/")[0]) || c.prefix >= 127, `${prefix} is the network itself, not a host address on it`);
    M.ipv6(curIface(ctx)).addresses.address = {[c.ip]: {config: {ip: c.ip, "prefix-length": c.prefix}}};
  },
  "ipv6.address.remove": ctx => {
    const v6 = M.ipv6(curIface(ctx), false);
    need(v6 && Object.keys(v6.addresses.address).length, "This interface has no IPv6 address");
    v6.addresses.address = {};
  },
  "static6.add": (ctx, [prefix, via]) => {
    const net = parseCidr6(prefix).cidr, nh = intToIp6(ip6ToInt(via));
    const r = M.statics(ctx.model)[net] ||= {prefix: net, config: {prefix: net}, "next-hops": {"next-hop": {}}};
    r["next-hops"]["next-hop"][nh] = {index: nh, config: {index: nh, "next-hop": nh}};
  },
  "static6.remove": (ctx, [prefix, via]) => {
    const net = parseCidr6(prefix).cidr, all = M.statics(ctx.model), r = all[net], nh = via && intToIp6(ip6ToInt(via));
    need(r && (!nh || r["next-hops"]["next-hop"][nh]), `There is no static route to ${net}${nh ? ` via ${nh}` : ""}`);
    if (nh) delete r["next-hops"]["next-hop"][nh]; else delete all[net];
    if (all[net] && !Object.keys(all[net]["next-hops"]["next-hop"]).length) delete all[net];
  },
  "ipv4.address.dhcp": ctx => { const v4 = M.ipv4(curIface(ctx)); v4.addresses.address = {}; v4.config["dhcp-client"] = true; },
  "ipv4.address.remove": ctx => {
    const ifc = curIface(ctx), v4 = M.ipv4(ifc, false);
    need(v4 && (Object.keys(v4.addresses.address).length || v4.config["dhcp-client"]), "This interface has no address");
    v4.addresses.address = {}; v4.config["dhcp-client"] = false;
  },

  // ---- static routes (FRRouting style: ip route PREFIX NEXTHOP; the mask form is accepted too)
  "static.add": (ctx, args) => {
    const {ip, p, rest: [via]} = cidrOf(args);
    need(p !== null, "That is not a valid network mask");
    const prefix = `${networkOf(ip, p)}/${p}`;
    const r = M.statics(ctx.model)[prefix] ||= {prefix, config: {prefix}, "next-hops": {"next-hop": {}}};
    r["next-hops"]["next-hop"][via] = {index: via, config: {index: via, "next-hop": via}};
  },
  "static.remove": (ctx, args) => {
    const {ip, p, rest: [via]} = cidrOf(args);
    const prefix = `${networkOf(ip, p)}/${p}`, all = M.statics(ctx.model), r = all[prefix];
    need(r && (!via || r["next-hops"]["next-hop"][via]), `There is no static route to ${prefix}${via ? ` via ${via}` : ""}`);
    if (via) delete r["next-hops"]["next-hop"][via]; else delete all[prefix];
    if (all[prefix] && !Object.keys(all[prefix]["next-hops"]["next-hop"]).length) delete all[prefix];
  },
  "static.default": (ctx, [via]) => HANDLERS["static.add"](ctx, ["0.0.0.0/0", via]),
  "static.no-default": ctx => { need(M.statics(ctx.model)["0.0.0.0/0"], "There is no default gateway"); delete M.statics(ctx.model)["0.0.0.0/0"]; },

  // ---- switch ports (openconfig-vlan switched-vlan)
  "switchport.mode": (ctx, args, mode) => {
    const c = M.switchedVlan(curIface(ctx));
    if (mode === "access") { c["interface-mode"] = "ACCESS"; c["access-vlan"] ??= 1; delete c["trunk-vlans"]; delete c["native-vlan"]; }
    else { c["interface-mode"] = "TRUNK"; c["trunk-vlans"] ??= [1]; delete c["access-vlan"]; }
  },
  "switchport.access-vlan": (ctx, [v]) => {
    const c = M.switchedVlan(curIface(ctx));
    need(c["interface-mode"] !== "TRUNK", "This port is a trunk: set switchport mode access first");
    c["interface-mode"] = "ACCESS"; c["access-vlan"] = v;
  },
  "switchport.no-access-vlan": ctx => { const c = M.switchedVlan(curIface(ctx)); if (c["interface-mode"] === "ACCESS") c["access-vlan"] = 1; },
  "switchport.trunk-allowed": (ctx, [list]) => {
    const c = M.switchedVlan(curIface(ctx));
    need(c["interface-mode"] === "TRUNK", "Set switchport mode trunk first");
    c["trunk-vlans"] = list;
  },
  "switchport.trunk-native": (ctx, [v]) => {
    const c = M.switchedVlan(curIface(ctx));
    need(c["interface-mode"] === "TRUNK", "Set switchport mode trunk first");
    c["native-vlan"] = v;
  },
  "switchport.no-trunk-native": ctx => { delete M.switchedVlan(curIface(ctx))["native-vlan"]; },
  "switchport.remove": ctx => { const ifc = curIface(ctx); if (ifc.ethernet) delete ifc.ethernet["switched-vlan"]; },

  // ---- spanning tree (openconfig-spanning-tree)
  "stp.enable": ctx => { if (!M.stpEnabled(ctx.model)) M.stpGlobal(ctx.model)["enabled-protocol"] = ["STP"]; },
  "stp.mode": (ctx, args, mode) => { M.stpGlobal(ctx.model)["enabled-protocol"] = [mode]; },
  "stp.mode.unset": ctx => { if (M.stpEnabled(ctx.model)) M.stpGlobal(ctx.model)["enabled-protocol"] = ["STP"]; },
  "stp.portfast": ctx => { need(M.stpEnabled(ctx.model), "Turn spanning tree on first (spanning-tree)"); M.stpPort(ctx.model, curIface(ctx).config.name)["edge-port"] = "EDGE_ENABLE"; },
  "stp.portfast.unset": ctx => { const c = M.stpPort(ctx.model, curIface(ctx).config.name, false); if (c) delete c["edge-port"]; },
  "stp.disable": ctx => { ctx.model.stp = M.emptyModel("").stp; },
  "stp.set": (ctx, [v], leaf) => { need(STP_LEAVES[leaf], `unknown setting ${leaf}`); M.stpGlobal(ctx.model)[leaf] = v; },
  "stp.unset": (ctx, args, leaf) => { delete M.stpGlobal(ctx.model)[leaf]; },
  "stp.port.set": (ctx, [v], leaf) => { M.stpPort(ctx.model, curIface(ctx).config.name)[leaf] = v; },
  "stp.port.unset": (ctx, args, leaf) => { const c = M.stpPort(ctx.model, curIface(ctx).config.name, false); if (c) delete c[leaf]; },

  // ---- link aggregation (LACP): channel-group N mode active on a member port makes interface PoN
  "lag.join": (ctx, [n]) => {
    const ifc = curIface(ctx); need(!M.isLagName(ifc.config.name), "A port-channel cannot join a channel");
    const id = `Po${n}`; const po = M.iface(ctx.model, id); po.config.type = "ieee8023adLag"; po.aggregation = {config: {"lag-type": "LACP"}};
    M.setLag(ifc, id);
  },
  "lag.leave": ctx => {
    const ifc = curIface(ctx), id = M.lagOf(ifc); M.clearLag(ifc);
    if (id && !Object.values(M.interfaces(ctx.model)).some(i => M.lagOf(i) === id)) { delete M.interfaces(ctx.model)[id]; if (ctx.model.lacp) delete ctx.model.lacp.interfaces.interface[id]; }
  },
  "lag.rate": (ctx, args, rate) => {
    const ifc = curIface(ctx); need(M.isLagName(ifc.config.name), "lacp rate is set on a port-channel (interface Po1)");
    if (rate === "fast") M.lacpInterval(ctx.model, ifc.config.name).interval = "FAST"; else { const c = M.lacpInterval(ctx.model, ifc.config.name, false); if (c) delete c.interval; }
  },
  // ---- LLDP passes through a switch (bridge group_fwd_mask bit 14)
  // ---- DHCP snooping (engine/src/network.js dhcpSnooping; the trust flag is an extension on the interface)
  "snoop.on": ctx => { M.services(ctx.model).dhcpSnooping = true; },
  "snoop.off": ctx => { delete M.services(ctx.model).dhcpSnooping; },
  "snoop.trust": ctx => { need(M.services(ctx.model).dhcpSnooping, "Turn DHCP snooping on first (ip dhcp snooping)"); curIface(ctx)["openpacketrouter:dhcp-snooping-trust"] = true; },
  "snoop.untrust": ctx => { delete curIface(ctx)["openpacketrouter:dhcp-snooping-trust"]; },
  "bridge.lldp-forward": ctx => { M.services(ctx.model).forwardLldp = true; },
  "bridge.no-lldp-forward": ctx => { delete M.services(ctx.model).forwardLldp; },

  // ---- port security (engine/src/network.js portSecurity; stored as an extension on the interface)
  "portsec.max": (ctx, [n]) => { const c = (curIface(ctx)["openpacketrouter:port-security"] ||= {}); c.max = n; },
  "portsec.violation": (ctx, args, mode) => { const c = curIface(ctx)["openpacketrouter:port-security"]; need(c, "Set switchport port-security maximum first"); c.violation = mode; },
  "portsec.off": ctx => { const i = curIface(ctx); need(i["openpacketrouter:port-security"], "Port security is not on for this port"); delete i["openpacketrouter:port-security"]; },
  // ---- storm control (engine/src/link.js Police; stored as an extension on the interface)
  "storm.broadcast": (ctx, [rate, burst]) => {
    curIface(ctx)["openpacketrouter:storm-control"] = {broadcast: {rate, burst}};
  },
  "storm.off": ctx => { const i = curIface(ctx); need(i["openpacketrouter:storm-control"], "Storm control is not on for this port"); delete i["openpacketrouter:storm-control"]; },
  // ---- port mirroring (monitor sessions)
  "monitor.dest": (ctx, [n, port]) => {
    const all = M.monitor(ctx.model), s = (all[n] ||= {sources: {}});
    need(!Object.entries(all).some(([k, x]) => k !== n && x.destination === port), `${port} is already the destination of another session`);
    need(!Object.values(all).some(x => port in x.sources), `${port} is a source of a session; a destination cannot also be a source`);
    s.destination = port;
  },
  "monitor.src": (ctx, [n, port], dir) => {
    const all = M.monitor(ctx.model), s = (all[n] ||= {sources: {}});
    need(!Object.values(all).some(x => x.destination === port), `${port} is a monitor destination; a destination cannot also be a source`);
    s.sources[port] = dir;
  },
  "monitor.src.unset": (ctx, [n, port]) => {
    const s = M.monitor(ctx.model, false)[n]; need(s && port in s.sources, `${port} is not a source of session ${n}`);
    delete s.sources[port];
  },
  "monitor.unset": (ctx, [n]) => { need(M.monitor(ctx.model, false)[n], `No monitor session ${n}`); delete ctx.model.monitor[n]; if (!Object.keys(ctx.model.monitor).length) delete ctx.model.monitor; },
  // ---- MAC address table aging (openconfig fdb mac-aging-time)
  "fdb.aging": (ctx, [v]) => { M.fdb(ctx.model)["mac-aging-time"] = v; },
  "fdb.aging.unset": ctx => { delete M.fdb(ctx.model)["mac-aging-time"]; },

  // ---- link shaping (token bucket on the interface's egress)
  "shaper.set": (ctx, [rate, burst, limit]) => { curIface(ctx)["openpacketrouter:shaper"] = {rate, burst, limit}; },
  "shaper.remove": ctx => { delete curIface(ctx)["openpacketrouter:shaper"]; },
  "linkdelay.set": (ctx, [ms]) => { curIface(ctx)["openpacketrouter:delay"] = ms; },
  "linkdelay.remove": ctx => { delete curIface(ctx)["openpacketrouter:delay"]; },
  "linkloss.set": (ctx, [toBad, toGood, inBad, inGood]) => { curIface(ctx)["openpacketrouter:loss"] = {toBad, toGood, inBad, inGood}; },
  "linkloss.remove": ctx => { delete curIface(ctx)["openpacketrouter:loss"]; },

  // ---- OSPFv2 (openconfig-ospfv2: global router-id, one area 0, per-interface metric/timers)
  "ospf.enter": ctx => { M.ospf(ctx.model, true); ctx.s.router = "ospf"; },
  "ospf.remove": ctx => { M.ospfDelete(ctx.model); },
  "ospf.router-id": (ctx, [id]) => { ospfG(ctx).global.config["router-id"] = id; },
  "ospf.no-router-id": ctx => { delete ospfG(ctx).global.config["router-id"]; },
  "ospf.passive": (ctx, [i]) => { need(M.iface(ctx.model, i, false), `No interface named ${i}`); M.ospfIf(ctx.model, i).config.passive = true; },
  "ospf.redist": (ctx, [m, t], src) => { const o = M.ospf(ctx.model, false), l = o["openpacketrouter:redistribute"] ||= [], i = l.findIndex(r => r.source === src), e = {source: src, ...(m !== undefined ? {metric: m} : {}), ...(t !== undefined ? {metricType: t} : {})}; if (i < 0) l.push(e); else l[i] = e; },
  "ospf.no-redist": (ctx, a, src) => { const l = M.ospf(ctx.model, false)?.["openpacketrouter:redistribute"]; if (l) { const i = l.findIndex(r => r.source === src); if (i >= 0) l.splice(i, 1); } },
  "ospf.no-passive": (ctx, [i]) => { const e = M.ospfIf(ctx.model, i, false); if (e) delete e.config.passive; },
  // a network entry is the bare name for area 0, {network, area} for any other area
  "ospf.network": (ctx, [p, area]) => ospfNet(ctx, p, area),
  "ospf.network-if": (ctx, [p, area]) => ospfNet(ctx, p, area),
  "ospf.no-network": (ctx, [p]) => ospfNoNet(ctx, p),
  "ospf.no-network-if": (ctx, [p]) => ospfNoNet(ctx, p),
  "ospf.set": (ctx, [v], leaf) => { const e = ospfIfCtx(ctx); (TIMERS.has(leaf) ? e.timers.config : e.config)[leaf] = v; },
  "ospf.network-type": (ctx, args, type) => { ospfIfCtx(ctx).config["network-type"] = type; },
  "ospf.unset": (ctx, args, leaf) => { const e = ospfIfCtx(ctx); delete (TIMERS.has(leaf) ? e.timers.config : e.config)[leaf]; },

  // ---- DHCP relay (openconfig-relay-agent helper addresses)
  "relay.add": (ctx, [ip]) => { const h = M.relayHelpers(ctx.model, curIface(ctx).config.name); if (!h.includes(ip)) h.push(ip); },
  "relay.remove": (ctx, [ip]) => {
    const name = curIface(ctx).config.name, all = M.relayInterfaces(ctx.model);
    need(all[name], "This interface relays nothing");
    if (ip) all[name].config["helper-address"] = all[name].config["helper-address"].filter(x => x !== ip);
    if (!ip || !all[name].config["helper-address"].length) delete all[name];
  },

  // ---- DNS server: ip dns server + ip host NAME ADDRESS (the names the server answers)
  "dns.server": ctx => { const s = M.services(ctx.model); s.dns ||= {enabled: true, hosts: {}}; s.dns.enabled = true; },
  "dns.no-server": ctx => { const s = M.services(ctx.model); need(s.dns, "There is no DNS server here"); delete s.dns; },
  "dns.host": (ctx, [name, ip]) => { const s = M.services(ctx.model); s.dns ||= {enabled: false, hosts: {}}; s.dns.hosts[name] = ip; },
  "dns.no-host": (ctx, [name]) => { const d = M.services(ctx.model).dns; need(d && name in d.hosts, `No host entry for ${name}`); delete d.hosts[name]; },

  // ---- VLAN names (openconfig-network-instance vlans)
  "vlan.select": (ctx, [id]) => { const v = M.vlans(ctx.model); v[id] ||= {"vlan-id": +id, config: {"vlan-id": +id}}; ctx.s.vlan = +id; },
  "vlan.no-vlan": (ctx, [id]) => { delete M.vlans(ctx.model)[id]; },
  "vlan.name": (ctx, [name]) => { need(ctx.s.vlan, "No VLAN selected"); M.vlans(ctx.model)[ctx.s.vlan].config.name = name; },
  "vlan.no-name": ctx => { need(ctx.s.vlan, "No VLAN selected"); delete M.vlans(ctx.model)[ctx.s.vlan].config.name; },

  // ---- DHCP server pools
  "dhcp.pool": (ctx, [name]) => {
    const s = M.services(ctx.model); s["dhcp-server"] ||= {pools: {}};
    s["dhcp-server"].pools[name] ||= {}; ctx.s.pool = name;
  },
  "dhcp.no-pool": (ctx, [name]) => {
    const d = M.services(ctx.model)["dhcp-server"]; need(d && d.pools[name], `No DHCP pool named ${name}`);
    delete d.pools[name]; if (!Object.keys(d.pools).length) delete M.services(ctx.model)["dhcp-server"];
  },
  "dhcp.range": (ctx, [a, b]) => { pool(ctx).range = [a, b]; },
  "dhcp.set": (ctx, [v], leaf) => { pool(ctx)[leaf] = leaf === "netmask" ? prefixToMask(maskToPrefix(v)) : v; },
  "dhcp.unset": (ctx, args, leaf) => { delete pool(ctx)[leaf]; },

  // ---- VRRP (kept under services.vrrp, a list shaped like the spec's vrrp groups; "interface" is the spec's iface)
  "vrrp.address": (ctx, [id, ip]) => { vrrpGroup(ctx, id, true).ip = ip; },
  "vrrp.priority": (ctx, [id, n]) => { vrrpGroup(ctx, id, true).priority = +n; },
  "vrrp.interval": (ctx, [id, n]) => { vrrpGroup(ctx, id, true).interval = +n; },
  "vrrp.preempt": (ctx, [id]) => { delete vrrpGroup(ctx, id, true).preempt; },
  "vrrp.no-preempt": (ctx, [id]) => { vrrpGroup(ctx, id, true).preempt = false; },
  "vrrp.virtual-mac": (ctx, [id]) => { vrrpGroup(ctx, id, true).virtualMac = true; },
  "vrrp.no-virtual-mac": (ctx, [id]) => { delete vrrpGroup(ctx, id, true).virtualMac; },
  "vrrp.remove": (ctx, [id]) => { const g = vrrpGroup(ctx, id); const l = M.services(ctx.model).vrrp; l.splice(l.indexOf(g), 1); if (!l.length) delete M.services(ctx.model).vrrp; },
  // ---- LLDP (kept under services.lldp, shaped like the spec's lldp block)
  "lldp.run": ctx => { const s = M.services(ctx.model); s.lldp ||= {}; },
  "lldp.remove": ctx => { const s = M.services(ctx.model); need(s.lldp, "LLDP is not running"); delete s.lldp; },
  "lldp.timer": (ctx, [n]) => { lldp(ctx).txInterval = +n; },
  "lldp.no-timer": ctx => { delete lldp(ctx).txInterval; },
  "lldp.hold": (ctx, [n]) => { lldp(ctx).holdMultiplier = +n; },
  "lldp.no-hold": ctx => { delete lldp(ctx).holdMultiplier; },
  "lldp.description": (ctx, [t]) => { lldp(ctx).description = t; },
  "lldp.no-description": ctx => { delete lldp(ctx).description; },

  // ---- RIPng (kept under services.ripng, shaped like the spec's ripng block)
  "ripng.enter": ctx => { const s = M.services(ctx.model); s.ripng ||= {networks: []}; ctx.s.router = "ripng"; },
  "ripng.remove": ctx => { const s = M.services(ctx.model); need(s.ripng, "RIPng is not running"); delete s.ripng; },
  "ripng.network": (ctx, [n]) => { const r = ripng(ctx); if (!r.networks.includes(n)) r.networks.push(n); },
  "ripng.no-network": (ctx, [n]) => { const r = ripng(ctx); need(r.networks.includes(n), `RIPng does not run on ${n}`); r.networks = r.networks.filter(x => x !== n); },
  "ripng.passive": (ctx, [i]) => { const r = ripng(ctx); r.passive ||= []; if (!r.passive.includes(i)) r.passive.push(i); },
  "ripng.no-passive": (ctx, [i]) => { const r = ripng(ctx); need(r.passive?.includes(i), `${i} is not passive`); r.passive = r.passive.filter(x => x !== i); if (!r.passive.length) delete r.passive; },
  "ripng.timers": (ctx, [update, timeout, garbage]) => { ripng(ctx).timers = {update: +update, timeout: +timeout, garbage: +garbage}; },
  "ripng.no-timers": ctx => { delete ripng(ctx).timers; },
  "ripng.split": (ctx, args, v) => { const r = ripng(ctx); if (v === "simple") delete r.splitHorizon; else r.splitHorizon = v; },
  "ripng.triggered": (ctx, args, v) => { const r = ripng(ctx); if (v === "true") delete r.triggered; else r.triggered = false; },

  // ---- RIPv2 (kept under services.rip, shaped like the spec's rip block)
  "rip.enter": ctx => { const s = M.services(ctx.model); s.rip ||= {networks: []}; ctx.s.router = "rip"; },
  "rip.remove": ctx => { const s = M.services(ctx.model); need(s.rip, "RIP is not running"); delete s.rip; },
  "rip.version": () => {},
  "rip.network": (ctx, [n]) => { const r = rip(ctx); if (!r.networks.includes(n)) r.networks.push(n); },
  "rip.no-network": (ctx, [n]) => { const r = rip(ctx); need(r.networks.includes(n), `RIP does not run on ${n}`); r.networks = r.networks.filter(x => x !== n); },
  "rip.passive": (ctx, [i]) => { const r = rip(ctx); r.passive ||= []; if (!r.passive.includes(i)) r.passive.push(i); },
  "rip.no-passive": (ctx, [i]) => { const r = rip(ctx); need(r.passive?.includes(i), `${i} is not passive`); r.passive = r.passive.filter(x => x !== i); if (!r.passive.length) delete r.passive; },
  "rip.timers": (ctx, [update, timeout, garbage]) => { rip(ctx).timers = {update: +update, timeout: +timeout, garbage: +garbage}; },
  "rip.no-timers": ctx => { delete rip(ctx).timers; },
  "rip.split": (ctx, args, v) => { const r = rip(ctx); if (v === "simple") delete r.splitHorizon; else r.splitHorizon = v; },
  "rip.triggered": (ctx, args, v) => { const r = rip(ctx); if (v === "true") delete r.triggered; else r.triggered = false; },

  // ---- IPv4 access lists (services.acl.lists, shaped like the spec's acl.lists; the binding is on the interface)
  "acl.enter": (ctx, [name]) => { const s = M.services(ctx.model); s.acl ||= {lists: {}}; s.acl.lists[name] ||= []; ctx.s.acl = name; },
  "acl.remove": (ctx, [name]) => {
    const a = M.services(ctx.model).acl; need(a && a.lists[name], `No access list named ${name}`);
    for (const [ifn, ifc] of Object.entries(M.interfaces(ctx.model))) for (const d of ["in", "out"]) need(ifc["openpacketrouter:acl"]?.[d] !== name, `${name} is still applied ${d} on ${ifn}: remove it there first`);
    delete a.lists[name]; if (!Object.keys(a.lists).length) delete M.services(ctx.model).acl;
  },
  "acl.rule": (ctx, [src, dst, type], leaf) => {
    const [action, shape] = leaf.split("/"), proto = shape.split("-")[0], list = acl(ctx);
    const s = aclEndpoint(src), d = aclEndpoint(dst);
    need(proto === "tcp" || proto === "udp" || (s.port === undefined && d.port === undefined), `Ports (:PORT) only work with tcp and udp`);
    const rule = {action, ...(proto !== "ip" ? {proto} : {}), ...(s.addr ? {src: s.addr} : {}), ...(d.addr ? {dst: d.addr} : {}),
      ...(s.port !== undefined ? {sport: s.port} : {}), ...(d.port !== undefined ? {dport: d.port} : {}),
      ...(shape === "icmp-type" ? {icmpType: +type} : {}), ...(shape === "tcp-est" ? {established: true} : {})};
    list.push(rule);
  },
  "acl.no-rule": (ctx, [n]) => { const list = acl(ctx); need(n >= 1 && n <= list.length, `This list has ${list.length} rule${list.length === 1 ? "" : "s"}`); list.splice(n - 1, 1); },
  "acl.group": (ctx, [name], dir) => {
    need(M.services(ctx.model).acl?.lists[name], `No access list named ${name}: create it with ip access-list ${name}`);
    const i = curIface(ctx); (i["openpacketrouter:acl"] ||= {})[dir] = name;
  },
  "acl.ungroup": (ctx, args, dir) => {
    const i = curIface(ctx); need(i["openpacketrouter:acl"]?.[dir], `No ${dir}bound access list on this interface`);
    delete i["openpacketrouter:acl"][dir]; if (!Object.keys(i["openpacketrouter:acl"]).length) delete i["openpacketrouter:acl"];
  },

  // ---- NAT (services.nat = {overload, static}, shaped like the spec's nat key; inside/outside is a flag on the interface)
  "nat.side": (ctx, args, side) => { curIface(ctx)["openpacketrouter:nat"] = side; },
  "nat.no-side": ctx => { const i = curIface(ctx); need(i["openpacketrouter:nat"], "This interface is neither inside nor outside"); delete i["openpacketrouter:nat"]; },
  "nat.overload": (ctx, [prefix]) => { const s = M.services(ctx.model); (s.nat ||= {}).overload = prefix ? {src: prefix} : true; },
  "nat.no-overload": ctx => { const n = M.services(ctx.model).nat; need(n && n.overload, "Overload is not configured"); delete n.overload; if (!n.static) delete M.services(ctx.model).nat; },
  "nat.static": (ctx, [inside, outside]) => { natStatic(ctx, {inside, outside}); },
  "nat.static-port": (ctx, [inside, insidePort, outside, outsidePort], proto) => { natStatic(ctx, {proto, inside, insidePort, outside, outsidePort}); },
  "nat.no-static": (ctx, [inside, outside]) => { natUnstatic(ctx, {inside, outside}); },
  "nat.no-static-port": (ctx, [inside, insidePort, outside, outsidePort], proto) => { natUnstatic(ctx, {proto, inside, insidePort, outside, outsidePort}); },

  // ---- TCP services
  "tcp.echo": (ctx, [port]) => { const s = M.services(ctx.model); s.tcp ||= {}; s.tcp[port] = "echo"; },
  "tcp.discard": (ctx, [port]) => { const s = M.services(ctx.model); s.tcp ||= {}; s.tcp[port] = "discard"; },
  "tcp.http": (ctx, [port]) => { const s = M.services(ctx.model); s.tcp ||= {}; s.tcp[port] = "http"; },
  "http.page": (ctx, [path, text]) => { const s = M.services(ctx.model); s.http ||= {}; s.http[path] = decodeURIComponent(text); },
  "http.no-page": (ctx, [path]) => { const s = M.services(ctx.model); need(s.http && path in s.http, `There is no page ${path}`); delete s.http[path]; if (!Object.keys(s.http).length) delete s.http; },
  "ntp.on": (ctx, [stratum]) => { M.services(ctx.model).ntp = Number(stratum); },
  "ntp.off": ctx => { const s = M.services(ctx.model); need(s.ntp, "The NTP service is not running"); delete s.ntp; },
  "syslog.on": ctx => { M.services(ctx.model).syslog = true; },
  "syslog.off": ctx => { const s = M.services(ctx.model); need(s.syslog, "The syslog service is not running"); delete s.syslog; },
  "tcp.slow": (ctx, [port]) => { const s = M.services(ctx.model); s.tcp ||= {}; s.tcp[port] = "slow"; },
  "tcp.no-echo": (ctx, [port]) => { const t = M.services(ctx.model).tcp; need(t && t[port], `Nothing listens on TCP port ${port}`); delete t[port]; if (!Object.keys(t).length) delete M.services(ctx.model).tcp; },
};
