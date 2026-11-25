// Rapid spanning tree (IEEE 802.1D-2004 clause 17, the state machines the Linux daemon `mstpd` runs in RSTP mode).
//
// The Linux kernel bridge only does classic STP; with `stp_state 2` it hands spanning tree to mstpd, which runs the
// standard's state machines. This file follows mstpd's mstp.c machine by machine (names in the comments are the
// standard's): port receive (PRX), protocol migration (PPM), bridge detection (BDM), port information (PIM), port role
// selection (PRS), port role transitions (PRT), port state transitions (PST), topology change (TCM) and port transmit (PTX).
// Timers count whole seconds and tick once a second, as in the daemon. Frames: the same BPDU objects as stp.js, plus
// `version: 2` and `flags` (the RSTP flags byte: 0x01 TC, 0x02 proposal, 0x0c role, 0x10 learning, 0x20 forwarding,
// 0x40 agreement). A bridge that hears a version 0 (classic) BPDU on a port falls back to classic BPDUs on that port.
//
// Not modeled: MSTP (regions, instances), BPDU guard/filter, root guard, restricted roles, BA assurance.

import {STP_MAC} from "./stp.js";

const BLOCKING = "blocking", LEARNING = "learning", FORWARDING = "forwarding", DISABLED = "disabled";
const ROLE = {disabled: 0, alternate: 1, backup: 1, root: 2, designated: 3};
const MIGRATE = 3, TX_HOLD = 6;

