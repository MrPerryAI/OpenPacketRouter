/* ========================================================================
   1. THE NETWORK  (same as the Packet Tracer lab)
   Sites sit at their real longitude/latitude (latitude stretched 2x).
   ======================================================================== */
const FE = 100e6, GE = 1e9, FRAME_BITS = 84 * 8, SWITCH_LAT = 5e-6, MS = 1e-3, US = 1e-6;
const LON0 = -108, LAT0 = 37.5;
const proj = (lon, lat) => [Math.round(40 + (lon - LON0) * 46), Math.round(70 + (LAT0 - lat) * 92)];
const [ABQ, AMA, FTW, ELD, MEM] = [proj(-106.65, 35.08), proj(-101.83, 35.19), proj(-97.32, 32.75), proj(-92.67, 33.21), proj(-90.05, 35.15)];
const DEV = {
  "NOC-SW":   {kind: "switch", x: 470, y: 118, label: "NOC-SW", tag: "FTI core", ptag: "Network HQ", psub: "", prio: 4096, mac: 1},
  "ZFW-SW":   {kind: "switch", x: FTW[0], y: FTW[1], label: "ZFW-SW", tag: "Fort Worth Center", ptag: "Fort Worth", psub: "air traffic center", center: "ZFW", prio: 32768, mac: 2},
  "ZME-SW":   {kind: "switch", x: MEM[0], y: MEM[1], label: "ZME-SW", tag: "Memphis Center", ptag: "Memphis", psub: "air traffic center", center: "ZME", prio: 32768, mac: 9},
  "ZAB-SW":   {kind: "switch", x: ABQ[0] + 30, y: ABQ[1], label: "ZAB-SW", tag: "Albuquerque Center", ptag: "Albuquerque", psub: "air traffic center", center: "ZAB", prio: 32768, mac: 3},
  "AMA-SW":   {kind: "switch", x: AMA[0], y: AMA[1], label: "AMA-SW", tag: "Amarillo radar site", ptag: "Amarillo", psub: "radar site", prio: 32768, mac: 5},
  "ELD-OLD":  {kind: "switch", x: ELD[0] - 25, y: ELD[1] + 30, label: "ELD-OLD", tag: "", ptag: "Old junction", psub: "", prio: 32768, mac: 6},
  "ELD-NEW":  {kind: "switch", x: ELD[0] + 150, y: ELD[1] + 30, label: "ELD-NEW", tag: "", ptag: "New junction", psub: "", prio: 32768, mac: 7},
  "ELD-RTR":  {kind: "router", x: ELD[0] + 150, y: ELD[1] - 80, label: "ELD-RTR", tag: "routed edge", ptag: "Border gate", psub: "", routedOnly: true},
  "NOC-MON":  {kind: "host", x: 610, y: 84, label: "NOC-MON", plabel: "HQ screen", glyph: "M"},
  "ZFW-VOICE":{kind: "host", x: FTW[0] - 150, y: FTW[1], label: "ZFW-VOICE", plabel: "Fort Worth desk", glyph: "V"},
  "ZME-VOICE":{kind: "host", x: MEM[0] + 90, y: MEM[1] - 80, label: "ZME-VOICE", plabel: "Memphis desk", glyph: "V"},
  "ZAB-VOICE":{kind: "host", x: ABQ[0] + 30, y: ABQ[1] - 100, label: "ZAB-VOICE", plabel: "Albuquerque desk", glyph: "V"},
  "AMA-RADAR":{kind: "host", x: AMA[0], y: AMA[1] - 100, label: "AMA-RADAR", plabel: "radar dish", glyph: "R"},
  "ELD-RADIO":{kind: "host", x: ELD[0] - 25, y: ELD[1] + 130, label: "ELD-RADIO", plabel: "radio tower", glyph: "RF"},
};
const SITE = {x: ELD[0] - 105, y: ELD[1] - 40, w: 350, h: 215, label: "EL DORADO, AR · REMOTE RADIO SITE"};
const LINKS = [
  ["L1", "NOC-SW", "Fa0/1", "ZFW-SW", "Fa0/1", 4*MS, FE, ""],
  ["L2", "NOC-SW", "Fa0/2", "ZME-SW", "Fa0/1", 6*MS, FE, ""],
  ["L3", "NOC-SW", "Fa0/3", "ZAB-SW", "Fa0/1", 8*MS, FE, ""],
  ["L4", "ZFW-SW", "Fa0/2", "ZME-SW", "Fa0/2", 5*MS, FE, "backup"],
  ["L5", "ZME-SW", "Fa0/3", "ZAB-SW", "Fa0/2", 9*MS, FE, "backup", [470, 480]],
  ["L6", "ZME-SW", "Fa0/4", "ELD-OLD","Fa0/1", 3*MS, FE, "old copper"],
  ["L7", "ZAB-SW", "Fa0/4", "AMA-SW", "Fa0/1", 3*MS, FE, ""],
  ["L8", "NOC-SW", "Fa0/10","NOC-MON","Fa0", 1*US, FE, ""],
  ["L9", "ZFW-SW", "Fa0/11","ZFW-VOICE","Fa0", 1*US, FE, ""],
  ["L10","ZME-SW", "Fa0/11","ZME-VOICE","Fa0", 1*US, FE, ""],
  ["L11","ZAB-SW", "Fa0/11","ZAB-VOICE","Fa0", 1*US, FE, ""],
  ["L12","AMA-SW", "Fa0/10","AMA-RADAR","Fa0", 1*US, FE, ""],
  ["L13","ELD-OLD","Fa0/10","ELD-RADIO","Fa0", 1*US, FE, ""],
  ["L14","NOC-SW", "Gi0/1", "ELD-NEW","Gi0/1", 7*MS, GE, "new fiber"],
  ["L15","ELD-NEW","Fa0/23","ELD-OLD","Fa0/23", 1*US, FE, "cross-connect A", [ELD[0] + 62, ELD[1] + 0]],
  ["L16","ELD-NEW","Fa0/24","ELD-OLD","Fa0/24", 1*US, FE, "cross-connect B", [ELD[0] + 62, ELD[1] + 65]],
  ["L17","ZME-SW", "Fa0/4", "ELD-RTR","Gi0/0", 3*MS, FE, "", null, true],
  ["L18","ELD-RTR","Gi0/1", "ELD-NEW","Gi0/1", 1*US, FE, "", null, true],
].map(([id, a, ap, b, bp, prop, cap, label, ctrl, routedOnly]) => ({id, a, ap, b, bp, prop, cap, label, ctrl, routedOnly: !!routedOnly}));
const LINK = Object.fromEntries(LINKS.map(l => [l.id, l]));
const PLAIN_LINK = {L4: "spare road", L5: "spare road", L6: "old cable", L14: "new fiber", L15: "cable A", L16: "cable B"};
const CENTERS = [["ZFW", "ZFW-VOICE", "L1"], ["ZME", "ZME-VOICE", "L2"], ["ZAB", "ZAB-VOICE", "L3"]];

