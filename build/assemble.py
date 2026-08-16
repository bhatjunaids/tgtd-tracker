#!/usr/bin/env python3
"""Inject the built data assets into template.html -> docs/index.html."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
DOCS = ROOT / "docs"

html = (BUILD / "template.html").read_text()
for marker, path in (
    ("__TARGETS__", "targets.js"),
    ("__INTEGRITY__", "integrity.json"),
    ("__ASKQL__", "askql.js"),
    ("__PAYLOAD__", "payload.b64"),
):
    text = (BUILD / path).read_text().strip()
    assert marker in html, f"marker {marker} missing from template"
    html = html.replace(marker, text)

DOCS.mkdir(exist_ok=True)
out = DOCS / "index.html"
out.write_text(html)
print(f"wrote {out}  ({len(html)/1e6:.2f} MB)")
