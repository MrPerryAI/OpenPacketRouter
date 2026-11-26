// Link capacity, queues and drops: a token-bucket shaper on an interface's egress, modeled on Linux's
// `tbf` qdisc (net/sched/sch_tbf.c, with its default bfifo child), so that storms and congestion have
// physical limits. Validated frame for frame against `tc qdisc add dev X root tbf rate R burst B limit L`
// on veth links in validate/links/.
//
//   rate   bits per second the bucket refills at (the link's capacity)
//   burst  bytes of tokens the bucket holds (how much may leave back to back)
//   limit  bytes the queue may hold while frames wait for tokens; a frame that would overflow it is dropped
//
// Like the kernel, every frame is first offered to the queue (dropped if backlog + len > limit), then the
// queue is drained in order while the bucket has tokens for the head frame; otherwise a timer fires when it
// will. Tokens are kept as time (seconds of transmission at `rate`), capped at burst/rate.

/** Bytes a frame occupies at the qdisc (Ethernet header + payload, no FCS), as Linux counts skb->len. */
export function frameBytes(f) {
  if (f.type === "arp") return 42;
  const tag = f.vlan !== undefined ? 4 : 0;
  // Non-IP protocols. Linux hands the qdisc an skb of Ethernet header + (802.3 LLC for spanning tree) + PDU, no FCS.
  if (f.type === "bpdu") {   // 14 + 3 LLC + BPDU: config 35, RSTP 36, TCN 4 bytes
    const b = f.bpdu;
    return 14 + tag + 3 + (b.tcn ? 4 : b.version === 2 ? 36 : 35);
  }
  if (f.type === "lacpdu") return 14 + tag + 110;           // slow-protocols subtype + LACPDU, fixed 110 bytes
  if (f.type === "lldp") {                                  // TLVs: chassis (MAC) 9, port (MAC) 9, TTL 4, description TLVs, capabilities 8, end 2
    const l = f.lldp, t = x => 2 + String(x ?? "").length;
    return 14 + tag + 9 + 9 + 4 + t(l.portDescr) + t(l.sysName) + t(l.sysDescr) + 8 + 2;
  }
  if (f.type === "ipv6") {
    const p = f.ip6;
    let l4;
    if (p.proto === "icmp6") {
      const t = p.icmp.type;
      if (t === 135 || t === 136) l4 = 8 + 16 + 8;          // NS/NA: target address + one link-layer address option
      else if (t === 128 || t === 129) l4 = 8 + (p.icmp.size ?? 16);
      else l4 = 8 + 40 + 8;                                 // error: the original IPv6 header + 8 bytes
    } else if (p.proto === "udp") l4 = 8 + (p.udp.size ?? JSON.stringify(p.udp.payload ?? null).length);
    else if (p.proto === "tcp") l4 = 20 + (p.tcp.len || 0);
    else l4 = 0;
    return 14 + tag + 40 + l4;
  }
  const p = f.ip;
  let l4;
  if (p.proto === "ospf") return 14 + tag + 20 + p.ospf.size;
  if (p.proto === "tcp") return 14 + tag + 20 + (p.tcp.flags === "S" || p.tcp.flags === "SA" ? 40 : p.tcp.flags[0] === "R" ? 20 : 32) + (p.tcp.len || 0);   // Linux options: SYNs 40 bytes, resets none, the rest timestamps
  if (p.proto === "udp") l4 = 8 + (p.udp.size ?? JSON.stringify(p.udp.payload ?? null).length);
  else if (p.icmp.type === 0 || p.icmp.type === 8) l4 = 8 + (p.icmp.size ?? 16);
  else l4 = 8 + 28;                                        // ICMP error: original IP header + 8 bytes
  return 14 + tag + 20 + l4;
}

const UNITS = {"": 1, bit: 1, kbit: 1e3, mbit: 1e6, gbit: 1e9, bps: 8, kbps: 8e3, mbps: 8e6};
/** "100kbit" / "1mbit" / 1e6 → bits per second (tc's units: kbit = 1000 bit/s, kbps = 1000 bytes/s). */
export function parseRate(r) {
  if (typeof r === "number") return r;
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(String(r).trim());
  if (!m || !(m[2].toLowerCase() in UNITS)) throw new Error(`bad rate ${r} (use bits/s or e.g. "100kbit", "1mbit")`);
  return +m[1] * UNITS[m[2].toLowerCase()];
}