/* ========================================================================
   2. STATE + PRESETS
   ======================================================================== */
const S = {
  link: {}, stp: {}, bpduPass: true, routed: false,
  live: false, chatter: false, broadcasts: [], t0: performance.now(),
  sel: null, mission: 0, seen: {}, gsStart: null, gsLast: null, history: [],
  mode: "student", stepDone: [], predicted: null, hints: 0,
};
function preset(name) {
  for (const l of LINKS) S.link[l.id] = l.routedOnly ? "absent" : "up";
  for (const id of ["L14", "L15", "L16"]) S.link[id] = "absent";
  Object.assign(S.stp, {"NOC-SW": true, "ZFW-SW": true, "ZME-SW": true, "ZAB-SW": true,
                        "AMA-SW": false, "ELD-OLD": false, "ELD-NEW": false});
  S.bpduPass = true; S.routed = false; S.chatter = false; S.live = false; S.broadcasts = []; S.sel = null;
  S.gsStart = null; S.gsLast = null; S.history = [];
  if (name === "cutover" || name === "storm") for (const id of ["L14", "L15", "L16"]) S.link[id] = "up";
  if (name === "storm") { S.chatter = true; S.live = true; }
  if (name === "fixed") { for (const id of ["L14", "L15", "L16"]) S.link[id] = "up";
    S.stp["ELD-OLD"] = S.stp["ELD-NEW"] = S.stp["AMA-SW"] = true; }
  recompute();
}
function setRouted(on) {
  S.routed = on;
  S.link.L6 = S.link.L14 = on ? "absent" : "up";
  S.link.L17 = S.link.L18 = on ? "up" : "absent";
}

