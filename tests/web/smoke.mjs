// Browser smoke test for the El Dorado Storm Lab, served by server/server.js.
//   node tests/web/smoke.mjs
// Runs twice: with HTML-in-Canvas enabled (Chromium flag) and without it.
// Needs the `playwright` package and a Chromium it can launch.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}/`;
let failures = 0;
const check = (ok, what, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? "  (" + detail + ")" : ""}`); if (!ok) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const data = fs.mkdtempSync(path.join(os.tmpdir(), "stormlab-"));
const server = spawn(process.execPath, [path.join(root, "server", "server.js")], {env: {...process.env, PORT, DATA_DIR: data, TEACHER_KEY: "smoke"}, stdio: "ignore"});
for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "api/scores")).ok) break; } catch {} await sleep(100); }

async function page(browser, errors, label) {
  const p = await (await browser.newContext({viewport: {width: 1440, height: 1000}})).newPage();
  p.on("pageerror", e => errors.push(`${label}: ${e}`));
  p.on("console", m => { if (m.type() === "error" && !/favicon/.test(m.text()) && !/404/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
  await p.goto(BASE); await p.waitForTimeout(800);
  return p;
}

try {
  for (const hic of [true, false]) {
    console.log(`\n--- HTML-in-Canvas ${hic ? "on" : "off"}`);
    const browser = await chromium.launch({args: hic ? ["--enable-blink-features=CanvasDrawElement"] : []});
    const errors = [];
    const p = await page(browser, errors, "student");
    check(await p.evaluate(() => HIC) === hic, "HTML-in-Canvas detected correctly");
    check(await p.isVisible("#intro"), "intro shows on first visit");
    await p.click('.intro .who button[data-mode="student"]');
    const n = await p.evaluate(() => { preset("cutover"); const a = [M.regime, +M.rho.toFixed(4)]; S.bpduPass = false; recompute();
      a.push(+M.rho.toFixed(4), +(Math.log(2) / M.r * 1e3).toFixed(3)); S.bpduPass = true; recompute(); return a; });
    check(n[0] === "CIRCULATING" && n[1] === 1 && n[2] === 1.5437 && n[3] === 1.842, "storm math numbers", n.join(" "));

    await p.evaluate(() => openMission(2));
    for (const id of ["L14", "L15", "L16"]) { await p.evaluate(id => select({link: id}), id); await p.click('#inspector button[data-act="install"]'); }
    check(await p.evaluate(() => S.link.L16) === "absent", "prediction gate blocks cross-connect B");
    await p.click('.predict .opts button[data-o="1"]'); await p.click('#inspector button[data-act="install"]'); await p.waitForTimeout(300);
    check(await p.evaluate(() => S.link.L16 === "up" && M.regime === "CIRCULATING"), "cable installs after the prediction; loop forms");
    check((await p.textContent("#reveal")).startsWith("You called it"), "prediction reveal");

    const xy = await p.evaluate(() => { fx.scrollIntoView({block: "center"}); const d = DEV["ZME-SW"], r = fx.getBoundingClientRect(); return {x: r.left + d.x * K, y: r.top + d.y * K}; });
    await p.mouse.click(xy.x, xy.y); await p.waitForTimeout(200);
    check(await p.evaluate(() => S.sel && S.sel.dev) === "ZME-SW", "clicking a device card on the map selects it");

    await p.evaluate(() => openMission(4)); await p.waitForTimeout(3500);
    check((await p.textContent("#gs")).startsWith("GROUND STOP"), "ground stop triggers in the drill");
    await p.evaluate(() => { S.link.L14 = "shut"; S.link.L6 = "shut"; recompute(); }); await p.waitForTimeout(1500);
    check((await p.textContent("#gs")).startsWith("Ground stop lifted") && await p.isVisible("#complete"), "containment lifts the ground stop and completes the mission");
    check(await p.evaluate(() => best.full[4] && best.full[4].contain != null), "containment time is scored");

    await p.click('.modes button[data-mode="plain"]'); await p.evaluate(() => openMission(2)); await p.click("#chatter"); await p.waitForTimeout(3500);
    check((await p.textContent("#rhoK")) === "Echo score" && (await p.textContent("#gs")).startsWith("GROUND STOP"), "plain-English mode and story chapter 3");
    await p.click(".term >> nth=0"); check(await p.isVisible("#gloss"), "glossary popover opens");
    await p.click('.modes button[data-mode="student"]'); await p.click("#reportBtn");
    check(await p.isVisible("#report") && /points/.test(await p.innerText("#reportSheet")), "score report opens");
    await p.click("#closeReport");

    if (hic) {
      await fetch(BASE + "api/scores?key=smoke", {method: "DELETE"});
      for (const name of ["Ana R.", "Ben T."]) {
        const s = await page(browser, errors, name);
        await s.click('.intro .who button[data-mode="student"]'); await s.waitForTimeout(600);
        await s.fill("#bname", name); await s.locator("#bname").blur();
        await s.evaluate(() => openMission(0)); await s.click("#send"); await s.waitForTimeout(5200);
      }
      await sleep(4000);
      const rows = await (await fetch(BASE + "api/scores")).json();
      check(rows.length === 2 && rows.every(r => r.total > 0), "two students post to the class scoreboard", rows.map(r => `${r.name}:${r.total}`).join(", "));
      await p.reload(); await p.waitForTimeout(1500);
      const board = await p.innerText("#boardBody");
      check(board.includes("Ana R.") && board.includes("Ben T."), "scoreboard shows other students live");
    }
    check(errors.length === 0, "no page errors", errors.slice(0, 3).join(" | "));
    await browser.close();
  }
} finally {
  server.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
