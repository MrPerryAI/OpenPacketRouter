// TCP (RFC 793), the part that decides which frames appear on the wire, modeled on what a Linux
// kernel puts on the cable (validated in validate/tcp/):
//   - three-way handshake SYN → SYN+ACK → ACK; the client's ACK goes out at once, before any data;
//   - SYN retransmission with a 1 s initial timeout that doubles (1, 3, 7 s after the first SYN);
//   - a segment to a closed port is answered with RST+ACK; the client sees "connection refused";
//   - every data segment and every FIN is acknowledged at once (Linux "quick ack" mode, which covers the
//     first segments of a connection); no delayed ACKs, no window or congestion modeling yet;
//   - teardown: FIN+ACK, ACK, FIN+ACK, ACK. The side that closes first goes to TIME_WAIT (no frames).
// Not modeled: data retransmission, reordering, windows, options, simultaneous open/close.
// Servers: services.tcp = {"7": "echo"} listens on port 7 and echoes what it receives, then closes when
// the client does.

const seg = (conn, flags, len = 0, extra = {}) => conn.node.sendIp({src: conn.laddr, dst: conn.raddr, ttl: 64, proto: "tcp",
  tcp: {sport: conn.lport, dport: conn.rport, flags, seq: conn.snd, ack: conn.rcv, len, ...extra}});

const key = (lport, raddr, rport) => `${lport}|${raddr}|${rport}`;
const table = node => node.tcpConns || (node.tcpConns = new Map());
export const flagsName = f => ({S: "SYN", SA: "SYN+ACK", A: "ACK", PA: "PSH+ACK", FA: "FIN+ACK", R: "RST", RA: "RST+ACK"})[f] || f;

function setState(conn, s) { conn.node.log("tcp", `${conn.laddr}:${conn.lport} ↔ ${conn.raddr}:${conn.rport}: ${conn.state} → ${s}`); conn.state = s; }
function drop(conn) { conn.dead = true; table(conn.node).delete(key(conn.lport, conn.raddr, conn.rport)); }

/** Entry from IpNode.deliver for proto "tcp". */
export function tcpInput(node, p) {
  const t = p.tcp, conn = table(node).get(key(t.dport, p.src, t.sport));
  if (conn) return onSegment(conn, t);
  const listener = node.services.tcp && node.services.tcp[t.dport];
  if (t.flags === "S" && listener) {
    const c = newConn(node, p.dst, t.dport, p.src, t.sport, "SYN_RCVD");
    c.rcv = t.seq + 1; c.server = listener;
    node.log("tcp", `SYN to port ${t.dport} (${listener}): answering SYN+ACK`);
    return seg(c, "SA");
  }
  if (t.flags.includes("R")) return;                                  // never answer a reset
  if (t.flags === "S") { node.log("tcp", `nothing listens on TCP ${t.dport}: RST+ACK`);
    return node.sendIp({src: p.dst, dst: p.src, ttl: 64, proto: "tcp", tcp: {sport: t.dport, dport: t.sport, flags: "RA", seq: 0, ack: t.seq + 1, len: 0}}); }
  node.log("tcp", `segment for no connection: RST`);
  node.sendIp({src: p.dst, dst: p.src, ttl: 64, proto: "tcp", tcp: {sport: t.dport, dport: t.sport, flags: "R", seq: t.ack, ack: 0, len: 0}});
}

function newConn(node, laddr, lport, raddr, rport, state) {
  const c = {node, laddr, lport, raddr, rport, state, snd: 1000, rcv: 0, dead: false};
  table(node).set(key(lport, raddr, rport), c); return c;
}

