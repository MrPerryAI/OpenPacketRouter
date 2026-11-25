// Engine backend: the configuration model <-> one node of an OpenPacketRouter spec (docs/spec-format.md).
//
//   engineBackend(spec)                        keeps the spec in memory (terminal program, tests)
//   engineBackend({spec: () => s, setSpec})    a host that owns the spec (Studio); see the options below
//
// Options (all optional): spec() / setSpec(newSpec) -> errors[] (host-owned spec), cut: Set of link indexes that
// are unplugged (or a function returning it) and setCut(set) (Studio's cable cut; `shutdown` on a router or host interface uses it), state(device),
// run(action) -> result (a host that animates the run), save(spec), onRename(old, new).
//
// The mapping: interface addresses <-> ifaces, static routes <-> routes (0.0.0.0/0 <-> gw), switchport settings <->
// vlans, spanning tree <-> stp, shutdown on a switch port <-> blocked, shaping <-> the cable's shape/shapeBack,
// helper addresses <-> services.dhcpRelay, DNS / DHCP pools / TCP echo <-> services.*.

import {validateSpec, loadSpec, ACTIONS} from "../../../engine/src/spec.js";
import {intToIp, inSubnet} from "../../../engine/src/addr.js";
import * as M from "../model.js";
import {maskToPrefix, prefixToMask} from "../types.js";

const clone = o => JSON.parse(JSON.stringify(o));
const ref = (dev, port) => `${dev}:${port}`;

/** Ports of a device: switch ports come from the cables; IP devices have their interfaces (plus any cabled name). */
export function portsOf(spec, device) {
  const n = spec.nodes.find(x => x.name === device); if (!n) return [];
  const cabled = [];
  for (const l of spec.links) for (const r of l.slice(0, 2)) if (typeof r === "string" && r.startsWith(device + ":")) cabled.push(r.slice(device.length + 1));
  return n.kind === "switch" ? [...new Set([...cabled, ...Object.keys(n.ifaces || {})])] : [...new Set([...cabled, ...Object.keys(n.ifaces || {})])];   // cable order: stable
}
const linkIndex = (spec, device, port) => spec.links.findIndex(l => l[0] === ref(device, port) || l[1] === ref(device, port));

// ---------------------------------------------------------------- spec node -> model

