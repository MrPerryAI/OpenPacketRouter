// TCP (RFC 793), the part that decides which frames appear on the wire, modeled on what a Linux
// kernel puts on the cable (validated in validate/tcp/):
//   - three-way handshake SYN → SYN+ACK → ACK; the client's ACK goes out at once, before any data;
//   - SYN retransmission with a 1 s initial timeout that doubles (1, 3, 7 s after the first SYN). Linux 6.7+
//     defaults to four linear 1 s retries first (tcp_syn_linear_timeouts); validation pins that to 0;
//   - a segment to a closed port is answered with RST+ACK; the client sees "connection refused";
//   - every data segment and every FIN is acknowledged at once (Linux "quick ack" mode, which covers the
//     first segments of a connection); no delayed ACKs, no window or congestion modeling yet;
//   - teardown: FIN+ACK, FIN+ACK, ACK (the closing peer's ACK of the FIN rides on its own FIN, because its app
//     closes at once). The side that closes first goes to TIME_WAIT (no frames).
//   - data is cut into segments of MSS bytes (1448: a 1500-byte MTU less 20+20 and the 12 bytes of timestamp option
//     Linux adds); every segment but the last of a write is a plain ACK, the last one carries PSH;
//   - data retransmission: every data segment stays on a list until acknowledged. When the oldest unacknowledged
//     segment is not acknowledged within the RTO (200 ms, Linux's minimum; a LAN round trip is far below it) it is
//     sent again, and the RTO doubles for each further timeout (0.2, 0.4, 0.8 s ...); an acknowledgment that
//     advances restarts the timer at 200 ms;
//   - a segment that is not the next in sequence (a gap, or data already received) is answered with an ACK of what
//     was received so far (a duplicate ACK) and is not delivered.
// Not modeled: fast retransmit and SACK, congestion windows (a write is limited to ten segments, Linux's initial
// window), receive windows, reordering, FIN retransmission, simultaneous open/close.
// Servers: services.tcp = {"7": "echo"} listens on port 7 and echoes what it receives, then closes when
// the client does; {"9": "discard"} reads and acknowledges but never answers.

const seg = (conn, flags, len = 0, extra = {}) => conn.node.sendIp({src: conn.laddr, dst: conn.raddr, ttl: 64, proto: "tcp",
  tcp: {sport: conn.lport, dport: conn.rport, flags, seq: conn.snd, ack: conn.rcv, len, ...extra}});

export const MSS = 1448, RTO = 0.2, MAX_WRITE = 10 * MSS;

/** Send `total` bytes as MSS-sized segments, keep them for retransmission and start the timer. */
function sendData(conn, total, payload) {
  for (let left = total, off = 0; left > 0;) {
    const n = Math.min(MSS, left); left -= n;
    // a string is cut into the segments' bytes; any other payload (a BGP message) rides on the last segment
    const flags = left ? "A" : "PA", data = payload === undefined ? undefined : typeof payload === "string" ? payload.slice(off, off + n) : left ? undefined : payload; off += n;
    seg(conn, flags, n, data === undefined ? {} : {data}); (conn.unacked ||= []).push({seq: conn.snd, len: n, flags, data}); conn.snd += n;
  }
  armRto(conn, RTO);
}
function armRto(conn, rto) {
  const gen = conn.rtoTimer = (conn.rtoTimer || 0) + 1; conn.rto = rto;
  if (!conn.unacked || !conn.unacked.length) return;
  conn.node.net._after(rto, () => {
    if (conn.dead || conn.rtoTimer !== gen || !conn.unacked.length) return;
    const h = conn.unacked[0];
    conn.node.log("tcp", `no ACK for seq ${h.seq} within ${rto} s: retransmitting ${h.len} bytes`);
    conn.retransmits = (conn.retransmits || 0) + 1;
    seg(conn, h.flags, h.len, h.data === undefined ? {seq: h.seq} : {seq: h.seq, data: h.data}); armRto(conn, rto * 2);
  });
}
/** An ACK number: forget what it covers and restart the timer for the rest. */
function onAck(conn, ack) {
  if (!conn.unacked || !conn.unacked.length) return;
  const n = conn.unacked.length; conn.unacked = conn.unacked.filter(u => u.seq + u.len > ack);
  if (conn.unacked.length !== n) armRto(conn, RTO);
}

const key = (lport, raddr, rport) => `${lport}|${raddr}|${rport}`;
const table = node => node.tcpConns || (node.tcpConns = new Map());
export const flagsName = f => ({S: "SYN", SA: "SYN+ACK", A: "ACK", PA: "PSH+ACK", FA: "FIN+ACK", R: "RST", RA: "RST+ACK"})[f] || f;

function setState(conn, s) { conn.node.log("tcp", `${conn.laddr}:${conn.lport} ↔ ${conn.raddr}:${conn.rport}: ${conn.state} → ${s}`); conn.state = s; }
function drop(conn) { conn.dead = true; table(conn.node).delete(key(conn.lport, conn.raddr, conn.rport)); }

