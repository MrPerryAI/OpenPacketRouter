// Browser smoke test for the Studio (studio/), served as static files from the repository root.
//   node tests/studio/smoke.mjs            (SCREENSHOT=dir to save a picture of each lab)
// Needs the `playwright` package and a Chromium it can launch.
import {createRequire} from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const {chromium} = createRequire(import.meta.url)("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let failures = 0;
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? "  (" + detail + ")" : ""}`); if (!ok) failures++; };

const TYPES = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".md": "text/markdown"};
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  const f = p.endsWith("/") ? path.join(p, "index.html") : p;
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {"content-type": TYPES[path.extname(f)] || "application/octet-stream"}); fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/studio/`;

const labs = fs.readdirSync(path.join(root, "examples")).filter(d => fs.existsSync(path.join(root, "examples", d, "spec.json"))).sort();
const shots = process.env.SCREENSHOT;
const browser = await chromium.launch({args: process.platform === "darwin" ? ["--single-process"] : []});
try {
  const page = await (await browser.newContext({viewport: {width: 1440, height: 950}})).newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => { if (m.type() === "error" && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  await page.goto(BASE); await page.waitForFunction(() => document.body.dataset.ready);
  check(await page.evaluate(() => document.body.dataset.ready) === "1", "studio starts");

  const listed = await page.$$eval("#examples option[value]:not([value=''])", o => o.length);
  check(listed === labs.length, "every lab in examples/ is in the dropdown", `${listed} listed, ${labs.length} folders`);

  for (const [i, lab] of (await page.evaluate(() => window.studio.S.examples.map(e => e.id))).entries()) {
    await page.selectOption("#examples", String(i));
    await page.waitForFunction(id => window.studio.S.name === id, lab);
    const r = await page.evaluate(() => { const S = window.studio.S; return {
      nodes: document.querySelectorAll("#map .node").length, cables: document.querySelectorAll("#map line.cable").length,
      specNodes: S.spec.nodes.length, specLinks: S.spec.links.length, steps: S.sim.steps.length, actions: document.querySelectorAll("#actions li[data-action]").length,
      wantActions: S.actions.length, errors: document.querySelector("#errors").hidden ? "" : document.querySelector("#errors").textContent}; });
    check(r.nodes === r.specNodes && r.cables === r.specLinks && r.actions === r.wantActions && r.steps > 0 && !r.errors,
      `${lab}: draws ${r.nodes} devices, ${r.cables} cables, runs ${r.actions} actions`, `${r.steps} frames${r.errors ? "; " + r.errors : ""}`);
    const q = await page.evaluate(() => { const st = window.studio.S.sim.steps; const filt = [...document.querySelectorAll("#filters input[data-kind]")].map(x => x.dataset.kind);
      return {badDesc: st.filter(x => /undefined|NaN|\[object|\?\?/.test(x.desc || "")).map(x => x.desc).slice(0, 2), noDesc: st.filter(x => !x.desc).length,
        noFilter: [...new Set(st.map(x => x.kind))].filter(k => !filt.includes(k))}; });
    await page.evaluate(() => { const st = window.studio; st.goto(st.S.sim.steps.length - 1); for (const nd of st.S.spec.nodes) st.select(nd.name); });   // every device panel at the last frame: a throw lands in "no page errors"
    check(!q.badDesc.length && !q.noDesc && !q.noFilter.length, `${lab}: every frame is described and has a filter`, JSON.stringify(q).slice(0, 200));
    if (shots) { fs.mkdirSync(shots, {recursive: true}); await page.screenshot({path: path.join(shots, `${lab}.png`)}); }
  }

  // loop with spanning tree: one port blocks at rest
  await page.goto(BASE + "?lab=loop-with-stp"); await page.waitForFunction(() => document.body.dataset.ready === "1");
  check(await page.$$eval(".port-dot.blocking", d => d.length) === 1, "loop-with-stp: one port drawn blocking after convergence");
  check(await page.getAttribute("#storm", "data-regime") === "TREE", "loop-with-stp: storm badge says no loop");

  // playback: step, reasons, play/pause
  await page.goto(BASE + "?lab=routed-lan-dns"); await page.waitForFunction(() => document.body.dataset.ready === "1");
  await page.click("#step");
  const reason = await page.textContent("#reason");
  check(/PC1:eth0 → SW1:p1/.test(reason) && /who has 10\.0\.0\.1/.test(reason), "step 1: the first frame and the engine's reason", reason.replace(/\s+/g, " ").slice(0, 120));
  check(await page.$$eval("line.cable.active", l => l.length) === 1 && await page.$$eval("circle.packet", c => c.length) === 1, "step 1: the cable lights up and a packet moves");
  await page.click("#step"); await page.click("#back");
  check(await page.evaluate(() => window.studio.S.step) === 0, "step back");
  await page.fill("#speed", "4"); await page.dispatchEvent("#speed", "input");
  await page.click("#play"); await page.waitForTimeout(600); await page.click("#play");
  const at = await page.evaluate(() => window.studio.S.step);
  check(at > 2, "play advances and pause stops", `at frame ${at + 1}`);
  await page.waitForTimeout(300);
  check(await page.evaluate(() => window.studio.S.step) === at, "paused stays put");

  // device panel
  await page.evaluate(() => window.studio.goto(window.studio.S.sim.actions[0].last));
  await page.click('#map .node[data-node="R1"]');
  const dev = await page.textContent("#device");
  check(/Routing table/.test(dev) && /10\.1\.0\.0\/24/.test(dev) && /ARP cache/.test(dev) && /10\.0\.0\.10/.test(dev), "router panel: routing table and ARP cache");
  await page.click('#map .node[data-node="SW1"]');
  check(/MAC address table/.test(await page.textContent("#device")) && await page.$$eval("#device table", t => t[0].rows.length) > 1, "switch panel: learned MAC addresses");

  // storm badge + cable cut on the loop
  await page.goto(BASE + "?lab=loop-no-stp"); await page.waitForFunction(() => document.body.dataset.ready === "1");
  check(await page.getAttribute("#storm", "data-regime") === "CIRCULATING", "loop-no-stp: badge says broadcasts circulate", await page.textContent("#storm"));
  const before = await page.evaluate(() => window.studio.S.sim.steps.length);
  await page.click('g.cable-group[data-link="0"] line.cable-hit');
  await page.waitForFunction(() => window.studio.S.cut.has(0));
  const after = await page.evaluate(() => window.studio.S.sim.steps.length);
  check(await page.getAttribute("#storm", "data-regime") === "TREE" && after < before && await page.$$eval("line.cable.cut", l => l.length) === 1,
    "cutting a ring cable ends the loop and re-runs", `${before} → ${after} frames`);
  await page.click('g.cable-group[data-link="0"] line.cable-hit');
  await page.waitForFunction(() => !window.studio.S.cut.has(0));
  check(await page.getAttribute("#storm", "data-regime") === "CIRCULATING", "plugging it back in brings the loop back");

  // DHCP leases
  await page.goto(BASE + "?lab=dhcp-router"); await page.waitForFunction(() => document.body.dataset.ready === "1");
  await page.evaluate(() => window.studio.goto(window.studio.S.sim.actions[0].last));
  await page.click('#map .node[data-node="DHCP"]');
  check(/DHCP leases/.test(await page.textContent("#device")) && /10\.0\.0\.100/.test(await page.textContent("#device")), "DHCP server panel lists the lease");

  // console: the project's CLI (cli/) per device; config changes re-run the network
  await page.goto(BASE + "?lab=routed-lan-dns"); await page.waitForFunction(() => document.body.dataset.ready === "1");
  await page.dblclick('#map .node[data-node="R1"]');
  check(await page.isVisible("#console") && await page.textContent("#consolePrompt") === "R1>", "double-click opens the console at R1>");
  const type = async line => { await page.fill("#consoleInput", line); await page.press("#consoleInput", "Enter"); };
  await type("en"); await type("conf t");
  await page.fill("#consoleInput", "int eth"); await page.press("#consoleInput", "?");
  check(/eth0/.test(await page.textContent("#consoleOut")) && /eth1/.test(await page.textContent("#consoleOut")), "? lists the interfaces");
  await page.fill("#consoleInput", "interface eth1"); await page.press("#consoleInput", "Enter");
  check(await page.textContent("#consolePrompt") === "R1(config-if)#", "prompt follows the mode", await page.textContent("#consolePrompt"));
  await page.fill("#consoleInput", "shut"); await page.press("#consoleInput", "Tab");
  check(await page.inputValue("#consoleInput") === "shutdown ", "Tab completes a word");
  await page.press("#consoleInput", "Enter");
  const failed = await page.evaluate(() => window.studio.S.sim.actions.map(a => !!a.result.ok));
  check(await page.$$eval("line.cable.cut", l => l.length) === 1 && failed[0] === false, "shutdown unplugs the cable and the ping fails", failed.join(","));
  await type("no shutdown"); await type("end"); await type("ping 10.1.0.53");
  check(/1 sent, 1 answered/.test(await page.textContent("#consoleOut")) && await page.evaluate(() => window.studio.S.actions.length) === 5,
    "ping from the console succeeds and joins the playback");
  await page.press("#consoleInput", "ArrowUp");
  check(await page.inputValue("#consoleInput") === "ping 10.1.0.53", "↑ recalls history");
  await page.fill("#consoleInput", ""); await type("conf t"); await type("hostname CORE");
  check(await page.textContent("#consolePrompt") === "CORE(config)#" && await page.$$eval('#map .node[data-node="CORE"]', n => n.length) === 1, "hostname renames the device on the map");
  await type("ip route 10.9.0.0 255.255.255.0 10.1.0.99"); await type("do show ip route");
  check(/S  10\.9\.0\.0\/24 via 10\.1\.0\.99/.test(await page.textContent("#consoleOut")), "static route added and shown");
  await type("ip route 10.9.0.0 255.255.255.0 10.7.7.7");
  check(/not on any of its subnets/.test(await page.textContent("#consoleOut")), "an invalid change is refused with the engine's reason");
  await type("do show ip interface brief | json");
  check(/"address": "10\.0\.0\.1\/24"/.test(await page.textContent("#consoleOut")), "| json prints the show output as JSON");
  await page.evaluate(() => window.studio.goto(window.studio.S.sim.actions[0].last)); await type("do show arp");
  check(/10\.0\.0\.10/.test((await page.textContent("#consoleOut")).split("show arp").pop()), "show arp reads the tables at the current frame");
  await page.evaluate(() => window.studio.goto(-1)); await type("do show arp");
  check(/empty/.test((await page.textContent("#consoleOut")).split("show arp").pop()), "… and they are empty before the first frame");
  await page.click("#consoleClose");


  // several consoles in tabs
  await page.dblclick('#map .node[data-node="CORE"]');
  const other = await page.evaluate(() => window.studio.S.spec.nodes.find(n => n.name !== "CORE" && n.kind !== "switch").name);
  await page.evaluate(n => window.studio.openConsole(n), other);
  check(await page.$$eval("#consoleTabs .tab", t => t.length) >= 2 && await page.$eval("#consoleTabs .tab.on", t => t.dataset.tab) === other, "each opened device gets a console tab");
  await page.click('#consoleTabs .tab[data-tab="CORE"] span');
  check(/^CORE/.test(await page.textContent("#consolePrompt")) && /hostname CORE/.test(await page.textContent("#consoleOut")), "clicking a tab switches to that console and keeps its history");
  await type("conf t"); await type("hostname EDGE");
  check(await page.$$eval('#consoleTabs .tab[data-tab="EDGE"]', t => t.length) === 1 && await page.$$eval('#map .node[data-node="EDGE"]', n => n.length) === 1, "configuring in a tab updates the map and the tab name");
  await page.click(`#consoleTabs .tab[data-tab="${other}"] button`);
  check(await page.$$eval("#consoleTabs .tab", t => t.length) === 1 && await page.isVisible("#console"), "closing a tab leaves the others open");
  await page.click("#consoleTabs .tab button");
  check(!(await page.isVisible("#console")), "closing the last tab closes the console window");
  // topology editor: build a small network from the palette, validate, edit, delete
  await page.evaluate(() => window.studio.load({version: 1, name: "Empty", nodes: [], links: []}));
  await page.click('[data-add="switch"]'); await page.click('[data-add="host"]'); await page.click('[data-add="host"]');
  check(await page.$$eval("#map .node", n => n.length) === 3, "palette adds a switch and two hosts");
  await page.click('[data-tool="cable"]');
  await page.dispatchEvent('#map .node[data-node="PC1"]', "pointerdown"); await page.dispatchEvent('#map .node[data-node="SW1"]', "pointerdown");
  await page.dispatchEvent('#map .node[data-node="PC2"]', "pointerdown"); await page.dispatchEvent('#map .node[data-node="SW1"]', "pointerdown");
  check(await page.evaluate(() => JSON.stringify(window.studio.S.spec.links)) === '[["PC1:eth0","SW1:p1"],["PC2:eth0","SW1:p2"]]', "cable tool joins two devices on the next free ports");
  await page.click('[data-tool="select"]'); await page.evaluate(() => window.studio.select("PC1"));
  await page.fill('[data-f=addr][data-iface=eth0]', "10.0.0.1/24"); await page.press('[data-f=addr][data-iface=eth0]', "Enter");
  await page.evaluate(() => window.studio.select("PC2"));
  await page.fill('[data-f=addr][data-iface=eth0]', "10.0.0.2/24"); await page.press('[data-f=addr][data-iface=eth0]', "Enter");
  check(await page.evaluate(() => window.studio.S.spec.nodes[2].ifaces.eth0) === "10.0.0.2/24", "interface address edited in the form");
  await page.fill('[data-f=addr][data-iface=eth0]', "banana"); await page.press('[data-f=addr][data-iface=eth0]', "Enter");
  check(/not an address/.test(await page.textContent("#errors")) && await page.evaluate(() => window.studio.S.spec.nodes[2].ifaces.eth0) === "10.0.0.2/24", "an invalid address is refused with the validator's message");
  await page.evaluate(() => window.studio.select("SW1"));
  await page.fill('[data-f=vlan][data-port=p1]', "10"); await page.press('[data-f=vlan][data-port=p1]', "Enter");
  check(await page.evaluate(() => JSON.stringify(window.studio.S.spec.nodes[0].vlans)) === '{"p1":{"access":10}}', "switch port VLAN edited in the form");
  await page.fill('[data-f=name]', "CORE"); await page.press('[data-f=name]', "Enter");
  check(await page.evaluate(() => window.studio.S.spec.links[0][1]) === "CORE:p1", "renaming a device renames its cable ends");
  await page.evaluate(() => window.studio.S.actions = []);
  check(await page.evaluate(() => { const S = window.studio.S; return window.studio.edit({...S.spec, nodes: S.spec.nodes.map(n => ({...n}))}); }), "edit accepts a valid spec");
  await page.click('[data-tool="delete"]');
  await page.dispatchEvent('#map .cable-hit >> nth=0', "click");
  check(await page.evaluate(() => window.studio.S.spec.links.length) === 1, "delete tool removes a cable");
  await page.dispatchEvent('#map .node[data-node="PC2"]', "pointerdown");
  check(await page.evaluate(() => window.studio.S.spec.nodes.length + "/" + window.studio.S.spec.links.length) === "2/0", "delete tool removes a device and its cables");
  await page.click('[data-tool="select"]');
  // save and export: download the spec, reopen it, autosave and restore
  await page.evaluate(() => { localStorage.removeItem("studio-autosave"); window.studio.load({version: 1, name: "Saved net", nodes: [{name: "SW1", kind: "switch"}, {name: "PC1", kind: "host", ifaces: {eth0: "10.0.0.1/24"}}], links: [["PC1:eth0", "SW1:p1"]]}); });
  check(await page.evaluate(() => !localStorage.getItem("studio-autosave")), "a plain load does not autosave");
  await page.evaluate(() => { const c = URL.createObjectURL; URL.createObjectURL = b => { window.lastBlob = b; return c.call(URL, b); };
    document.addEventListener("click", e => { if (e.target.download) window.lastName = e.target.download; }, true); });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#saveSpec")]);
  const saved = await page.evaluate(() => window.lastBlob.text());
  check(dl.suggestedFilename() === "saved-net.spec.json" && JSON.parse(saved).nodes.length === 2, "Save spec downloads the network as JSON", dl.suggestedFilename());
  await page.evaluate(() => window.studio.load({version: 1, name: "Other", nodes: [], links: []}));
  await page.setInputFiles("#specFile", {name: "saved.json", mimeType: "application/json", buffer: Buffer.from(saved)});
  await page.waitForFunction(() => window.studio.S.spec.nodes.length === 2);
  check(await page.evaluate(() => window.studio.specJson()) === saved, "reopening the saved file gives the same spec back");
  await page.evaluate(() => window.studio.toggleCut(0));                 // any change autosaves
  check(await page.evaluate(() => !!localStorage.getItem("studio-autosave")) && !(await page.$eval("#restore", b => b.hidden)), "a change autosaves and shows Restore");
  await page.evaluate(() => window.studio.load({version: 1, name: "Other", nodes: [], links: []}));
  await page.click("#restore");
  check(await page.evaluate(() => window.studio.S.spec.name) === "Saved net", "Restore autosave brings the network back");
  await page.evaluate(() => { const s = Storage.prototype.setItem; Storage.prototype.setItem = () => { throw new Error("quota"); }; window.studio.toggleCut(0); Storage.prototype.setItem = s; });
  check(true, "a full or disabled browser storage does not break the page");
  await page.evaluate(() => localStorage.setItem("studio-autosave", "{not json")); 
  check(await page.evaluate(() => window.studio.restoreAutosave()) === false, "a corrupt autosave is ignored");
  // YAML: save the network as YAML and open it again
  await page.evaluate(() => { window.studio.load({version: 1, name: "Yaml net", nodes: [{name: "SW1", kind: "switch"}, {name: "PC1", kind: "host", ifaces: {eth0: "10.0.0.1/24"}}], links: [["PC1:eth0", "SW1:p1"]]}); });
  const [dly] = await Promise.all([page.waitForEvent("download"), page.click("#saveYaml")]);
  const ytext = await page.evaluate(() => window.lastBlob.text());
  check(dly.suggestedFilename() === "yaml-net.spec.yaml" && /"name": "SW1"/.test(ytext), "Save YAML downloads the network as YAML", dly.suggestedFilename());
  await page.evaluate(() => window.studio.load({version: 1, name: "Other", nodes: [], links: []}));
  await page.setInputFiles("#specFile", {name: "net.yaml", mimeType: "text/yaml", buffer: Buffer.from(ytext)});
  await page.waitForFunction(() => window.studio.S.spec.nodes.length === 2);
  check(await page.evaluate(() => window.studio.S.spec.nodes[1].ifaces.eth0) === "10.0.0.1/24", "a YAML spec opens like a JSON one");

  // panels for newer engine features
  // student guides: every lab with a README shows it, commands get run buttons that reach the console
  const {renderGuide} = await import(path.join(root, "studio", "guide.js"));
  const safe = renderGuide("<script>x</script> [a](javascript:alert(1)) [b](https://x.test) [ok](other.md) `show ip route`", ["R"], "R");
  check(!/<script|href="javascript|href="https/.test(safe) && /href="other.md"/.test(safe) && /data-device="R"/.test(safe), "the guide renderer escapes HTML and keeps only relative links");
  const labsWithGuide = fs.readdirSync(path.join(root, "examples")).filter(d => fs.existsSync(path.join(root, "examples", d, "README.md")) && fs.existsSync(path.join(root, "examples", d, "spec.json")));
  let guideButtons = 0, guideBad = [];
  for (const lab of labsWithGuide) {
    await page.goto(BASE + "?lab=" + lab); await page.waitForFunction(() => document.body.dataset.ready === "1");
    await page.waitForFunction(() => !document.querySelector("#guideBox").hidden, null, {timeout: 5000}).catch(() => guideBad.push(lab + ": no guide"));
    const n = await page.$$eval(".run-cmd", b => b.length);
    for (let i = 0; i < n; i++) {
      await page.evaluate(k => document.querySelectorAll(".run-cmd")[k].click(), i);
      const out = await page.textContent("#consoleOut");
      if (/undefined|\[object|TypeError/.test(out)) guideBad.push(lab + ": " + out.slice(-80));
      guideButtons++;
    }
  }
  check(labsWithGuide.length > 0 && guideBad.length === 0, `every lab guide opens and its command buttons reach the console (${labsWithGuide.length} labs, ${guideButtons} buttons)`, guideBad.join("; ").slice(0, 200));
  check(guideButtons > 0, "at least one guide has a run-in-console button");

  const panel = async (lab, dev) => { await page.goto(BASE + "?lab=" + lab); await page.waitForFunction(() => document.body.dataset.ready === "1");
    await page.evaluate(d => window.studio.select(d), dev); return page.textContent("#device"); };
  check(/RIP routes/.test(await panel("rip-chain", "R2")) && /192\.168|10\./.test(await page.textContent("#device")), "RIP table panel on a RIP router");
  const nat = await panel("nat-lab", "R"); check(/NAT translations/.test(nat), "NAT translations panel");
  check(/ACL/.test(await panel("acl-lab", "R")), "ACL panel lists the rules");
  await page.evaluate(() => window.studio.goto(window.studio.S.sim.steps.length - 1));
  const aclHits = await page.evaluate(() => Object.values(window.studio.S.sim.steps.at(-1).state.R.aclHits || {}).reduce((a, b) => a + b, 0));
  check(aclHits > 0 && /<td>[1-9]\d*<\/td>/.test(await page.innerHTML("#device")), "ACL hit counts grow as packets are filtered", String(aclHits));
  check(/Port-channels \(LACP\)/.test(await panel("lacp-channel", "SW1")), "LACP bundle panel on a switch with a port-channel");
  await panel("mac-aging", "SW1"); await page.evaluate(() => window.studio.goto(window.studio.S.sim.actions[0].last));
  check(/expires in/.test(await page.textContent("#device")) && /Aging time 5 s/.test(await page.textContent("#device")), "MAC table shows aging time and time left");
  await page.evaluate(() => window.studio.load({version: 1, name: "OSPF+LLDP", nodes: [
    {name: "R1", kind: "router", ifaces: {eth0: "10.0.0.1/24"}, ospf: {networks: ["10.0.0.0/24"]}, lldp: {}},
    {name: "R2", kind: "router", ifaces: {eth0: "10.0.0.2/24"}, ospf: {networks: ["10.0.0.0/24"]}, lldp: {}}], links: [["R1:eth0", "R2:eth0"]]}));
  await page.evaluate(() => window.studio.select("R1"));
  const op = await page.textContent("#device");
  check(/OSPF neighbors/.test(op) && /Full/.test(op) && /LLDP neighbors/.test(op) && /R2/.test(op), "OSPF neighbors (Full) and LLDP neighbors are listed at rest");
  // playback filters and the event list (routing protocol frames included)
  await page.evaluate(() => window.studio.load({version: 1, name: "Proto mix", nodes: [
    {name: "R1", kind: "router", ifaces: {eth0: "10.0.0.1/24"}, ospf: {networks: ["10.0.0.0/24"]}, rip: {networks: ["10.0.0.0/24"]}, lldp: {}},
    {name: "R2", kind: "router", ifaces: {eth0: "10.0.0.2/24"}, ospf: {networks: ["10.0.0.0/24"]}, rip: {networks: ["10.0.0.0/24"]}, lldp: {}}],
    links: [["R1:eth0", "R2:eth0"]]}, [{do: "ping", src: "R1", dst: "10.0.0.2"}]));
  const kinds = await page.$$eval("#filters input", i => i.map(x => x.dataset.kind));
  check(["arp", "icmp", "ospf", "rip", "lldp"].every(k => kinds.includes(k)), "a filter for each protocol that appears (incl. OSPF, RIP, LLDP)", kinds.join(","));
  const total = await page.$$eval("#events .ev", r => r.length);
  check(total === await page.evaluate(() => window.studio.S.sim.steps.length) && /OSPF hello/.test(await page.textContent("#events")), "the event list has one row per frame");
  for (const k of kinds.filter(k => k !== "icmp")) await page.uncheck(`#filters input[data-kind="${k}"]`);
  const only = await page.$$eval("#events .ev", r => r.length);
  check(only > 0 && only < total && /shown/.test(await page.textContent("#counter")), "unchecking protocols shortens the list", `${only} of ${total}`);
  await page.click("#first"); await page.click("#step");
  check(await page.evaluate(() => window.studio.S.sim.steps[window.studio.S.step].kind) === "icmp", "stepping skips frames of hidden protocols");
  await page.click("#events .ev >> nth=1");
  check(await page.evaluate(() => window.studio.S.step) === +(await page.getAttribute("#events .ev >> nth=1", "data-step")) && await page.$$eval("#events .ev.current", r => r.length) === 1, "clicking an event jumps to that frame");
  await page.check('#filters input[data-kind="ospf"]');
  check(/OSPF/.test(await page.textContent("#events")), "checking a protocol brings its frames back");
  // keyboard and accessibility basics
  await page.goto(BASE + "?lab=routed-lan-dns"); await page.waitForFunction(() => document.body.dataset.ready === "1");
  await page.focus('.node[data-node="R1"]');
  check(/router R1/.test(await page.getAttribute('.node[data-node="R1"]', "aria-label")), "devices are focusable with a label");
  await page.keyboard.press("Enter");
  check(await page.evaluate(() => window.studio.S.selected) === "R1" && await page.evaluate(() => document.activeElement.dataset.node) === "R1", "Enter selects the focused device and keeps focus");
  const x0 = await page.evaluate(() => window.studio.S.pos.R1.x);
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("Shift+ArrowRight");
  check(await page.evaluate(() => window.studio.S.pos.R1.x) === x0 + 50 && await page.evaluate(() => document.activeElement.dataset.node) === "R1", "arrow keys move a device (Shift: bigger steps)");
  await page.keyboard.press("c");
  check(await page.isVisible("#console"), "C opens the console on the focused device");
  await page.keyboard.press("Escape");
  await page.focus('#console input'); await page.keyboard.press("Escape");
  check(!(await page.isVisible("#console")), "Escape closes the console");
  await page.focus('.cable-hit >> nth=0'); await page.keyboard.press("Enter");
  check(await page.$$eval("line.cable.cut", l => l.length) === 1, "Enter on a focused cable unplugs it");
  await page.focus('.cable-hit >> nth=0'); await page.keyboard.press("Enter");
  check(await page.$$eval("line.cable.cut", l => l.length) === 0, "… and plugs it back in");
  check(await page.getAttribute("#play", "aria-label") === "Play or pause" && await page.$("a.skip") !== null, "player buttons are labelled; skip link present");
  // a phone-width screen
  await page.setViewportSize({width: 390, height: 800});
  await page.goto(BASE + "?lab=vlans"); await page.waitForFunction(() => document.body.dataset.ready === "1");
  const m = await page.evaluate(() => ({sw: document.documentElement.scrollWidth, w: innerWidth, map: document.querySelector("#map").getBoundingClientRect().width, cols: getComputedStyle(document.querySelector("main")).gridTemplateColumns.split(" ").length}));
  check(m.sw <= m.w && m.map > 300 && m.cols === 1, "phone width: one column, no sideways scrolling, map fills the screen", JSON.stringify(m));
  await page.evaluate(() => window.studio.openConsole("SW1"));
  const c = await page.evaluate(() => { const r = document.querySelector("#console").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
  check(c, "the console fits a phone screen");
  await page.setViewportSize({width: 1440, height: 950});

  // features merged later: IPv6, DHCP snooping, lossy cables, HTTP, OSPF areas (the engine's own validation specs and examples)
  const vfile = f => JSON.parse(fs.readFileSync(path.join(root, "validate", f)));
  const vload = async (specFile, actionsFile) => page.evaluate(([sp, ac]) => { const ok = window.studio.load(sp, ac, "t"); return {ok, errors: document.querySelector("#errors").hidden ? "" : document.querySelector("#errors").textContent}; },
    [vfile(specFile), actionsFile ? vfile(actionsFile) : []]);
  let r6 = await vload("ipv6/ipv6-lab.json", "ipv6/ipv6-lab.actions.json");
  check(r6.ok && !/spec /.test(r6.errors), "IPv6 lab loads and runs", r6.errors.slice(0, 120));
  const kinds6 = await page.$$eval("#filters input[data-kind]", i => i.map(x => x.dataset.kind));
  check(kinds6.includes("icmp6") && kinds6.includes("ndp"), "IPv6 frames get their own filters (ICMPv6, IPv6 ND)", kinds6.join(","));
  check((await page.$$eval("#events li", l => l.map(x => x.textContent)).catch(() => [])).some(t => /neighbor solicitation/.test(t)) ||
        (await page.evaluate(() => window.studio.S.sim.steps.some(st => /neighbor solicitation/.test(st.desc)))), "IPv6 neighbor solicitation shows in playback");
  await page.evaluate(() => window.studio.select("A"));
  const dev6 = await page.textContent("#device");
  check(/IPv6 addresses/.test(dev6) && /2001:db8:1::a/.test(dev6) && /IPv6 neighbors/.test(dev6), "device panel lists IPv6 addresses and neighbors");

  await page.goto(BASE + "?lab=dhcp-snooping"); await page.waitForFunction(() => document.body.dataset.ready === "1");
  const swName = await page.evaluate(() => window.studio.S.spec.nodes.find(n => n.dhcpSnooping).name);
  await page.evaluate(n => window.studio.select(n), swName);
  const snoop = await page.textContent("#device");
  check(/DHCP snooping/.test(snoop) && /trusted/.test(snoop) && /server messages dropped/.test(snoop), "switch panel shows DHCP snooping trusted ports and drop counts");

  const rl = await vload("netem/loss.json", "netem/loss.actions.json");
  check(rl.ok && !/spec /.test(rl.errors), "lossy-cable spec loads", rl.errors.slice(0, 120));
  check(await page.$$eval("#map line.cable.lossy", l => l.length) >= 1, "a lossy cable is drawn dotted");
  check((await page.$$eval("#actions li small", l => l.map(x => x.textContent))).some(t => /lost on a lossy cable/.test(t)), "the action list counts frames a lossy cable dropped");

  const rh = await vload("tcp/tcp-http.json", "tcp/tcp-http.actions.json");
  check(rh.ok && !/spec /.test(rh.errors), "HTTP spec loads", rh.errors.slice(0, 120));
  check(await page.evaluate(() => window.studio.S.sim.steps.some(st => /\(GET \//.test(st.desc))), "an HTTP GET request is named in the frame description");

  const rs = await vload("services/syslog-lan.json", "services/syslog-lan.actions.json");
  check(rs.ok && !/spec /.test(rs.errors), "syslog lab loads", rs.errors.slice(0, 120));
  await page.evaluate(() => { window.studio.select("LOG"); });
  const svcPanel = await page.textContent("#device");
  check(/Services/.test(svcPanel) && /Syslog receiver/.test(svcPanel), "a server's panel lists its syslog receiver", svcPanel.slice(0, 80));

  const rn = await vload("services/ntp-lan.json", "services/ntp-lan.actions.json");
  check(rn.ok && !/spec /.test(rn.errors), "NTP lab loads", rn.errors.slice(0, 120));
  await page.evaluate(() => { window.studio.select("LOG"); window.studio.goto && window.studio.goto(window.studio.S.sim.steps.length); });
  const ntpPanel = await page.textContent("#device");
  const nm = /NTP server \(UDP 123\) at stratum (\d+): (\d+) client quer/.exec(ntpPanel);
  check(nm && +nm[2] > 0, "the NTP server's panel shows its stratum and a query count above 0", ntpPanel.slice(0, 120));

  const rw = await vload("tcp/tcp-window.json", "tcp/tcp-window.actions.json");
  check(rw.ok && !/spec /.test(rw.errors), "TCP window spec loads", rw.errors.slice(0, 120));
  check(await page.evaluate(() => window.studio.S.sim.steps.some(st => /window \d+ B/.test(st.desc))), "TCP segments name the receiver's advertised window");
  check(await page.evaluate(() => window.studio.S.sim.steps.some(st => /window 0 B \(full/.test(st.desc))), "a zero window is called out in the frame description");
  const tcpDev = await page.evaluate(() => { const st = window.studio.S.sim.steps.find(x => Object.values(x.state).some(d => d.tcp && d.tcp.length)); return st ? Object.keys(st.state).find(n => st.state[n].tcp) : null; });
  check(!!tcpDev, "a host with a TCP connection has it in its snapshot", String(tcpDev));
  if (tcpDev) {
    await page.evaluate(n => { const S = window.studio.S; S.step = S.sim.steps.findIndex(x => x.state[n] && x.state[n].tcp); window.studio.select(n); }, tcpDev);
    const tp = await page.textContent("#device");
    check(/TCP connections/.test(tp) && /ESTABLISHED|SYN|FIN/.test(tp), "the device panel shows a TCP connections table", tp.slice(0, 120));
  }

  const rv = await page.evaluate(([sp, ac]) => { const ok = window.studio.load(sp, ac, "t"); return {ok, errors: document.querySelector("#errors").hidden ? "" : document.querySelector("#errors").textContent}; },
    [vfile("vrrp/vrrp-preempt.net"), [{do: "wait", seconds: 8}, {do: "ping", src: "H1", dst: "10.0.0.254"}, {do: "link", end: "R1:eth0", up: false}, {do: "wait", seconds: 8}, {do: "ping", src: "H1", dst: "10.0.0.254"}]]);
  check(rv.ok && !/spec /.test(rv.errors), "VRRP spec loads", rv.errors.slice(0, 120));
  await page.evaluate(() => { window.studio.select("R1"); window.studio.goto(window.studio.S.sim.steps.length - 1); });
  check(await page.evaluate(() => window.studio.S.sim.steps.some(st => /VRRP advert vrid/.test(st.desc))), "VRRP adverts are named in playback");
  check(await page.$$eval("#filters input[data-kind]", i => i.some(x => x.dataset.kind === "vrrp")), "VRRP frames get a filter checkbox");
  check(await page.$eval("#legend", l => /VRRP/.test(l.textContent)), "the legend lists VRRP");
  const badWait = await page.$$eval("#actions li", l => l.filter(x => /wait|cable|link/i.test(x.textContent) && x.querySelector(".bad")).length);
  check(badWait === 0, "wait and cable actions are not marked as failures", String(badWait));
  await page.evaluate(() => { window.studio.select("R2"); });
  const vp = await page.textContent("#device");
  check(/VRRP/.test(vp) && /MASTER/.test(vp), "after the master is cut, the backup router shows MASTER; a VRRP router's panel shows its group state", vp.slice(0, 100));
  const rng = await page.evaluate(sp => { const ok = window.studio.load(sp, [{do: "wait", seconds: 45}], "t"); return {ok, errors: document.querySelector("#errors").hidden ? "" : document.querySelector("#errors").textContent}; }, vfile("ripng/ripng-chain.json"));
  check(rng.ok && !/spec /.test(rng.errors), "RIPng spec loads", rng.errors.slice(0, 120));
  await page.evaluate(() => { window.studio.select("R2"); window.studio.goto(window.studio.S.sim.steps.length - 1); });
  check(await page.evaluate(() => window.studio.S.sim.steps.some(st => /RIPng response, \d+ route/.test(st.desc))), "RIPng messages are named in playback");
  check(await page.$$eval("#filters input[data-kind]", i => i.some(x => x.dataset.kind === "ripng")), "RIPng frames get a filter checkbox");
  check(/RIPng routes/.test(await page.textContent("#device")), "RIPng routes panel on a RIPng router");

  const ro = await vload("ospf/ospf-areas.net");
  check(ro.ok && !/spec /.test(ro.errors), "OSPF areas spec loads", ro.errors.slice(0, 120));
  await page.evaluate(() => window.studio.select("R2"));
  const osp = await page.textContent("#device");
  check(/Area border router/.test(osp) && /inter-area/.test(osp) && /0\.0\.0\.1/.test(osp), "OSPF panel marks the ABR, shows areas and inter-area routes");

  // a spec with an error is reported, not thrown
  const bad = await page.evaluate(() => { const ok = window.studio.load({nodes: [{name: "X", kind: "toaster"}], links: []});
    return {ok, text: document.querySelector("#errors").textContent}; });
  check(!bad.ok && /kind must be one of/.test(bad.text), "an invalid spec shows its errors");

  check(!errors.length, "no page errors", errors.join(" | "));
} finally {
  await browser.close(); server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall studio checks passed");
process.exit(failures ? 1 : 0);