export function modelFromSpec(spec, device, {cut = new Set()} = {}) {
  const n = spec.nodes.find(x => x.name === device);
  if (!n) throw new Error(`No device named ${device}`);
  const m = M.emptyModel(n.name);
  const ports = portsOf(spec, device);
  for (const p of ports) M.iface(m, p);

  if (n.kind === "switch") {
    for (const p of n.blocked || []) M.iface(m, p).config.enabled = false;
    if (n.agingTime !== undefined) M.fdb(m)["mac-aging-time"] = n.agingTime;
    if (n.forwardLldp) M.services(m).forwardLldp = true;
    // a Layer 3 switch: SVIs (vlanN with an address) and static routes
    for (const [name, a] of Object.entries(n.ifaces || {})) { const [ip, pl] = a.split("/"); M.ipv4(M.iface(m, name)).addresses.address[ip] = {config: {ip, "prefix-length": +pl}}; }
    for (const [dst, via] of n.routes || []) {
      const r = M.statics(m)[dst] ||= {prefix: dst, config: {prefix: dst}, "next-hops": {"next-hop": {}}};
      r["next-hops"]["next-hop"][via] = {index: via, config: {index: via, "next-hop": via}};
    }
    for (const [id, name] of Object.entries(n.vlanNames || {})) M.vlans(m)[id] = {"vlan-id": +id, config: {"vlan-id": +id, name}};
    for (const [p, c] of Object.entries(n.vlans || {})) {
      const sv = M.switchedVlan(M.iface(m, p));
      if (c.trunk) { sv["interface-mode"] = "TRUNK"; sv["trunk-vlans"] = [...c.trunk]; if (c.native !== undefined) sv["native-vlan"] = c.native; }
      else { sv["interface-mode"] = "ACCESS"; sv["access-vlan"] = c.access ?? 1; }
    }
    for (const [p, c] of Object.entries(n.portSecurity || {})) M.iface(m, p)["openpacketrouter:port-security"] = {max: c.max, ...(c.violation ? {violation: c.violation} : {})};
    for (const [p, c] of Object.entries(n.stormControl || {})) M.iface(m, p)["openpacketrouter:storm-control"] = {broadcast: {...c.broadcast}};
    for (const [cn, c] of Object.entries(n.channels || {})) {   // port-channels: members point at the channel, the channel is an interface (Po1)
      const po = M.iface(m, cn); po.config.type = "ieee8023adLag"; po.aggregation = {config: {"lag-type": "LACP"}};
      for (const p of c.ports) M.setLag(M.iface(m, p), cn);
      if (c.rate === "fast") M.lacpInterval(m, cn).interval = "FAST";
    }
    if (n.stp) {
      const g = M.stpGlobal(m); g["enabled-protocol"] = [n.stp.mode === "rstp" ? "RSTP" : "STP"];
      const map = {priority: "bridge-priority", hello: "hello-time", maxAge: "max-age", forwardDelay: "forwarding-delay", mac: "openpacketrouter:bridge-address"};
      for (const [k, leaf] of Object.entries(map)) if (n.stp[k] !== undefined) g[leaf] = n.stp[k];
      for (const [p, v] of Object.entries(n.stp.cost || {})) M.stpPort(m, p).cost = v;
      for (const [p, v] of Object.entries(n.stp.portPriority || {})) M.stpPort(m, p)["port-priority"] = v;
      for (const [p, v] of Object.entries(n.stp.edge || {})) if (v) M.stpPort(m, p)["edge-port"] = "EDGE_ENABLE";
    }
  } else {
    for (const [name, a] of Object.entries(n.ifaces || {})) {
      const v4 = M.ipv4(M.iface(m, name));
      if (a === "dhcp") v4.config["dhcp-client"] = true;
      else { const [ip, p] = a.split("/"); v4.addresses.address[ip] = {config: {ip, "prefix-length": +p}}; }
    }
    for (const p of ports) { const i = linkIndex(spec, device, p); if (i >= 0 && cut.has(i)) M.iface(m, p).config.enabled = false; }
    const st = M.statics(m);
    const addRoute = (prefix, via) => {
      const r = st[prefix] ||= {prefix, config: {prefix}, "next-hops": {"next-hop": {}}};
      r["next-hops"]["next-hop"][via] = {index: via, config: {index: via, "next-hop": via}};
    };
    for (const [dst, via] of n.routes || []) addRoute(dst, via);
    if (n.gw) addRoute("0.0.0.0/0", n.gw);
    const sv = n.services || {}, out = M.services(m);
    if (sv.dns) out.dns = {enabled: true, hosts: {...sv.dns}};
    if (sv.dhcp) {
      const pool = (p, extra) => ({...(p.range ? {range: [...p.range]} : {}), ...(extra && p.mask ? {netmask: p.mask} : {}),
        ...(p.router ? {"default-router": p.router} : {}), ...(p.dns ? {"dns-server": p.dns} : {}), ...(p.lease !== undefined ? {lease: p.lease} : {})});
      const pools = {POOL1: pool(sv.dhcp, false)};
      (sv.dhcp.pools || []).forEach((p, i) => { pools[`POOL${i + 2}`] = pool(p, true); });
      out["dhcp-server"] = {pools};
    }
    if (sv.dhcpRelay) for (const c of sv.dhcpRelay.clients || Object.keys(n.ifaces || {})) M.relayHelpers(m, c).push(sv.dhcpRelay.server);
    if (sv.tcp) out.tcp = {...sv.tcp};
    if (n.lldp) out.lldp = {...n.lldp};
    if (n.vrrp) out.vrrp = n.vrrp.map(g => ({...g}));
    if (n.nat) {
      out.nat = {...(n.nat.overload ? {overload: n.nat.overload === true ? true : {...n.nat.overload}} : {}), ...(n.nat.static?.length ? {static: n.nat.static.map(x => ({...x}))} : {})};
      if (!Object.keys(out.nat).length) delete out.nat;
      for (const side of ["inside", "outside"]) for (const ifn of n.nat[side] || []) M.iface(m, ifn)["openpacketrouter:nat"] = side;
    }
    if (n.acl) {
      out.acl = {lists: JSON.parse(JSON.stringify(n.acl.lists || {}))};
      for (const [ifn, b] of Object.entries(n.acl.bind || {})) M.iface(m, ifn)["openpacketrouter:acl"] = {...b};
    }
    if (n.rip) { const {networks, passive, timers, splitHorizon, triggered} = n.rip;
      out.rip = {networks: [...networks], ...(passive ? {passive: [...passive]} : {}), ...(timers ? {timers: {...timers}} : {}),
        ...(splitHorizon !== undefined ? {splitHorizon} : {}), ...(triggered !== undefined ? {triggered} : {})}; }
    if (n.ospf) {
      const o = M.ospf(m, true);
      if (n.ospf.routerId) o.global.config["router-id"] = n.ospf.routerId;
      o["openpacketrouter:networks"].push(...n.ospf.networks);
      for (const p of n.ospf.passive || []) M.ospfIf(m, p).config.passive = true;
      for (const [p, c] of Object.entries(n.ospf.interfaces || {})) {
        const e = M.ospfIf(m, p), t = e.timers.config;
        if (c.type) e.config["network-type"] = c.type === "point-to-point" ? "POINT_TO_POINT_NETWORK" : "BROADCAST_NETWORK";
        if (c.cost !== undefined) e.config.metric = c.cost;
        if (c.priority !== undefined) e.config.priority = c.priority;
        if (c.hello !== undefined) t["hello-interval"] = c.hello;
        if (c.dead !== undefined) t["dead-interval"] = c.dead;
        if (c.retransmit !== undefined) t["retransmission-interval"] = c.retransmit;
      }
    }
  }
  spec.links.forEach(l => {
    const o = l[3] || {};
    if (typeof l[0] === "string" && l[0].startsWith(device + ":") && o.shape) M.iface(m, l[0].split(":")[1])["openpacketrouter:shaper"] = {...o.shape};
    if (typeof l[1] === "string" && l[1].startsWith(device + ":") && o.shapeBack) M.iface(m, l[1].split(":")[1])["openpacketrouter:shaper"] = {...o.shapeBack};
  });
  return m;
}

