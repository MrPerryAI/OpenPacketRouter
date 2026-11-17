// El Dorado Storm Lab class server: serves the lab and a shared scoreboard.
// No dependencies. Run with Docker (see README) or `node server/server.js`.
//   PORT          port to listen on (default 8080)
//   DATA_DIR      where scores.json is kept (default ./data)
//   TEACHER_KEY   if set, DELETE /api/scores?key=<TEACHER_KEY> clears the board
"use strict";
const http = require("http"), fs = require("fs"), path = require("path");
const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const KEY = process.env.TEACHER_KEY || "";
const PAGE_FILE = path.join(__dirname, "..", "web", "index.html");
const SCORES_FILE = path.join(DATA_DIR, "scores.json");
const MAX_ROWS = 400;

fs.mkdirSync(DATA_DIR, {recursive: true});
let scores = {};
try { scores = JSON.parse(fs.readFileSync(SCORES_FILE, "utf8")); } catch { scores = {}; }
let saveTimer = null;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFile(SCORES_FILE, JSON.stringify(scores), () => {}), 500); };

// The lab file is written as page content (the Claude artifact host adds the
// document shell). Wrap it the same way so browsers render it in standards mode.
const SHELL_HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style></head><body>';
const page = () => SHELL_HEAD + fs.readFileSync(PAGE_FILE, "utf8") + "</body></html>";

const clean = r => ({id: r.id, name: r.name, total: r.total, done: r.done, contain: r.contain});
const list = () => Object.values(scores).sort((a, b) => b.total - a.total).map(clean);
function valid(b) {
  if (!b || typeof b !== "object") return null;
  const id = String(b.id || ""); if (!/^[a-z0-9]{4,32}$/i.test(id)) return null;
  const name = String(b.name || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 24); if (!name) return null;
  const int = (v, max) => Number.isFinite(+v) ? Math.max(0, Math.min(max, Math.round(+v))) : 0;
  return {id, name, total: int(b.total, 100000), done: int(b.done, 50), contain: b.contain == null ? null : int(b.contain, 36000), updated: Date.now()};
}
function send(res, code, body, type = "application/json") {
  res.writeHead(code, {"content-type": type + "; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff"});
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/" || url.pathname === "/index.html") return send(res, 200, page(), "text/html");
  if (url.pathname === "/api/scores") {
    if (req.method === "GET") return send(res, 200, list());
    if (req.method === "DELETE") {
      if (!KEY || url.searchParams.get("key") !== KEY) return send(res, 403, {error: "teacher key required"});
      scores = {}; save(); return send(res, 200, {cleared: true});
    }
    if (req.method === "POST") {
      let raw = "";
      req.on("data", c => { raw += c; if (raw.length > 4096) req.destroy(); });
      req.on("end", () => {
        let row; try { row = valid(JSON.parse(raw)); } catch { row = null; }
        if (!row) return send(res, 400, {error: "invalid score"});
        if (!scores[row.id] && Object.keys(scores).length >= MAX_ROWS) return send(res, 429, {error: "scoreboard full"});
        scores[row.id] = row; save(); send(res, 200, clean(row));
      });
      return;
    }
    return send(res, 405, {error: "method not allowed"});
  }
  send(res, 404, {error: "not found"});
}).listen(PORT, () => console.log(`El Dorado Storm Lab on http://0.0.0.0:${PORT}`));
