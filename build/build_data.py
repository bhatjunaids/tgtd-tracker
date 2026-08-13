#!/usr/bin/env python3
"""
Build the embedded data assets for the TG & TD Distribution Tracker.

Inputs : Master Sheet TG and TD.xlsx  (Sheet1 = district targets,
                                       Sheet2 = block master,
                                       Sheet3 = school master)
Outputs: build/targets.js       - district target rows, pasted into the dashboard
         build/payload.b64      - gzip+base64 block+school master
         build/integrity.json   - data-integrity notes surfaced in the UI
         sheet-templates/*.csv  - starter tabs for the backend Google Sheet
"""

import base64
import gzip
import io
import json
import re
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
SRC = Path("/Users/junny/Downloads/downloads/Master Sheet TG and TD.xlsx")
BUILD = ROOT / "build"
TEMPLATES = ROOT / "sheet-templates"

# Column headers used in the backend Google Sheet, in fixed order.
TITLE_COLS = ["TG Math", "TG Hindi", "Teacher Diary"]


def norm(s):
    """District/block key: strip everything but A-Z0-9 so casing and
    punctuation differences between the three sheets stop mattering."""
    return re.sub(r"[^A-Z0-9]", "", str(s).upper())


def titlecase(s):
    """Sheet1 is SHOUTING, Sheet2/3 are Title Case. Prefer Sheet2/3 spelling."""
    return " ".join(w.capitalize() for w in str(s).split())


def main():
    d_tgt = pd.read_excel(SRC, "Sheet1")
    d_blk = pd.read_excel(SRC, "Sheet2")
    d_sch = pd.read_excel(SRC, "Sheet3")

    d_sch["School Name"] = d_sch["School Name"].fillna("(name missing)")

    # ---------- districts ----------
    # Display name comes from the block master (proper Title Case).
    disp = {}
    for d in d_blk["District"]:
        disp.setdefault(norm(d), str(d).strip())
    for d in d_sch["District"]:
        disp.setdefault(norm(d), str(d).strip())
    for d in d_tgt["District"]:
        disp.setdefault(norm(d), titlecase(d))

    districts = sorted({norm(d) for d in d_tgt["District"]}, key=lambda k: disp[k])
    dist_idx = {k: i for i, k in enumerate(districts)}
    dist_names = [disp[k] for k in districts]

    # ---------- targets ----------
    tgt_by_dist = {}
    for _, r in d_tgt.iterrows():
        tgt_by_dist[norm(r["District"])] = [
            int(r["TG Math (Class 1-3)"]),
            int(r["TG Hindi (Class 1-3)"]),
            int(r["Teachers diary (Class 1 to 8)"]),
        ]
    target_rows = [[dist_names[i], *tgt_by_dist[k]] for i, k in enumerate(districts)]

    # ---------- blocks ----------
    d_blk = d_blk.sort_values(["District", "Block"], kind="stable")
    blocks = []          # [distIdx, name, code]
    blk_idx = {}         # (distKey, blockKey) -> index
    for _, r in d_blk.iterrows():
        dk, bk = norm(r["District"]), norm(r["Block"])
        if (dk, bk) in blk_idx:
            continue
        blk_idx[(dk, bk)] = len(blocks)
        blocks.append([dist_idx[dk], str(r["Block"]).strip(), int(r["Block Code"])])

    # ---------- schools ----------
    d_sch = d_sch.sort_values(["District", "Block", "School Name"], kind="stable")
    schools = []         # [blockIdx, udise, name]
    orphan_blocks = set()
    for _, r in d_sch.iterrows():
        dk, bk = norm(r["District"]), norm(r["Block"])
        bi = blk_idx.get((dk, bk))
        if bi is None:
            orphan_blocks.add((dk, bk))
            continue
        schools.append([bi, str(int(r["UDISE Code"])), str(r["School Name"]).strip()])

    # ---------- integrity ----------
    sch_per_block = {}
    for bi, _, _ in schools:
        sch_per_block[bi] = sch_per_block.get(bi, 0) + 1
    empty_blocks = [
        {"district": dist_names[b[0]], "block": b[1], "code": b[2]}
        for i, b in enumerate(blocks)
        if sch_per_block.get(i, 0) == 0
    ]
    integrity = {
        "builtOn": pd.Timestamp.today().strftime("%d %b %Y"),
        "districts": len(districts),
        "blocks": len(blocks),
        "schools": len(schools),
        "blocksWithSchools": len(sch_per_block),
        "emptyBlocks": empty_blocks,
        "orphanBlocks": sorted(orphan_blocks),
        "dupUdise": int(d_sch["UDISE Code"].duplicated().sum()),
        "minSchoolsInBlock": min(sch_per_block.values()),
        "maxSchoolsInBlock": max(sch_per_block.values()),
    }

    # ---------- payload ----------
    # Tab-delimited, section-separated. Far smaller than JSON before gzip and
    # trivial to split in the browser.
    out = io.StringIO()
    out.write("\t".join(dist_names))
    out.write("\n@@\n")
    out.write("\n".join(f"{d}\t{n}\t{c}" for d, n, c in blocks))
    out.write("\n@@\n")
    out.write("\n".join(f"{b}\t{u}\t{n}" for b, u, n in schools))
    raw = out.getvalue().encode("utf-8")
    gz = gzip.compress(raw, 9)
    b64 = base64.b64encode(gz).decode("ascii")

    BUILD.mkdir(exist_ok=True)
    (BUILD / "payload.b64").write_text(b64)
    (BUILD / "integrity.json").write_text(json.dumps(integrity, indent=1))
    (BUILD / "targets.js").write_text(
        "const TARGET_ROWS = [\n"
        + "\n".join(json.dumps(r) + "," for r in target_rows)
        + "\n];\n"
    )

    # ---------- backend sheet templates ----------
    TEMPLATES.mkdir(exist_ok=True)

    dt = pd.DataFrame(target_rows, columns=["District", *[f"{t} Target" for t in TITLE_COLS]])
    for t in TITLE_COLS:
        dt[f"{t} Received"] = 0
    dt = dt[["District"] + [c for t in TITLE_COLS for c in (f"{t} Target", f"{t} Received")]]
    dt["Scan Date"] = ""
    dt.to_csv(TEMPLATES / "1_district.csv", index=False)

    bt = pd.DataFrame(
        [[dist_names[d], n, c] for d, n, c in blocks],
        columns=["District", "Block", "Block Code"],
    )
    for t in TITLE_COLS:
        bt[t] = 0
    bt["Scan Date"] = ""
    bt.to_csv(TEMPLATES / "2_block.csv", index=False)

    st = pd.DataFrame(
        [[dist_names[blocks[b][0]], blocks[b][1], u, n] for b, u, n in schools],
        columns=["District", "Block", "UDISE Code", "School Name"],
    )
    for t in TITLE_COLS:
        st[t] = 0
    st["Scan Date"] = ""
    st.to_csv(TEMPLATES / "3_school.csv", index=False)

    print(f"districts {len(districts)}  blocks {len(blocks)}  schools {len(schools):,}")
    print(f"payload raw {len(raw)/1e6:.2f} MB -> gz {len(gz)/1e6:.2f} MB -> b64 {len(b64)/1e6:.2f} MB")
    print(f"empty blocks (no schools): {len(empty_blocks)}  orphan blocks: {len(orphan_blocks)}")


if __name__ == "__main__":
    main()
