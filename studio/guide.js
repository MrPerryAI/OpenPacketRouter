// Student guides in Studio: a small, safe Markdown renderer (no raw HTML ever reaches the page; links only to relative
// files) that puts a "run in console" button on CLI commands (show / ping / traceroute) and picks the device from the text.
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"})[c]);
const VERBS = /^(show|ping|traceroute)\s/;
const SAFE_HREF = /^(?![a-z][a-z0-9+.-]*:|\/\/|#)[^\s"'<>]+$/i;     // relative files only: no scheme, no protocol-relative, no bare anchors

/** Render guide Markdown. `devices`: node names; `fallback`: device used for commands before any device is named. */
export function renderGuide(md, devices = [], fallback = null) {
  let dev = fallback;
  const nameIn = text => { const m = [...text.matchAll(/\b[Oo]n (?:`)?([\w-]+)/g)].map(x => x[1]).filter(n => devices.includes(n)).pop()
    || [...text.matchAll(/(?:`|\*\*)([\w-]+)(?:`|\*\*)/g)].map(x => x[1]).filter(n => devices.includes(n)).pop(); if (m) dev = m; };
  const button = cmd => dev ? ` <button type="button" class="run-cmd" data-device="${esc(dev)}" data-cmd="${esc(cmd)}" title="Run on ${esc(dev)}">▶ run on ${esc(dev)}</button>` : "";
  const inline = text => {
    let out = "", rest = text;
    const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/;
    for (let m; (m = re.exec(rest));) {
      out += esc(rest.slice(0, m.index)); rest = rest.slice(m.index + m[0].length);
      if (m[1] !== undefined) out += `<code>${esc(m[1])}</code>${VERBS.test(m[1]) ? button(m[1]) : ""}`;
      else if (m[2] !== undefined) out += `<strong>${esc(m[2])}</strong>`;
      else out += SAFE_HREF.test(m[4]) ? `<a href="${esc(m[4])}" target="_blank" rel="noopener">${esc(m[3])}</a>` : esc(m[3]);
    }
    return out + esc(rest);
  };
  const lines = String(md).replace(/\r/g, "").split("\n"), out = [];
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const body = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]); i++;
      out.push(`<pre>${body.map(b => `${esc(b)}${VERBS.test(b.trim()) ? button(b.trim()) : ""}`).join("\n")}</pre>`);
    } else if (/^#{1,6}\s/.test(l)) { const n = Math.min(6, l.match(/^#+/)[0].length + 1); nameIn(l); out.push(`<h${n}>${inline(l.replace(/^#+\s*/, ""))}</h${n}>`); i++; }
    else if (/^\s*\|/.test(l)) {
      const rows = []; while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = r => r.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      const body = rows.filter(r => !/^\s*\|[\s:|-]+\|?\s*$/.test(r)); const head = body.shift();
      out.push(`<table><thead><tr>${cells(head).map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map(r => { nameIn(r); return `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join("")}</tr>`; }).join("")}</tbody></table>`);
    } else if (/^\s*[-*]\s/.test(l)) {
      const items = []; while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) { nameIn(lines[i]); items.push(`<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`); i++; }
      out.push(`<ul>${items.join("")}</ul>`);
    } else if (/^\s*\d+\.\s/.test(l)) {
      const items = []; while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) { nameIn(lines[i]); items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`); i++; }
      out.push(`<ol>${items.join("")}</ol>`);
    } else if (!l.trim()) i++;
    else { const para = []; while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|\s*\||\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])) para.push(lines[i++]); const t = para.join(" "); nameIn(t); out.push(`<p>${inline(t)}</p>`); }
  }
  return out.join("\n");
}
