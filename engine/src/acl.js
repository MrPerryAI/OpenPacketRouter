// IPv4 access lists on routers: stateless packet filters bound to an interface, in or out.
//
//   "acl": {
//     "lists": {"WEB-ONLY": [{"action": "permit", "proto": "tcp", "src": "10.1.0.0/24", "dst": "10.2.0.10", "dport": 80},
//                            {"action": "permit", "proto": "icmp"}]},
//     "bind": {"eth0": {"in": "WEB-ONLY"}, "eth1": {"out": "OTHER"}}
//   }
//
// A list is checked top to bottom; the first rule that matches decides. A packet nothing matches is denied
// (the implicit deny at the end of every bound list). A denied packet is dropped and the router answers the
// sender with ICMP "destination unreachable, administratively prohibited" (type 3, code 13), like a Linux
// `reject with icmp type admin-prohibited`.
//
// Where it acts (the same places as Linux netfilter, so frames match):
//   in  - every IPv4 packet that arrives on the interface, before any routing decision (netfilter prerouting):
//         transit packets and packets for the router itself;
//   out - packets the router forwards out of the interface (netfilter forward), after the TTL check and the
//         route lookup. Packets the router itself originates are never filtered.
// Multicast (224.0.0.0/4) and the limited broadcast 255.255.255.255 are never filtered, so routing protocols,
// DHCP and similar keep working whatever the lists say.
//
// Rule fields: action ("permit" | "deny"), proto ("ip" = any, default; "icmp" | "tcp" | "udp"), src and dst
// ("any", an address, or a prefix like 10.0.0.0/24; default any), sport and dport (a port number or "lo-hi";
// tcp and udp only), icmpType (a number; icmp only), established (true: tcp segments with ACK or RST set).
import {ipToInt, parseCidr, inSubnet} from "./addr.js";

export const ACL_REJECT = {type: 3, code: 13};

/** "any" | "10.0.0.5" | "10.0.0.0/24" → {net, mask} or null (any). */
export function parseAddr(x) {
  if (x === undefined || x === "any") return null;
  const c = parseCidr(String(x).includes("/") ? x : `${x}/32`);
  return {net: c.net, mask: c.mask};
}

export function parsePort(x) {
  if (x === undefined) return null;
  if (typeof x === "number") return [x, x];
  const m = /^(\d+)-(\d+)$/.exec(String(x));
  return m ? [+m[1], +m[2]] : null;
}

const inRange = (r, v) => r === null || (v >= r[0] && v <= r[1]);
const inNet = (n, ip) => n === null || inSubnet(ip, n.net, n.mask);

export class Acl {
  constructor(cfg) {
    this.lists = {};
    for (const [name, rules] of Object.entries(cfg.lists || {})) {
      this.lists[name] = rules.map(r => ({
        permit: r.action === "permit", proto: r.proto || "ip", src: parseAddr(r.src), dst: parseAddr(r.dst),
        sport: parsePort(r.sport), dport: parsePort(r.dport), icmpType: r.icmpType, established: !!r.established,
      }));
    }
    this.bind = cfg.bind || {};
  }

  matches(rule, p) {
    if (rule.proto !== "ip" && rule.proto !== p.proto) return false;
    if (!inNet(rule.src, p.src) || !inNet(rule.dst, p.dst)) return false;
    if (rule.proto === "tcp" && (!inRange(rule.sport, p.tcp.sport) || !inRange(rule.dport, p.tcp.dport))) return false;
    if (rule.proto === "tcp" && rule.established && !/[AR]/.test(p.tcp.flags)) return false;
    if (rule.proto === "udp" && (!inRange(rule.sport, p.udp.sport) || !inRange(rule.dport, p.udp.dport))) return false;
    if (rule.proto === "icmp" && rule.icmpType !== undefined && p.icmp.type !== rule.icmpType) return false;
    return true;
  }

  /** {permit, list, rule}: rule is the index of the deciding rule, -1 for the implicit deny, null if nothing is bound. */
  check(dir, ifname, p) {
    const name = this.bind[ifname]?.[dir];
    if (!name || !this.lists[name]) return {permit: true, list: null, rule: null};
    if (p.dst === "255.255.255.255" || (ipToInt(p.dst) >>> 28) === 14) return {permit: true, list: name, rule: null};
    const rules = this.lists[name];
    for (let i = 0; i < rules.length; i++) if (this.matches(rules[i], p)) return {permit: rules[i].permit, list: name, rule: i};
    return {permit: false, list: name, rule: -1};
  }
}
