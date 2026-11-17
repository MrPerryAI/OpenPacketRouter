// Run a list of actions on a network spec and print, per action, the result and
// the frames sent on every cable direction ("A:if>B:if": n).
//   node tools/run_spec.mjs spec.json actions.json
//   node tools/run_spec.mjs --describe spec.json     (MACs, port numbers, STP and VLAN settings)
//
// Traffic actions (ping, traceroute, dns, udp) flush caches (ARP, switch MAC
// tables) first, so each starts cold and its frame counts don't depend on the
// order of actions. Spanning-tree state is never flushed.
//
// Actions may carry "at": seconds since power-on (when every switch starts
// spanning tree). The clock runs to that time first. Other actions:
//   {"do": "stp"}                          spanning-tree state of every STP switch
//   {"do": "observe", "seconds": 6}        BPDUs per cable direction, and the last one seen on each
//   {"do": "link", "cable": "SW1:p2", "up": false}   unplug / plug a cable
// Output per action: {action, result, frames, bpdus, tagged}; "frames" excludes
// BPDUs; "tagged" counts 802.1Q-tagged frames per "cable#vlan".
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {Network, ping, traceroute, dns, udpRequest} from "../src/index.js";

export function describeNet(net) {
  const out = {};
  for (const n of net.nodes.values()) {
    const d = {kind: n.kind, ifaces: {}};
    for (const i of Object.values(n.ifaces)) d.ifaces[i.name] = {mac: i.mac, ...(i.parent ? {parent: i.parent, vlan: i.vlan} : {})};
    if (n.kind === "switch") {
      Object.assign(d, {mac: n.mac, vlanAware: n.vlanAware, stp: n.stp ? {priority: n.stp.priority, hello: n.stp.bHello, forwardDelay: n.stp.bFd, maxAge: n.stp.bMaxAge} : null, ports: {}});
      for (const i of Object.values(n.ifaces)) d.ports[i.name] = {no: i.no, ...(i.stp ? {cost: i.stp.cost, priority: i.stp.prio} : {}),
        ...(i.vlan ? {pvid: i.vlan.pvid, untagged: [...i.vlan.untagged], tagged: [...i.vlan.tagged]} : {})};
    }
    out[n.name] = d;
  }
  return out;
}

export const bpduView = (f, key) => f.bpdu.type === "tcn" ? {src: f.src, type: "tcn"} :
  {src: f.src, type: "config", tc: f.bpdu.tc, tca: f.bpdu.tca, root: f.bpdu.root, cost: f.bpdu.cost, bridge: f.bpdu.bridge,
    port: "0x" + f.bpdu.port.toString(16).padStart(4, "0"), age: Math.floor(f.bpdu.age), maxAge: f.bpdu.maxAge, hello: f.bpdu.hello, fwdDelay: f.bpdu.fwdDelay};

export function runActions(net, actions) {
  const out = [];
  for (const a of actions) {
    if (a.at != null) {
      if (a.at < net.time - 1e-9) throw new Error(`action at ${a.at}s comes after the clock (${net.time.toFixed(3)}s)`);
      net.runTo(a.at);
    }
    const traffic = ["ping", "traceroute", "dns", "udp"].includes(a.do);
    if (traffic) net.flushCaches();
    const before = net.snapshot();
    let result;
    if (a.do === "ping") result = ping(net, a.src, a.dst, {ttl: a.ttl ?? 64, timeout: a.timeout ?? 2});
    else if (a.do === "traceroute") result = traceroute(net, a.src, a.dst, {maxHops: a.maxHops ?? 8});
    else if (a.do === "dns") result = dns(net, a.src, a.server, a.name);
    else if (a.do === "udp") result = udpRequest(net, a.src, a.dst, a.port, {probe: true});
    else if (a.do === "stp") result = net.stpReport();
    else if (a.do === "link") { net.setLink(a.cable, a.up); result = {ok: true}; }
    else if (a.do === "observe") {
      const last = {}; const tap = (key, f) => { if (f.type === "bpdu") last[key] = bpduView(f); };
      net.taps.add(tap); net.run(net.time + a.seconds); net.taps.delete(tap);
      result = {last};
    } else throw new Error(`unknown action ${a.do}`);
    net.run(net.time + (a.settle ?? (traffic ? 1 : 0)));
    out.push({action: a, result, frames: net.diff(before), bpdus: net.diff(before, "bpdus"), tagged: net.diff(before, "tagged")});
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  if (args[0] === "--describe") {
    const net = Network.fromSpec(JSON.parse(fs.readFileSync(args[1], "utf8")));
    process.stdout.write(JSON.stringify(describeNet(net), null, 1));
  } else {
    const [specFile, actionsFile] = args;
    const net = Network.fromSpec(JSON.parse(fs.readFileSync(specFile, "utf8")));
    process.stdout.write(JSON.stringify(runActions(net, JSON.parse(fs.readFileSync(actionsFile, "utf8"))), null, 1));
  }
}
