#!/usr/bin/env python3
"""Render the docs site's two HTML pages from their markdown sources (needs: pip install markdown).
   python3 tools/pages.py   ->  site/setup/index.html, site/privacy/index.html"""
# Run this after editing site/setup.md or site/privacy.md, then commit the regenerated HTML with the markdown.
# PUB is the site/ folder. Each PAGES entry is (markdown source, HTML output, page title, description for link previews).
import html, pathlib, markdown
PUB = pathlib.Path(__file__).resolve().parents[1] / "site"
STYLE = '<style>body{font:17px/1.6 -apple-system,system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:1.5rem;color:#111;background:#fff}\nh1{font-size:1.7rem;line-height:1.25}h2{font-size:1.25rem;margin-top:2rem;border-top:1px solid #eee;padding-top:1rem}h3{font-size:1.05rem}\npre{background:#f5f5f5;padding:.8rem;border-radius:8px;overflow-x:auto;font-size:.85rem;line-height:1.45}code{font-size:.9em;background:#f3f3f3;padding:.08rem .25rem;border-radius:4px}pre code{background:none;padding:0}\nblockquote{margin:1rem 0;padding:.4rem 1rem;border-left:3px solid #ccc;color:#444}table{border-collapse:collapse;font-size:.9rem;width:100%}td,th{border:1px solid #ddd;padding:.4rem;text-align:left;vertical-align:top}\na{color:#0b57d0}.top{font-size:.9rem;color:#666}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}pre,code{background:#1d1d1d}td,th{border-color:#333}h2{border-color:#222}blockquote{color:#bbb}}</style>'
NAV = '<p class="top"><a href="/">Pull Tab</a> · <a href="/setup/">Setup guide</a> · <a href="/setup.md">setup.md</a> · <a href="/privacy/">Privacy</a></p>\n'
PAGES = [("setup.md", "setup/index.html", 'Pull Tab setup guide (for a Tab)', "How a Tab connects its person's Even G2 glasses through Pull Tab."),
         ("privacy.md", "privacy/index.html", 'Pull Tab privacy notice', 'What Pull Tab handles and where it goes.')]
for src, dst, title, desc in PAGES:
    body = markdown.markdown((PUB / src).read_text(), extensions=["fenced_code", "tables"])
    t, d = (html.escape(x, quote=False).replace('"', "&quot;") for x in (title, desc))
    head = (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n'
            f'<title>{t}</title><meta name="description" content="{d}"><meta property="og:title" content="{t}"><meta property="og:description" content="{d}">\n')
    (PUB / dst).write_text(head + STYLE + "</head><body>" + NAV + body + "</body></html>")
    print("wrote", dst)
