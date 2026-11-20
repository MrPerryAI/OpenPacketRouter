// Shared test helpers: every spec in the repository, and a blank copy of one device.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** [{file, spec}] for every network spec under examples/ and validate/. */
export function allSpecs() {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".json")) {
        let s; try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
        if (s && Array.isArray(s.nodes) && Array.isArray(s.links)) out.push({file: path.relative(ROOT, p), spec: s});
      }
    }
  };
  walk(path.join(ROOT, "examples")); walk(path.join(ROOT, "validate"));
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** The spec with `device` replaced by an unconfigured device of the same kind called NEW, on the same cables. */
export function blankDevice(spec, device) {
  const s = JSON.parse(JSON.stringify(spec));
  const i = s.nodes.findIndex(n => n.name === device);
  const {kind, about} = s.nodes[i];
  s.nodes[i] = {name: "NEW", kind, ...(about !== undefined ? {about} : {})};
  s.links = s.links.map(l => {
    const out = l.map(x => typeof x === "string" && x.startsWith(device + ":") ? "NEW" + x.slice(device.length) : x);
    if (out[3]) {
      const o = {...out[3]};
      if (out[0].startsWith("NEW:")) delete o.shape;
      if (out[1].startsWith("NEW:")) delete o.shapeBack;
      if (Object.keys(o).length) out[3] = o; else out.length = 3;
    }
    return out;
  });
  return s;
}
