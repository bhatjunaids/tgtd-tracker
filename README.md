# TG & TD Distribution Tracker

Delivery tracking for three titles — **TG Math (Class 1–3)**, **TG Hindi (Class 1–3)** and
**Teacher Diary (Class 1–8)** — from district targets down to individual schools.

Built from `Master Sheet TG and TD.xlsx`: 75 districts, 1,016 blocks, 1,31,383 schools.
The dashboard is a single self-contained HTML file that reads the backend Google Sheet live.

---

## 1. Make the backend sheet readable

The dashboard reads the sheet from the browser, so the sheet must be link-readable.

Open the [backend sheet](https://docs.google.com/spreadsheets/d/1YyBUXBQ8ID9ALl4ZCfXZ-zrVEra6n3Dcw6PTW_36JrE/edit)
→ **Share** → **General access** → **Anyone with the link · Viewer** → Done.

Nothing else is needed. Editing stays restricted to whoever you have given edit access;
"Anyone with the link · Viewer" only lets the dashboard read it.

**The sheet link is not shown anywhere on the dashboard.** It is baked into the page and
connects on load. Viewers see only a slim status line — *Live · updated 14:49 · auto-refresh
every 5 min* — with a **Refresh** button to pull immediately. If the sheet ever stops being
readable, that line turns red and says what to fix.

To preview the layout with random numbers, add `?demo=1` to the URL. It is deliberately not
linked from the interface.

## 2. Set up the three tabs

`sheet-templates/` holds a starter CSV for each tab, pre-filled with the full master list and
a `0` in every title column. Import each one into the matching tab
(**File → Import → Upload → Replace current sheet**):

| Template | Tab | gid | Rows |
|---|---|---|---|
| `1_district.csv` | District | `0` | 75 |
| `2_block.csv` | Block | `872546719` | 1,016 |
| `3_school.csv` | School | `1341514569` | 1,31,383 |

### District tab
```
District | TG Math Target | TG Math Received | TG Hindi Target | TG Hindi Received | Teacher Diary Target | Teacher Diary Received | Scan Date
```
Targets come pre-filled from the master sheet. **You update the `Received` columns** as scans
come in. The dashboard shows `Received ÷ Target` as % received.

If you delete the Target columns entirely, the dashboard falls back to the targets baked into
the page — so the % still works. Keep them if you expect targets to be revised.

### Block and School tabs
```
District | Block | Block Code | TG Math | TG Hindi | Teacher Diary | Scan Date
District | Block | UDISE Code | School Name | TG Math | TG Hindi | Teacher Diary | Scan Date
```
**You put any number in the title column when the title has reached.** The dashboard converts:

| Cell value | Shows |
|---|---|
| blank, `0` | **NO** |
| `1`, `5`, `250`, any non-zero number | **YES** |
| `YES`, `Y`, `received` | **YES** |
| `NO`, `N`, `NIL`, `N/A`, `-` | **NO** |

Blocks are matched on district + block name, falling back to Block Code.
Schools are matched on **UDISE Code** — that is the join key, so don't edit it.
A school missing from the sheet simply reads NO everywhere.

### Scan Date

Every tab has one **Scan Date** column per row — the date that row was scanned. It is shown as
**dd-mm-yy** everywhere on screen and in the exports, and appears as a `Scan date` column on the
District, Block and School screens.

You do not have to type it in any particular way. These all work:

| You type | Reads as |
|---|---|
| `02-04-26` | 2 April 2026 |
| `2-4-26`, `02/04/2026`, `02.04.2026` | 2 April 2026 |
| `2026-04-02` | 2 April 2026 |
| `02-04-2026 14:30` | 2 April 2026 (time kept for the hover tooltip) |
| a real Google Sheets date cell | whatever date it holds |

Ambiguous `d/m/y` is always read **day first**, so `02/04/26` is 2 April, never 4 February.
Impossible dates (`31-02-26`, `32-13-26`) are rejected and show as `?` rather than silently
rolling over into the next month. A blank shows as `—`. Hovering a date shows the full
`dd-mm-yyyy hh:mm` and, if it differs, the raw text from the sheet.

In the state report the district column shows that district's own scan date, while the block and
school bands show the **latest** scan date across that district's blocks and schools.

## 3. Publish the dashboard

`docs/index.html` is fully self-contained (the master list is embedded, gzip-compressed).
Live at **https://bhatjunaids.github.io/tgtd-tracker/** — GitHub Pages serves `/docs` from `main`,
so any push that changes `docs/index.html` redeploys within a minute.

---

## The screens

1. **District** — % received per title against target, plus an *Analysis* tab (state totals,
   how districts are spread, strongest and weakest ten) and a *Not reached* tab listing every
   district–title pair still at zero.
2. **Block** — YES/NO per title for all 1,016 blocks, filterable by district and by how many
   of the three titles have landed.
3. **School** — YES/NO per title, one district at a time (pick a district, then optionally a
   block).
4. **Reports** — the state report: one row per district joining all three levels, searchable
   and sortable, with a state total row. This is the screen to export and circulate.

The page re-reads the sheet every 5 minutes, and **Refresh** forces it.

The District, Block and School screens keep a plain **Export CSV** for the raw filtered rows.
The Excel workbook below is the one to send to people.

## The Ask screen

A fifth screen takes a question in plain English and turns it into a **filter** — a level, a
set of titles, some conditions, a sort and a limit — then runs that filter over the same live
rows the other screens show.

**The division of labour is the point.** A language model may decide *what to look at*. It
never decides what the number is. The only thing a translator is allowed to return is a
`FilterSpec` — a small JSON object validated against a strict schema. Every count, total and
percentage on the screen is computed afterwards, in `build/askql.js`, by code the model never
touches. The filter that ran is always displayed, as chips and as raw JSON, so any answer can
be checked against the District, Block and School tables by hand.

That makes the failure mode benign: a misread question returns the *wrong rows*, visibly
described, rather than a confident wrong figure.

### Two translators, one filter

- **Built-in parser** — always present, no key, no network. Handles the common shapes:
  thresholds ("districts below 50%"), scope ("blocks in Sitapur"), per-title negation
  ("have not received the Teacher Diary"), counts ("how many schools…"), ranking ("20 worst
  districts"), status ("blocks with all three titles"), and scan dates. When it cannot pin a
  question down it says so and falls back to a broad filter rather than guessing.
- **Claude** — optional. Handles free-form phrasing. Uses structured outputs against the same
  schema, so it cannot return anything the parser could not have returned.

Swapping one translator for the other cannot change a number — only which rows get counted.

### Connecting Claude (optional)

The page is static, so there is no server to hold a key and no key is embedded. **Connect
Claude** stores a key the reader supplies in that browser's `localStorage` and calls
`api.anthropic.com` directly from the page. The key never enters this repository, the built
HTML, or the backend sheet.

Anyone with access to that browser profile can read the key, so this is for a personal
machine, not a shared or public one. Questions are a few hundred tokens, so the cost per
question is a fraction of a paisa.

### Semantics worth knowing

- Naming titles narrows *every* measure — status, percentage and totals are then computed over
  those titles only.
- `complete` means every selected title has been received; `none` means no selected title has.
- District rows carry work-order copy counts, so **% of target** there is a real fill rate.
  Block and school sheets record arrival rather than quantity, so each title counts as one and
  **% of target** at those levels is the share of selected titles received. The table shows
  Target and Received columns only where they are real counts.
- Counts are reported against the places the question actually asked about: "schools in Hardoi
  with nothing" is *n* of Hardoi's schools, not of all 1,31,383.

## The Excel export

**Reports → Export Excel** produces a real `.xlsx` (not a CSV renamed) with four sheets:

| Sheet | What's in it |
|---|---|
| State Report | Exactly the table on screen, with merged level bands and a state total row |
| District detail | Target / received / % for each of the three titles, per district |
| Block status | All 1,016 blocks with YES/NO per title |
| Coverage roll-up | Blocks and schools started vs. all-three, per district |

Percentages are stored as **real numbers** with a `0.0"%"` format and the same colour bands as
the screen (green above 80%, amber 50–80%, red below 50%). Scan dates are stored as **real Excel
dates** formatted `dd-mm-yy`, not text — so both sort, filter and pivot properly without any
cleaning up.

The workbook is generated by a small ZIP + SpreadsheetML writer built into the page
(`writeXlsx` / `zipFile`) rather than a CDN library, so the export works offline and cannot
break when a third-party script changes. The output was verified by round-tripping a generated
workbook through `openpyxl` — all ZIP CRCs valid, four sheets, merges, number formats and band
fills intact — and it identifies as `Microsoft Excel 2007+`.

---

## Rebuilding

Only needed if the master list of districts/blocks/schools changes.

```bash
python3 build/build_data.py && python3 build/assemble.py
```

`build_data.py` reads the source xlsx and writes the embedded payload, the district targets,
an integrity report, and the three sheet templates. `assemble.py` injects them into
`build/template.html` and writes `docs/index.html`, along with `build/askql.js`, the Ask screen's query engine. **Edit `build/template.html`, never
`docs/index.html`** — the latter is generated.

`build/validate_palette.py` re-runs the colour-accessibility checks on the three title colours
(`#12A18E`, `#2563A8`, `#9C4A12`): colourblind separation, contrast, lightness band.

## Known data notes

- 11 blocks in the block master have no schools in the school master, so they appear at block
  level only. The dashboard flags them under the source bar. They are:
  Auraiya/Nagar Achhalda, Bhadohi/Nagar Palika Bhadohi, Ghaziabad/City Zone Ghaziabad,
  Kanpur Dehat/Jijhak, Lucknow/Nagar-2, Lucknow/Nagar-4, Pilibhit/Nagar Bisalpur,
  Sambhal/Gunnor, Sitapur/Nagar Palika Mahmoodabad, Sonbhadra/Karma, Sonbhadra/Kon.
- District names differ in case between the source tabs (`AGRA` vs `Agra`); matching ignores
  case, spaces and punctuation, so either spelling works in the sheet.
- No duplicate UDISE codes and no duplicate block codes in the master.