// ---------------------------------------------------------------- model -> spec

/** A new spec with the device's configuration replaced by the model, and the cut set to apply. Throws on what the spec can't say. */
export function specWithModel(spec, device, m, {cut = new Set()} = {}) {
  const out = clone(spec), newCut = new Set(cut);
  const i = out.nodes.findIndex(x => x.name === device);
  if (i < 0) throw new Error(`No device named ${device}`);
  const old = out.nodes[i], name = M.hostname(m);
  if (name !== device && out.nodes.some(x => x.name === name)) throw new Error(`${name} is already the name of another device`);
  const n = {name, kind: old.kind};
  for (const [k, v] of Object.entries(old)) if (!["name", "kind", "ifaces", "gw", "routes", "services", "lldp", "vrrp", "rip", "acl", "nat", "ospf", "blocked", "stp", "vlans", "agingTime", "forwardLldp", "vlanNames", "channels", "portSecurity", "stormControl"].includes(k)) n[k] = v;
  const ports = portsOf(spec, device);
  const ifs = M.interfaces(m);

  if (old.kind === "switch") {
    for (const p of Object.keys(ifs)) if (!ports.includes(p) && !/^vlan\d+$/.test(p) && !M.isLagName(p)) throw new Error(`${p}: a switch's ports come from its cables, and nothing is plugged into ${p}`);
    const svis = {};
    for (const [p, ifc] of Object.entries(ifs)) {
      const addrs = M.addressesOf(ifc);
      if (addrs.length > 1) throw new Error(`${p}: the engine keeps one address per interface`);
      if (addrs.length) {
        if (!/^vlan\d+$/.test(p)) throw new Error(`${p}: only a VLAN interface (vlanN) of a switch takes an address`);
        svis[p] = `${addrs[0].ip}/${addrs[0].prefixLength}`;
      }
    }
    if (Object.keys(svis).length) n.ifaces = svis;
    const srt = [];
    for (const r of M.staticList(m)) srt.push([r.prefix, r.nextHop]);
    if (srt.length) n.routes = srt;
    const blocked = ports.filter(p => ifs[p] && ifs[p].config.enabled === false);
    if (blocked.length) n.blocked = blocked;
    if (M.fdb(m)["mac-aging-time"] !== undefined) n.agingTime = M.fdb(m)["mac-aging-time"];
    if (M.services(m).forwardLldp) n.forwardLldp = true;
    const channels = {};   // members in cable order; the channel's rate is slow unless `lacp rate fast`
    for (const p of ports) { const id = ifs[p] && M.lagOf(ifs[p]); if (id) (channels[id] ||= {ports: []}).ports.push(p); }
    for (const [id, c] of Object.entries(channels)) if (M.lacpInterval(m, id, false)?.interval === "FAST") c.rate = "fast";
    if (Object.keys(channels).length) n.channels = channels;
    const vl = {};
    for (const p of [...ports, ...Object.keys(channels)]) {
      const sv = ifs[p] && M.switchedVlan(ifs[p], false);
      if (!sv || !sv["interface-mode"]) continue;
      vl[p] = sv["interface-mode"] === "TRUNK" ? {trunk: [...sv["trunk-vlans"]], ...(sv["native-vlan"] !== undefined ? {native: sv["native-vlan"]} : {})} : {access: sv["access-vlan"]};
    }
    if (Object.keys(vl).length) n.vlans = vl;
    const psec = {}; for (const p of ports) { const c = ifs[p]?.["openpacketrouter:port-security"]; if (c) psec[p] = {max: c.max, ...(c.violation ? {violation: c.violation} : {})}; }
    if (Object.keys(psec).length) n.portSecurity = psec;
    const storm = {}; for (const p of ports) { const c = ifs[p]?.["openpacketrouter:storm-control"]; if (c) storm[p] = {broadcast: {...c.broadcast}}; }
    if (Object.keys(storm).length) n.stormControl = storm;
    const vn = {}; for (const [id, v] of Object.entries(M.vlans(m))) if (v.config?.name) vn[id] = v.config.name;
    if (Object.keys(vn).length) n.vlanNames = vn;
    const g = M.stpGlobal(m), portCfg = m.stp.interfaces.interface;
    if (M.stpEnabled(m)) {
      const s = {};
      if (g["enabled-protocol"][0] === "RSTP") s.mode = "rstp";
      const map = {"bridge-priority": "priority", "hello-time": "hello", "max-age": "maxAge", "forwarding-delay": "forwardDelay", "openpacketrouter:bridge-address": "mac"};
      for (const [leaf, k] of Object.entries(map)) if (g[leaf] !== undefined) s[k] = g[leaf];
      for (const [p, e] of Object.entries(portCfg)) {
        if (e.config.cost !== undefined) (s.cost ||= {})[p] = e.config.cost;
        if (e.config["port-priority"] !== undefined) (s.portPriority ||= {})[p] = e.config["port-priority"];
        if (e.config["edge-port"] === "EDGE_ENABLE") (s.edge ||= {})[p] = true;
      }
      n.stp = s;
    } else if (Object.values(portCfg).some(e => e.config.cost !== undefined || e.config["port-priority"] !== undefined || e.config["edge-port"] !== undefined) || Object.keys(g).length)
      throw new Error("Spanning tree is off on this switch: turn it on first (spanning-tree)");
  } else {
    const ifaces = {};
    for (const [p, ifc] of Object.entries(ifs)) {
      const addrs = M.addressesOf(ifc);
      if (addrs.length > 1) throw new Error(`${p}: the engine keeps one address per interface`);
      if (M.dhcpClientOf(ifc)) ifaces[p] = "dhcp";
      else if (addrs.length) ifaces[p] = `${addrs[0].ip}/${addrs[0].prefixLength}`;
      if (M.switchedVlan(ifc, false)?.["interface-mode"]) throw new Error(`${p}: switchport settings are for switches`);
      const li = linkIndex(spec, device, p);
      if (ifc.config.enabled === false) { if (li < 0) throw new Error(`${p} has no cable to turn off`); newCut.add(li); }
      else if (li >= 0) newCut.delete(li);
    }
    for (const p of Object.keys(old.ifaces || {})) if (!(p in ifaces) && linkIndex(spec, device, p) >= 0)
      throw new Error(`${p} has a cable, and the engine needs an address on every cabled interface: change it with ip address (or ip address dhcp) instead of removing it`);
    if (Object.keys(ifaces).length) n.ifaces = ifaces;
    const routes = [];
    for (const r of M.staticList(m)) {
      if (r.prefix === "0.0.0.0/0") { if (n.gw) throw new Error("The engine keeps one default route"); n.gw = r.nextHop; }
      else routes.push([r.prefix, r.nextHop]);
    }
    if (routes.length) n.routes = routes;
    const s = M.services(m), svc = {};
    if (s.dns) {
      if (s.dns.enabled) svc.dns = {...s.dns.hosts};   // names without the server stay pending in the model
    }
    if (s["dhcp-server"]) {
      const pools = Object.entries(s["dhcp-server"].pools);
      // A pool reaches the spec once it is complete (a range; a netmask for the extra pools); until then it is pending.
      const conv = ([, p], extra) => ({range: [...p.range], ...(extra ? {mask: p.netmask} : {}), ...(p.lease !== undefined ? {lease: p.lease} : {}),
          ...(p["default-router"] ? {router: p["default-router"]} : {}), ...(p["dns-server"] ? {dns: p["dns-server"]} : {})});
      if (pools.length && pools[0][1].netmask) throw new Error(`DHCP pool ${pools[0][0]} serves this device's own network: leave out its netmask (only the extra, relayed pools have one)`);
      if (pools.length && pools[0][1].range) {
        svc.dhcp = conv(pools[0], false);
        const extra = pools.slice(1).filter(([, p]) => p.range && p.netmask);
        if (extra.length) svc.dhcp.pools = extra.map(p => conv(p, true));
      }
    }
    const relay = Object.entries(M.relayInterfaces(m)).filter(([, e]) => e.config["helper-address"].length);
    if (relay.length) {
      const servers = new Set(relay.flatMap(([, e]) => e.config["helper-address"]));
      if (servers.size > 1) throw new Error("The engine relays to one DHCP server: use the same helper address everywhere");
      svc.dhcpRelay = {server: [...servers][0], clients: relay.map(([p]) => p)};
    }
    if (s.tcp) svc.tcp = {...s.tcp};
    if (s.lldp) n.lldp = {...s.lldp};
    if (s.vrrp?.some(g => g.ip)) n.vrrp = s.vrrp.filter(g => g.ip).map(g => ({...g}));
    if (s.rip && s.rip.networks.length) n.rip = JSON.parse(JSON.stringify(s.rip));
    if (s.acl) {
      const bind = {};
      for (const [ifn, ifc] of Object.entries(ifs)) if (ifc["openpacketrouter:acl"]) bind[ifn] = {...ifc["openpacketrouter:acl"]};
      n.acl = {lists: JSON.parse(JSON.stringify(s.acl.lists)), ...(Object.keys(bind).length ? {bind} : {})};
    }
    const sides = {inside: [], outside: []};
    for (const [ifn, ifc] of Object.entries(ifs)) if (ifc["openpacketrouter:nat"]) sides[ifc["openpacketrouter:nat"]].push(ifn);
    if (s.nat || sides.inside.length || sides.outside.length) n.nat = {inside: sides.inside, outside: sides.outside, ...(s.nat ? JSON.parse(JSON.stringify(s.nat)) : {})};
    if (Object.keys(svc).length) n.services = svc;
    const o = M.ospf(m);
    // OSPF reaches the spec once it has a network (until then `router ospf` is pending in the model)
    if (o && o["openpacketrouter:networks"].length) {
      const sp = {networks: [...o["openpacketrouter:networks"]]};
      if (o.global.config["router-id"]) sp.routerId = o.global.config["router-id"];
      const ifc = {}, pas = [];
      for (const [p, e] of Object.entries(o.areas.area["0"].interfaces.interface)) {
        const c = e.config, t = e.timers.config, r = {};
        if (c["network-type"]) r.type = c["network-type"] === "POINT_TO_POINT_NETWORK" ? "point-to-point" : "broadcast";
        if (c.priority !== undefined) r.priority = c.priority;
        if (c.metric !== undefined) r.cost = c.metric;
        if (t["hello-interval"] !== undefined) r.hello = t["hello-interval"];
        if (t["dead-interval"] !== undefined) r.dead = t["dead-interval"];
        if (t["retransmission-interval"] !== undefined) r.retransmit = t["retransmission-interval"];
        if (c.passive) pas.push(p);
        if (Object.keys(r).length) ifc[p] = r;
      }
      if (pas.length) sp.passive = pas;
      if (Object.keys(ifc).length) sp.interfaces = ifc;
      n.ospf = sp;
    }
  }

  out.nodes[i] = n;
  // shaping on this device's ends of its cables
  out.links = out.links.map(l => {
    const ends = [0, 1].filter(e => typeof l[e] === "string" && l[e].startsWith(device + ":"));
    if (!ends.length) return l;
    const o = {...(l[3] || {})}; let touched = false;
    for (const e of ends) {
      const key = e === 0 ? "shape" : "shapeBack", sh = ifs[l[e].split(":")[1]]?.["openpacketrouter:shaper"];
      if (sh) { o[key] = {...sh}; touched = true; } else if (o[key]) { delete o[key]; touched = true; }
    }
    if (!touched) return l;
    const base = [l[0], l[1], l.length >= 3 ? l[2] : 1];
    return Object.keys(o).length ? [...base, o] : (l.length >= 3 ? base : [l[0], l[1]]);
  });
  if (name !== device) out.links = out.links.map(l => l.map(x => typeof x === "string" && x.startsWith(device + ":") ? name + x.slice(device.length) : x));
  return {spec: out, cut: newCut};
}