function onSegment(conn, t) {
  const f = t.flags;
  if (f.includes("R")) { const was = conn.state; drop(conn); conn.node.log("tcp", `reset received in ${was}`);
    return conn.onEvent && conn.onEvent(was === "SYN_SENT" ? "refused" : "reset"); }
  switch (conn.state) {
    case "SYN_SENT":
      if (f === "SA") { conn.rcv = t.seq + 1; conn.snd += 1; conn.rtoGen = (conn.rtoGen || 0) + 1; setState(conn, "ESTABLISHED"); seg(conn, "A"); conn.onEvent && conn.onEvent("connected"); }
      return;
    case "SYN_RCVD":
      if (f === "A") { conn.snd += 1; setState(conn, "ESTABLISHED"); }
      return;
    case "ESTABLISHED": case "FIN_WAIT_1": case "FIN_WAIT_2": {
      if (f === "A" && conn.state === "FIN_WAIT_1") { setState(conn, "FIN_WAIT_2"); return; }
      if (t.len > 0) {
        conn.rcv += t.len; seg(conn, "A");                                       // quick ack
        if (conn.server === "echo") { conn.node.log("tcp", `echo ${t.len} bytes`); seg(conn, "PA", t.len); conn.snd += t.len; }
        else if (conn.onEvent) conn.onEvent("data", t.len);
      }
      if (f.includes("F")) {
        conn.rcv += 1; if (f === "FA" && conn.state === "FIN_WAIT_1") conn.snd += 0;
        seg(conn, "A");
        if (conn.state === "ESTABLISHED") {          // the peer closed first: the app sees EOF and closes too
          setState(conn, "LAST_ACK"); seg(conn, "FA"); conn.snd += 1;
        } else { setState(conn, "TIME_WAIT"); drop(conn); }                       // our FIN was already out
      }
      return;
    }
    case "LAST_ACK":
      if (f === "A") { setState(conn, "CLOSED"); drop(conn); }
      return;
  }
}

/** Client side: connect, send `size` bytes, read the echo, close. Returns the result object. */
export function tcpRequest(net, srcName, dst, port, {size = 100, timeout = 5} = {}) {
  const node = net.node(srcName);
  const route = node.route(dst); if (!route) return {ok: false, error: "no route"};
  const laddr = node.ifaces[route.iface].ip, lport = node.nextPort++;
  const conn = newConn(node, laddr, lport, dst, port, "SYN_SENT");
  let res = null; const t0 = net.time;
  const done = r => { if (!res) res = {...r, rtt_ms: +((net.time - t0) * 1000).toFixed(3)}; };
  conn.onEvent = (ev, n) => {
    if (ev === "connected") { seg(conn, "PA", size); conn.snd += size; }
    else if (ev === "data") { done({ok: true, from: dst, bytes: n}); setState(conn, "FIN_WAIT_1"); seg(conn, "FA"); conn.snd += 1; }
    else if (ev === "refused") done({ok: false, error: "refused", from: dst});
    else if (ev === "reset") done({ok: false, error: "reset", from: dst});
  };
  // SYN with retransmissions: 1 s, then doubling
  const syn = (rto, gen) => {
    if (conn.dead || conn.state !== "SYN_SENT" || gen !== conn.rtoGen) return;
    seg(conn, "S", 0, {seq: 1000 - 0}); conn.snd = 1000;
    net._after(rto, () => syn(rto * 2, gen));
  };
  conn.rtoGen = 1; syn(1, 1);
  net.run(net.time + timeout, () => res);
  if (!res) { done({ok: false, error: "timeout"}); conn.rtoGen = -1; drop(conn); }
  return res;
}

/** The `tcp` action: connect, send `size` bytes, read the echo, close. `wire` lists the TCP segments on the client's cable. */
export function tcpAction(net, a) {
  const client = net.node(a.src), wire = [];
  const tap = (node, ifname, f) => {
    if (f.type !== "ipv4" || f.ip.proto !== "tcp") return;
    const out = node === client, inn = node.ifaces[ifname].peer.node === client;
    if (out || inn) wire.push(`${out ? "out" : "in"} ${f.ip.tcp.flags}${f.ip.tcp.len ? " " + f.ip.tcp.len : ""}`);
  };
  (net.taps ||= new Set()).add(tap);
  const r = tcpRequest(net, a.src, a.dst, a.port, {size: a.size ?? 100, timeout: a.timeout ?? 5});
  net.settle(a.settle ?? 1); net.taps.delete(tap);
  return {...r, wire};
}
