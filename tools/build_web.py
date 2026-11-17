#!/usr/bin/env python3
"""Build web/index.html (the El Dorado Storm Lab) from web/src/.

    python3 tools/build_web.py           # write web/index.html
    python3 tools/build_web.py --check   # fail if web/index.html is out of date

The output is page content, not a full HTML document: the Claude artifact host
and server/server.js both wrap it in a document shell. Edit files in web/src/,
never web/index.html directly.

Source order:
  page.html        title, styles, markup, and the opening <script> tag
  10-network.js    devices, links, coordinates
  20-engine.js     spanning tree, storm math, live load (keep in sync with poc/storm-math)
  30-content.js    words per audience mode, glossary, mission tracks
  40-render.js     canvas map, HTML-in-Canvas device cards, effects, slow motion
  50-ui.js         strip, missions, coach, inspector, intro, main loop
  60-score.js      scoring, scoreboard, score report
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web" / "src"
OUT = ROOT / "web" / "index.html"

# (file, text appended after it): separators reproduce the original assembly exactly
PARTS = [("page.html", ""), ("10-network.js", ""), ("20-engine.js", "\n"), ("30-content.js", ""),
         ("40-render.js", ""), ("50-ui.js", "\n"), ("60-score.js", "</script>\n")]


def build() -> str:
    return "".join((SRC / name).read_text() + sep for name, sep in PARTS)


def main() -> int:
    html = build()
    if "--check" in sys.argv:
        if OUT.read_text() != html:
            print("web/index.html is out of date: run python3 tools/build_web.py")
            return 1
        print("web/index.html is up to date")
        return 0
    OUT.write_text(html)
    print(f"wrote {OUT.relative_to(ROOT)} ({len(html):,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