// ---------------------------------------------------------------- running the engine for show and ping

function convergeTime(spec) {
  let t = 0;
  for (const n of spec.nodes || []) if (n.kind === "switch" && n.stp) t = Math.max(t, 2 * (n.stp.forwardDelay ?? 15) + (n.stp.maxAge ?? 20) + 1);
  for (const n of spec.nodes || []) if (n.kind === "switch" && n.channels) t = Math.max(t, 6);   // LACP bundles the cables about 3 s after the switches start
  // OSPF: adjacencies need a few dead intervals (broadcast networks wait one for the DR election), then SPF runs
  for (const n of spec.nodes || []) if (n.ospf) {
    const dead = Math.max(1, ...Object.keys(n.ifaces || {}).map(p => { const c = n.ospf.interfaces?.[p] || {}; return c.dead ?? 4 * (c.hello ?? 10); }));
    t = Math.max(t, Math.ceil(1.5 * dead) + 10);
  }
  for (const n of spec.nodes || []) for (const g of n.vrrp || []) t = Math.max(t, 3 * (g.interval ?? 1) + (g.interval ?? 1) + 1);   // the master-down timer runs 3 intervals + skew, then the winner speaks
  if ((spec.nodes || []).some(n => n.lldp)) t = Math.max(t, 3);   // the first LLDPDU leaves 1 s after start
  // RIP learns routes over a few update periods
  for (const n of spec.nodes || []) if (n.rip) t = Math.max(t, 3 * (n.rip.timers?.update ?? 30));
  return t;
}
function freshNet(spec, cut) {
  const net = loadSpec(spec);
  for (const i of cut) if (net.links[i]) net.links[i].up = false;
  const t = convergeTime(spec); net._start(); if (t) net.run(t);
  return net;
}

