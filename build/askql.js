/* ==================== ASKQL BEGIN ====================
   Ask — a plain-English query layer.

   The contract, and the whole point of this file:
   a language model may choose WHAT TO LOOK AT. It never says what the number is.

   A question goes to a translator, which returns nothing but a FilterSpec — a small
   JSON object naming a level, some titles, some predicates, a sort and a limit.
   execute() then runs that spec over the tracker's own live rows, in this file,
   with arithmetic no model ever touches. Every figure on screen is computed here.

   Two translators produce the same spec:
     · a deterministic parser, always present, no key, no network
     · Claude, when the user supplies their own API key

   Swapping one for the other cannot change a number — only which rows get counted.
   The filter that ran is always shown, so the answer is auditable line by line.

   The host page supplies an adapter (see AskQL.init) that normalises its own data
   into one row shape. Everything below this line is tracker-agnostic.
   ==================================================================== */
const AskQL = (function(){
"use strict";

/* ---------- small helpers (self-contained: no host dependencies) ---------- */
const A_esc  = s => String(s==null?"":s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const A_norm = s => String(s==null?"":s).toUpperCase().replace(/[^A-Z0-9]/g,"");
const A_fmt  = n => Number(n||0).toLocaleString("en-IN");
const A_pct  = (r,t) => t>0 ? (r/t)*100 : (r>0?100:0);
const A_p2   = n => String(n).padStart(2,"0");
const A_date = d => d ? `${A_p2(d.getDate())}-${A_p2(d.getMonth()+1)}-${String(d.getFullYear()).slice(-2)}` : "";
const A_q    = s => document.querySelector(s);

function A_download(name, text){
  const url = URL.createObjectURL(new Blob(["﻿"+text], {type:"text/csv;charset=utf-8"}));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const A_cell = v => `"${String(v==null?"":v).replace(/"/g,'""')}"`;
const A_csv  = rows => rows.map(r => r.map(A_cell).join(",")).join("\n");

/* Parse a YYYY-MM-DD the spec carries. Local midnight, so comparisons match the
   day-first dates the trackers already show. */
function A_isoDate(s){
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s||"").trim());
  if(!m) return null;
  const d = new Date(+m[1], +m[2]-1, +m[3]);
  return (d.getFullYear()===+m[1] && d.getMonth()===+m[2]-1 && d.getDate()===+m[3]) ? d : null;
}

/* ---------- adapter ---------- */
/* AD is set by AskQL.init(). Contract:
     AD.trackerLabel  string
     AD.titles        [{key, label, short}]
     AD.districts()   -> [display names]
     AD.levels        {district:{label,noun}, block:{...}, school:{...}}
     AD.rows(level)   -> Promise<[Row]>   Row = {
                           district, block, code, school, udise,
                           tgt:{titleKey:number}, rcv:{titleKey:number}, date:Date|null }
     AD.counting(lvl) -> "units" | "titles"  — whether tgt/rcv at this level are real
                         copy counts or a one-per-title stand-in. Drives both the
                         columns shown and how pct is explained to the model.
     AD.freshness()   -> short string describing where the numbers came from
     AD.notes         [string]  extra semantics for the translator prompt
     AD.examples      [string]  one-click example questions
     AD.ready()       -> Promise<bool>  whether the underlying data can be queried yet
*/
let AD = null;

const LS_KEY = "askql.key";
const LS_MODEL = "askql.model";
const MODELS = [
  {id:"claude-opus-5",   label:"Claude Opus 5 — most capable"},
  {id:"claude-sonnet-5", label:"Claude Sonnet 5 — faster"},
  {id:"claude-haiku-4-5",label:"Claude Haiku 4.5 — fastest"}
];

/* =====================================================================
   1. The FilterSpec — the only thing a model is ever allowed to produce
   ===================================================================== */

function blankSpec(level){
  return {
    restatement: "",
    level: level || "district",
    titles: [],
    where: {
      districts: [], blockSearch: null, schoolSearch: null,
      status: "any", pct: null, titleIs: null, titlesReceived: null, scanDate: null
    },
    sort: {by:"name", dir:"asc"},
    limit: 50,
    aggregate: "list"
  };
}

/* JSON Schema handed to the model. Structured outputs require every object to
   carry additionalProperties:false and list every key in `required`, so optional
   predicates are expressed as an explicit null rather than an absent key. */
function jsonSchema(){
  const titleEnum = AD.titles.map(t => t.key);
  /* Structured outputs documents anyOf but not type-arrays, and requires every
     object to carry additionalProperties:false with every key listed in required.
     Optional values are therefore an explicit null branch, never an absent key. */
  const nullable = (type, description) => ({anyOf:[{type}, {type:"null"}], description});
  const nullableObj = (props, required) => ({
    anyOf: [
      {type:"null"},
      {type:"object", additionalProperties:false, required, properties:props}
    ]
  });
  return {
    type:"object", additionalProperties:false,
    required:["restatement","level","titles","where","sort","limit","aggregate"],
    properties:{
      restatement:{type:"string", description:"One short line restating the question as the filter you built. Describe the selection only. Never state a count, total, percentage or any other figure — you do not know them."},
      level:{type:"string", enum:["district","block","school"], description:"Which list of rows to filter."},
      titles:{type:"array", items:{type:"string", enum:titleEnum},
        description:"Titles the question is about. Empty array means all titles."},
      where:{
        type:"object", additionalProperties:false,
        required:["districts","blockSearch","schoolSearch","status","pct","titleIs","titlesReceived","scanDate"],
        properties:{
          districts:{type:"array", items:{type:"string"},
            description:"District names to restrict to, spelled as in the district list. Empty array means all districts."},
          blockSearch:nullable("string","Free text to match against block name or block code. Null for no block filter."),
          schoolSearch:nullable("string","Free text to match against school name or UDISE code. Null for no school filter."),
          status:{type:"string", enum:["any","complete","partial","none"],
            description:"complete = every selected title received; none = no selected title received; partial = some but not all."},
          pct:nullableObj({
            op:{type:"string", enum:["lt","lte","gt","gte","between"]},
            value:{type:"number", description:"Percentage, 0-100."},
            value2:nullable("number","Upper bound for 'between', else null.")
          }, ["op","value","value2"]),
          titleIs:nullableObj({
            title:{type:"string", enum:titleEnum},
            received:{type:"boolean", description:"true = this title has been received, false = it has not."}
          }, ["title","received"]),
          titlesReceived:nullableObj({
            op:{type:"string", enum:["lt","lte","gt","gte","eq"]},
            value:{type:"integer", description:"How many of the selected titles have been received."}
          }, ["op","value"]),
          scanDate:nullableObj({
            op:{type:"string", enum:["before","after","between","missing","present"]},
            value:nullable("string","YYYY-MM-DD, or null for missing/present."),
            value2:nullable("string","YYYY-MM-DD upper bound for 'between', else null.")
          }, ["op","value","value2"])
        }
      },
      sort:{
        type:"object", additionalProperties:false, required:["by","dir"],
        properties:{
          by:{type:"string", enum:["name","pct","received","target","gap","titles","date"]},
          dir:{type:"string", enum:["asc","desc"]}
        }
      },
      limit:{type:"integer", description:"Maximum rows to show, 1 to 2000. Use 2000 when the question implies everything."},
      aggregate:{type:"string", enum:["list","count"],
        description:"count when the question asks how many; list when it asks which."}
    }
  };
}

/* Normalise anything a translator returns into a spec the executor can trust.
   Unknown values are dropped rather than guessed, and reported to the reader. */
function coerceSpec(raw){
  const warn = [];
  const s = blankSpec();
  const titleKeys = AD.titles.map(t => t.key);
  const dnames = AD.districts();
  const dbyKey = new Map(dnames.map(n => [A_norm(n), n]));

  if(!raw || typeof raw !== "object") return {spec:s, warn:["The translator returned nothing usable."]};

  if(["district","block","school"].includes(raw.level)) s.level = raw.level;
  s.restatement = typeof raw.restatement === "string" ? raw.restatement.slice(0,240) : "";

  if(Array.isArray(raw.titles))
    s.titles = raw.titles.filter(k => titleKeys.includes(k));

  const w = (raw.where && typeof raw.where === "object") ? raw.where : {};
  if(Array.isArray(w.districts)){
    for(const d of w.districts){
      const hit = dbyKey.get(A_norm(d));
      if(hit) s.where.districts.push(hit);
      else if(String(d||"").trim()) warn.push(`No district named “${String(d).trim()}” — that filter was dropped.`);
    }
  }
  if(typeof w.blockSearch === "string" && w.blockSearch.trim()) s.where.blockSearch = w.blockSearch.trim();
  if(typeof w.schoolSearch === "string" && w.schoolSearch.trim()) s.where.schoolSearch = w.schoolSearch.trim();
  if(["any","complete","partial","none"].includes(w.status)) s.where.status = w.status;

  if(w.pct && ["lt","lte","gt","gte","between"].includes(w.pct.op) && Number.isFinite(+w.pct.value)){
    s.where.pct = {op:w.pct.op, value:+w.pct.value, value2:Number.isFinite(+w.pct.value2)?+w.pct.value2:null};
    if(s.where.pct.op === "between" && s.where.pct.value2 == null){ s.where.pct = null; warn.push("A “between” range was missing its upper bound, so it was dropped."); }
  }
  if(w.titleIs && titleKeys.includes(w.titleIs.title) && typeof w.titleIs.received === "boolean")
    s.where.titleIs = {title:w.titleIs.title, received:w.titleIs.received};

  if(w.titlesReceived && ["lt","lte","gt","gte","eq"].includes(w.titlesReceived.op) && Number.isFinite(+w.titlesReceived.value))
    s.where.titlesReceived = {op:w.titlesReceived.op, value:Math.round(+w.titlesReceived.value)};

  if(w.scanDate && ["before","after","between","missing","present"].includes(w.scanDate.op)){
    const a = A_isoDate(w.scanDate.value), b = A_isoDate(w.scanDate.value2);
    const needsOne = ["before","after","between"].includes(w.scanDate.op);
    if(needsOne && !a) warn.push("A date filter had no readable date, so it was dropped.");
    else if(w.scanDate.op === "between" && !b) warn.push("A date range was missing its second date, so it was dropped.");
    else s.where.scanDate = {op:w.scanDate.op, value:a, value2:b};
  }

  const sortKeys = ["name","pct","received","target","gap","titles","date"];
  if(raw.sort && sortKeys.includes(raw.sort.by)) s.sort.by = raw.sort.by;
  if(raw.sort && ["asc","desc"].includes(raw.sort.dir)) s.sort.dir = raw.sort.dir;
  if(Number.isFinite(+raw.limit)) s.limit = Math.max(1, Math.min(2000, Math.round(+raw.limit)));
  if(["list","count"].includes(raw.aggregate)) s.aggregate = raw.aggregate;

  return {spec:s, warn};
}

/* =====================================================================
   2. The executor — deterministic, and the only source of every figure
   ===================================================================== */

function selectedTitles(spec){
  const keys = spec.titles.length ? spec.titles : AD.titles.map(t => t.key);
  return AD.titles.filter(t => keys.includes(t.key));
}

/* Fold one adapter row into the numbers every predicate and column reads from.
   tgt/rcv are summed over the SELECTED titles only, so "% for Teacher Diary
   alone" and "% overall" are the same code path with a different selection. */
function measure(row, sel){
  let T = 0, R = 0, nRecv = 0;
  for(const t of sel){
    const tv = +(row.tgt && row.tgt[t.key]) || 0;
    const rv = +(row.rcv && row.rcv[t.key]) || 0;
    T += tv; R += rv;
    if(rv > 0) nRecv++;
  }
  const status = nRecv === 0 ? "none" : (nRecv === sel.length ? "complete" : "partial");
  return {T, R, nRecv, nSel:sel.length, pct:A_pct(R,T), gap:Math.max(0, T-R), status};
}

function cmpNum(op, v, a, b){
  switch(op){
    case "lt":  return v <  a;
    case "lte": return v <= a;
    case "gt":  return v >  a;
    case "gte": return v >= a;
    case "eq":  return v === a;
    case "between": return v >= Math.min(a,b) && v <= Math.max(a,b);
  }
  return true;
}

function execute(rows, spec){
  const sel = selectedTitles(spec);
  const w = spec.where;
  const dset = w.districts.length ? new Set(w.districts.map(A_norm)) : null;
  const bq = w.blockSearch ? A_norm(w.blockSearch) : null;
  const sq = w.schoolSearch ? A_norm(w.schoolSearch) : null;

  /* Two passes, deliberately. Scope predicates (which places) set the denominator
     a count is reported against; condition predicates (what is true of them) set
     the numerator. Counting "schools in Hardoi with nothing" against all 1.3 lakh
     schools in the state would be arithmetically correct and completely useless. */
  const out = [];
  let scoped = 0;
  for(const row of rows){
    if(dset && !dset.has(A_norm(row.district))) continue;
    if(bq && !(A_norm(row.block).includes(bq) || A_norm(row.code).includes(bq))) continue;
    if(sq && !(A_norm(row.school).includes(sq) || A_norm(row.udise).includes(sq))) continue;
    scoped++;

    const m = measure(row, sel);

    if(w.status !== "any" && m.status !== w.status) continue;
    if(w.pct && !cmpNum(w.pct.op, m.pct, w.pct.value, w.pct.value2)) continue;
    if(w.titlesReceived && !cmpNum(w.titlesReceived.op, m.nRecv, w.titlesReceived.value)) continue;
    if(w.titleIs){
      const got = (+(row.rcv && row.rcv[w.titleIs.title]) || 0) > 0;
      if(got !== w.titleIs.received) continue;
    }
    if(w.scanDate){
      const d = row.date;
      if(w.scanDate.op === "missing"){ if(d) continue; }
      else if(w.scanDate.op === "present"){ if(!d) continue; }
      else {
        if(!d) continue;
        const t = d.getTime(), a = w.scanDate.value.getTime();
        if(w.scanDate.op === "before" && !(t <  a)) continue;
        if(w.scanDate.op === "after"  && !(t >  a)) continue;
        if(w.scanDate.op === "between"){
          const b = w.scanDate.value2.getTime();
          if(!(t >= Math.min(a,b) && t <= Math.max(a,b) + 86399999)) continue;
        }
      }
    }
    out.push({row, m});
  }

  const dir = spec.sort.dir === "desc" ? -1 : 1;
  const label = e => `${e.row.district||""}${e.row.block||""}${e.row.school||e.row.udise||""}`;
  const key = {
    name:     e => null,
    pct:      e => e.m.pct,
    received: e => e.m.R,
    target:   e => e.m.T,
    gap:      e => e.m.gap,
    titles:   e => e.m.nRecv,
    date:     e => e.row.date ? e.row.date.getTime() : -Infinity
  }[spec.sort.by];
  out.sort((x,y) => {
    if(spec.sort.by !== "name"){
      const d = (key(x) - key(y)) * dir;
      if(d) return d;
    }
    return label(x).localeCompare(label(y)) * (spec.sort.by === "name" ? dir : 1);
  });

  /* Totals are over every matching row, not just the page shown. */
  let T = 0, R = 0;
  for(const e of out){ T += e.m.T; R += e.m.R; }

  return {
    sel,
    matched: out.length,
    scoped,                 // rows left after the place filters — the honest denominator
    scanned: rows.length,
    narrowed: scoped < rows.length,
    shown: out.slice(0, spec.limit),
    truncated: out.length > spec.limit,
    totals: {T, R, pct:A_pct(R,T), gap:Math.max(0,T-R)},
    all: out
  };
}

/* =====================================================================
   3. Translator A — deterministic. No key, no network, always available.
   ===================================================================== */

const NUMWORD = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
                 twenty:20,twentyfive:25,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,hundred:100};

const MONTHS = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,sept:9,oct:10,nov:11,dec:12};