/** Entry from IpNode.deliver for proto "tcp". */
export function tcpInput(node, p) {
  const t = p.tcp, conn = table(node).get(key(t.dport, p.src, t.sport));
  if (conn) return onSegment(conn, t);
  const app = node.tcpApps && node.tcpApps.get(t.dport);
  if (t.flags === "S" && app) {                                      // an in-engine application (BGP): it decides whether to accept
    const c = newConn(node, p.dst, t.dport, p.src, t.sport, "SYN_RCVD");
    c.rcv = t.seq + 1;
    if (app(c)) { node.log("tcp", `SYN to port ${t.dport}: answering SYN+ACK`); return seg(c, "SA"); }
    drop(c);
  }
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

/** An ICMP "destination unreachable" about one of our segments: a connection still in SYN_SENT fails at once, like
 *  Linux (tcp_v4_err). The error is the errno Linux maps the code to: 111 (refused) for codes 2 and 3, 101 for
 *  net unreachable, 113 for host unreachable and administratively prohibited (13). */
export function tcpIcmpError(node, p) {
  const o = p.icmp.orig; if (!o || o.proto !== "tcp" || p.icmp.type !== 3) return;
  const conn = table(node).get(key(o.sport, o.dst, o.dport));
  if (!conn || conn.state !== "SYN_SENT") return;
  node.log("tcp", `ICMP unreachable (code ${p.icmp.code}) from ${p.src}: connection to ${o.dst}:${o.dport} fails`);
  drop(conn);
  if (conn.onEvent) conn.onEvent("icmp", p.icmp.code);
}
const ICMP_ERRNO = {0: 101, 1: 113, 2: 111, 3: 111, 4: 90, 5: 113, 6: 101, 7: 113, 8: 113, 9: 13, 10: 13, 11: 101, 12: 113, 13: 113, 14: 113, 15: 113};

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
      if (f === "A") { conn.snd += 1; setState(conn, "ESTABLISHED"); if (conn.onEvent) conn.onEvent("connected"); }
      return;
    case "ESTABLISHED": case "FIN_WAIT_1": case "FIN_WAIT_2": {
      if (f.includes("A") && t.ack !== undefined) onAck(conn, t.ack);
      if (f === "A" && conn.state === "FIN_WAIT_1") { setState(conn, "FIN_WAIT_2"); return; }
      if (t.len > 0 && t.seq !== conn.rcv) {                                      // a gap or a repeat: ACK what we have
        conn.node.log("tcp", `segment seq ${t.seq} but expected ${conn.rcv}: ACK ${conn.rcv} again`);
        seg(conn, "A"); return;
      }
      if (t.len > 0) {
        conn.rcv += t.len; seg(conn, "A");                                       // quick ack
        if (conn.server === "echo") { conn.node.log("tcp", `echo ${t.len} bytes`); sendData(conn, t.len); }
        else if (conn.server === "discard") conn.node.log("tcp", `discard ${t.len} bytes`);
        else if (conn.server === "http") httpServe(conn, t);
        else if (conn.onEvent) conn.onEvent("data", t.len, t.data);
      }
      if (f.includes("F")) {
        conn.rcv += 1;
        if (conn.onEvent) conn.onEvent("eof");
        if (conn.state === "ESTABLISHED") {          // the peer closed first: the app sees EOF and closes at once, so our ACK
          setState(conn, "LAST_ACK"); seg(conn, "FA"); conn.snd += 1;                 // rides on our own FIN (Linux does not ACK a FIN on its own here)
        } else { seg(conn, "A"); setState(conn, "TIME_WAIT"); drop(conn); }       // our FIN was already out
      }
      return;
    }
    case "LAST_ACK":
      if (f === "A") { setState(conn, "CLOSED"); drop(conn); }
      return;
  }
}

/** The "http" server: collect request bytes until the blank line, answer with the page for the path (HTTP/1.0 style: the
 *  server closes after the response, so its FIN follows the data). services.http maps a path to its body; anything else is a 404. */
export function httpResponse(pages, path) {
  const body = Object.prototype.hasOwnProperty.call(pages || {}, path) ? pages[path] : null;
  const text = body === null ? "not found\n" : body;
  return `HTTP/1.0 ${body === null ? "404 Not Found" : "200 OK"}\r\nContent-Type: text/plain\r\nContent-Length: ${text.length}\r\n\r\n${text}`;
}
export const httpRequest = (path, host) => `GET ${path} HTTP/1.0\r\nHost: ${host}\r\n\r\n`;
function httpServe(conn, t) {
  conn.rx = (conn.rx || "") + (t.data || "");
  if (conn.answered || !conn.rx.includes("\r\n\r\n")) return;
  conn.answered = true;
  const path = (conn.rx.split(" ")[1] || "/"), resp = httpResponse(conn.node.services.http, path);
  conn.node.log("tcp", `HTTP GET ${path}: answering ${resp.length} bytes, then closing`);
  sendData(conn, resp.length, resp);
  setState(conn, "FIN_WAIT_1"); seg(conn, "FA"); conn.snd += 1;
}

