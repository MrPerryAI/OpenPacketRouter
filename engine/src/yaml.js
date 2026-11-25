// Minimal YAML reader for spec/actions files (no dependencies). Supports the subset a spec needs:
// block mappings and sequences (indentation), flow [..] and {..} collections, plain/'single'/"double"
// quoted scalars, numbers, true/false/null, # comments, and "---" document start. Not supported (error):
// anchors, tags, multi-document, block scalars (| and >), multi-line flow collections, tab indentation.
export class YamlError extends Error {}

const fail = (n, msg) => { throw new YamlError(`line ${n}: ${msg}`); };

function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = null; }
    else if (c === '"' || c === "'") { if (i === 0 || /[\s:\[{,-]/.test(s[i - 1])) q = c; }
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function scalar(t, n) {
  t = t.trim();
  if (t === "" || t === "~" || t === "null") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t) && !/^[-+]?0\d/.test(t)) return Number(t);
  if (t[0] === '"') {
    if (t.length < 2 || t.at(-1) !== '"') fail(n, `unterminated string ${t}`);
    try { return JSON.parse(t); } catch { fail(n, `bad double-quoted string ${t}`); }
  }
  if (t[0] === "'") {
    if (t.length < 2 || t.at(-1) !== "'") fail(n, `unterminated string ${t}`);
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[&*!|>]/.test(t)) fail(n, `unsupported YAML feature near "${t.slice(0, 12)}"`);
  return t;
}

// split on top-level commas inside a flow collection body
function splitFlow(body, n) {
  const out = []; let depth = 0, q = null, cur = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (q) { cur += c; if (c === "\\" && q === '"') cur += body[++i] ?? ""; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  if (q || depth !== 0) fail(n, "unbalanced flow collection");
  if (cur.trim() !== "" || out.length) out.push(cur);
  return out;
}

function findKeyColon(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === "\\" && q === '"') i++; else if (c === q) q = null; continue; }
    if (i === 0 && (c === '"' || c === "'")) { q = c; continue; }
    if (c === ":" && (i === s.length - 1 || s[i + 1] === " ")) return i;
    if (c === "[" || c === "{") return -1;
  }
  return -1;
}

function flow(t, n) {
  t = t.trim();
  if (t[0] === "[") {
    if (t.at(-1) !== "]") fail(n, "unterminated [");
    return splitFlow(t.slice(1, -1), n).map(x => flow(x, n));
  }
  if (t[0] === "{") {
    if (t.at(-1) !== "}") fail(n, "unterminated {");
    const o = {};
    for (const part of splitFlow(t.slice(1, -1), n)) {
      const k = findKeyColon(part.trim() + " ");
      if (k < 0) fail(n, `expected "key: value" in {…}, got "${part.trim()}"`);
      const p = part.trim() + " ";
      o[key(p.slice(0, k), n)] = flow(p.slice(k + 1), n);
    }
    return o;
  }
  return scalar(t, n);
}

const key = (k, n) => { const v = scalar(k, n); return typeof v === "string" ? v : String(v); };

export function parseYaml(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\t/.test(raw)) { if (raw.trim() !== "" && !raw.trim().startsWith("#")) fail(i + 1, "tab indentation is not allowed"); return; }
    const s = stripComment(raw).replace(/\s+$/, "");
    if (s.trim() === "") return;
    if (/^(---|\.\.\.)\s*$/.test(s)) { if (lines.length && s.startsWith("---")) fail(i + 1, "multiple documents are not supported"); return; }
    lines.push({n: i + 1, indent: s.length - s.trimStart().length, text: s.trim()});
  });
  if (!lines.length) return null;
  let pos = 0;

  const value = (rest, parentIndent, n) => {
    // rest: text after "key:" or "- " ; may be empty -> nested block
    if (rest === "") {
      const nx = lines[pos];
      if (nx && (nx.indent > parentIndent || (nx.indent === parentIndent && nx.text.startsWith("- ") && false))) return block(nx.indent);
      return null;
    }
    return flow(rest, n);
  };

  function block(indent) {
    const first = lines[pos];
    if (first.text === "-" || first.text.startsWith("- ")) return seq(indent);
    return map(indent);
  }

  function seq(indent) {
    const arr = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].text === "-" || lines[pos].text.startsWith("- "))) {
      const l = lines[pos++];
      const rest = l.text.slice(1).trim();
      if (rest === "") { const nx = lines[pos]; arr.push(nx && nx.indent > indent ? block(nx.indent) : null); continue; }
      const k = findKeyColon(rest);
      if (k >= 0 && rest[0] !== "[" && rest[0] !== "{") {
        // "- key: value" starts an inline mapping whose further keys are indented to the key column
        const col = indent + (l.text.length - rest.length);
        lines.splice(pos, 0, {n: l.n, indent: col, text: rest});
        arr.push(map(col));
      } else arr.push(flow(rest, l.n));
    }
    return arr;
  }

  function map(indent) {
    const o = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const l = lines[pos];
      if (l.text === "-" || l.text.startsWith("- ")) fail(l.n, "unexpected list item inside a mapping");
      const k = findKeyColon(l.text + " ");
      if (k < 0) fail(l.n, `expected "key: value", got "${l.text}"`);
      const t = l.text + " ";
      const kk = key(t.slice(0, k), l.n);
      if (Object.hasOwn(o, kk)) fail(l.n, `duplicate key "${kk}"`);
      pos++;
      const rest = t.slice(k + 1).trim();
      if (rest === "") {
        const nx = lines[pos];
        if (nx && nx.indent > indent) o[kk] = block(nx.indent);
        else if (nx && nx.indent === indent && (nx.text === "-" || nx.text.startsWith("- "))) o[kk] = seq(indent);  // list at same indent as key
        else o[kk] = null;
      } else o[kk] = flow(rest, l.n);
    }
    if (pos < lines.length && lines[pos].indent > indent) fail(lines[pos].n, "unexpected indentation");
    return o;
  }

  const out = block(lines[0].indent);
  if (pos < lines.length) fail(lines[pos].n, "unexpected indentation");
  return out;
}

// Parse a spec/actions file by extension: .yaml/.yml -> YAML, anything else -> JSON.
export function parseData(text, file = "") {
  return /\.ya?ml$/i.test(file) ? parseYaml(text) : JSON.parse(text);
}

// Write a value as block-style YAML that parseYaml reads back unchanged (scalars use JSON quoting).
export function dumpYaml(v) {
  const filled = x => x && typeof x === "object" && (Array.isArray(x) ? x.length : Object.keys(x).length);
  const emit = (x, ind) => {
    const pad = " ".repeat(ind);
    if (Array.isArray(x)) return x.length ? x.map(e => filled(e) ? `${pad}-\n${emit(e, ind + 2)}` : `${pad}- ${JSON.stringify(e)}`).join("\n") : `${pad}[]`;
    if (x && typeof x === "object") return Object.keys(x).length ? Object.entries(x).map(([k, e]) => filled(e) ? `${pad}${JSON.stringify(k)}:\n${emit(e, ind + 2)}` : `${pad}${JSON.stringify(k)}: ${JSON.stringify(e)}`).join("\n") : `${pad}{}`;
    return `${pad}${JSON.stringify(x)}`;
  };
  return emit(v, 0) + "\n";
}
