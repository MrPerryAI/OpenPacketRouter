// Turns command definition files (cli/commands/*.json) into a matcher with help and completion.
//
// A definition: {"modes": [...], "kinds": [...]?, "syntax": "ip route PREFIX NEXTHOP", "args": {"PREFIX": "ipv4-prefix"},
//                "help": {"ip": "...", "PREFIX": "..."}, "handler": "static.add", "enter": "config-if"?}
// Lower-case words are keywords (any unique prefix is accepted); UPPER-CASE words are typed arguments.

import {typeOf} from "./types.js";

/** Compile one or more definition files ({feature, commands: [...]}) into a command table. Throws on a bad definition. */
export function compile(files) {
  const commands = [], problems = [];
  for (const file of files) {
    for (const [i, d] of (file.commands || []).entries()) {
      const where = `${file.feature || "?"}: command ${i} ("${d.syntax}")`;
      if (typeof d.syntax !== "string" || !d.syntax.trim()) { problems.push(`${where}: no syntax`); continue; }
      if (!Array.isArray(d.modes) || !d.modes.length) problems.push(`${where}: no modes`);
      if (typeof d.handler !== "string") problems.push(`${where}: no handler`);
      const tokens = d.syntax.trim().split(/\s+/).map(w => {
        if (/^[A-Z][A-Z0-9_-]*$/.test(w)) {
          const tname = (d.args || {})[w], type = typeOf(tname);
          if (!type) problems.push(`${where}: argument ${w} has unknown type "${tname}"`);
          return {arg: w, type: type || {test: () => false, hint: w, help: ""}};
        }
        if (!/^[a-z0-9][a-z0-9.-]*$/.test(w)) problems.push(`${where}: "${w}" is neither a keyword nor an ARGUMENT`);
        return {lit: w};
      });
      commands.push({feature: file.feature, syntax: d.syntax.trim(), modes: d.modes || [], kinds: d.kinds || null,
        tokens, help: d.help || {}, handler: d.handler, enter: d.enter || null});
    }
  }
  if (problems.length) throw new Error("bad command definitions:\n  " + problems.join("\n  "));
  // One help line per keyword and mode: the first definition that explains it.
  const helpIndex = new Map();
  for (const c of commands) c.tokens.forEach(t => {
    if (!t.lit || !c.help[t.lit]) return;
    for (const m of c.modes) { const k = `${m}|${t.lit}`; if (!helpIndex.has(k)) helpIndex.set(k, c.help[t.lit]); }
    if (!helpIndex.has(`*|${t.lit}`)) helpIndex.set(`*|${t.lit}`, c.help[t.lit]);
  });
  return {
    commands,
    helpFor: (mode, word) => helpIndex.get(`${mode}|${word}`) || helpIndex.get(`*|${word}`) || "",
  };
}

/** The commands available in a mode for a device kind. */
export const available = (table, mode, kind) => table.commands.filter(c => c.modes.includes(mode) && (!c.kinds || c.kinds.includes(kind)));

/**
 * Match whole words against commands. Returns {live: [{c, values}]} with the commands still possible after the
 * words, or {error: "unknown" | "ambiguous", at: index, options?}.
 * A keyword typed in full beats one it is a prefix of; a keyword beats an argument.
 */
export function walk(cmds, words, ctx) {
  let live = cmds.map(c => ({c, values: []}));
  for (let i = 0; i < words.length; i++) {
    const w = words[i], lw = w.toLowerCase();
    const here = live.filter(x => x.c.tokens.length > i);
    const lits = here.filter(x => x.c.tokens[i].lit);
    let next = lits.filter(x => x.c.tokens[i].lit === lw);
    if (!next.length) {
      const pre = lits.filter(x => x.c.tokens[i].lit.startsWith(lw));
      const distinct = [...new Set(pre.map(x => x.c.tokens[i].lit))];
      if (distinct.length > 1) return {error: "ambiguous", at: i, options: distinct.sort()};
      next = pre;
    }
    if (!next.length) next = here.filter(x => x.c.tokens[i].arg && x.c.tokens[i].type.test(w, ctx))
      .map(x => { const t = x.c.tokens[i].type; return {c: x.c, values: [...x.values, t.normalize ? t.normalize(w, ctx) : w]}; });
    if (!next.length) return {error: "unknown", at: i};
    live = next;
  }
  return {live};
}

/** Choices for the word after `words` (help after a space): [{word, help, arg?}] plus {word: "<cr>"} when complete. */
export function nextChoices(table, mode, cmds, words, ctx) {
  const r = walk(cmds, words, ctx);
  if (r.error) return r;
  const rows = new Map();
  for (const {c} of r.live) {
    if (c.tokens.length === words.length) { rows.set("<cr>", {word: "<cr>", help: ""}); continue; }
    const t = c.tokens[words.length];
    if (t.lit) { if (!rows.has(t.lit)) rows.set(t.lit, {word: t.lit, help: words.length === 0 ? table.helpFor(mode, t.lit) : c.help[t.lit] || table.helpFor(mode, t.lit)}); }
    else if (t.type.complete) for (const p of t.type.complete(ctx)) rows.set(p, rows.get(p) || {word: p, help: c.help[t.arg] || t.type.help, arg: true});
    else { const k = `${t.type.hint}|${c.help[t.arg] || t.type.help}`; if (!rows.has(k)) rows.set(k, {word: t.type.hint, help: c.help[t.arg] || t.type.help, arg: true}); }
  }
  const list = [...rows.values()];
  list.sort((a, b) => a.word === "<cr>" ? 1 : b.word === "<cr>" ? -1 : a.word.localeCompare(b.word));
  return {choices: list};
}

/** Words that complete a partial last word (help right after letters, and Tab). Keywords and known interface names only. */
export function completions(cmds, words, partial, ctx) {
  const r = walk(cmds, words, ctx);
  if (r.error) return [];
  const out = new Set(), lp = partial.toLowerCase();
  for (const {c} of r.live) {
    const t = c.tokens[words.length]; if (!t) continue;
    if (t.lit) { if (t.lit.startsWith(lp)) out.add(t.lit); }
    else if (t.type.complete) for (const p of t.type.complete(ctx)) if (p.toLowerCase().startsWith(lp)) out.add(p);
  }
  return [...out].sort();
}