/** Client side: connect, send `size` bytes, read the echo, close. Returns the result object. */
export function tcpRequest(net, srcName, dst, port, {size = 100, timeout = 5, discard = false, pause = 0, http = null} = {}) {
  const node = net.node(srcName);
  const req = http === null ? null : httpRequest(http, dst); if (req) size = req.length;
  if (size > MAX_WRITE) return {ok: false, error: `a write is limited to ${MAX_WRITE} bytes (ten segments)`};
  const route = node.route(dst); if (!route) return {ok: false, error: "no route"};
  const laddr = node.ifaces[route.iface].ip, lport = node.nextPort++;
  const conn = newConn(node, laddr, lport, dst, port, "SYN_SENT");
  let res = null; const t0 = net.time;
  const done = r => { if (!res) res = {...r, rtt_ms: +((net.time - t0) * 1000).toFixed(3)}; };
  conn.onEvent = (ev, n, d) => {
    if (ev === "connected") {
      sendData(conn, size, req === null ? undefined : req);
      if (discard) net._after(pause, () => {         // nothing comes back: write, wait `pause` seconds, close
        if (conn.dead || res) return;
        done({ok: true, from: dst, bytes: size, unacked: conn.unacked.length, retransmits: conn.retransmits || 0}); setState(conn, "FIN_WAIT_1"); seg(conn, "FA"); conn.snd += 1; });
    }
    else if (req !== null && ev === "data") conn.rx = (conn.rx || "") + (d || "");
    else if (req !== null && ev === "eof") { const i = (conn.rx || "").indexOf("\r\n\r\n"); done({ok: true, from: dst, status: +(conn.rx.split(" ")[1]), bytes: i < 0 ? 0 : conn.rx.length - i - 4}); }
    else if (ev === "data") { done({ok: true, from: dst, bytes: n}); setState(conn, "FIN_WAIT_1"); seg(conn, "FA"); conn.snd += 1; }
    else if (ev === "refused") done({ok: false, error: "refused", from: dst});
    else if (ev === "reset") done({ok: false, error: "reset", from: dst});
    else if (ev === "icmp") done({ok: false, error: ICMP_ERRNO[n] === 111 ? "refused" : `os error ${ICMP_ERRNO[n]}`});
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

/** The `tcp` action: connect, send `size` bytes, read the echo, close (against a `discard` service: wait `pause` s after the write, then close). `wire` lists the TCP segments on the client's cable. */
export function tcpAction(net, a) {
  const client = net.node(a.src), wire = [];
  const tap = (node, ifname, f) => {
    if (f.type !== "ipv4" || f.ip.proto !== "tcp") return;
    const out = node === client, inn = node.ifaces[ifname].peer.node === client;
    if (out || inn) wire.push(`${out ? "out" : "in"} ${f.ip.tcp.flags}${f.ip.tcp.len ? " " + f.ip.tcp.len : ""}`);
  };
  (net.taps ||= new Set()).add(tap);
  const r = tcpRequest(net, a.src, a.dst, a.port, {size: a.size ?? 100, timeout: a.timeout ?? 5, discard: a.discard === true, pause: a.pause ?? 0, http: a.http ?? null});
  net.settle(a.settle ?? 1); net.taps.delete(tap);
  return {...r, wire};
}


// ---- API for in-engine applications that keep a connection (BGP) -------------------------------------------------
/** Listen on `port`: accept(conn) is called for every SYN, sets conn.onEvent and returns true to answer SYN+ACK (false: RST). */
export function tcpListen(node, port, accept) { (node.tcpApps ||= new Map()).set(port, accept); }
/** Open a connection from `laddr` (or the route's address) to dst:port; returns the connection, or null without a route.
 *  conn.onEvent(ev, n, data): "connected", "data", "peerclosed", "reset", "refused", "icmp". SYN retransmits like Linux (1, 2, 4 s). */
export function tcpConnect(node, dst, port, onEvent) {
  const route = node.route(dst); if (!route) return null;
  const conn = newConn(node, node.ifaces[route.iface].ip, node.nextPort++, dst, port, "SYN_SENT");
  conn.onEvent = onEvent;
  const syn = (rto, gen) => {
    if (conn.dead || conn.state !== "SYN_SENT" || gen !== conn.rtoGen) return;
    seg(conn, "S", 0, {seq: 1000}); conn.snd = 1000;
    node.net._after(rto, () => syn(rto * 2, gen));
  };
  conn.rtoGen = 1; syn(1, 1);
  return conn;
}
/** Write one application message of `len` bytes (carried as `data` on the last segment). */
export function tcpWrite(conn, len, data) { if (!conn.dead && conn.state === "ESTABLISHED") sendData(conn, len, data); }
/** Close from our side: FIN, nothing more is retransmitted. */
export function tcpClose(conn) {
  if (conn.dead) return;
  conn.unacked = []; conn.rtoGen = -1;
  if (conn.state === "ESTABLISHED") { setState(conn, "FIN_WAIT_1"); seg(conn, "FA"); conn.snd += 1; }
  else drop(conn);
}
/** Forget the connection without a word (the cable is down). */
export function tcpAbort(conn) { if (!conn.dead) { conn.unacked = []; conn.rtoGen = -1; drop(conn); } }