const cmpId = (a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
const idStr = id => `${id[0].toString(16).padStart(4, "0")}.${id[1].replace(/:/g, "")}`;
/** Compare priority vectors {root, cost, bridge, port}: negative when a is better (lower). */
const cmpVec = (a, b) => cmpId(a.root, b.root) || a.cost - b.cost || cmpId(a.bridge, b.bridge) || a.port - b.port;
const sameVec = (a, b) => cmpVec(a, b) === 0;
const betterOrSame = (a, ra, b, rb) => { const c = cmpVec(a, b); return c < 0 || (c === 0 && ra <= rb); };
const times = t => ({...t});
const sameTimes = (a, b) => a.fwd === b.fwd && a.maxAge === b.maxAge && a.hello === b.hello && a.age === b.age;

export class Rstp {
  /** sw: the Switch. opts: {priority, mac, hello, maxAge, forwardDelay, cost: {port: n}, portPriority: {port: n}, edge: {port: bool}, autoEdge} */
  constructor(sw, opts = {}) {
    this.sw = sw; this.net = sw.net; this.rstp = true;
    this.priority = opts.priority ?? 0x8000; this.mac = opts.mac;
    this.hello = opts.hello ?? 2; this.maxAge = opts.maxAge ?? 20; this.forwardDelay = opts.forwardDelay ?? 15;
    this.costOf = opts.cost || {}; this.prioOf = opts.portPriority || {}; this.edgeOf = opts.edge || {}; this.autoEdge = opts.autoEdge ?? true;
    this.started = false; this.ports = new Map(); this.running = false; this.again = false;
    this.tc = false; this.curFwd = this.forwardDelay;   // (`tc` stays false: classic STP shortens MAC ageing while a topology change is in force, RSTP flushes the ports instead)
    this.tcActive = false;
  }
  get bid() { return [this.priority, this.mac]; }
  isRoot() { return cmpId(this.rootPri.root, this.bid) === 0; }

  start() {
    if (this.started) return; this.started = true;
    this.bridgeTimes = {fwd: this.forwardDelay, maxAge: this.maxAge, hello: this.hello, age: 0};
    this.bridgePri = {root: this.bid, cost: 0, bridge: this.bid, port: 0};
    this.rootPri = {...this.bridgePri}; this.rootPortId = 0; this.rootTimes = times(this.bridgeTimes); this.rootPort = null;
    let no = 0;
    for (const name of Object.keys(this.sw.ifaces)) {
      no++;
      const p = {name, no, id: (((this.prioOf[name] ?? 128) >> 4) << 12) | no, cost: this.costOf[name] ?? 20000, adminEdge: !!this.edgeOf[name],
        state: DISABLED, role: "disabled", selectedRole: "disabled"};
      this.ports.set(name, p); this._begin(p);
    }
    this.net._after(1, () => this._tick(), true);
    this._run();
  }
  _up(p) { const i = this.sw.ifaces[p.name]; return !!(i.link && i.link.up); }

  // ----- BEGIN: every machine in its initial state -----
  _begin(p) {
    p.portEnabled = this._up(p) && this.started;
    p.portTimes = times(this.bridgeTimes); p.designatedTimes = times(this.bridgeTimes); p.msgTimes = times(this.bridgeTimes);
    p.portPri = {...this.bridgePri}; p.designatedPri = {...this.bridgePri}; p.msgPri = {...this.bridgePri};
    Object.assign(p, {rcvdBpdu: false, rcvdMsg: false, rcvdRSTP: false, rcvdSTP: false, bpdu: null, rcvdTc: false, rcvdTcn: false, rcvdTcAck: false, tcProp: false, tcAck: false,
      proposed: false, proposing: false, agree: false, agreed: false, synced: false, disputed: false, learn: false, forward: false,
      learning: false, forwarding: false, reselect: false, selected: false, updtInfo: false, infoIs: "disabled", rcvdInfo: null, newInfo: false, txCount: 0, fdbFlush: false,
      sync: true, reRoot: true, operEdge: p.adminEdge, autoEdgeOn: this.autoEdge, mcheck: false, sendRSTP: true, operP2P: true,
      edgeDelayWhile: MIGRATE, fdWhile: this.maxAge, rrWhile: this.forwardDelay, rbWhile: 0, rcvdInfoWhile: 0, tcWhile: 0, helloWhen: 0, mdelayWhile: MIGRATE});
    p.pim = "DISABLED"; p.prx = "DISCARD"; p.ppm = "CHECKING_RSTP"; p.bdm = p.adminEdge ? "EDGE" : "NOT_EDGE"; p.ptx = "TRANSMIT_INIT"; p.prt = "INIT_PORT"; p.pst = "DISCARDING"; p.tcm = "INACTIVE";
    p.role = "disabled"; p.selectedRole = "disabled"; p.newInfo = true;
    p.state = DISABLED;
  }

  linkChange(name, up) {
    if (!this.started) return;
    const p = this.ports.get(name); if (!p) return;
    p.portEnabled = up; this._run();
  }

  // ----- timers: one tick a second -----
  _tick() {
    for (const p of this.ports.values()) {
      for (const k of ["helloWhen", "mdelayWhile", "edgeDelayWhile", "txCount", "fdWhile", "rrWhile", "rbWhile", "rcvdInfoWhile"]) if (p[k]) p[k]--;
      if (p.tcWhile && --p.tcWhile === 0) this._setTc();
    }
    this.net._after(1, () => this._tick(), true);
    this._run();
  }
  _setTc(hint, p) {
    const was = this.tcActive;
    this.tcActive = hint ? true : [...this.ports.values()].some(q => q.tcWhile !== 0);
    if (this.tcActive !== was) this.sw.log("stp", this.tcActive ? `topology change${p ? ` (port ${p.name})` : ""}` : "topology change over");
  }

  // ----- the clause 17 helpers -----
  _fwdDelay(p) { return p.sendRSTP ? p.portTimes.hello : this.rootTimes.fwd; }   // PRT's forwardDelay: the learning delay is a hello in RSTP
  _betterOrSameInfo(p, is) {
    if (is === "received" && p.infoIs === "received") return betterOrSame(p.msgPri, 0, p.portPri, 0);
    if (is === "mine" && p.infoIs === "mine") return betterOrSame(p.designatedPri, 0, p.portPri, 0);
    return false;
  }
  _newTcWhile(p) {
    if (p.tcWhile) return;
    if (p.sendRSTP) { p.tcWhile = p.portTimes.hello + 1; this._setTc(true, p); p.newInfo = true; }
    else { p.tcWhile = this.rootTimes.maxAge + this.rootTimes.fwd; this._setTc(true, p); }
  }
  _setTcPropTree(from) { for (const q of this.ports.values()) if (q !== from) q.tcProp = true; }
  _flush(p) { if (p.operEdge) { p.fdbFlush = false; return; } this.sw.flushPort(p.name); p.fdbFlush = false; }
  _allSynced(p) {
    for (const q of this.ports.values()) {
      if (!q.selected || q.role !== q.selectedRole || q.updtInfo) return false;
      if (p.role === "root" || p.role === "alternate" || p.role === "backup") { if (q.role !== "root" && !q.synced) return false; }
      else if (p.role === "designated") { if (q !== p && !q.synced) return false; }
      else return false;
    }
    return true;
  }

  // ----- PRX: port receive -----
  receive(ifname, f) {
    const p = this.ports.get(ifname); if (!p || !p.portEnabled) return;
    const b = f.bpdu;
    if (!b.tcn && cmpId(b.bridge, this.bid) === 0) return;          // our own BPDU back: loop or reflection
    if (!b.tcn && b.age >= b.maxAge) return;                        // message age reached max age
    p.bpdu = b; p.rcvdBpdu = true; this._run();
  }
  _prx(p) {
    if ((p.rcvdBpdu || p.edgeDelayWhile !== MIGRATE) && !p.portEnabled) {
      if (p.prx === "DISCARD" && !p.rcvdBpdu && !p.rcvdRSTP && !p.rcvdSTP && !p.rcvdMsg && p.edgeDelayWhile === MIGRATE) return false;
      p.prx = "DISCARD"; p.rcvdBpdu = p.rcvdRSTP = p.rcvdSTP = p.rcvdMsg = false; p.edgeDelayWhile = MIGRATE; return true;
    }
    if (p.prx === "DISCARD" && p.rcvdBpdu && p.portEnabled) { this._toReceive(p); return true; }
    if (p.prx === "RECEIVE" && p.rcvdBpdu && p.portEnabled && !p.rcvdMsg) { this._toReceive(p); return true; }
    return false;
  }
  _toReceive(p) {
    p.prx = "RECEIVE";
    if (p.bpdu.version >= 2) p.rcvdRSTP = true; else p.rcvdSTP = true;     // updtBPDUVersion
    p.rcvdMsg = true; p.operEdge = false; p.rcvdBpdu = false; p.edgeDelayWhile = MIGRATE;
  }

  // ----- PPM: protocol migration -----
  _ppm(p) {
    if (p.ppm === "CHECKING_RSTP") {
      if (p.mdelayWhile !== MIGRATE && !p.portEnabled) { p.mcheck = false; p.sendRSTP = true; p.mdelayWhile = MIGRATE; return true; }
      if (p.mdelayWhile === 0) { p.ppm = "SENSING"; p.rcvdRSTP = p.rcvdSTP = false; return true; }
    } else if (p.ppm === "SELECTING_STP") {
      if (p.mdelayWhile === 0 || !p.portEnabled || p.mcheck) { p.ppm = "SENSING"; p.rcvdRSTP = p.rcvdSTP = false; return true; }
    } else if (p.ppm === "SENSING") {
      if (!p.portEnabled || p.mcheck || (!p.sendRSTP && p.rcvdRSTP)) { p.ppm = "CHECKING_RSTP"; p.mcheck = false; p.sendRSTP = true; p.mdelayWhile = MIGRATE; return true; }
      if (p.sendRSTP && p.rcvdSTP) { p.ppm = "SELECTING_STP"; p.sendRSTP = false; p.mdelayWhile = MIGRATE; return true; }
    }
    return false;
  }

  // ----- BDM: bridge detection (edge ports) -----
  _bdm(p) {
    if (p.bdm === "EDGE") {
      if (((!p.portEnabled || !p.autoEdgeOn) && !p.adminEdge) || !p.operEdge) { p.bdm = "NOT_EDGE"; p.operEdge = false; return true; }
    } else if ((!p.portEnabled && p.adminEdge) || (p.edgeDelayWhile === 0 && p.autoEdgeOn && p.sendRSTP && p.proposing)) { p.bdm = "EDGE"; p.operEdge = true; return true; }
    return false;
  }

  // ----- PIM: port information -----
  _rcvInfo(p) {
    const b = p.bpdu;
    if (b.tcn) { p.rcvdTcn = true; p.rcvdTc = true; return "other"; }
    let designated = true;
    if (b.version >= 2) {
      const r = (b.flags >> 2) & 3;
      if (r === 1 || r === 2) designated = false; else if (r !== 3) return "other";
    }
    p.msgPri = {root: b.root, cost: b.cost, bridge: b.bridge, port: b.port};
    p.msgTimes = {fwd: b.fwd, maxAge: b.maxAge, hello: b.hello, age: b.age};
    const better = !betterOrSame(p.portPri, 0, p.msgPri, 0);
    if (designated) {
      if (better || (p.msgPri.bridge[1] === p.portPri.bridge[1] && ((p.msgPri.port ^ p.portPri.port) & 0x0fff) === 0)) return "superior";
      const same = sameVec(p.msgPri, p.portPri) && sameTimes(p.msgTimes, p.portTimes);
      if (!same && betterOrSame(p.msgPri, 0, p.portPri, 0)) return "superior";
      if (same && p.infoIs === "received") return "repeated";
      return "inferior";
    }
    return better ? "other" : "inferiorRoot";
  }
  _recordTcFlags(p) {
    const b = p.bpdu, fl = b.version >= 2 ? b.flags : (b.tc ? 1 : 0) | (b.tca ? 0x80 : 0);
    if (fl & 0x80) p.rcvdTcAck = true;
    if (fl & 1) p.rcvdTc = true;
  }
  _recordAgreement(p) {
    if (p.operP2P && p.bpdu.version >= 2 && (p.bpdu.flags & 0x40)) { p.agreed = true; p.proposing = false; } else p.agreed = false;
  }
  _updtRcvdInfoWhile(p) { p.rcvdInfoWhile = p.portTimes.age + 1 <= p.portTimes.maxAge ? 3 * p.portTimes.hello : 0; }
  _pim(p) {
    if (!p.portEnabled && p.infoIs !== "disabled") {
      p.pim = "DISABLED"; p.rcvdMsg = false; p.proposing = p.proposed = p.agree = p.agreed = false; p.rcvdInfoWhile = 0; p.infoIs = "disabled"; p.reselect = true; p.selected = false; return true;
    }
    switch (p.pim) {
      case "DISABLED":
        if (p.portEnabled) { p.pim = "AGED"; p.infoIs = "aged"; p.reselect = true; p.selected = false; return true; }
        if (p.rcvdMsg) { p.rcvdMsg = false; return true; }
        return false;
      case "AGED":
        if (p.selected && p.updtInfo) return this._toUpdate(p);
        return false;
      case "UPDATE": case "SUPERIOR_DESIGNATED": case "REPEATED_DESIGNATED": case "INFERIOR_DESIGNATED": case "NOT_DESIGNATED": case "OTHER": p.pim = "CURRENT"; return true;
      case "CURRENT":
        if (p.rcvdMsg && !p.updtInfo) { p.pim = "RECEIVE"; p.rcvdInfo = this._rcvInfo(p); return true; }
        if (p.infoIs === "received" && p.rcvdInfoWhile === 0 && !p.updtInfo && !p.rcvdMsg) { p.pim = "AGED"; p.infoIs = "aged"; p.reselect = true; p.selected = false; return true; }
        if (p.selected && p.updtInfo) return this._toUpdate(p);
        return false;
      case "RECEIVE": {
        switch (p.rcvdInfo) {
          case "superior":
            p.pim = "SUPERIOR_DESIGNATED"; p.agreed = false; p.proposing = false;
            if (p.bpdu.version >= 2 ? p.bpdu.flags & 2 : false) p.proposed = true;
            this._recordTcFlags(p);
            p.agree = p.agree && this._betterOrSameInfo(p, "received");
            this._recordAgreement(p); p.synced = p.synced && p.agreed;
            p.portPri = {...p.msgPri}; p.portTimes = times(p.msgTimes); this._updtRcvdInfoWhile(p);
            p.infoIs = "received"; p.reselect = true; p.selected = false; p.rcvdMsg = false; return true;
          case "repeated":
            p.pim = "REPEATED_DESIGNATED";
            if (p.bpdu.version >= 2 && (p.bpdu.flags & 2)) p.proposed = true;
            this._recordTcFlags(p); this._recordAgreement(p); this._updtRcvdInfoWhile(p); p.rcvdMsg = false; return true;
          case "inferior":
            p.pim = "INFERIOR_DESIGNATED";
            if (p.bpdu.version >= 2 && (p.bpdu.flags & 0x10)) { p.disputed = true; p.agreed = false; }
            p.rcvdMsg = false; return true;
          case "inferiorRoot": p.pim = "NOT_DESIGNATED"; this._recordAgreement(p); this._recordTcFlags(p); p.rcvdMsg = false; return true;
          default: p.pim = "OTHER"; p.rcvdMsg = false; return true;
        }
      }
    }
    return false;
  }
  _toUpdate(p) {
    p.pim = "UPDATE"; p.proposing = p.proposed = false;
    p.agreed = p.agreed && this._betterOrSameInfo(p, "mine"); p.synced = p.synced && p.agreed;
    p.portPri = {...p.designatedPri}; p.portTimes = times(p.designatedTimes); p.updtInfo = false; p.infoIs = "mine"; p.newInfo = true;
    return true;
  }

  // ----- PRS: port role selection (updtRolesTree) -----
  _prs() {
    if (![...this.ports.values()].some(p => p.reselect)) return false;
    let root = null;
    this.rootPri = {...this.bridgePri}; this.rootPortId = 0;
    for (const p of this.ports.values()) {
      if (p.infoIs !== "received" || cmpId(p.portPri.bridge, this.bid) === 0) continue;
      const cand = {...p.portPri, cost: p.portPri.cost + p.cost};
      if (betterOrSame(cand, p.id, this.rootPri, this.rootPortId)) { this.rootPri = cand; this.rootPortId = p.id; root = p; }
    }
    if (root) { this.rootTimes = times(root.portTimes); this.rootTimes.age++; } else this.rootTimes = times(this.bridgeTimes);
    this.rootPort = root ? root.name : null;
    for (const p of this.ports.values()) {
      p.designatedPri = {...this.rootPri, bridge: this.bid, port: p.id};
      p.designatedTimes = times(this.rootTimes); p.designatedTimes.hello = p.portTimes.hello;
    }
    for (const p of this.ports.values()) {
      if (p.infoIs === "disabled") { p.selectedRole = "disabled"; continue; }
      if (p.infoIs === "aged") { p.selectedRole = "designated"; p.updtInfo = true; continue; }
      if (p.infoIs === "mine") {
        p.selectedRole = "designated";
        if (!sameVec(p.portPri, p.designatedPri) || !sameTimes(p.portTimes, p.designatedTimes)) p.updtInfo = true;
        continue;
      }
      if (root === p) { p.selectedRole = "root"; p.updtInfo = false; }
      else if (betterOrSame(p.portPri, 0, p.designatedPri, 0)) { p.selectedRole = cmpId(p.portPri.bridge, this.bid) !== 0 ? "alternate" : "backup"; p.updtInfo = false; }
      else { p.selectedRole = "designated"; p.updtInfo = true; }
    }
    for (const p of this.ports.values()) { p.reselect = false; p.selected = true; }
    return true;
  }

  // ----- PRT: port role transitions -----
  _syncTree() { for (const q of this.ports.values()) q.sync = true; }
  _reRootTree() { for (const q of this.ports.values()) q.reRoot = true; }
  _prt(p) {
    const fwdDelay = this.rootTimes.fwd, maxAge = this.rootTimes.maxAge, fd = this._fwdDelay(p), hello = p.portTimes.hello;
    if (p.role !== p.selectedRole && p.selected && !p.updtInfo) {
      switch (p.selectedRole) {
        case "disabled": p.prt = "DISABLE_PORT"; p.role = "disabled"; p.learn = p.forward = false; return true;
        case "root": p.prt = "ROOT_PORT"; p.role = "root"; p.rrWhile = fwdDelay; return true;
        case "designated": p.prt = "DESIGNATED_PORT"; p.role = "designated"; return true;
        default: p.prt = "BLOCK_PORT"; p.role = p.selectedRole; p.learn = p.forward = false; return true;
      }
    }
    const allSynced = this._allSynced(p), ready = p.selected && !p.updtInfo;
    switch (p.prt) {
      case "INIT_PORT": p.prt = "DISABLE_PORT"; p.role = "disabled"; p.learn = p.forward = false; return true;
      case "DISABLE_PORT":
        if (ready && !p.learning && !p.forwarding) { p.prt = "DISABLED_PORT"; p.fdWhile = maxAge; p.synced = true; p.rrWhile = 0; p.sync = p.reRoot = false; return true; }
        return false;
      case "DISABLED_PORT":
        if (ready && (p.sync || p.reRoot || !p.synced || p.fdWhile !== maxAge)) { p.fdWhile = maxAge; p.synced = true; p.rrWhile = 0; p.sync = p.reRoot = false; return true; }
        return false;
      case "ROOT_PROPOSED": case "ROOT_AGREED": case "ROOT_SYNCED": case "REROOT": case "ROOT_FORWARD": case "ROOT_LEARN": case "REROOTED":
        p.prt = "ROOT_PORT"; p.role = "root"; p.rrWhile = fwdDelay; return true;
      case "ROOT_PORT": {
        if (!ready) return false;
        if (!p.forward && !p.reRoot) { p.prt = "REROOT"; this._reRootTree(); return true; }
        if ((p.agreed && !p.synced) || (p.sync && p.synced)) { p.prt = "ROOT_SYNCED"; p.synced = true; p.sync = false; return true; }
        if ((allSynced && !p.agree) || (p.proposed && p.agree)) { p.prt = "ROOT_AGREED"; p.proposed = false; p.sync = false; p.agree = true; p.newInfo = true; return true; }
        if (p.proposed && !p.agree) { p.prt = "ROOT_PROPOSED"; this._syncTree(); p.proposed = false; return true; }
        const reRooted = [...this.ports.values()].every(q => q === p || q.rrWhile === 0);
        if (p.fdWhile === 0 || (reRooted && p.rbWhile === 0)) {
          if (!p.learn) { p.prt = "ROOT_LEARN"; p.fdWhile = fd; p.learn = true; return true; }
          if (!p.forward) { p.prt = "ROOT_FORWARD"; p.fdWhile = 0; p.forward = true; return true; }
        }
        if (p.reRoot && p.forward) { p.prt = "REROOTED"; p.reRoot = false; return true; }
        if (p.rrWhile !== fwdDelay) { p.prt = "ROOT_PORT"; p.rrWhile = fwdDelay; return true; }
        return false;
      }
      case "DESIGNATED_PROPOSE": case "DESIGNATED_AGREED": case "DESIGNATED_SYNCED": case "DESIGNATED_RETIRED": case "DESIGNATED_FORWARD": case "DESIGNATED_LEARN": case "DESIGNATED_DISCARD":
        p.prt = "DESIGNATED_PORT"; p.role = "designated"; return true;
      case "DESIGNATED_PORT": {
        if (!ready) return false;
        if (p.reRoot && p.rrWhile === 0) { p.prt = "DESIGNATED_RETIRED"; p.reRoot = false; return true; }
        if ((!p.learning && !p.forwarding && !p.synced) || (p.agreed && !p.synced) || (p.operEdge && !p.synced) || (p.sync && p.synced)) { p.prt = "DESIGNATED_SYNCED"; p.rrWhile = 0; p.synced = true; p.sync = false; return true; }
        if (allSynced && (p.proposed || !p.agree)) { p.prt = "DESIGNATED_AGREED"; p.proposed = false; p.sync = false; p.agree = true; p.newInfo = true; return true; }
        if (!p.forward && !p.agreed && !p.proposing && !p.operEdge) { p.prt = "DESIGNATED_PROPOSE"; p.proposing = true; p.edgeDelayWhile = p.operP2P ? MIGRATE : maxAge; p.newInfo = true; return true; }
        if ((p.fdWhile === 0 || p.agreed || p.operEdge) && (p.rrWhile === 0 || !p.reRoot) && !p.sync) {
          if (!p.learn) { p.prt = "DESIGNATED_LEARN"; p.learn = true; p.fdWhile = fd; return true; }
          if (!p.forward) { p.prt = "DESIGNATED_FORWARD"; p.forward = true; p.fdWhile = 0; p.agreed = p.sendRSTP; return true; }
        }
        if (((p.sync && !p.synced) || (p.reRoot && p.rrWhile !== 0) || p.disputed) && !p.operEdge && (p.learn || p.forward)) {
          p.prt = "DESIGNATED_DISCARD"; p.learn = p.forward = p.disputed = false; p.fdWhile = fd; return true;
        }
        return false;
      }
      case "BLOCK_PORT":
        if (ready && !p.learning && !p.forwarding) { p.prt = "ALTERNATE_PORT"; p.fdWhile = fd; p.synced = true; p.rrWhile = 0; p.sync = p.reRoot = false; return true; }
        return false;
      case "BACKUP_PORT": case "ALTERNATE_PROPOSED": case "ALTERNATE_AGREED": p.prt = "ALTERNATE_PORT"; p.fdWhile = fd; p.synced = true; p.rrWhile = 0; p.sync = p.reRoot = false; return true;
      case "ALTERNATE_PORT":
        if (!ready) return false;
        if ((allSynced && !p.agree) || (p.proposed && p.agree)) { p.prt = "ALTERNATE_AGREED"; p.proposed = false; p.agree = true; p.newInfo = true; return true; }
        if (p.proposed && !p.agree) { p.prt = "ALTERNATE_PROPOSED"; this._syncTree(); p.proposed = false; return true; }
        if (p.rbWhile !== 2 * hello && p.role === "backup") { p.prt = "BACKUP_PORT"; p.rbWhile = 2 * hello; return true; }
        if (p.fdWhile !== fd || p.sync || p.reRoot || !p.synced) { p.fdWhile = fd; p.synced = true; p.rrWhile = 0; p.sync = p.reRoot = false; return true; }
        return false;
    }
    return false;
  }

  // ----- PST: port state transitions (the kernel's port state) -----
  _pst(p) {
    let ch = false;
    if (p.pst === "DISCARDING" && p.learn) { p.pst = "LEARNING"; p.learning = true; ch = true; }
    else if (p.pst === "LEARNING") {
      if (!p.learn) { p.pst = "DISCARDING"; p.learning = p.forwarding = false; ch = true; }
      else if (p.forward) { p.pst = "FORWARDING"; p.forwarding = true; ch = true; }
    } else if (p.pst === "FORWARDING" && !p.forward) { p.pst = "DISCARDING"; p.learning = p.forwarding = false; ch = true; }
    if (ch) this._setState(p);
    return ch;
  }
  _setState(p) {
    const s = !p.portEnabled && p.role === "disabled" ? DISABLED : p.forwarding ? FORWARDING : p.learning ? LEARNING : BLOCKING;
    if (s === p.state) return;
    this.sw.log("stp", `port ${p.name}: ${p.state} → ${s} (${p.role})`); p.state = s;
    if (s === DISABLED) this.sw.flushPort(p.name);
  }

  // ----- TCM: topology change -----
  _tcm(p) {
    const active = p.role === "root" || p.role === "designated";
    switch (p.tcm) {
      case "INACTIVE":
        if (p.learn && !p.fdbFlush) { p.tcm = "LEARNING"; p.rcvdTcn = p.rcvdTcAck = p.rcvdTc = p.tcProp = false; return true; }
        return false;
      case "LEARNING":
        if (active && p.forward && !p.operEdge) { p.tcm = "DETECTED"; this._newTcWhile(p); this._setTcPropTree(p); p.newInfo = true; return true; }
        if (p.rcvdTc || p.tcProp || p.rcvdTcn || p.rcvdTcAck) { p.rcvdTcn = p.rcvdTcAck = p.rcvdTc = p.tcProp = false; return true; }
        if (!active && !(p.learn || p.learning)) { p.tcm = "INACTIVE"; this._flush(p); p.tcWhile = 0; this._setTc(); p.tcAck = false; return true; }
        return false;
      case "NOTIFIED_TCN": p.tcm = "NOTIFIED_TC"; p.rcvdTc = false; p.rcvdTcn = false; if (p.role === "designated") p.tcAck = true; this._setTcPropTree(p); return true;
      case "DETECTED": case "NOTIFIED_TC": case "PROPAGATING": case "ACKNOWLEDGED": p.tcm = "ACTIVE"; return true;
      case "ACTIVE":
        if (!active || p.operEdge) { p.tcm = "LEARNING"; p.rcvdTcn = p.rcvdTcAck = p.rcvdTc = p.tcProp = false; return true; }
        if (p.rcvdTcn) { p.tcm = "NOTIFIED_TCN"; this._newTcWhile(p); return true; }
        if (p.rcvdTc) { p.tcm = "NOTIFIED_TC"; p.rcvdTc = false; p.rcvdTcn = false; if (p.role === "designated") p.tcAck = true; this._setTcPropTree(p); return true; }
        if (p.tcProp) { p.tcm = "PROPAGATING"; this._newTcWhile(p); this._flush(p); p.tcProp = false; return true; }
        if (p.rcvdTcAck) { p.tcm = "ACKNOWLEDGED"; p.tcWhile = 0; this._setTc(); p.rcvdTcAck = false; return true; }
    }
    return false;
  }

  // ----- PTX: port transmit -----
  _ptx(p) {
    if (!p.portEnabled) {
      if (p.ptx === "TRANSMIT_INIT" && p.newInfo && p.txCount === 0) return false;
      p.ptx = "TRANSMIT_INIT"; p.newInfo = true; p.txCount = 0; return true;
    }
    if (p.ptx !== "IDLE") { p.ptx = "IDLE"; p.helloWhen = p.portTimes.hello; return true; }
    if (!p.selected || p.updtInfo) return false;
    if (p.helloWhen === 0) { p.ptx = "TRANSMIT_PERIODIC"; p.newInfo = p.newInfo || p.role === "designated" || (p.role === "root" && p.tcWhile !== 0); return true; }
    if (!(p.txCount < TX_HOLD)) return false;
    if (p.sendRSTP) { if (p.newInfo) { this._txRstp(p); return true; } }
    else if (p.newInfo && p.role === "designated") { this._txConfig(p); return true; }
    else if (p.newInfo && p.role === "root") { this._txTcn(p); return true; }
    return false;
  }
  _bpduBase(p) {
    const d = p.designatedPri, t = p.designatedTimes;
    return {root: d.root, cost: d.cost, bridge: d.bridge, port: d.port, age: t.age, maxAge: t.maxAge, hello: p.portTimes.hello, fwd: t.fwd};
  }
  _tx(p, bpdu) { this.sw.send(p.name, {src: this.sw.ifaces[p.name].mac, dst: STP_MAC, type: "bpdu", bpdu}); p.txCount++; p.newInfo = false; }
  _txRstp(p) {
    if (p.role === "disabled") { p.newInfo = false; return; }
    let flags = ROLE[p.role] << 2;
    if (p.tcWhile) flags |= 1; if (p.proposing) flags |= 2; if (p.learning) flags |= 0x10; if (p.forwarding) flags |= 0x20; if (p.agree) flags |= 0x40;
    this._tx(p, {...this._bpduBase(p), version: 2, flags, tc: !!p.tcWhile, tca: false}); p.tcAck = false;
  }
  _txConfig(p) { this._tx(p, {...this._bpduBase(p), tc: !!p.tcWhile, tca: !!p.tcAck}); p.tcAck = false; }
  _txTcn(p) { this._tx(p, {tcn: true}); }

  // ----- run every machine until nothing changes -----
  // The daemon's order: per port receive, migration, bridge detection, transmit and port information; then role selection;
  // then per port role transitions, state transitions and topology change. Each machine runs on until it has no transition
  // left (so a BPDU leaves only once the machines before it have settled), and the whole pass repeats until nothing changes.
  _run() {
    if (this.running) { this.again = true; return; }
    this.running = true;
    const rtc = (fn, p) => { let ch = false; for (let i = 0; i < 200 && fn.call(this, p); i++) ch = true; return ch; };
    try {
      for (let n = 0; n < 500; n++) {
        let ch = false;
        for (const p of this.ports.values()) { ch = rtc(this._prx, p) || ch; ch = rtc(this._ppm, p) || ch; ch = rtc(this._bdm, p) || ch; ch = rtc(this._ptx, p) || ch; ch = rtc(this._pim, p) || ch; }
        ch = this._prs() || ch;
        for (const p of this.ports.values()) { ch = rtc(this._prt, p) || ch; ch = rtc(this._pst, p) || ch; ch = rtc(this._tcm, p) || ch; this._setState(p); }
        if (!ch && !this.again) break; this.again = false;
      }
    } finally { this.running = false; }
  }

  /** What an engineer would read off `show spanning-tree`. */
  describe() {
    const state = {blocking: "discarding"};
    return {mode: "rstp", bridgeId: idStr(this.bid), root: idStr(this.rootPri.root), isRoot: this.isRoot(), topologyChange: this.tcActive, rootCost: this.rootPri.cost, rootPort: this.rootPort,
      ports: Object.fromEntries([...this.ports.values()].map(p => [p.name, {role: p.role, state: state[p.state] ?? p.state, no: p.no, id: p.id, cost: p.cost, edge: p.operEdge, pointToPoint: p.operP2P,
        designatedRoot: idStr(p.portPri.root), designatedCost: p.portPri.cost, designatedBridge: idStr(p.portPri.bridge), designatedPort: p.portPri.port}]))};
  }
}