/** Operational state of one device from a running network: interfaces, routes, ARP, MAC table, spanning tree, leases. */
function routesOf(n) {
  const routes = [];
  for (const i of Object.values(n.ifaces)) if (i.ip) routes.push({prefix: `${intToIp(i.net)}/${i.prefix}`, protocol: "connected", interface: i.name});
  for (const r of n.routes) {
    const out = Object.values(n.ifaces).find(i => i.ip && inSubnet(r.via, i.net, i.mask));
    routes.push({prefix: r.cidr || `${intToIp(r.net)}/${r.prefix}`, protocol: "static", nextHop: r.via, interface: out ? out.name : null});
  }
  if (n.ospf) for (const r of n.ospf.fib()) routes.push({prefix: r.cidr, protocol: "ospf", nextHop: r.gw, interface: r.iface, metric: r.metric});
  if (n.rip) for (const r of n.rip.fib()) routes.push({prefix: r.cidr, protocol: "rip", nextHop: r.gw, interface: r.iface ?? null, metric: r.metric});
  return routes;
}

export function stateOf(net, device, spec) {
  const n = net.node(device); if (!n) return {};
  const cabledUp = p => { const i = n.ifaces[p]; return !!(i && i.link && i.link.up !== false); };
  if (n.kind === "switch") {
    const svis = n.l3 ? Object.values(n.l3.ifaces) : [];
    // An SVI is up while some cabled, forwarding port carries its VLAN (as a Linux vlan device on a bridge follows its ports).
    const sviUp = i => Object.keys(n.ifaces).some(p => cabledUp(p) && !n.blocked.has(p) && n.vcfg(p).member.has(i.vid));
    const base = {
      interfaces: [...Object.keys(n.ifaces).map(p => ({name: p, status: !cabledUp(p) ? "down" : n.blocked.has(p) ? "admin-down" : "up"})),
        ...svis.map(i => ({name: i.name, address: i.ip ? `${i.ip}/${i.prefix}` : null, mac: i.mac, status: sviUp(i) ? "up" : "down"}))],
      portSecurity: n.portSecurity(),
      stormControl: n.stormControl(),
      mac: n.macTable().map(e => ({...e, vlan: e.vlan || 1})),
      stp: n.stp && n.stp.started ? n.stp.describe() : null,
      lacp: [...n.channels.values()].map(c => c.describe()),
    };
    if (!n.l3) return base;
    return {...base, routes: routesOf(n.l3), arp: [...n.l3.arp].map(([ip, e]) => ({ip, mac: e.mac, interface: e.iface}))};
  }
  const routes = routesOf(n);
  return {
    interfaces: Object.values(n.ifaces).map(i => ({name: i.name, address: i.ip ? `${i.ip}/${i.prefix}` : null, dhcp: !!i.dhcp, mac: i.mac,
      status: !i.link ? "down" : i.link.up === false ? "admin-down" : "up"})),
    routes,
    arp: [...n.arp].map(([ip, e]) => ({ip, mac: e.mac, interface: e.iface})),
    ...(n.nat ? {nat: {translations: n.nat.translations(), hits: n.nat.hits, misses: n.nat.misses}} : {}),
    ospf: n.ospf ? {routerId: n.ospf.routerId(), neighbors: n.ospf.neighbors(), interfaces: n.ospf.interfaces(), routes: n.ospf.describe(), database: n.ospf.database()} : null,
    ...(n.vrrp ? {vrrp: n.vrrp.describe()} : {}),
    ...(n.lldp ? {lldp: {txInterval: n.lldp.txInterval, holdMultiplier: n.lldp.holdMultiplier, description: n.lldp.description, neighbors: n.lldp.neighbors()}} : {}),
    ...(n.rip ? {rip: n.rip.describe()} : {}),
    leases: n.dhcpLeases ? [...n.dhcpLeases].map(([mac, ip]) => ({mac, ip})) : [],
  };
}