function parseLooseDate(text){
  let m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if(m) return new Date(+m[1], +m[2]-1, +m[3]);
  m = /(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/.exec(text);
  if(m){ let y = +m[3]; if(y < 100) y += y < 80 ? 2000 : 1900; return new Date(y, +m[2]-1, +m[1]); }
  const month = w => MONTHS[String(w).slice(0,4).toLowerCase()] || MONTHS[String(w).slice(0,3).toLowerCase()] || null;
  m = /(\d{1,2})\s*(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?\s*(\d{4})?/i.exec(text);   // 1 April 2026
  if(m){
    const mo = month(m[2]);
    if(mo) return new Date(m[3] ? +m[3] : new Date().getFullYear(), mo-1, +m[1]);
  }
  m = /([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/i.exec(text);     // April 1 2026
  if(m){
    const mo = month(m[1]);
    if(mo) return new Date(m[3] ? +m[3] : new Date().getFullYear(), mo-1, +m[2]);
  }
  return null;
}
const toIso = d => d ? `${d.getFullYear()}-${A_p2(d.getMonth()+1)}-${A_p2(d.getDate())}` : null;

function parseLocally(question){
  const q = " " + String(question||"").toLowerCase().trim() + " ";
  const spec = blankSpec();
  let hits = [];                // what the parser actually understood
  let confident = false;

  /* --- level --- */
  if(/\bschool|udise|vidyalay/.test(q)){ spec.level = "school"; hits.push("school level"); confident = true; }
  else if(/\bblock|vikas ?khand|nyay/.test(q)){ spec.level = "block"; hits.push("block level"); confident = true; }
  else if(/\bdistrict|jila|janpad|zila/.test(q)){ spec.level = "district"; hits.push("district level"); confident = true; }

  /* --- titles --- */
  for(const t of AD.titles){
    const needles = [t.label, t.short, t.key].filter(Boolean).map(s => s.toLowerCase());
    for(const n of needles){
      const clean = n.replace(/[^a-z0-9 ]+/g," ").trim();
      if(clean.length >= 3 && q.includes(" " + clean)){ spec.titles.push(t.key); hits.push(t.short || t.label); confident = true; break; }
    }
  }
  spec.titles = [...new Set(spec.titles)];

  /* --- districts (longest name first, so KANPUR NAGAR beats KANPUR) --- */
  const names = AD.districts().slice().sort((a,b) => b.length - a.length);
  const qn = A_norm(q);
  for(const n of names){
    if(qn.includes(A_norm(n)) && !spec.where.districts.some(x => A_norm(x).includes(A_norm(n)))){
      spec.where.districts.push(n); hits.push(n); confident = true;
    }
  }
  /* --- percentage predicates --- */
  const pctNum = () => {
    const m = /(\d{1,3})\s*(?:%|per ?cent|percent)/.exec(q) || /(?:below|under|less than|above|over|more than|at least|at most)\s+(\d{1,3})\b/.exec(q);
    if(m) return +m[1];
    for(const wd in NUMWORD) if(new RegExp("\\b"+wd+"\\s*(?:%|per ?cent|percent)").test(q)) return NUMWORD[wd];
    return null;
  };
  const between = /between\s+(\d{1,3})\s*(?:%|per ?cent)?\s*(?:and|-|to)\s*(\d{1,3})\s*(?:%|per ?cent)?/.exec(q);
  if(between){
    spec.where.pct = {op:"between", value:+between[1], value2:+between[2]};
    hits.push(`${between[1]}–${between[2]}%`); confident = true;
  } else {
    const v = pctNum();
    if(v != null){
      if(/\b(below|under|less than|lower than|worse than|short of)\b/.test(q)) { spec.where.pct = {op:"lt", value:v, value2:null}; hits.push(`below ${v}%`); confident = true; }
      else if(/\b(above|over|more than|higher than|at least|beyond)\b/.test(q)) { spec.where.pct = {op:"gte", value:v, value2:null}; hits.push(`${v}% or more`); confident = true; }
    }
  }

  /* --- status --- */
  if(/\b(nothing|not received|no (?:books|material|title|delivery)|zero|never received|not reached|yet to receive|haven'?t received|has not received|awaiting)\b/.test(q)){
    spec.where.status = "none"; hits.push("nothing received"); confident = true;
  } else if(/\ball\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)?\s*(?:titles?|books?|materials?)\b/.test(q)
         || /\b(complete|completed|fully (?:received|delivered)|everything|every title|all books)\b/.test(q)){
    spec.where.status = "complete"; hits.push("every selected title received"); confident = true;
  } else if(/\bpartial|some but not|incomplete|part(?:ially)?\b/.test(q)){
    spec.where.status = "partial"; hits.push("partly received"); confident = true;
  }

  /* A single named title plus a negation is a per-title predicate, not a status.
     It supersedes any status read a moment ago, so the restatement has to drop
     that phrasing too — a restatement describing a predicate that did not run
     would be exactly the kind of unverifiable claim this layer exists to avoid. */
  if(spec.titles.length === 1 && /\b(not|no|without|missing|haven'?t|hasn'?t|yet to|pending)\b/.test(q)){
    const statusPhrases = ["nothing received", "every selected title received", "partly received"];
    hits = hits.filter(h => !statusPhrases.includes(h));
    spec.where.titleIs = {title:spec.titles[0], received:false};
    spec.where.status = "any";
    hits.push(`${AD.titles.find(t=>t.key===spec.titles[0]).short} not received`);
    confident = true;
  }

  /* --- dates --- */
  if(/\b(no|missing|without) (?:scan )?date\b|\bnever scanned\b/.test(q)){
    spec.where.scanDate = {op:"missing", value:null, value2:null}; hits.push("no scan date"); confident = true;
  } else {
    const rangeM = /between\s+(.+?)\s+and\s+(.+?)(?:\s|$)/.exec(q);
    const d1 = rangeM ? parseLooseDate(rangeM[1]) : null, d2 = rangeM ? parseLooseDate(rangeM[2]) : null;
    if(d1 && d2){ spec.where.scanDate = {op:"between", value:d1, value2:d2}; hits.push(`scanned ${A_date(d1)}–${A_date(d2)}`); confident = true; }
    else {
      const m = /\b(before|after|since|from|until|till|up to)\b(.{0,24})/.exec(q);
      const d = m ? parseLooseDate(m[2]) : null;
      if(d){
        const op = /before|until|till|up to/.test(m[1]) ? "before" : "after";
        spec.where.scanDate = {op, value:d, value2:null};
        hits.push(`scanned ${op} ${A_date(d)}`); confident = true;
      }
    }
  }

  /* --- sort and limit --- */
  const topM = /\b(?:top|first|best|worst|bottom|lowest|highest|weakest|slowest)\s+(\d{1,4})\b/.exec(q)
            || /\b(\d{1,4})\s+(?:worst|best|lowest|highest|weakest)\b/.exec(q);
  if(topM){ spec.limit = Math.min(2000, +topM[1]); confident = true; }
  if(/\b(worst|bottom|lowest|weakest|slowest|behind|laggard|needs? follow ?up)\b/.test(q)){
    spec.sort = {by:"pct", dir:"asc"}; hits.push("worst first");
  } else if(/\b(best|top|highest|leading|ahead|strongest)\b/.test(q)){
    spec.sort = {by:"pct", dir:"desc"}; hits.push("best first");
  } else if(/\b(recent|latest|newest)\b/.test(q)){
    spec.sort = {by:"date", dir:"desc"}; hits.push("most recent first");
  } else if(/\b(biggest gap|largest gap|most outstanding|most pending|shortfall)\b/.test(q)){
    spec.sort = {by:"gap", dir:"desc"}; hits.push("biggest shortfall first");
  }

  /* --- how many vs which --- */
  if(/^\s*(how many|count|number of|what share|what proportion)\b/.test(q) || /\bhow many\b/.test(q)){
    spec.aggregate = "count"; hits.push("counted"); confident = true;
  }
  if(spec.aggregate === "list" && !topM) spec.limit = spec.level === "district" ? 75 : 300;

  spec.restatement = hits.length ? hits.join(" · ") : "";
  return {spec, confident, hits};
}

/* =====================================================================
   4. Translator B — Claude. Produces a FilterSpec and nothing else.
   ===================================================================== */

function systemPrompt(){
  const titleLines = AD.titles.map(t => `  ${t.key} = ${t.label}`).join("\n");
  const districtLine = AD.districts().join(", ");
  const counting = ["district","block","school"].map(lv =>
    `${lv}: ${AD.counting(lv) === "units"
      ? "target and received are counts of physical copies, so pct is a real fill rate"
      : "arrival is recorded but not quantity, so each title counts as one and pct is the share of selected titles received"}`
  ).join("; ");
  return [
`You translate a question about the ${AD.trackerLabel} into a filter. You are a query planner, not an analyst.`,
``,
`You choose WHAT TO LOOK AT. You never state what the numbers are. The tool runs your filter over the live data and computes every figure itself, so any count, total or percentage you tried to write would be ignored and would only mislead. Return the filter and nothing else.`,
``,
`Levels: district (targets and receipts per district), block, school.`,
``,
`Titles:`,
titleLines,
``,
`Districts (use these spellings exactly):`,
districtLine,
``,
`Semantics:`,
`- titles: [] means all titles. Naming titles narrows every measure — status, percentage and counts are then computed over those titles only.`,
`- status complete = every selected title received; none = no selected title received; partial = in between.`,
`- pct is received divided by target across the selected titles, as a percentage. By level — ${counting}.`,
`- titleIs asks whether one specific title has arrived. Prefer it over status when the question names a single title.`,
`- Use blockSearch or schoolSearch only for a name or code the question actually gives. Do not invent one.`,
`- aggregate: count when the question asks how many, list when it asks which.`,
`- Sort worst-first (pct asc) for questions about who is behind, best-first (pct desc) for who is ahead.`,
AD.notes && AD.notes.length ? AD.notes.map(n => `- ${n}`).join("\n") : "",
``,
`If the question is vague, choose the most useful reasonable reading rather than an empty filter. If it is about something this data cannot answer, still return your closest filter — the tool will show the reader what actually ran.`
].filter(Boolean).join("\n");
}

async function translateWithClaude(question, key, model){
  const body = {
    model,
    max_tokens: 4000,
    system: [{type:"text", text:systemPrompt(), cache_control:{type:"ephemeral"}}],
    /* Thinking stays on. On Opus 5, disabling it can leak internal tags or plain-text
       tool calls into the output — the exact failure this layer must not have. Effort
       is low because turning one sentence into a small filter is not a hard problem. */
    thinking: {type:"adaptive"},
    output_config: {
      effort: "low",
      format: {type:"json_schema", schema: jsonSchema()}
    },
    messages: [{role:"user", content:question}]
  };

  let res;
  try{
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{
        "content-type":"application/json",
        "x-api-key":key,
        "anthropic-version":"2023-06-01",
        "anthropic-dangerous-direct-browser-access":"true"
      },
      body: JSON.stringify(body)
    });
  }catch(e){
    throw new Error("Could not reach the Claude API. Check the network connection and try again.");
  }

  if(!res.ok){
    let detail = "";
    try{ const j = await res.json(); detail = (j && j.error && j.error.message) || ""; }catch(_){}
    if(res.status === 401) throw new Error("That API key was rejected. Check it and save it again.");
    if(res.status === 429) throw new Error("Rate limited by the API. Wait a moment and ask again.");
    if(res.status === 400 && /credit|balance/i.test(detail)) throw new Error("The API account has no credit available.");
    throw new Error(`The API returned ${res.status}. ${detail}`.trim());
  }

  const msg = await res.json();
  if(msg.stop_reason === "refusal") throw new Error("Claude declined to answer this one. Try rephrasing the question.");
  if(msg.stop_reason === "max_tokens") throw new Error("The reply was cut short. Try a shorter question.");

  const text = (msg.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  if(!text) throw new Error("Claude returned no filter. Try rephrasing the question.");
  let parsed;
  try{ parsed = JSON.parse(text); }
  catch(_){ throw new Error("Claude's reply was not a readable filter. Try rephrasing the question."); }

  const usage = msg.usage || {};
  return {raw: parsed, usage, model: msg.model || model};
}

/* =====================================================================
   5. Rendering
   ===================================================================== */

const CSS = `
#askql{margin-top:20px}
#askql .aq-intro{color:var(--ink-soft);font-size:12.5px;line-height:1.6;margin:0 0 16px;max-width:82ch}
#askql .aq-intro b{color:var(--ink)}
#askql .aq-box{background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:18px}
#askql .aq-row{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}
#askql textarea{flex:1;min-width:280px;min-height:52px;resize:vertical;font-family:var(--sans);font-size:14.5px;line-height:1.5;
  color:var(--ink);background:#FCFCFA;border:1px solid var(--line);border-radius:9px;padding:12px 13px}
#askql textarea:focus{outline:none;border-color:var(--spine);box-shadow:0 0 0 3px rgba(14,122,110,.12)}
#askql .aq-go{font-family:var(--sans);font-size:13.5px;font-weight:600;padding:13px 22px;border-radius:9px;border:1px solid var(--spine);
  background:var(--spine);color:#fff;cursor:pointer;white-space:nowrap}
#askql .aq-go:hover{background:var(--spine-deep);border-color:var(--spine-deep)}
#askql .aq-go[disabled]{opacity:.55;cursor:default}
#askql .aq-btn{font-family:var(--sans);font-size:12.5px;font-weight:500;padding:7px 12px;border-radius:8px;border:1px solid var(--line);
  background:var(--surface);color:var(--ink-soft);cursor:pointer;white-space:nowrap}
#askql .aq-btn:hover{background:#FBFBF8;color:var(--ink)}
#askql .aq-egs{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}
#askql .aq-eg{font-family:var(--sans);font-size:12px;padding:6px 11px;border-radius:20px;border:1px solid var(--line);
  background:#FBFBF8;color:var(--ink-soft);cursor:pointer}
#askql .aq-eg:hover{border-color:var(--spine);color:var(--spine-deep);background:#F2F8F6}

#askql .aq-src{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px;padding-top:13px;border-top:1px solid var(--line-soft);
  font-size:12px;color:var(--ink-faint)}
#askql .aq-dot{width:8px;height:8px;border-radius:50%;background:var(--ink-faint);flex:0 0 auto}
#askql .aq-dot.on{background:var(--green)}
#askql .aq-src select{font-family:var(--sans);font-size:12px;padding:5px 8px;border-radius:7px;border:1px solid var(--line);
  background:var(--surface);color:var(--ink)}
#askql .aq-sp{flex:1}

#askql .aq-keyform{margin-top:12px;padding:14px;border:1px solid var(--line);border-radius:10px;background:#FBFBF8}
#askql .aq-keyform p{margin:0 0 10px;font-size:12.5px;color:var(--ink-soft);line-height:1.6;max-width:78ch}
#askql .aq-keyform input{font-family:var(--mono);font-size:12.5px;padding:9px 11px;border-radius:8px;border:1px solid var(--line);
  background:var(--surface);color:var(--ink);width:min(420px,100%)}
#askql .aq-warn{color:#8E2020}

#askql .aq-out{margin-top:18px}
#askql .aq-err{background:#FDF4F4;border:1px solid #E8CFCF;color:#8E2020;border-radius:10px;padding:14px 16px;font-size:13px;line-height:1.6}
#askql .aq-note{background:#FDFAF2;border:1px solid #EDE0C4;color:#7A5B12;border-radius:10px;padding:11px 14px;font-size:12.5px;line-height:1.6;margin-bottom:14px}
#askql .aq-note ul{margin:6px 0 0;padding-left:18px}

#askql .aq-answer{background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);padding:20px 22px}
#askql .aq-head{font-family:var(--serif);font-size:15px;font-weight:600;color:var(--ink-soft);margin:0 0 4px}
#askql .aq-fig{font-family:var(--mono);font-size:34px;font-weight:600;line-height:1.1;letter-spacing:-.02em;color:var(--ink)}
#askql .aq-fig small{font-family:var(--sans);font-size:14px;font-weight:500;color:var(--ink-soft);letter-spacing:0}
#askql .aq-sub{color:var(--ink-soft);font-size:12.5px;margin-top:7px;line-height:1.6}

#askql .aq-stats{display:flex;gap:26px;flex-wrap:wrap;margin-top:16px;padding-top:15px;border-top:1px solid var(--line-soft)}
#askql .aq-stat .k{font-family:var(--mono);font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-faint)}
#askql .aq-stat .v{font-family:var(--mono);font-size:17px;font-weight:600;margin-top:3px}

#askql .aq-filter{margin-top:16px;padding-top:15px;border-top:1px solid var(--line-soft)}
#askql .aq-flabel{font-family:var(--mono);font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:8px}
#askql .aq-chips{display:flex;gap:7px;flex-wrap:wrap}
#askql .aq-chip{font-family:var(--mono);font-size:11.5px;padding:4px 10px;border-radius:6px;background:#F2F5F4;border:1px solid #DEE7E5;color:var(--spine-deep)}
#askql details.aq-json{margin-top:11px}
#askql details.aq-json summary{font-size:12px;color:var(--ink-faint);cursor:pointer}
#askql details.aq-json pre{font-family:var(--mono);font-size:11.5px;line-height:1.55;background:#FAFAF7;border:1px solid var(--line);
  border-radius:8px;padding:12px;overflow:auto;margin:9px 0 0;color:var(--ink-soft)}

#askql .aq-tablewrap{margin-top:18px;border:1px solid var(--line);border-radius:10px;overflow:auto;max-height:62vh}
#askql table{width:100%;border-collapse:collapse;font-size:13px}
#askql thead th{position:sticky;top:0;background:#FBFBF8;border-bottom:1px solid var(--line);text-align:left;
  font-family:var(--mono);font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-faint);
  font-weight:600;padding:10px 12px;white-space:nowrap;z-index:1}
#askql tbody td{border-bottom:1px solid var(--line-soft);padding:9px 12px;vertical-align:middle}
#askql tbody tr:last-child td{border-bottom:0}
#askql tbody tr:hover td{background:#FCFCFA}
#askql td.num{text-align:right;font-family:var(--mono);font-size:12.5px;white-space:nowrap}
#askql td.dim{color:var(--ink-faint)}
#askql .aq-yes{display:inline-block;width:9px;height:9px;border-radius:3px;background:var(--green)}
#askql .aq-no{display:inline-block;width:9px;height:9px;border-radius:3px;background:#DCD9D1}
#askql .aq-meter{position:relative;height:7px;border-radius:4px;background:#EDEBE4;min-width:64px;overflow:hidden}
#askql .aq-meter i{position:absolute;inset:0 auto 0 0;border-radius:4px;display:block}
#askql .aq-foot{color:var(--ink-faint);font-size:12px;margin-top:12px;line-height:1.6}
#askql .aq-spin{width:16px;height:16px;border:2px solid var(--line);border-top-color:var(--spine);border-radius:50%;
  animation:aqspin .7s linear infinite;display:inline-block;vertical-align:-3px;margin-right:8px}
@keyframes aqspin{to{transform:rotate(360deg)}}
@media(max-width:720px){
  #askql .aq-fig{font-size:27px}
  #askql .aq-stats{gap:18px}
}
`;

function markup(){
  const egs = AD.examples.map(e => `<button class="aq-eg" type="button">${A_esc(e)}</button>`).join("");
  const models = MODELS.map(m => `<option value="${m.id}">${A_esc(m.label)}</option>`).join("");
  return `
<p class="aq-intro">Ask in plain English. The question is turned into a <b>filter</b> — a level, some titles,
some conditions — and this page runs that filter over the same live data the other tabs show.
<b>Every number below is computed here, not written by a language model.</b> The filter that ran is
always shown, so you can check the answer against the tables yourself.</p>

<div class="aq-box">
  <div class="aq-row">
    <textarea id="aqQ" rows="2" placeholder="e.g. which blocks in Sitapur have not received the Teacher Diary?"></textarea>
    <button class="aq-go" id="aqGo" type="button">Ask</button>
  </div>
  <div class="aq-egs" id="aqEgs">${egs}</div>
  <div class="aq-src">
    <span class="aq-dot" id="aqDot"></span>
    <span id="aqSrcTxt">Reading questions with the built-in parser</span>
    <select id="aqModel" style="display:none">${models}</select>
    <span class="aq-sp"></span>
    <button class="aq-btn" id="aqKeyBtn" type="button">Connect Claude</button>
  </div>
  <div class="aq-keyform" id="aqKeyForm" style="display:none">
    <p>Paste your own Anthropic API key. It is kept in this browser's local storage on this device
    and sent only to <code>api.anthropic.com</code> — it is never written into this page, this repository,
    or the backend sheet. Anyone with access to this browser profile can read it, so
    <b class="aq-warn">do not do this on a shared or public machine</b>, and use a key scoped to a workspace you
    are willing to spend from. Questions are short, so cost per question is a fraction of a paisa.</p>
    <div class="aq-row" style="gap:8px">
      <input type="password" id="aqKey" placeholder="sk-ant-..." autocomplete="off" spellcheck="false">
      <button class="aq-btn" id="aqKeySave" type="button">Save</button>
      <button class="aq-btn" id="aqKeyClear" type="button">Remove key</button>
      <button class="aq-btn" id="aqKeyHide" type="button">Close</button>
    </div>
  </div>
</div>

<div class="aq-out" id="aqOut"></div>`;
}

function chipsFor(spec, res){
  const c = [];
  const lvl = AD.levels[spec.level];
  c.push(`level: ${lvl.noun}`);
  c.push(`titles: ${spec.titles.length ? res.sel.map(t => t.short || t.label).join(" + ") : "all " + AD.titles.length}`);
  const w = spec.where;
  if(w.districts.length) c.push(`district: ${w.districts.length > 4 ? w.districts.length + " selected" : w.districts.join(", ")}`);
  if(w.blockSearch)  c.push(`block matches "${w.blockSearch}"`);
  if(w.schoolSearch) c.push(`school matches "${w.schoolSearch}"`);
  if(w.status !== "any") c.push({complete:"every selected title received", none:"nothing received", partial:"partly received"}[w.status]);
  if(w.pct) c.push("received " + ({lt:"< ",lte:"≤ ",gt:"> ",gte:"≥ "}[w.pct.op] || "") +
    (w.pct.op === "between" ? `${w.pct.value}–${w.pct.value2}%` : `${w.pct.value}% of target`));
  if(w.titleIs){
    const t = AD.titles.find(x => x.key === w.titleIs.title);
    c.push(`${t.short || t.label} ${w.titleIs.received ? "received" : "not received"}`);
  }
  if(w.titlesReceived) c.push(`titles received ${({lt:"<",lte:"≤",gt:">",gte:"≥",eq:"="})[w.titlesReceived.op]} ${w.titlesReceived.value}`);
  if(w.scanDate){
    const d = w.scanDate;
    c.push(d.op === "missing" ? "no scan date" : d.op === "present" ? "has a scan date" :
           d.op === "between" ? `scanned ${A_date(d.value)} – ${A_date(d.value2)}` : `scanned ${d.op} ${A_date(d.value)}`);
  }
  const sortLabel = {name:"name",pct:"% of target",received:"received",target:"target",gap:"shortfall",titles:"titles received",date:"scan date"}[spec.sort.by];
  c.push(`sorted by ${sortLabel}, ${spec.sort.dir === "asc" ? "lowest" : "highest"} first`);
  if(res.truncated) c.push(`showing first ${spec.limit}`);
  return c;
}

function bandColor(p){ return p > 80 ? "var(--green)" : p >= 50 ? "var(--amber)" : p > 0 ? "var(--red)" : "#D8D5CE"; }

function tableFor(spec, res){
  const lvl = AD.levels[spec.level];
  const sel = res.sel;
  const showCounts = AD.counting(spec.level) === "units";
  const head = [];
  if(spec.level === "district") head.push("District");
  if(spec.level === "block")   head.push("District","Block","Code");
  if(spec.level === "school")  head.push("District","Block","UDISE","School");
  for(const t of sel) head.push(t.short || t.label);
  if(showCounts) head.push("Target","Received");
  head.push("% of target","Scan date");

  const body = res.shown.map(({row, m}) => {
    const cells = [];
    if(spec.level === "district") cells.push(`<td>${A_esc(row.district)}</td>`);
    if(spec.level === "block")    cells.push(`<td>${A_esc(row.district)}</td><td>${A_esc(row.block)}</td><td class="num dim">${A_esc(row.code||"")}</td>`);
    if(spec.level === "school")   cells.push(`<td>${A_esc(row.district)}</td><td>${A_esc(row.block)}</td><td class="num dim">${A_esc(row.udise||"")}</td><td>${A_esc(row.school||"")}</td>`);
    for(const t of sel){
      const rv = +(row.rcv && row.rcv[t.key]) || 0;
      const tv = +(row.tgt && row.tgt[t.key]) || 0;
      cells.push(showCounts && tv > 1
        ? `<td class="num">${rv ? A_fmt(rv) : '<span class="dim">—</span>'}</td>`
        : `<td class="num"><span class="${rv > 0 ? "aq-yes" : "aq-no"}" title="${rv > 0 ? "received" : "not received"}"></span></td>`);
    }
    if(showCounts) cells.push(`<td class="num dim">${A_fmt(m.T)}</td><td class="num">${A_fmt(m.R)}</td>`);
    cells.push(`<td><div class="aq-meter" title="${m.pct.toFixed(1)}%"><i style="width:${Math.max(0,Math.min(100,m.pct)).toFixed(1)}%;background:${bandColor(m.pct)}"></i></div></td>`);
    cells.push(`<td class="num dim">${row.date ? A_date(row.date) : "—"}</td>`);
    return `<tr>${cells.join("")}</tr>`;
  }).join("");

  return `<div class="aq-tablewrap"><table>
    <thead><tr>${head.map(h => `<th>${A_esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${body || `<tr><td colspan="${head.length}" class="dim" style="padding:26px;text-align:center">No ${lvl.noun} matched this filter.</td></tr>`}</tbody>
  </table></div>`;
}

function csvFor(spec, res){
  const sel = res.sel, showCounts = AD.counting(spec.level) === "units";
  const head = [];
  if(spec.level === "district") head.push("District");
  if(spec.level === "block")    head.push("District","Block","Block Code");
  if(spec.level === "school")   head.push("District","Block","UDISE","School");
  for(const t of sel) head.push(t.label);
  head.push("Target","Received","Percent of target","Titles received","Scan date");
  const rows = res.all.map(({row, m}) => {
    const r = [];
    if(spec.level === "district") r.push(row.district);
    if(spec.level === "block")    r.push(row.district, row.block, row.code || "");
    if(spec.level === "school")   r.push(row.district, row.block, row.udise || "", row.school || "");
    for(const t of sel){
      const rv = +(row.rcv && row.rcv[t.key]) || 0;
      const tv = +(row.tgt && row.tgt[t.key]) || 0;
      r.push(showCounts && tv > 1 ? rv : (rv > 0 ? "YES" : "NO"));
    }
    r.push(m.T, m.R, m.pct.toFixed(1), `${m.nRecv} of ${m.nSel}`, row.date ? A_date(row.date) : "");
    return r;
  });
  return A_csv([head, ...rows]);
}

/* =====================================================================
   6. Wiring
   ===================================================================== */

let lastRun = null;

function getKey(){ try{ return localStorage.getItem(LS_KEY) || ""; }catch(_){ return ""; } }
function setKey(v){ try{ v ? localStorage.setItem(LS_KEY, v) : localStorage.removeItem(LS_KEY); }catch(_){} }
function getModel(){
  let m = ""; try{ m = localStorage.getItem(LS_MODEL) || ""; }catch(_){}
  return MODELS.some(x => x.id === m) ? m : MODELS[0].id;
}

function refreshSource(){
  const on = !!getKey();
  A_q("#aqDot").classList.toggle("on", on);
  A_q("#aqSrcTxt").textContent = on
    ? "Questions read by Claude · figures always computed by this page"
    : "Questions read by the built-in parser · add a key for free-form questions";
  A_q("#aqModel").style.display = on ? "" : "none";
  A_q("#aqModel").value = getModel();
  A_q("#aqKeyBtn").textContent = on ? "Claude connected" : "Connect Claude";
  const inp = A_q("#aqKey");
  if(inp) inp.value = "";
}

function render(html){ A_q("#aqOut").innerHTML = html; }

function renderResult(question, spec, res, meta){
  const lvl = AD.levels[spec.level];
  const notes = [];
  if(meta.warn && meta.warn.length) notes.push(...meta.warn);
  if(meta.source === "local" && !meta.confident)
    notes.push("The built-in parser could not pin this question down, so it fell back to a broad filter. Connect a Claude key for free-form questions, or use one of the example phrasings.");

  /* The denominator names the places the question actually asked about. A tracker's
     district list and its school master can disagree on capitalisation, so prefer
     whatever spelling the matched rows themselves carry — that is what the table
     below will show, and the two should not read as different places. */
  let scopeName = spec.where.districts[0] || "";
  if(scopeName && res.shown.length) scopeName = res.shown[0].row.district || scopeName;
  const scopeWord = spec.where.districts.length === 1 ? ` in ${A_esc(scopeName)}`
                  : spec.where.districts.length > 1 ? ` in the ${spec.where.districts.length} districts selected`
                  : "";
  const head = `${A_esc(lvl.label)} matching this filter`;
  const noun = A_esc(res.matched === 1 && !res.narrowed ? lvl.one : lvl.noun);
  const outOf = (spec.aggregate === "count" || res.narrowed)
    ? `of ${A_fmt(res.scoped)} ${noun}${scopeWord}`
    : noun;
  const fig = `${A_fmt(res.matched)} <small>${outOf}${
    res.truncated ? ` · showing ${A_fmt(res.shown.length)}` : ""}</small>`;

  const stats = [
    {k:"Target",   v:A_fmt(res.totals.T)},
    {k:"Received", v:A_fmt(res.totals.R)},
    {k:"Of target",v:res.totals.T > 0 ? res.totals.pct.toFixed(1) + "%" : "—"},
    {k:"Shortfall",v:A_fmt(res.totals.gap)}
  ].map(s => `<div class="aq-stat"><div class="k">${s.k}</div><div class="v">${s.v}</div></div>`).join("");

  const chips = chipsFor(spec, res).map(c => `<span class="aq-chip">${A_esc(c)}</span>`).join("");

  const provenance = meta.source === "claude"
    ? `Filter written by ${A_esc(meta.model || getModel())}; all figures computed on this page from ${A_esc(AD.freshness())}.`
    : `Filter written by the built-in parser; all figures computed on this page from ${A_esc(AD.freshness())}.`;

  render(`
    ${notes.length ? `<div class="aq-note"><b>Worth knowing</b><ul>${notes.map(n => `<li>${A_esc(n)}</li>`).join("")}</ul></div>` : ""}
    <div class="aq-answer">
      <p class="aq-head">${head}</p>
      <div class="aq-fig">${fig}</div>
      ${spec.restatement ? `<p class="aq-sub">${A_esc(spec.restatement)}</p>` : ""}
      <div class="aq-stats">${stats}</div>
      <div class="aq-filter">
        <div class="aq-flabel">The filter that ran</div>
        <div class="aq-chips">${chips}</div>
        <details class="aq-json"><summary>Show it as JSON</summary><pre>${A_esc(JSON.stringify(specForDisplay(spec), null, 2))}</pre></details>
      </div>
      ${spec.aggregate === "count" && res.matched === 0 ? "" : tableFor(spec, res)}
      <div class="aq-row" style="margin-top:14px;align-items:center">
        <button class="aq-btn" id="aqExport" type="button">Export these ${A_fmt(res.matched)} rows to CSV</button>
        <span class="aq-sp"></span>
      </div>
      <p class="aq-foot">${provenance}</p>
    </div>`);

  const ex = A_q("#aqExport");
  if(ex) ex.addEventListener("click", () => {
    const stamp = new Date().toISOString().slice(0,10);
    A_download(`ask-${spec.level}-${stamp}.csv`, csvFor(spec, res));
  });
}

/* Dates live in the spec as Date objects; show them back as the ISO the model wrote. */
function specForDisplay(spec){
  const c = JSON.parse(JSON.stringify(spec, (k,v) => v instanceof Date ? toIso(v) : v));
  return c;
}

async function ask(){
  const question = A_q("#aqQ").value.trim();
  if(!question) return;
  const go = A_q("#aqGo");
  go.disabled = true;
  render(`<div class="aq-answer"><span class="aq-spin"></span>Working out which rows to look at…</div>`);

  try{
    const ready = await AD.ready();
    if(!ready) throw new Error("The underlying data has not loaded yet. Wait for the other tabs to fill in, then ask again.");

    const key = getKey();
    let raw, source, confident = true, model = "";
    if(key){
      const r = await translateWithClaude(question, key, getModel());
      raw = r.raw; source = "claude"; model = r.model;
    } else {
      const r = parseLocally(question);
      raw = r.spec; source = "local"; confident = r.confident;
    }

    const {spec, warn} = coerceSpec(raw);
    const rows = await AD.rows(spec.level);
    const res = execute(rows, spec);
    lastRun = {question, spec, res};
    renderResult(question, spec, res, {source, warn, confident, model});
  }catch(e){
    render(`<div class="aq-err"><b>That question did not run.</b><br>${A_esc(e.message || String(e))}</div>`);
  }finally{
    go.disabled = false;
  }
}

function init(adapter){
  AD = adapter;
  const host = document.getElementById("askql");
  if(!host) return;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  host.innerHTML = markup();

  A_q("#aqGo").addEventListener("click", ask);
  A_q("#aqQ").addEventListener("keydown", e => {
    if(e.key === "Enter" && (e.metaKey || e.ctrlKey)){ e.preventDefault(); ask(); }
  });
  A_q("#aqEgs").addEventListener("click", e => {
    const b = e.target.closest(".aq-eg");
    if(!b) return;
    A_q("#aqQ").value = b.textContent;
    ask();
  });
  A_q("#aqKeyBtn").addEventListener("click", () => {
    const f = A_q("#aqKeyForm");
    f.style.display = f.style.display === "none" ? "" : "none";
    if(f.style.display === "") A_q("#aqKey").focus();
  });
  A_q("#aqKeyHide").addEventListener("click", () => { A_q("#aqKeyForm").style.display = "none"; });
  A_q("#aqKeySave").addEventListener("click", () => {
    const v = A_q("#aqKey").value.trim();
    if(!v) return;
    setKey(v); refreshSource(); A_q("#aqKeyForm").style.display = "none";
  });
  A_q("#aqKeyClear").addEventListener("click", () => { setKey(""); refreshSource(); });
  A_q("#aqModel").addEventListener("change", e => {
    try{ localStorage.setItem(LS_MODEL, e.target.value); }catch(_){}
  });
  refreshSource();
}

return {init, execute, coerceSpec, parseLocally, blankSpec, jsonSchema};
})();
/* ==================== ASKQL END ==================== */