export class TokenBucket {
  constructor({rate, burst, limit}) {
    this.rate = parseRate(rate); this.burst = burst; this.limit = limit;
    this.buffer = burst * 8 / this.rate;                   // seconds of tokens when full
    this.tokens = this.buffer; this.tc = 0;               // tokens as of time tc
    this.queue = []; this.backlog = 0; this.timer = false;
    this.sent = 0; this.dropped = 0;
  }
  flush() {}                                               // queues and tokens are physics, not caches
  /** Offer a frame. `wire(frame)` puts it on the cable. */
  enqueue(net, frame, wire, who) {
    const len = frameBytes(frame);
    if (this.backlog + len > this.limit) {
      this.dropped++; net.log(who, "queue-drop", `queue full (${this.backlog}+${len} > ${this.limit} bytes): dropped a frame`);
      return;
    }
    this.queue.push({frame, len}); this.backlog += len;
    this.dequeue(net, wire, who);
  }
  dequeue(net, wire, who) {
    while (this.queue.length) {
      const {frame, len} = this.queue[0];
      const toks = Math.min(this.buffer, this.tokens + (net.time - this.tc)) - len * 8 / this.rate;
      if (toks < -1e-12) {
        if (!this.timer) {
          this.timer = true;
          net._after(-toks, () => { this.timer = false; this.dequeue(net, wire, who); });
        }
        return;
      }
      this.queue.shift(); this.backlog -= len; this.tokens = Math.max(0, toks); this.tc = net.time; this.sent++;
      wire(frame);
    }
  }
}

/** Shape the egress of `ref` ("node:iface"): {rate, burst, limit}. */
/** Deterministic frame loss on an interface's egress, modeled on Linux's `tc qdisc ... netem loss gemodel P R 1-H 1-K` (net/sched/sch_netem.c,
 *  loss_gilb_ell) with every probability either 0 or 1, so no random numbers are involved and the pattern is exact:
 *  a two-state Gilbert-Elliott chain that starts in the good state. For every frame, in the state it starts in:
 *    good: with probability toBad the chain moves to bad; the frame is lost with probability inGood
 *    bad:  with probability toGood the chain moves to good; the frame is lost with probability inBad
 *  (all four are 0 or 1). Examples: {toBad: 1, toGood: 1, inBad: 1, inGood: 0} loses every second frame, starting with the second;
 *  {toBad: 0, toGood: 0, inBad: 0, inGood: 1} loses everything. Validated in validate/netem/ (the probabilities in between are random in Linux,
 *  so the engine rejects them). */
export class LossModel {
  constructor({toBad, toGood, inBad, inGood}) {
    this.toBad = toBad; this.toGood = toGood; this.inBad = inBad; this.inGood = inGood;
    this.bad = false; this.sent = 0; this.dropped = 0;
  }
  flush() {}
  /** True when this frame is lost; advances the chain. */
  lose() {
    if (!this.bad) { if (this.toBad) this.bad = true; return !!this.inGood; }
    if (this.toGood) this.bad = false; return !!this.inBad;
  }
  enqueue(net, frame, wire, who) {
    if (this.lose()) { this.dropped++; net.log(who, "netem-loss", "frame lost on the link (loss model)"); return; }
    this.sent++; wire(frame);
  }
}

export function lossModel(net, ref, params) {
  const [n, i] = ref.split(":"); const iface = net.node(n).ifaces[i];
  if (!iface) throw new Error(`${ref}: no such interface`);
  if (iface.shaper) throw new Error(`${ref}: a link end can have a shaper or a loss model, not both (Linux: one root qdisc)`);
  iface.shaper = new LossModel(params);
  return iface.shaper;
}

export function shape(net, ref, params) {
  const [n, i] = ref.split(":"); const iface = net.node(n).ifaces[i];
  if (!iface) throw new Error(`${ref}: no such interface`);
  for (const k of ["rate", "burst", "limit"]) if (params[k] === undefined) throw new Error(`${ref}: shaping needs ${k}`);
  iface.shaper = new TokenBucket(params);
  return iface.shaper;
}

/** Per shaped interface: frames sent and dropped so far ({"A:eth0": {sent, dropped}}). */
export function queueStats(net) {
  const out = {};
  for (const node of net.nodes.values()) for (const i of Object.values(node.ifaces))
    if (i.shaper) out[`${node.name}:${i.name}`] = {sent: i.shaper.sent, dropped: i.shaper.dropped};
  for (const node of net.nodes.values()) for (const [p, c] of node.storm || []) if (c.broadcast) out[`${node.name}:${p}`] = {sent: c.broadcast.passed, dropped: c.broadcast.dropped};   // storm control policers
  return out;
}

/** Ingress policer, modeled on Linux's `tc ... action police rate R burst B conform-exceed drop` (net/sched/act_police.c).
 *  Same token bucket as above, but no queue: a frame either conforms (its tokens are taken) or is dropped, and a dropped
 *  frame takes no tokens. At the tc ingress hook the kernel has already pulled the Ethernet header, so a frame costs its
 *  length without the 14-byte header (`frameBytes(f) - 14`). Used by switch storm control (stormControl spec key). */
export class Police {
  constructor({rate, burst}) {
    this.rate = parseRate(rate); this.burstBytes = burst; this.rateSpec = rate;
    this.buffer = burst * 8 / this.rate; this.tokens = this.buffer; this.tc = 0; this.passed = 0; this.dropped = 0;
  }
  flush() {}
  /** True if the frame conforms. */
  admit(net, frame) {
    const len = frameBytes(frame) - 14;
    const toks = Math.min(this.buffer, this.tokens + (net.time - this.tc)) - len * 8 / this.rate;
    if (toks < -1e-12) { this.dropped++; return false; }
    this.tokens = Math.max(0, toks); this.tc = net.time; this.passed++; return true;
  }
}
