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
