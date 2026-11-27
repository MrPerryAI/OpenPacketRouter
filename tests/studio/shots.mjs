// Captures the screenshots used by docs/studio-guide.md into docs/img/studio/.
//   node tests/studio/shots.mjs        (needs the `playwright` package and a Chromium it can launch)
import {createRequire} from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const {chromium} = createRequire(import.meta.url)("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.join(root, "docs", "img", "studio"); fs.mkdirSync(out, {recursive: true});
const TYPES = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".md": "text/markdown"};
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  const f = p.endsWith("/") ? path.join(p, "index.html") : p;
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, {"content-type": TYPES[path.extname(f)] || "application/octet-stream"}); fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/studio/`;
const browser = await chromium.launch({args: process.platform === "darwin" ? ["--single-process"] : []});
try {
  const page = await (await browser.newContext({viewport: {width: 1200, height: 800}})).newPage();
  const ready = async lab => { await page.goto(BASE + "?lab=" + lab); await page.waitForFunction(() => document.body.dataset.ready === "1"); await page.waitForTimeout(400); };
  const shot = async (name, clip) => { await page.screenshot({path: path.join(out, name + ".png"), ...(clip ? {clip} : {})}); console.log("saved", name); };

  await ready("nat-lab");                                              // 1: a lab, as it opens (map, actions, guide)
  await shot("1-open-lab");
  await page.evaluate(() => window.studio.goto(40));                   // 2: playback paused on a frame
  await page.waitForTimeout(300);
  await shot("2-playback");
  await page.evaluate(() => { window.studio.select("R"); window.studio.goto(window.studio.S.sim.steps.length - 1); });   // 3: a device panel
  await page.waitForTimeout(300);
  await page.locator("#device").scrollIntoViewIfNeeded();   // below the fold at 1200x800
  await page.locator("#device").screenshot({path: path.join(out, "3-device-panel.png")}); console.log("saved 3-device-panel");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => window.studio.runInConsole("R", "show ip route"));   // 4: the console
  await page.waitForTimeout(300);
  await shot("4-console");
  await ready("nat-lab");                                              // 6: the student guide with its run buttons
  await page.evaluate(() => window.studio.select("R"));
  await page.evaluate(() => document.querySelector("#guideBody").scrollTo(0, 99999));
  await shot("6-student-guide", {x: 820, y: 100, width: 370, height: 420});
  await ready("routed-lan-dns");                                       // 5: the editor
  await page.evaluate(() => window.studio.load({version: 1, name: "My network", nodes: [], links: []}, [], "mine"));
  await page.click('[data-add="switch"]'); await page.click('[data-add="host"]'); await page.click('[data-add="host"]');
  await page.click('[data-tool="cable"]');
  for (const [a, b] of [["SW1", "PC1"], ["SW1", "PC2"]]) { await page.click(`[data-node="${a}"]`); await page.click(`[data-node="${b}"]`); }
  await page.click('[data-tool="select"]'); await page.click('[data-node="PC1"]');
  await page.waitForTimeout(300);
  await shot("5-editor");
} finally { await browser.close(); server.close(); }