// ---------------------------------------------------------------- the backend

export function engineBackend(init, opts = {}) {
  const hosted = typeof init === "object" && typeof init.spec === "function";
  const o = hosted ? init : opts;
  let mine = hosted ? null : clone(init);
  let myCut = new Set(), lastNet = null;
  // The last model applied per device, with the spec it produced: settings the spec can't hold yet (a DHCP pool
  // still without its range, an interface with no address) stay visible until the spec is changed from elsewhere.
  const cache = new Map();
  const keyOf = () => JSON.stringify(spec()) + "|" + [...cut()].sort().join(",");
  const spec = () => hosted ? o.spec() : mine;
  const cut = () => o.cut ? new Set(typeof o.cut === "function" ? o.cut() : o.cut) : myCut;   // a Set, or a function returning one

  return {
    name: "engine",
    kind: device => spec().nodes.find(n => n.name === device)?.kind ?? null,
    devices: () => spec().nodes.map(n => n.name),
    ports: device => portsOf(spec(), device),
    canCreatePorts: () => false,   // a device's interfaces are the spec's: its ifaces and its cables
    getConfig(device) {
      const c = cache.get(device);
      return c && c.key === keyOf() ? clone(c.model) : modelFromSpec(spec(), device, {cut: cut()});
    },
    /** Apply a model. Refuses (returns the reasons) when the spec would gain a problem it did not have. */
    setConfig(device, model) {
      let next;
      try { next = specWithModel(spec(), device, model, {cut: cut()}); } catch (e) { return [e.message]; }
      // Refuse only problems the spec did not have before (a half-built device may already have some).
      const newName = M.hostname(model), esc = device.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const sig = e => `${e.path} ${e.message.replace(/\s*\(.*\)$/, "")}`;   // "(it has eth0)" changes as interfaces are added
      const before = new Set(validateSpec(spec()).errors.map(e => sig({...e, message: e.message.replace(new RegExp(`\\b${esc}\\b`, "g"), newName)})));
      const fresh = validateSpec(next.spec).errors.filter(e => !before.has(sig(e))).map(e => e.message);
      if (fresh.length) return fresh;
      if (hosted && o.setSpec) { const errs = o.setSpec(next.spec) || []; if (errs.length) return errs; }
      else mine = next.spec;
      if (o.setCut) o.setCut(next.cut); else myCut = next.cut;
      lastNet = null;
      cache.delete(device); cache.set(newName, {key: keyOf(), model: clone(model)});
      if (newName !== device && o.onRename) o.onRename(device, newName);
      return [];
    },
    state(device) {
      if (o.state) return o.state(device);
      if (!validateSpec(spec()).ok) return {};
      if (!lastNet) lastNet = freshNet(spec(), cut());
      return stateOf(lastNet, device, spec());
    },
    run(device, action) {
      const a = {...action, src: device};
      if (o.run) return o.run(a);
      const net = freshNet(spec(), cut());
      net.flushCaches();
      const result = ACTIONS[a.do].run(net, a);
      net.settle(a.settle ?? 1);
      lastNet = net;
      return result;
    },
    save: o.save ? () => o.save(spec()) : undefined,
    spec,
  };
}

export {prefixToMask, maskToPrefix};
