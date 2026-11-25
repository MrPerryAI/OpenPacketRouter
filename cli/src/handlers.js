// Configuration handlers. Each gets a context {model, s (session selection: iface, pool …), kind} and the parsed
// argument values, edits ctx.model (a copy) and may return {out}. Throwing an Error refuses the command with its
// message. A handler name may carry a parameter after a colon ("stp.set:hello-time"), so one function serves a
// family of commands.

import * as M from "./model.js";
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
const rip = ctx => { need(ctx.s.router === "rip" && M.services(ctx.model).rip, "Not in RIP configuration"); return M.services(ctx.model).rip; };
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
  "stp.enable": ctx => { M.stpGlobal(ctx.model)["enabled-protocol"] = ["STP"]; },
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
  // ---- MAC address table aging (openconfig fdb mac-aging-time)
  "fdb.aging": (ctx, [v]) => { M.fdb(ctx.model)["mac-aging-time"] = v; },
  "fdb.aging.unset": ctx => { delete M.fdb(ctx.model)["mac-aging-time"]; },

  // ---- link shaping (token bucket on the interface's egress)
  "shaper.set": (ctx, [rate, burst, limit]) => { curIface(ctx)["openpacketrouter:shaper"] = {rate, burst, limit}; },
  "shaper.remove": ctx => { delete curIface(ctx)["openpacketrouter:shaper"]; },

  // ---- OSPFv2 (openconfig-ospfv2: global router-id, one area 0, per-interface metric/timers)
  "ospf.enter": ctx => { M.ospf(ctx.model, true); ctx.s.router = "ospf"; },
  "ospf.remove": ctx => { M.ospfDelete(ctx.model); },
  "ospf.router-id": (ctx, [id]) => { ospfG(ctx).global.config["router-id"] = id; },
  "ospf.no-router-id": ctx => { delete ospfG(ctx).global.config["router-id"]; },
  "ospf.passive": (ctx, [i]) => { need(M.iface(ctx.model, i, false), `No interface named ${i}`); M.ospfIf(ctx.model, i).config.passive = true; },
  "ospf.no-passive": (ctx, [i]) => { const e = M.ospfIf(ctx.model, i, false); if (e) delete e.config.passive; },
  "ospf.network": (ctx, [p]) => { const l = ospfG(ctx)["openpacketrouter:networks"]; if (!l.includes(p)) l.push(p); },
  "ospf.network-if": (ctx, [p]) => { const l = ospfG(ctx)["openpacketrouter:networks"]; if (!l.includes(p)) l.push(p); },
  "ospf.no-network": (ctx, [p]) => { const g = ospfG(ctx), l = g["openpacketrouter:networks"]; need(l.includes(p), `OSPF is not running on ${p}`); g["openpacketrouter:networks"] = l.filter(x => x !== p); },
  "ospf.no-network-if": (ctx, [p]) => { const g = ospfG(ctx), l = g["openpacketrouter:networks"]; need(l.includes(p), `OSPF is not running on ${p}`); g["openpacketrouter:networks"] = l.filter(x => x !== p); },
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

  // ---- LLDP (kept under services.lldp, shaped like the spec's lldp block)
  "lldp.run": ctx => { const s = M.services(ctx.model); s.lldp ||= {}; },
  "lldp.remove": ctx => { const s = M.services(ctx.model); need(s.lldp, "LLDP is not running"); delete s.lldp; },
  "lldp.timer": (ctx, [n]) => { lldp(ctx).txInterval = +n; },
  "lldp.no-timer": ctx => { delete lldp(ctx).txInterval; },
  "lldp.hold": (ctx, [n]) => { lldp(ctx).holdMultiplier = +n; },
  "lldp.no-hold": ctx => { delete lldp(ctx).holdMultiplier; },
  "lldp.description": (ctx, [t]) => { lldp(ctx).description = t; },
  "lldp.no-description": ctx => { delete lldp(ctx).description; },

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
  "tcp.no-echo": (ctx, [port]) => { const t = M.services(ctx.model).tcp; need(t && t[port], `Nothing listens on TCP port ${port}`); delete t[port]; if (!Object.keys(t).length) delete M.services(ctx.model).tcp; },
};
