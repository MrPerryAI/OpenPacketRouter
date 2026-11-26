// Things clients do: ping, traceroute, DNS lookups, a UDP request.
// Each runs the simulation until an answer arrives or the timeout passes.

const ICMP_ERR = {11: "time exceeded", 3: {0: "net unreachable", 1: "host unreachable", 2: "protocol unreachable", 3: "port unreachable", 13: "administratively prohibited"}};
const errName = i => i.type === 11 ? ICMP_ERR[11] : (ICMP_ERR[3][i.code] || "unreachable");

/** The IP stack of a device: a Layer 3 switch's lives in `l3` (its SVIs); routers and hosts are their own. */
export const stackOf = (net, name) => { const n = net.node(name); if (n.l3 !== undefined && !n.l3) throw new Error(`${name} is a switch with no IP interfaces (give it SVIs: "ifaces": {"vlan10": ...})`); return n.l3 || n; };

function await_(net, srcName, send, match, timeout) {
  const node = stackOf(net, srcName); let res = null; const t0 = net.time;
  const fn = (n, p) => { if (n === node && !res) { const r = match(p); if (r) res = {...r, rtt_ms: +((net.time - t0) * 1000).toFixed(3)}; } };
  net.listeners.add(fn);
  try {
    if (!send(node)) return {ok: false, error: "no route"};
    net.run(net.time + timeout, () => res);
    return res || {ok: false, error: "timeout"};
  } finally { net.listeners.delete(fn); }
}

export function ping(net, src, dst, {ttl = 64, timeout = 2} = {}) {
  const id = net._pingId = ((net._pingId || 0) + 1) & 0xffff;
  return await_(net, src, n => n.sendIp({dst, ttl, proto: "icmp", icmp: {type: 8, code: 0, id, seq: 1}}), p => {
    if (p.proto !== "icmp") return null;
    if (p.icmp.type === 0 && p.icmp.id === id) return {ok: true, from: p.src};
    if ((p.icmp.type === 3 || p.icmp.type === 11) && p.icmp.orig && p.icmp.orig.id === id) return {ok: false, from: p.src, error: errName(p.icmp)};
    return null;
  }, timeout);
}

export function traceroute(net, src, dst, {maxHops = 12, timeout = 1} = {}) {
  const hops = [];
  for (let ttl = 1; ttl <= maxHops; ttl++) {
    const r = ping(net, src, dst, {ttl, timeout});
    hops.push(r.from ? {ttl, from: r.from, kind: r.ok ? "reached" : r.error} : {ttl, from: null, kind: "no answer"});
    if (r.ok || (r.from && r.error !== "time exceeded")) break;   // keep probing past silent hops, like real traceroute
  }
  return {reached: hops.some(h => h.kind === "reached"), hops};
}

export function udpRequest(net, src, dst, dport, payload, {timeout = 2} = {}) {
  let sport; const node = stackOf(net, src);
  try {
    return await_(net, src, n => { sport = n.nextPort++; n.sockets.add(sport); return n.sendIp({dst, ttl: 64, proto: "udp", udp: {sport, dport, payload}}); }, p => {
      if (p.proto === "udp" && p.udp.dport === sport && p.src === dst) return {ok: true, from: p.src, payload: p.udp.payload};
      if (p.proto === "icmp" && p.icmp.type === 3 && p.icmp.orig && p.icmp.orig.sport === sport) return {ok: false, from: p.src, error: errName(p.icmp)};
      return null;
    }, timeout);
  } finally { node.sockets.delete(sport); }   // the client closes its socket once it has its answer
}

export function dns(net, src, server, name, opts) {
  const r = udpRequest(net, src, server, 53, {q: name}, opts);
  return r.ok ? {ok: true, from: r.from, answer: r.payload.a} : r;
}

// ---- syslog (RFC 3164 over UDP 514): one datagram from the client, no answer. The text mirrors what util-linux `logger -n HOST -P 514 -d`
// sends: "<PRI>Mmm dd hh:mm:ss HOSTNAME TAG: MESSAGE", PRI = facility * 8 + severity (default user.notice = 13).
export const FACILITIES = {kern: 0, user: 1, mail: 2, daemon: 3, auth: 4, syslog: 5, lpr: 6, news: 7, uucp: 8, cron: 9, authpriv: 10, ftp: 11,
  local0: 16, local1: 17, local2: 18, local3: 19, local4: 20, local5: 21, local6: 22, local7: 23};
export const SEVERITIES = {emerg: 0, alert: 1, crit: 2, err: 3, warning: 4, notice: 5, info: 6, debug: 7};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The datagram text. The clock is the simulation's (a fixed day), so the same run always gives the same text. */
export function syslogText(host, time, {message, tag = "user", facility = "user", severity = "notice"}) {
  const s = Math.floor(time), two = n => String(n).padStart(2, "0");
  return `<${FACILITIES[facility] * 8 + SEVERITIES[severity]}>${MONTHS[0]}  1 ${two(Math.floor(s / 3600) % 24)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)} ${host} ${tag}: ${message}`;
}
/** Send one syslog message from `src` to `dst` and let the network settle. Returns what the destination's syslog service logged because of it. */
export function syslogSend(net, src, dst, opts) {
  if (opts.facility !== undefined && !(opts.facility in FACILITIES)) return {ok: false, error: `unknown facility ${opts.facility}`};
  if (opts.severity !== undefined && !(opts.severity in SEVERITIES)) return {ok: false, error: `unknown severity ${opts.severity}`};
  const node = stackOf(net, src), before = {};
  for (const n of net.nodes.values()) before[n.name] = (n.syslogLog || []).length;
  const sport = node.nextPort++;
  if (!node.sendIp({dst, ttl: 64, proto: "udp", udp: {sport, dport: 514, payload: syslogText(node.name, net.time, opts)}})) return {ok: false, error: "no route"};
  net.settle(opts.settle ?? 1);
  const got = [...net.nodes.values()].flatMap(n => (n.syslogLog || []).slice(before[n.name]));
  return {ok: true, received: got};
}
