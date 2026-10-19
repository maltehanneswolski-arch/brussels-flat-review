"use strict";

const GN = [50.86038, 4.36009]; // Gare du Nord
const CATS = [
  {k: "fit", label: "Dec–Jan"},
  {k: "ask", label: "Date not given"},
  {k: "later", label: "February"},
  {k: "early", label: "Free before mid-Nov"}
];
const CAT_ORDER = {fit: 0, ask: 1, later: 2, early: 3};
const CONFIG = window.FLAT_REVIEW_CONFIG || {};

// ---------- small helpers ----------
const $ = (s) => document.querySelector(s);
const euro = (n) => "€" + n.toLocaleString("en-US");
const total = (x) => x.rent == null ? null : x.rent + (x.charges || 0);
const priceText = (x) => x.rent == null ? "Ask price" : euro(total(x));

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
function store(key, value) {
  try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch { return null; }
  return value;
}
function distKm(lat, lng) {
  const t = Math.PI / 180;
  const dx = (lng - GN[1]) * t * Math.cos(((lat + GN[0]) / 2) * t);
  const dy = (lat - GN[0]) * t;
  return 6371 * Math.sqrt(dx * dx + dy * dy);
}
function catOf(x, checked) {
  const a = x.available;
  if (!a || a === "TO_BE_DEFINED") return "ask";
  if (a === "IMMEDIATELY" || a < "2026-11-15" || a <= checked) return "early";
  if (a <= "2027-01-31") return "fit";
  return "later";
}
function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  const s = d.toLocaleDateString("en-GB", {day: "numeric", month: "short"});
  return d.getFullYear() !== 2026 ? s + " " + d.getFullYear() : s;
}
function whenLabel(x) {
  if (x.cat === "ask") return "Ask for date";
  if (x.cat === "early") return x.available === "IMMEDIATELY" ? "Free now" : "From " + fmtDate(x.available);
  return "From " + fmtDate(x.available);
}
function floorLabel(f) {
  if (f == null) return null;
  if (f === 0) return "ground floor";
  const s = f === 1 ? "st" : f === 2 ? "nd" : f === 3 ? "rd" : "th";
  return f + s + " floor";
}

// ---------- who is using the page: Malte or Lilly (remembered in this browser) ----------
// A fixed id per person, so votes and steps from a phone and a laptop count as the same person.
const PEOPLE = {
  malte: {name: "Malte", id: "6d616c74-6500-4000-8000-000000000001"},
  lilly: {name: "Lilly", id: "6c696c6c-7900-4000-8000-000000000002"}
};
let person = PEOPLE[store("flat-review:person")] ? store("flat-review:person") : null;
const me = {
  get id() { return person ? PEOPLE[person].id : null; },
  get name() { return person ? PEOPLE[person].name : ""; }
};
// Older rows used a random id per browser; the name is what identifies a person now.
const personKey = (r) => (r.reviewer_name || "").trim().toLowerCase() || r.reviewer_id;
const isMe = (r) => !!person && personKey(r) === person;
function renderWhoami() {
  for (const b of document.querySelectorAll("#whoami [data-person]")) b.setAttribute("aria-checked", String(b.dataset.person === person));
  $("#whoami").classList.remove("need");
  document.documentElement.classList.toggle("lilly", person === "lilly"); // Lilly's view has a slight purple tint
}
for (const b of document.querySelectorAll("#whoami [data-person]")) b.addEventListener("click", () => {
  person = b.dataset.person;
  store("flat-review:person", person);
  loadSeen();
  renderWhoami();
  state.byFlat = aggregate(state.rows);
  renderAll();
  toast(`Hi ${PEOPLE[person].name}!`);
});
renderWhoami();
function needPerson(what) {
  if (person) return false;
  $("#whoami").classList.add("need");
  $("#whoami").scrollIntoView({block: "nearest", behavior: "smooth"});
  toast(`Pick Malte or Lilly at the top first, so the other knows who ${what}.`);
  return true;
}

// ---------- review storage ----------
// Shared mode: Supabase REST (see supabase/schema.sql). Otherwise reviews stay in this browser.
function supabaseStore(url, key) {
  const base = url.replace(/\/+$/, "") + "/rest/v1/reviews";
  const headers = {apikey: key};
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key; // legacy anon JWT
  return {
    shared: true,
    async load() {
      const r = await fetch(base + "?select=flat_id,reviewer_id,reviewer_name,verdict,comment,created_at&order=created_at.asc&limit=10000", {headers});
      if (!r.ok) throw new Error("load " + r.status);
      return r.json();
    },
    async add(row) {
      const r = await fetch(base, {method: "POST", headers: {...headers, "Content-Type": "application/json", Prefer: "return=minimal"}, body: JSON.stringify(row)});
      if (!r.ok) throw new Error("save " + r.status);
    }
  };
}
function localStore() {
  const KEY = "flat-review:rows";
  const read = () => { try { return JSON.parse(store(KEY) || "[]"); } catch { return []; } };
  return {
    shared: false,
    async load() { return read(); },
    async add(row) { const rows = read(); rows.push({...row, created_at: new Date().toISOString()}); store(KEY, JSON.stringify(rows)); }
  };
}
const db = CONFIG.supabaseUrl && CONFIG.supabaseKey ? supabaseStore(CONFIG.supabaseUrl, CONFIG.supabaseKey) : localStore();

// Progress of shortlisted flats (supabase/progress.sql): one row per step, the latest wins.
function supabaseProgress(url, key) {
  const base = url.replace(/\/+$/, "") + "/rest/v1/progress";
  const headers = {apikey: key};
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
  return {
    shared: true,
    async load() {
      const r = await fetch(base + "?select=flat_id,stage,note,happens_at,reviewer_id,reviewer_name,created_at&order=created_at.asc&limit=10000", {headers});
      if (r.status === 404 || r.status === 400) { const e = new Error("missing table"); e.missing = true; throw e; }
      if (!r.ok) throw new Error("load " + r.status);
      return r.json();
    },
    async add(row) {
      const r = await fetch(base, {method: "POST", headers: {...headers, "Content-Type": "application/json", Prefer: "return=minimal"}, body: JSON.stringify(row)});
      if (!r.ok) throw new Error("save " + r.status);
    }
  };
}
function localProgress() {
  const KEY = "flat-review:progress";
  const read = () => { try { return JSON.parse(store(KEY) || "[]"); } catch { return []; } };
  return {
    shared: false,
    async load() { return read(); },
    async add(row) { const rows = read(); rows.push({...row, created_at: new Date().toISOString()}); store(KEY, JSON.stringify(rows)); }
  };
}
const progressDb = CONFIG.supabaseUrl && CONFIG.supabaseKey ? supabaseProgress(CONFIG.supabaseUrl, CONFIG.supabaseKey) : localProgress();

// ---------- state ----------
const TABS = {all: "all", shortlist: "short", short: "short", contact: "contact"};
const state = {
  flats: [], areas: [], checked: "2026-10-16",
  areaOn: new Set(), cats: new Set(["fit", "ask", "later"]), furn: new Set(["f", "u"]),
  gnKm: 1, sort: "new", selected: null, onlyNew: false,
  rows: [], byFlat: {}, lastSync: null, syncError: false, status: {},
  tab: TABS[location.hash.slice(1)] || "all",
  progressRows: [], progress: {}, progressReady: true
};

function aggregate(rows) {
  const by = {};
  for (const r of rows) {
    const f = by[r.flat_id] || (by[r.flat_id] = {});
    f[personKey(r)] = r; // rows arrive oldest first, so the latest one per person wins
  }
  const out = {};
  for (const [flat, people] of Object.entries(by)) {
    const list = Object.values(people);
    out[flat] = {
      yes: list.filter((r) => r.verdict === "yes" || r.verdict === "super"), // a super yes is a yes too
      super: list.filter((r) => r.verdict === "super"),
      no: list.filter((r) => r.verdict === "no"),
      comments: list.filter((r) => r.comment).sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "")),
      mine: person ? people[person] || null : null
    };
  }
  return out;
}
const rev = (id) => state.byFlat[id] || {yes: [], super: [], no: [], comments: [], mine: null};
const score = (id) => { const r = rev(id); return r.yes.length + r.super.length - r.no.length; }; // a super yes counts twice

function aggregateProgress(rows) {
  const out = {};
  for (const r of rows) (out[r.flat_id] ||= []).push(r); // oldest first
  return out;
}
// Where a flat stands: latest progress step, or "to_contact" once someone said Yes
function stageOf(x) {
  const steps = state.progress[x.id];
  if (steps?.length) return steps[steps.length - 1].stage;
  return rev(x.id).yes.length ? "to_contact" : null;
}
const SHORT_STAGES = new Set(["to_contact", "contacted"]);
const CONTACT_STAGES = new Set(["heard_back", "viewing", "viewed", "applied", "signed"]);
const inShort = (x) => SHORT_STAGES.has(stageOf(x));
const inContact = (x) => CONTACT_STAGES.has(stageOf(x));

async function refresh() {
  try {
    state.rows = await db.load();
    state.byFlat = aggregate(state.rows);
    state.lastSync = new Date();
    state.syncError = false;
  } catch (e) {
    state.syncError = true;
  }
  try {
    state.progressRows = await progressDb.load();
    state.progress = aggregateProgress(state.progressRows);
    state.progressReady = true;
  } catch (e) {
    if (e.missing) state.progressReady = false;
  }
  renderAll();
}

async function addProgress(x, stage, note = "", happensAt = "", msg = "") {
  if (needPerson("did this")) return false;
  if (!state.progressReady) { toast("Progress can't be saved yet: the progress table isn't set up (see the banner)."); return false; }
  const row = {flat_id: x.id, stage, note: note.trim().slice(0, 500), happens_at: happensAt.slice(0, 40), reviewer_id: me.id, reviewer_name: me.name};
  state.progressRows = [...state.progressRows, {...row, created_at: new Date().toISOString()}];
  state.progress = aggregateProgress(state.progressRows);
  renderAll();
  try {
    await progressDb.add(row);
    toast(msg || STAGE[stage].done);
    if (progressDb.shared) refresh();
    return true;
  } catch (e) {
    toast("Couldn't save that. Check your connection and try again.");
    refresh();
    return false;
  }
}

async function vote(x, verdict) {
  if (needPerson("voted")) return;
  const cur = rev(x.id).mine;
  const next = cur?.verdict === verdict ? "none" : verdict;
  const row = {flat_id: x.id, reviewer_id: me.id, reviewer_name: me.name, verdict: next, comment: cur?.comment || ""};
  await save(row, {none: "Vote removed.", yes: "Marked Yes.", super: "Marked Super yes!", no: "Marked No."}[next]);
}
async function comment(x, text) {
  if (needPerson("wrote this")) return false;
  const cur = rev(x.id).mine;
  const row = {flat_id: x.id, reviewer_id: me.id, reviewer_name: me.name, verdict: cur?.verdict || "none", comment: text.trim().slice(0, 500)};
  return save(row, row.comment ? "Comment posted." : "Comment removed.");
}
async function save(row, okMsg) {
  // show it straight away, then confirm with the server
  state.rows = [...state.rows, {...row, created_at: new Date().toISOString()}];
  state.byFlat = aggregate(state.rows);
  renderAll();
  try {
    await db.add(row);
    toast(okMsg);
    if (db.shared) refresh();
    return true;
  } catch (e) {
    // the database refuses "super" until supabase/super-yes.sql has been run once
    toast(row.verdict === "super" && e.message === "save 400"
      ? "Super yes needs a one-time database update: run supabase/super-yes.sql in the Supabase SQL Editor."
      : "Couldn't save that. Check your connection and try again.");
    refresh();
    return false;
  }
}

// Flats the daily search added in the last 2 days show in purple, until you've voted on them.
function addedRecently(x) {
  if (!x.added) return false;
  const days = (Date.now() - new Date(x.added + "T00:00:00").getTime()) / 86400000;
  return days >= 0 && days < 2;
}
const isNew = (x) => addedRecently(x) && !votedByMe(x);

// What's new to you: flats that weren't on the map at your last visit (per person, in this browser).
// A visit ends after an hour away, so a reload doesn't wipe the list.
// On a first visit there is nothing to compare with, so it falls back to "added in the last 2 days".
const VISIT_GAP = 3600e3;
let seenRec = {};
let seenBefore = null;
let lastVisitAt = null;
const seenKey = () => "flat-review:seen:" + (person || "anyone");
function loadSeen() {
  try { seenRec = JSON.parse(store(seenKey()) || "null") || {}; } catch { seenRec = {}; }
  if (seenRec.latest && Date.now() - new Date(seenRec.latest.at) > VISIT_GAP) seenRec.base = seenRec.latest;
  seenBefore = seenRec.base ? new Set(seenRec.base.ids) : null;
  lastVisitAt = seenRec.base?.at || null;
}
function saveSeen() {
  if (!state.flats.length) return;
  seenRec.latest = {at: new Date().toISOString(), ids: state.flats.map((f) => f.id)};
  store(seenKey(), JSON.stringify(seenRec));
}
const isUnseen = (x) => (seenBefore ? !seenBefore.has(x.id) : addedRecently(x)) && !votedByMe(x); // voting on a flat means you've seen it
document.addEventListener("visibilitychange", () => { if (document.hidden) saveSeen(); });
window.addEventListener("pagehide", saveSeen);

// ---------- filters ----------
function visible(x) {
  if (state.tab === "short") return inShort(x);
  if (state.tab === "contact") return inContact(x);
  if (state.onlyNew) return isUnseen(x);
  if (!state.areaOn.has(x.area)) return false;
  if (!state.cats.has(x.cat) && !isNew(x) && !isUnseen(x)) return false; // new flats show whatever their start date
  if (!state.furn.has(x.furnished === true ? "f" : "u")) return false;
  if (x.d != null && x.d < state.gnKm) return false;
  return true;
}
function sorted(list) {
  const by = {
    new: (a, b) => (isUnseen(b) - isUnseen(a)) || (isNew(b) - isNew(a)) || (score(b.id) - score(a.id)) || (CAT_ORDER[a.cat] - CAT_ORDER[b.cat]) || ((total(a) ?? 1e9) - (total(b) ?? 1e9)),
    score: (a, b) => (score(b.id) - score(a.id)) || (isNew(b) - isNew(a)) || (CAT_ORDER[a.cat] - CAT_ORDER[b.cat]) || ((total(a) ?? 1e9) - (total(b) ?? 1e9)),
    price: (a, b) => ((total(a) ?? 1e9) - (total(b) ?? 1e9)),
    date: (a, b) => (CAT_ORDER[a.cat] - CAT_ORDER[b.cat]) || String(a.available || "z").localeCompare(String(b.available || "z"))
  }[state.sort];
  // flats you've already voted on go to the bottom, so the top of the list is what you still have to decide
  return list.slice().sort((a, b) => (votedByMe(a) - votedByMe(b)) || by(a, b));
}
const votedByMe = (x) => { const v = rev(x.id).mine?.verdict; return v && v !== "none" ? 1 : 0; };

function renderChips() {
  const area = $("#f-area"); area.replaceChildren();
  state.areas.forEach((a) => area.append(el("button", {type: "button", class: "chip", "aria-pressed": String(state.areaOn.has(a)),
    onclick: () => { state.areaOn.has(a) ? state.areaOn.delete(a) : state.areaOn.add(a); renderAll(); }},
    a, el("span", {class: "n"}, state.flats.filter((x) => x.area === a).length))));
  const when = $("#f-when"); when.replaceChildren();
  CATS.forEach((c) => when.append(el("button", {type: "button", class: "chip", "aria-pressed": String(state.cats.has(c.k)),
    onclick: () => { state.cats.has(c.k) ? state.cats.delete(c.k) : state.cats.add(c.k); renderAll(); }},
    el("span", {class: "sw " + c.k}), c.label, el("span", {class: "n"}, state.flats.filter((x) => x.cat === c.k).length))));
  const furn = $("#f-furn"); furn.replaceChildren();
  [{k: "f", label: "Furnished"}, {k: "u", label: "Unfurnished"}].forEach((c) => furn.append(el("button", {type: "button", class: "chip", "aria-pressed": String(state.furn.has(c.k)),
    onclick: () => { state.furn.has(c.k) ? state.furn.delete(c.k) : state.furn.add(c.k); renderAll(); }}, c.label)));
  renderFilterSummary();
}
// The one-line summary shown while the filter panel is folded
function renderFilterSummary() {
  const areas = state.areaOn.size === state.areas.length ? "All areas" : state.areaOn.size ? [...state.areaOn].join(", ") : "No area";
  const dates = CATS.filter((c) => state.cats.has(c.k)).map((c) => c.label).join(", ") || "no start date";
  const furn = state.furn.size === 2 ? "furnished or not" : state.furn.has("f") ? "furnished only" : state.furn.has("u") ? "unfurnished only" : "no furnishing";
  const gn = state.gnKm ? `not within ${state.gnKm.toFixed(1)} km of Gare du Nord` : null;
  $("#f-summary").textContent = [areas, dates, furn, gn].filter(Boolean).join(" · ");
}

// The strip on top of the list: what's new to you, with a one-tap filter
function renderNewStrip() {
  const strip = $("#newstrip");
  const unseen = state.flats.filter(isUnseen);
  const last = lastVisitAt && new Date(lastVisitAt);
  const since = !last ? "in the last 2 days"
    : last.toDateString() === new Date().toDateString() ? "since your last visit at " + last.toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit"})
    : "since your last visit on " + last.toLocaleDateString("en-GB", {weekday: "short", day: "numeric", month: "short"});
  strip.hidden = false;
  if (!unseen.length) {
    state.onlyNew = false;
    strip.classList.add("quiet");
    strip.replaceChildren(el("span", {}, `Nothing new ${since}.`));
    return;
  }
  strip.classList.remove("quiet");
  const byArea = {};
  unseen.forEach((x) => { byArea[x.area] = (byArea[x.area] || 0) + 1; });
  const where = Object.entries(byArea).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${n} in ${a}`).join(", ");
  strip.replaceChildren(
    el("span", {class: "nsum"}, el("b", {}, `${unseen.length} new`), ` ${since}: ${where}.`),
    el("button", {type: "button", class: "btn " + (state.onlyNew ? "primary" : "ghost"), "aria-pressed": String(state.onlyNew),
      onclick: () => { state.onlyNew = !state.onlyNew; renderAll(); setTimeout(fitVisible, 0); }}, state.onlyNew ? "Show all flats" : "Show only these"));
}

function renderStatusLine() {
  const time = (d) => d.toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit"});
  $("#status-line").textContent = `${state.flats.length} flats · checked ${fmtDate(state.checked)}` +
    (state.syncError ? " · couldn't load votes, retrying" : db.shared && state.lastSync ? ` · votes updated ${time(state.lastSync)}` : "");
}

// ---------- cards ----------
function voteRow(x) {
  const r = rev(x.id);
  const mine = r.mine?.verdict;
  return el("div", {class: "vote"},
    el("div", {class: "vbtns", role: "group", "aria-label": "Your vote"},
      el("button", {type: "button", class: "vb super", "aria-pressed": String(mine === "super"), onclick: (e) => { e.stopPropagation(); vote(x, "super"); }}, "★ Super yes", el("span", {class: "n"}, r.super.length)),
      el("button", {type: "button", class: "vb yes", "aria-pressed": String(mine === "yes"), onclick: (e) => { e.stopPropagation(); vote(x, "yes"); }}, "Yes", el("span", {class: "n"}, r.yes.length - r.super.length)),
      el("button", {type: "button", class: "vb no", "aria-pressed": String(mine === "no"), onclick: (e) => { e.stopPropagation(); vote(x, "no"); }}, "No", el("span", {class: "n"}, r.no.length))
    ),
    el("a", {class: "link", href: x.url, target: "_blank", rel: "noopener"}, "Open on " + x.source + " ↗")
  );
}
function whoLine(x) {
  const r = rev(x.id);
  if (!r.yes.length && !r.no.length) return null;
  const names = (list) => list.map((p) => isMe(p) ? "you" : p.reviewer_name).join(", ");
  const plainYes = r.yes.filter((p) => p.verdict === "yes");
  return el("div", {class: "who"}, [
    r.super.length ? [el("b", {class: "s"}, "★ Super yes: "), names(r.super)] : null,
    plainYes.length ? [el("b", {class: "y"}, "Yes: "), names(plainYes)] : null,
    r.no.length ? [el("b", {class: "x"}, "No: "), names(r.no)] : null
  ].filter(Boolean).flatMap((part, i) => (i ? [" · ", part] : [part])));
}
// Status from the daily check of flats with a Yes vote (monitor/check.mjs)
function watchLine(x) {
  const w = state.status[x.id];
  if (!w) return null;
  const when = (d) => d ? fmtDate(d) : "?";
  const text = {
    online: `Watching: still online, checked ${when(w.checked)}`,
    "under-option": `Under option since ${when(w.since)}: someone else is ahead`,
    removed: `Listing removed since ${when(w.since)}, probably rented`,
    unknown: `Watching: last check failed (${when(w.checked)})`
  }[w.status];
  const extra = [];
  if (w.status !== "removed" && w.rent != null && x.rent != null && w.rent !== x.rent) extra.push(`rent now ${euro(w.rent)}`);
  if (w.status !== "removed" && w.available && x.available && w.available !== x.available) extra.push(`start now ${/^\d{4}-/.test(w.available) ? fmtDate(w.available) : {IMMEDIATELY: "free now", TO_BE_DEFINED: "to be agreed"}[w.available] || "to be agreed"}`);
  return el("div", {class: "watch " + w.status}, text, extra.length ? " · " + extra.join(" · ") : null);
}

// Can you register your address there (domiciliation)? Read from the listing text (monitor/domicile.mjs); most listings don't say.
// domicileNote is an English sentence written by hand; the listing's own words (domicileQuote) aren't shown.
const DOMICILE = {
  yes: {label: "Domiciliation possible", row: "Possible"},
  no: {label: "No domiciliation", row: "Not allowed"},
  unknown: {label: "Domiciliation not stated", row: "Not stated in the listing. Ask them."}
};
const domOf = (x) => (x.domicile === "yes" || x.domicile === "no" ? x.domicile : "unknown");
function domBadge(x) {
  const d = domOf(x);
  return el("span", {class: "dom " + d, title: x.domicileNote || (d === "unknown" ? "The listing doesn't say whether you can register your address there." : null)}, DOMICILE[d].label);
}

function card(x) {
  const sel = state.selected === x.id;
  const r = rev(x.id);
  const facts = [
    x.area,
    x.furnished === true ? "Furnished" : x.furnished === false ? "Unfurnished" : "Furnishing not stated",
    x.bedrooms === 0 ? "studio" : x.bedrooms ? x.bedrooms + (x.bedrooms > 1 ? " bedrooms" : " bedroom") : null,
    x.m2 ? x.m2 + " m²" : null,
    floorLabel(x.floor),
    x.lift ? "lift" : null,
    x.terrace === true ? "terrace" : x.terrace ? "terrace " + x.terrace + " m²" : null,
    x.garden ? "garden" : null,
    x.d != null ? x.d.toFixed(1) + " km from Gare du Nord" : null
  ].filter(Boolean);
  let ta;
  const fresh = isNew(x);
  return el("article", {class: "card" + (sel ? " sel" : "") + (fresh ? " new" : ""), role: "listitem", id: "card-" + x.id},
    el("div", {class: "chead"},
      el("div", {class: "ctitle"},
        el("span", {class: "price"}, priceText(x), " ", el("small", {}, x.rent == null ? "price and dates on request" : x.units ? "cheapest unit that fits, bills usually extra" : x.charges ? `${euro(x.rent)} rent + ${euro(x.charges)} charges` : "rent, charges not stated")),
        el("h3", {class: "street"}, el("button", {class: "selbtn", type: "button", "aria-expanded": String(sel), onclick: () => select(x.id)}, x.street))
      ),
      el("span", {class: "tags"},
        fresh ? el("span", {class: "newtag", title: "Found by the daily search on " + fmtDate(x.added)}, "New " + fmtDate(x.added)) : null,
        el("span", {class: "when " + x.cat}, whenLabel(x)))
    ),
    el("div", {class: "facts"}, facts.join(" · "), x.epc ? el("span", {class: "peb " + x.epc, title: "Energy class (PEB) " + x.epc}, "PEB " + x.epc) : null, domBadge(x)),
    watchLine(x),
    x.description || x.warning || x.lat == null ? el("p", {class: "desc"}, x.description,
      x.warning ? [" ", el("span", {class: "warn"}, x.warning)] : null,
      x.lat == null ? [" ", el("em", {}, "Address not given, so no map pin.")] : null) : null,
    x.units ? el("ul", {class: "units", "aria-label": "Units that fit two people"}, x.units.map((u) => el("li", {}, u))) : null,
    x.kind === "vista" ? el("div", {class: "contact"}, "Ask Vista for prices and free dates: ", el("span", {}, "0478 555 620"), " · ", el("span", {}, "info@vistaresidences.org")) : null,
    voteRow(x),
    whoLine(x),
    r.comments.length ? el("ul", {class: "comments", "aria-label": "Comments"}, r.comments.map((c) =>
      el("li", {}, el("b", {}, (isMe(c) ? "You" : c.reviewer_name) + ": "), c.comment))) : null,
    sel ? el("form", {class: "cform", onsubmit: async (e) => { e.preventDefault(); if (await comment(x, ta.value)) ta.value = ""; }},
      (ta = el("textarea", {id: "comment-" + x.id, maxlength: "500", placeholder: r.mine?.comment ? "Change your comment (empty removes it)" : "Your comment: nice street, too small, call the agent…", "aria-label": "Your comment on " + x.street})),
      el("button", {type: "submit"}, r.mine?.comment ? "Update comment" : "Post comment")) : null
  );
}

function renderList() {
  const list = $("#list");
  const vis = sorted(state.flats.filter(visible));
  const hidden = state.onlyNew ? 0 : state.flats.filter((x) => x.d != null && x.d < state.gnKm && state.areaOn.has(x.area)).length;
  $("#count").textContent = `${vis.length} of ${state.flats.length} flats` + (hidden ? ` · ${hidden} hidden near Gare du Nord` : "");
  renderNewStrip();
  const voted = vis.filter(votedByMe).length;
  const items = vis.map(card);
  if (voted && voted < vis.length) items.splice(vis.length - voted, 0, el("div", {class: "listsep", role: "listitem"}, `Already voted by you (${voted})`));
  keepTyping(list, () => list.replaceChildren(...(vis.length ? items : [el("div", {class: "empty"}, "No flats match these filters. Turn an area or start date back on.")])));
}

// ---------- Shortlist and In contact tabs ----------
const STAGE = {
  to_contact: {label: "To contact", pin: "to contact", done: "Back on the shortlist."},
  contacted: {label: "Contacted, waiting for a reply", pin: "waiting", done: "Marked as contacted."},
  heard_back: {label: "Heard back", pin: "replied", done: "They answered: moved to In contact."},
  viewing: {label: "Viewing booked", pin: "viewing", done: "Viewing saved."},
  viewed: {label: "Visited", pin: "visited", done: "Marked as visited."},
  applied: {label: "Application sent", pin: "applied", done: "Application noted."},
  signed: {label: "Lease signed", pin: "signed", done: "Lease signed. Congratulations!"},
  dropped: {label: "Not going ahead", pin: "dropped", done: "Moved to Not going ahead."}
};
const STEPPER = ["heard_back", "viewing", "viewed", "applied", "signed"];
state.msgOpen = new Set();
state.msgLang = {};

function contactOf(x) {
  const c = state.status[x.id]?.contact;
  if (c) return c;
  if (x.kind === "vista") return {who: "Vista Residences", kind: "agency", phones: ["0478 55 56 20"], emails: ["info@vistaresidences.org"], website: "https://www.vistaresidences.org", form: null};
  if (x.kind === "spotahome") return {who: "Spotahome", kind: "platform", phones: [], emails: [], website: "https://www.spotahome.com", form: x.url, formLabel: "Book or ask a question on the Spotahome listing"};
  const portal = x.source === "Immoweb" || x.source === "Immovlan";
  return {who: portal ? null : x.source, kind: portal ? null : "agency", phones: [], emails: [], website: null, form: x.url, formLabel: `Contact form on the ${x.source} listing`, pending: true};
}
function fmtWhen(s) {
  if (!s) return "";
  const d = new Date(s);
  if (isNaN(d)) return s;
  return d.toLocaleDateString("en-GB", {weekday: "short", day: "numeric", month: "short"}) + (s.includes("T") ? ", " + d.toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit"}) : "");
}
const fmtStamp = (iso) => new Date(iso).toLocaleDateString("en-GB", {day: "numeric", month: "short"});
const lastStep = (x) => { const s = state.progress[x.id]; return s?.length ? s[s.length - 1] : null; };

function factsGrid(x) {
  const rows = [
    ["Price", x.rent == null ? "On request" : x.units ? `${euro(x.rent)} a month for the cheapest unit that fits, bills usually extra` : `${euro(total(x))} a month (${euro(x.rent)} rent${x.charges ? ` + ${euro(x.charges)} charges` : ", charges not stated"})`],
    ["Size", x.m2 ? x.m2 + " m²" : "Not given"],
    ["Rooms", x.bedrooms === 0 ? "Studio" : x.bedrooms ? `${x.bedrooms} bedroom${x.bedrooms > 1 ? "s" : ""}` : "Not given"],
    ["Furnished", x.furnished === true ? "Yes" : x.furnished === false ? "No" : "Not stated"],
    ["Start", whenLabel(x)],
    ["Location", [x.street, x.area, x.d != null ? x.d.toFixed(1) + " km from Gare du Nord" : null].filter(Boolean).join(" · ")],
    x.floor != null ? ["Floor", floorLabel(x.floor) + (x.lift ? ", lift" : "")] : null,
    x.epc ? ["Energy", "PEB " + x.epc] : null,
    ["Domiciliation", el("span", {class: "domrow " + domOf(x)}, DOMICILE[domOf(x)].row, x.domicileNote ? el("span", {class: "domnote"}, x.domicileNote) : null)],
    x.terrace || x.garden ? ["Outside", [x.terrace === true ? "terrace" : x.terrace ? `terrace ${x.terrace} m²` : null, x.garden ? "garden" : null].filter(Boolean).join(", ")] : null
  ].filter(Boolean);
  return el("dl", {class: "kv"}, rows.map(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
}

function contactBox(x) {
  const c = contactOf(x);
  const kind = {agency: "agency", platform: "booking platform"}[c.kind];
  const tel = (p) => "tel:" + p.replace(/\s/g, "").replace(/^0/, "+32");
  return el("div", {class: "contactbox"},
    el("div", {class: "cb-title"}, "How to reach them"),
    el("p", {}, c.who ? [el("strong", {}, c.who), kind ? ` (${kind})` : "", ` · listed on ${x.source}`] : `Listed on ${x.source}`),
    c.phones?.length ? el("p", {}, "Call ", c.phones.map((p, i) => [i ? " or " : "", el("a", {href: tel(p)}, p)])) : null,
    c.emails?.length ? el("p", {}, "Email ", c.emails.map((m, i) => [i ? ", " : "", el("a", {href: "mailto:" + m}, m)])) : null,
    c.form ? el("p", {}, el("a", {href: c.form, target: "_blank", rel: "noopener"}, (c.formLabel || "Open the listing") + " ↗")) : null,
    c.website ? el("p", {}, "Website ", el("a", {href: c.website, target: "_blank", rel: "noopener"}, c.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))) : null,
    c.kind === "private" ? el("p", {class: "hint"}, "Private owners don't publish a number on Immoweb. The contact form on the listing goes straight to them.") : null,
    c.kind === "platform" ? el("p", {class: "hint"}, `${c.who || "The platform"} handles this one: you book and pay through their site, and they take a booking fee. Ask your questions through the listing's message form first.`) : null,
    c.pending ? el("p", {class: "hint"}, "The phone number and email appear after the next daily check, around 08:20.") : null
  );
}

// Malte's letter, filled in for each flat: the agency's name when we have one, which flat it is, and something
// nice about it that is true (from the facts and the description). English is the letter as written; French is a translation.
const AMBIORIX = [50.8470, 4.3820];
function niceThings(x) {
  const text = `${x.street} ${x.description || ""} ${(x.units || []).join(" ")}`;
  const nice = [];
  if (x.terrace) nice.push(["the terrace", "la terrasse"]);
  if (x.garden) nice.push(["the garden", "le jardin"]);
  if (/bright|lumineux|lumineuse|light-filled|sunny/i.test(text)) nice.push(["the bright living spaces", "les pièces de vie lumineuses"]);
  if (/renovat|rénov/i.test(text)) nice.push(["the recent renovation", "la rénovation récente"]);
  if (/^(Square|Place|Plein)\b|plein$/i.test(x.street)) nice.push(["the location right on the square", "l'emplacement directement sur la place"]);
  else if (x.lat != null && Math.hypot((x.lat - AMBIORIX[0]) * 111, (x.lng - AMBIORIX[1]) * 70) < 0.7) nice.push(["the location, a few minutes' walk from where we work", "l'emplacement, à quelques minutes à pied de notre travail"]);
  else if (/Josaphat/i.test(text)) nice.push(["the location next to Josaphat Park", "l'emplacement à côté du parc Josaphat"]);
  else if (/Cinquantenaire|Jubelpark/i.test(text)) nice.push(["the location near the Cinquantenaire park", "l'emplacement près du parc du Cinquantenaire"]);
  if (x.m2 >= 70) nice.push(["the generous space", "l'espace généreux"]);
  if (/^[AB]$/.test(x.epc || "")) nice.push(["the good energy rating", "la bonne classe énergétique"]);
  if (x.furnished) nice.push(["that it comes fully furnished", "qu'il soit entièrement meublé"]);
  if (!nice.length) nice.push([`the location in ${x.area}`, `l'emplacement à ${x.area}`]);
  const two = nice.slice(0, 2);
  return {en: two.map((n) => n[0]).join(" and "), fr: two.map((n) => n[1]).join(" et ")};
}
const tidyName = (s) => s.replace(/\b([A-Z]{4,})\b/g, (w) => w[0] + w.slice(1).toLowerCase()); // IMMOEXPAT → Immoexpat
function messageText(x, lang) {
  const c = contactOf(x);
  const agency = c.kind === "agency" && c.who && !/advertiser/i.test(c.who) ? tidyName(c.who) : null;
  const code = x.source === "Immovlan" ? x.id.toUpperCase() : x.source === "Spotahome" ? x.unitIds?.[0] || "" : x.source === "Zimmo" ? x.id.replace("zimmo-", "").toUpperCase() : x.id;
  const portal = ["Immoweb", "Immovlan", "Spotahome", "Zimmo"].includes(x.source);
  const ref = portal ? `${x.source} listing ${code}`.trim() : `listed on ${x.source}`;
  const refFr = portal ? `annonce ${x.source} ${code}`.trim() : `annonce sur ${x.source}`;
  const nice = niceThings(x);
  const askDom = domOf(x) === "unknown";
  const noAddress = x.street === "Address not given";
  if (lang === "fr") {
    const where = noAddress ? `à ${x.area}` : `situé ${x.street}`;
    return `Madame, Monsieur,\n\nJe m'appelle Malte, j'ai 26 ans et je cherche un appartement à louer avec ma compagne. Nous sommes tous deux de jeunes professionnels d'environ 25 ans, nous travaillons près du square Ambiorix et nous cherchons un logement à long terme à Bruxelles.\n\nVotre appartement ${where} (${refFr}) nous intéresse particulièrement pour ${nice.fr}.\n\nSerait-il possible d'organiser une visite dès que possible ? Je travaille à Bruxelles et je peux adapter mon horaire.${askDom ? " Pourriez-vous aussi nous dire si la domiciliation y est possible ?" : ""}\n\nMerci beaucoup, dans l'attente de votre réponse.\n\nBien à vous,\nMalte Wolski et Lilly Maydell\n+49 15256107600`;
  }
  const where = noAddress ? `in ${x.area}` : `${/\d/.test(x.street) ? "at" : "on"} ${x.street}`;
  return `${agency ? `Dear ${agency},` : "Dear Sir or Madam,"}\n\nMy name is Malte, I am 26, and I am looking for an apartment to rent with my girlfriend. We are both young professionals in our mid-twenties, working near Square Ambiorix, and we are looking for a long-term home in Brussels.\n\nWe are particularly interested in your flat ${where} (${ref}) because of ${nice.en}.\n\nCould we arrange a viewing at your earliest convenience? I work in Brussels and I can adapt my schedule.${askDom ? " Could you also tell us whether we could register our address there (domiciliation)?" : ""}\n\nThank you very much, and I look forward to hearing from you.\n\nKind regards,\nMalte Wolski and Lilly Maydell\n+49 15256107600`;
}
function messageBox(x) {
  const lang = state.msgLang[x.id] || "en";
  const ta = el("textarea", {class: "msg", rows: "16", id: "msg-" + x.id, "aria-label": "Message to send"});
  ta.value = messageText(x, lang);
  const pick = (l) => { state.msgLang[x.id] = l; ta.value = messageText(x, l); fr.setAttribute("aria-pressed", String(l === "fr")); en.setAttribute("aria-pressed", String(l === "en")); };
  const fr = el("button", {type: "button", class: "chip", "aria-pressed": String(lang === "fr"), onclick: () => pick("fr")}, "Français");
  const en = el("button", {type: "button", class: "chip", "aria-pressed": String(lang === "en"), onclick: () => pick("en")}, "English");
  const copy = el("button", {type: "button", class: "btn", onclick: async () => {
    try { await navigator.clipboard.writeText(ta.value); toast("Message copied. Paste it into the form or email."); }
    catch { ta.focus(); ta.select(); toast("Press Ctrl+C to copy the selected message."); }
  }}, "Copy message");
  const d = el("details", {class: "msgbox", ontoggle: () => (d.open ? state.msgOpen.add(x.id) : state.msgOpen.delete(x.id))},
    el("summary", {}, "Message to send, ready to copy"), el("div", {class: "chips"}, fr, en), ta, copy);
  d.open = state.msgOpen.has(x.id);
  return d;
}

const btn = (label, cls, onclick) => el("button", {type: "button", class: "btn " + (cls || "ghost"), onclick}, label);
// The step where the current stage began (later rows with the same stage are just notes)
function stageSince(x) {
  const steps = state.progress[x.id] || [];
  let i = steps.length - 1;
  while (i > 0 && steps[i - 1].stage === steps[i].stage) i--;
  return steps[i] || null;
}

// Shared notes on a flat: anything written while working on it, plus review comments from All flats
function notesBox(x) {
  const notes = (state.progress[x.id] || []).filter((s) => s.note).slice().reverse();
  const fromReview = rev(x.id).comments;
  const input = el("textarea", {class: "note", id: "note-" + x.id, rows: "2", maxlength: "500",
    placeholder: "Add a note: what the agent said, questions to ask, how the viewing went…", "aria-label": "New note on " + x.street});
  const add = btn("Add note", "primary", async () => {
    const text = input.value.trim();
    if (!text) { toast("Write the note first."); return; }
    if (await addProgress(x, stageOf(x), text, "", "Note added.")) { const n = document.getElementById("note-" + x.id); if (n) n.value = ""; }
  });
  return el("section", {class: "notes", "aria-label": "Notes on " + x.street},
    el("div", {class: "cb-title"}, notes.length + fromReview.length ? `Notes (${notes.length + fromReview.length})` : "Notes"),
    notes.length || fromReview.length
      ? el("ul", {class: "notelist"},
          notes.map((s) => el("li", {}, el("span", {class: "hdate"}, fmtStamp(s.created_at)), " ", el("b", {}, isMe(s) ? "You" : s.reviewer_name), " ", s.note)),
          fromReview.map((c) => el("li", {}, el("span", {class: "hdate"}, "review"), " ", el("b", {}, isMe(c) ? "You" : c.reviewer_name), " ", c.comment)))
      : el("p", {class: "hint"}, "No notes yet."),
    input,
    el("div", {class: "actions"}, add));
}

function stepsBlock(items, actions) {
  return el("div", {class: "steps"},
    el("div", {class: "cb-title"}, "Next steps"),
    el("ol", {}, items.filter(Boolean).map((t) => el("li", {}, t))),
    actions ? el("div", {class: "actions"}, actions) : null);
}

function historyBox(x) {
  const all = state.progress[x.id] || [];
  const steps = all.filter((s, i) => i === 0 || s.stage !== all[i - 1].stage || s.happens_at !== all[i - 1].happens_at); // step changes only
  if (!steps.length) return null;
  return el("details", {class: "history"}, el("summary", {}, `History (${steps.length})`),
    el("ul", {}, steps.slice().reverse().map((s) => el("li", {},
      el("span", {class: "hdate"}, fmtStamp(s.created_at)), " ", el("b", {}, isMe(s) ? "You" : s.reviewer_name), ": ",
      STAGE[s.stage]?.label || s.stage, s.happens_at ? ` (${fmtWhen(s.happens_at)})` : ""))));
}

// Your own Yes or Super yes on a flat, so the Shortlist shows which ones you picked
const mineYes = (x) => { const v = rev(x.id).mine?.verdict; return v === "yes" || v === "super" ? v : null; };
function headerOf(x) {
  const st = stageOf(x);
  const ls = stageSince(x);
  const mine = mineYes(x);
  return el("div", {class: "chead"},
    el("div", {class: "ctitle"},
      el("span", {class: "price"}, priceText(x)),
      el("h3", {class: "street"}, el("button", {class: "selbtn", type: "button", onclick: () => select(x.id)}, `${x.street} · ${x.area}`))),
    el("span", {class: "tags"},
      mine ? el("span", {class: "mine-tag"}, mine === "super" ? "You said ★ Super yes" : "You said Yes") : null,
      el("span", {class: "stage s-" + st, title: ls ? `${STAGE[st].label} since ${fmtStamp(ls.created_at)}` : STAGE[st].label}, STAGE[st].label)));
}

function shortCard(x) {
  const st = stageOf(x);
  const since = stageSince(x);
  const c = contactOf(x);
  const how = c.phones?.length ? `Call ${c.phones[0]}` : c.emails?.length ? `Email ${c.emails[0]}` : "Use the contact form on the listing";
  const yes = rev(x.id).yes.map((p) => (isMe(p) ? "you" : p.reviewer_name) + (p.verdict === "super" ? " ★" : "")).join(", ");
  const steps = st === "contacted"
    ? stepsBlock([
        `Contacted on ${fmtStamp(since.created_at)} by ${isMe(since) ? "you" : since.reviewer_name}. Waiting for their reply.`,
        "Agencies usually answer within one or two working days.",
        "No answer after two working days? Call again, or try the other channel (phone or form).",
        "When they answer, press “We heard back”: the flat moves to In contact."
      ], [btn("We heard back", "primary", () => addProgress(x, "heard_back")),
          btn("No longer available", "", () => addProgress(x, "dropped", "No longer available"))])
    : stepsBlock([
        "Open the listing and check the photos and the full description.",
        `${how}, or send the message below.`,
        `Ask whether it's still free for a December or January start, when you can visit, ${domOf(x) === "unknown" ? "what the charges cover, and whether you can register your address there (domiciliation)" : "and what the charges cover"}.`,
        domOf(x) === "no" ? "Keep in mind: the listing says you can't register your address there (no domiciliation)." : null,
        "Then press “We contacted them”, so you don't both contact them."
      ], [btn("We contacted them", "primary", () => addProgress(x, "contacted")),
          btn("Not for us", "", () => addProgress(x, "dropped", "Not for us"))]);
  return el("article", {class: "card big" + (state.selected === x.id ? " sel" : "") + (mineYes(x) ? " mine" : ""), role: "listitem", id: "scard-" + x.id},
    headerOf(x),
    watchLine(x),
    factsGrid(x),
    x.warning ? el("p", {class: "desc warn"}, x.warning) : null,
    el("div", {class: "who"}, el("b", {class: "y"}, "Yes from: "), yes || "nobody yet"),
    contactBox(x),
    st === "to_contact" ? messageBox(x) : null,
    steps,
    notesBox(x),
    historyBox(x));
}

const VIEWING_CHECK = "At the viewing, check the heating and hot water, damp or mould, noise from the street and neighbours, daylight, phone signal, storage (cellar, bike room) and where the meters are.";
function contactCard(x) {
  const st = stageOf(x);
  const since = stageSince(x);
  const viewingAt = [...(state.progress[x.id] || [])].reverse().find((s) => s.stage === "viewing" && s.happens_at)?.happens_at;
  let steps;
  if (st === "heard_back") {
    const dt = el("input", {type: "datetime-local", class: "when-input", id: "when-" + x.id, "aria-label": "Viewing date and time"});
    steps = stepsBlock([
      `They answered on ${fmtStamp(since.created_at)}. Put what they said in the notes.`,
      "Book a viewing. Before you go, ask: what the charges cover, the lease length, the deposit (in Brussels at most 2 months' rent on a blocked bank account), whether you can register your address there, and the exact move-in date.",
      "Enter the viewing date and press “Viewing booked”."
    ], [dt, btn("Viewing booked", "primary", () => dt.value ? addProgress(x, "viewing", "", dt.value) : toast("Pick the viewing date and time first.")),
        btn("Not for us", "", () => addProgress(x, "dropped", "Not for us"))]);
  } else if (st === "viewing") {
    steps = stepsBlock([
      `Viewing ${viewingAt ? "on " + fmtWhen(viewingAt) : "booked"}. Take ID and proof of income (last 3 payslips or an employment contract).`,
      VIEWING_CHECK,
      "Ask for the energy certificate (PEB) and last year's charges statement.",
      "Afterwards, press “We've visited” and write down what you thought in the notes."
    ], [btn("We've visited", "primary", () => addProgress(x, "viewed")),
        btn("New date", "", () => addProgress(x, "heard_back", "", "", "Pick the new date above.")),
        btn("Not for us", "", () => addProgress(x, "dropped", "Not for us"))]);
  } else if (st === "viewed") {
    steps = stepsBlock([
      "Decide together. If it's a yes, apply quickly: good flats go within days.",
      "Send copies of both IDs, the last 3 payslips or employment contracts, and a reference from your current landlord if you have one.",
      "Ask for the draft lease and when the check-in inventory (état des lieux) would be done."
    ], [btn("Application sent", "primary", () => addProgress(x, "applied")),
        btn("Not for us", "", () => addProgress(x, "dropped", "Not for us after the visit"))]);
  } else if (st === "applied") {
    steps = stepsBlock([
      `Applied on ${fmtStamp(since.created_at)}. Waiting for the landlord's answer.`,
      "Meanwhile, ask your bank about a rental deposit account (a blocked account, at most 2 months' rent) and get a home insurance quote: landlords usually want proof of both before handing over the keys.",
      "Read the draft lease: duration, notice period, who pays which charges, indexation."
    ], [btn("Lease signed", "primary", () => addProgress(x, "signed")),
        btn("They chose someone else", "", () => addProgress(x, "dropped", "Landlord chose someone else"))]);
  } else {
    steps = stepsBlock([
      "Do the check-in inventory (état des lieux) with the landlord before moving in, and keep a copy.",
      "Register your address at the commune within 8 days of moving in.",
      "Set up electricity, gas and internet in your names, and take meter readings on day one."
    ], null);
  }
  return el("article", {class: "card big" + (state.selected === x.id ? " sel" : "") + (mineYes(x) ? " mine" : ""), role: "listitem", id: "ccard-" + x.id},
    headerOf(x),
    el("ol", {class: "stepper", "aria-label": "Progress"}, STEPPER.map((s) => el("li", {class: s === st ? "now" : STEPPER.indexOf(s) < STEPPER.indexOf(st) ? "past" : ""}, STAGE[s].pin))),
    watchLine(x),
    factsGrid(x),
    steps,
    notesBox(x),
    el("details", {class: "history"}, el("summary", {}, "Contact details"), contactBox(x)),
    historyBox(x));
}

function setupBanner() {
  if (state.progressReady || state.tab === "all") return null;
  return el("div", {class: "setup"}, "Progress can't be saved yet. Run ", el("a", {href: "https://github.com/maltehanneswolski-arch/brussels-flat-review/blob/main/supabase/progress.sql", target: "_blank", rel: "noopener"}, "supabase/progress.sql"), " once in the Supabase SQL Editor.");
}
function keepTyping(list, render) {
  const a = document.activeElement;
  const typing = a && list.contains(a) && a.id ? {id: a.id, v: a.value} : null;
  const keepScroll = list.scrollTop;
  render();
  list.scrollTop = keepScroll;
  if (typing) { const t = document.getElementById(typing.id); if (t) { t.value = typing.v; t.focus(); } }
}
function renderShort() {
  const list = $("#list-short");
  const flats = state.flats.filter(inShort).sort((a, b) => (stageOf(a) === "contacted") - (stageOf(b) === "contacted") || (score(b.id) - score(a.id)) || ((total(a) ?? 1e9) - (total(b) ?? 1e9)));
  keepTyping(list, () => list.replaceChildren(...[setupBanner(),
    ...(flats.length ? flats.map(shortCard) : [el("div", {class: "empty"}, "No flats here yet. Say Yes to a flat in All flats and it appears here.")])].filter(Boolean)));
}
function renderContact() {
  const list = $("#list-contact");
  const order = (s) => STEPPER.indexOf(s);
  const flats = state.flats.filter(inContact).sort((a, b) => order(stageOf(b)) - order(stageOf(a)));
  const dropped = state.flats.filter((x) => stageOf(x) === "dropped");
  keepTyping(list, () => list.replaceChildren(...[setupBanner(),
    ...(flats.length ? flats.map(contactCard) : [el("div", {class: "empty"}, "Nobody has answered yet. On the Shortlist, press “We heard back” when an agency or owner replies.")]),
    dropped.length ? el("details", {class: "dropped"}, el("summary", {}, `Not going ahead (${dropped.length})`),
      el("ul", {}, dropped.map((x) => el("li", {},
        el("span", {}, `${x.street} · ${priceText(x)}`, lastStep(x)?.note ? ` · ${lastStep(x).note}` : ""),
        btn("Bring back", "", () => addProgress(x, "to_contact", "", "", "Back on the shortlist.")))))) : null].filter(Boolean)));
}

function renderTabs() {
  $("#n-all").textContent = state.flats.length;
  $("#n-short").textContent = state.flats.filter(inShort).length;
  $("#n-contact").textContent = state.flats.filter(inContact).length;
  for (const b of document.querySelectorAll(".tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === state.tab));
  $("#pane-all").hidden = state.tab !== "all";
  $("#pane-short").hidden = state.tab !== "short";
  $("#pane-contact").hidden = state.tab !== "contact";
  // Shortlist and In contact: map on top, flats below it (the page scrolls)
  document.documentElement.classList.toggle("stacked", state.tab !== "all");
}
function setTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  state.selected = null;
  history.replaceState(null, "", tab === "all" ? location.pathname + location.search : "#" + (tab === "short" ? "shortlist" : tab));
  map.closePopup();
  renderAll();
  setTimeout(() => { map.invalidateSize(); fitVisible(); }, 60);
}
for (const b of document.querySelectorAll(".tabs [data-tab]")) b.addEventListener("click", () => setTab(b.dataset.tab));
window.addEventListener("hashchange", () => setTab(TABS[location.hash.slice(1)] || "all"));
document.querySelector(".tabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const order = ["all", "short", "contact"];
  const next = order[(order.indexOf(state.tab) + (e.key === "ArrowRight" ? 1 : 2)) % 3];
  setTab(next);
  document.querySelector(`.tabs [data-tab="${next}"]`).focus();
});
function fitVisible() {
  const pts = state.flats.filter((x) => x.lat != null && visible(x)).map((x) => [x.lat, x.lng]);
  if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), {paddingTopLeft: [30, 40], paddingBottomRight: [30, 16], maxZoom: 15, animate: false});
  else if (pts.length === 1) map.setView(pts[0], 15, {animate: false});
}

// ---------- map ----------
const map = L.map("map", {minZoom: 12, maxZoom: 18, zoomSnap: 0.5});
let mapReady = false;
map.whenReady(() => { mapReady = true; });
map.attributionControl.setPrefix(false);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
}).addTo(map);
// Keep Leaflet's idea of the map size right when the layout changes (tab switch, scrollbar appearing),
// and keep the flats in view until someone moves the map themselves (a tab opened in the background has no size yet).
let mapTouched = false;
for (const ev of ["pointerdown", "wheel", "keydown"]) document.getElementById("map").addEventListener(ev, () => { mapTouched = true; }, {passive: true});
if (window.ResizeObserver) new ResizeObserver(() => {
  map.invalidateSize();
  if (mapReady && !mapTouched) fitVisible();
}).observe(document.getElementById("map"));
const zone = L.circle(GN, {radius: 1000, className: "gn-zone", interactive: false}).addTo(map);
L.marker(GN, {icon: L.divIcon({className: "pw", html: '<span class="gn">Gare du Nord</span>', iconSize: [0, 0]}), interactive: false, keyboard: false}).addTo(map);
const layer = L.layerGroup().addTo(map);
const markers = {};
let popupFor = null;

// Pins: colour fill means new only. Dec–Jan is a yellow edge, an approximate address a dashed edge,
// and the vote balance a small dot (green more Yes, red more No, hollow tied). A star marks a Super yes.
function pillHtml(x) {
  const s = score(x.id);
  const r = rev(x.id);
  const gone = state.status[x.id]?.status === "removed" ? "gone" : "";
  const cls = ["pill", x.cat, x.kind === "vista" ? "vista" : "", x.approx ? "approx" : "", isNew(x) ? "new" : "", gone, state.selected === x.id ? "sel" : ""].join(" ");
  const label = (r.super.length ? '<b class="star">★</b>' : "") + (x.kind === "vista" ? "Vista" : x.rent == null ? "Ask" : euro(total(x)));
  const st = stageOf(x);
  if (state.tab !== "all" && STAGE[st]) return `<span class="${cls} st-${st}">${label}<span class="s">${STAGE[st].pin}</span></span>`;
  const dot = r.yes.length + r.no.length ? `<i class="vd ${s > 0 ? "y" : s < 0 ? "x" : "t"}"></i>` : "";
  return `<span class="${cls}">${dot}${label}${isNew(x) ? '<span class="s">new</span>' : ""}</span>`;
}

// Pins that would sit on top of each other become one count bubble; tapping it zooms in.
// From zoom 16 every flat has its own pin.
const GROUP_BELOW = 16;
function groupPins(list) {
  if (!mapReady || map.getZoom() >= GROUP_BELOW) return list.map((x) => [x]);
  const groups = [];
  for (const x of list) {
    const p = map.project([x.lat, x.lng]);
    const g = x.id === state.selected ? null : groups.find((g) => g.p && Math.abs(g.p.x - p.x) < 64 && Math.abs(g.p.y - p.y) < 26);
    if (g) g.push(x);
    else groups.push(Object.assign([x], {p: x.id === state.selected ? null : p}));
  }
  return groups;
}
function groupMarker(g) {
  const fresh = g.filter(isNew).length;
  const pos = [g[0].lat, g[0].lng]; // every member is within a pin's width of the first one, others aren't
  const star = g.some((x) => rev(x.id).super.length);
  const html = `<span class="grp">${g.length}${fresh ? `<b>${fresh} new</b>` : ""}${star ? '<i class="gstar">★</i>' : ""}</span>`;
  const mk = L.marker(pos, {icon: L.divIcon({className: "pw", html, iconSize: [0, 0]}), title: `${g.length} flats here${fresh ? `, ${fresh} new` : ""}. Zoom in`, zIndexOffset: 500});
  mk.on("click", () => map.fitBounds(L.latLngBounds(g.map((x) => [x.lat, x.lng])), {padding: [60, 60], maxZoom: GROUP_BELOW}));
  return mk;
}
function popupContent(x) {
  return el("div", {class: "pop"},
    el("div", {class: "price"}, priceText(x)),
    el("div", {class: "street"}, x.street + " · " + x.area),
    el("div", {class: "facts"}, state.tab === "all" ? whenLabel(x) : `${STAGE[stageOf(x)].label} · ${whenLabel(x)}`),
    state.tab === "all" ? voteRow(x) : el("a", {class: "link", href: x.url, target: "_blank", rel: "noopener"}, "Open on " + x.source + " ↗"));
}
function renderMarkers() {
  const shown = [];
  for (const x of state.flats) {
    const mk = markers[x.id];
    if (!mk) continue;
    mk.setIcon(L.divIcon({className: "pw", html: pillHtml(x), iconSize: [0, 0]}));
    mk.setZIndexOffset(state.selected === x.id ? 1000 : score(x.id) * 10 + (isNew(x) ? 8 : 0) + (x.cat === "fit" ? 5 : 0));
    if (visible(x)) shown.push(x);
  }
  // swap only what changed, so an open popup stays open
  const want = new Set(groupPins(shown).map((g) => g.length > 1 ? groupMarker(g) : markers[g[0].id]));
  layer.eachLayer((l) => { if (!want.has(l)) layer.removeLayer(l); });
  want.forEach((l) => { if (!layer.hasLayer(l)) layer.addLayer(l); });
  zone.setRadius(Math.max(state.gnKm, 0.01) * 1000);
  zone.setStyle({opacity: state.gnKm > 0 ? 1 : 0, fillOpacity: state.gnKm > 0 ? 0.07 : 0});
  if (popupFor && markers[popupFor]?.isPopupOpen()) markers[popupFor].setPopupContent(popupContent(state.flats.find((f) => f.id === popupFor)));
}
function select(id, fromMap) {
  state.selected = state.selected === id && !fromMap ? null : id;
  renderAll();
  const x = state.flats.find((f) => f.id === id);
  const stacked = state.tab !== "all";
  if (state.selected && x?.lat != null) {
    if (!fromMap) {
      mapTouched = true;
      map.panTo([x.lat, x.lng]);
      if (stacked) document.querySelector(".mapwrap").scrollIntoView({block: "nearest", behavior: "smooth"});
    }
    popupFor = id;
    markers[id].bindPopup(popupContent(x), {offset: [0, -22], autoPanPadding: [20, 20]}).openPopup();
  } else { map.closePopup(); popupFor = null; }
  const prefix = {all: "card-", short: "scard-", contact: "ccard-"}[state.tab];
  if (state.selected && fromMap && (stacked || matchMedia("(min-width: 901px)").matches)) document.getElementById(prefix + id)?.scrollIntoView({block: stacked ? "start" : "nearest", behavior: "smooth"});
}
map.on("popupclose", () => { popupFor = null; });
map.on("zoomend", renderMarkers);

function renderAll() {
  renderTabs();
  renderStatusLine();
  if (state.tab === "all") { renderChips(); renderList(); }
  else if (state.tab === "short") renderShort();
  else renderContact();
  renderMarkers();
  renderActivityBadge();
}

// ---------- activity: who said what about which flat ----------
// Built from the saved rows: a vote row says what changed against that person's previous row on the flat.
const actKey = () => "flat-review:activity-seen:" + (person || "anyone");
const VOTE_TEXT = {yes: "said Yes to", super: "said ★ Super yes to", no: "said No to", none: "took back the vote on"};
function activityEvents() {
  const ev = [], lastRow = {}, lastStage = {};
  const flatOf = (id) => state.flats.find((f) => f.id === id);
  for (const r of state.rows) {
    const x = flatOf(r.flat_id); if (!x) continue;
    const k = r.flat_id + "|" + personKey(r), p = lastRow[k]; lastRow[k] = r;
    const who = isMe(r) ? "You" : r.reviewer_name || "Someone";
    if (p ? p.verdict !== r.verdict : r.verdict !== "none") ev.push({at: r.created_at, who, mine: isMe(r), x, text: VOTE_TEXT[r.verdict] || "voted on"});
    if (r.comment && (p?.comment || "") !== r.comment) ev.push({at: r.created_at, who, mine: isMe(r), x, text: "commented on", note: r.comment});
  }
  for (const s of state.progressRows) {
    const x = flatOf(s.flat_id); if (!x) continue;
    const who = isMe(s) ? "You" : s.reviewer_name || "Someone";
    const changed = lastStage[s.flat_id] !== s.stage; lastStage[s.flat_id] = s.stage;
    if (changed) ev.push({at: s.created_at, who, mine: isMe(s), x, text: "moved", tail: `to “${STAGE[s.stage]?.label || s.stage}”`, note: s.note || null});
    else if (s.note) ev.push({at: s.created_at, who, mine: isMe(s), x, text: "added a note on", note: s.note});
  }
  return ev.sort((a, b) => b.at.localeCompare(a.at));
}
function fmtAt(iso) {
  const d = new Date(iso);
  const day = d.toDateString() === new Date().toDateString() ? "Today" : d.toLocaleDateString("en-GB", {weekday: "short", day: "numeric", month: "short"});
  return day + ", " + d.toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit"});
}
function renderActivityBadge() {
  const seenAt = store(actKey()) || "";
  const n = activityEvents().filter((e) => !e.mine && e.at > seenAt).length;
  const b = $("#bell-n"); b.textContent = n; b.hidden = !n;
  $("#bell").setAttribute("aria-label", n ? `Activity, ${n} new` : "Activity");
}
function renderActivity() {
  const seenAt = store(actKey()) || "";
  const events = activityEvents().filter((e, i) => i < 80 || (!e.mine && e.at > seenAt)); // the latest 80, plus anything unread
  $("#activity-list").replaceChildren(...(events.length ? events.map((e) => el("li", {class: (e.mine ? "mine" : "") + (!e.mine && e.at > seenAt ? " unread" : "")},
    el("span", {class: "when"}, fmtAt(e.at)),
    el("span", {class: "what"}, el("b", {}, e.who), ` ${e.text} `,
      el("button", {type: "button", class: "flatlink", onclick: () => goToFlat(e.x)}, x_name(e.x)), e.tail ? ` ${e.tail}` : null),
    e.note ? el("q", {class: "note"}, e.note) : null)) : [el("li", {class: "empty"}, "No votes or steps yet.")]));
  store(actKey(), new Date().toISOString()); // everything shown counts as read
  renderActivityBadge();
}
const x_name = (x) => x.street === "Address not given" ? `a flat in ${x.area} (${priceText(x)})` : `${x.street} (${x.area})`;
function goToFlat(x) {
  $("#activity").close();
  const tab = inContact(x) ? "contact" : inShort(x) ? "short" : "all";
  if (tab === "all") state.onlyNew = false;
  const switching = state.tab !== tab;
  if (switching) setTab(tab);
  setTimeout(() => {
    state.selected = null; select(x.id);
    document.getElementById({all: "card-", short: "scard-", contact: "ccard-"}[tab] + x.id)?.scrollIntoView({block: "center", behavior: "smooth"});
  }, switching ? 120 : 0);
}
$("#bell").addEventListener("click", () => { renderActivity(); $("#activity").showModal(); });
$("#activity-close").addEventListener("click", () => $("#activity").close());
$("#activity").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }); // click on the backdrop

// ---------- controls ----------
$("#gn-range").addEventListener("input", (e) => {
  state.gnKm = +e.target.value;
  $("#gn-out").textContent = state.gnKm ? state.gnKm.toFixed(1) + " km" : "Off";
  renderFilterSummary(); renderList(); renderMarkers();
});
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });

// ---------- boot ----------
(async () => {
  const data = await (await fetch("data/flats.json", {cache: "no-cache"})).json();
  state.checked = data.checked;
  state.areas = data.areas;
  state.areaOn = new Set(data.areas);
  state.flats = data.flats.map((x) => ({...x, cat: catOf(x, data.checked), d: x.lat != null ? distKm(x.lat, x.lng) : null}));
  $("#checked").textContent = fmtDate(data.checked) + " " + data.checked.slice(0, 4);
  loadSeen();
  try { state.status = (await (await fetch("data/status.json", {cache: "no-store"})).json()).flats || {}; } catch { state.status = {}; }
  for (const x of state.flats) {
    if (x.lat == null) continue;
    const mk = L.marker([x.lat, x.lng], {icon: L.divIcon({className: "pw", html: pillHtml(x), iconSize: [0, 0]}), title: x.street + " · " + priceText(x), riseOnHover: true});
    mk.on("click", () => select(x.id, true));
    markers[x.id] = mk;
  }
  if (!db.shared) {
    const b = $("#banner");
    b.textContent = "Reviews are only saved in this browser for now. Shared reviews switch on once the database is connected (see the README).";
    b.hidden = false;
  }
  renderAll();
  map.invalidateSize(); // the map column is narrower on the Shortlist and In contact tabs
  const pts = state.flats.filter((x) => x.lat != null && (state.tab !== "all" || visible(x))).map((x) => [x.lat, x.lng]);
  map.fitBounds(L.latLngBounds(pts), {padding: [30, 30]});
  await refresh();
  // the shortlist is only known once the votes are in; wait a frame so the list (and scrollbar) has its final size
  if (state.tab !== "all") setTimeout(() => { map.invalidateSize(); fitVisible(); }, 60);
  if (db.shared) {
    setInterval(() => { if (!document.hidden) refresh(); }, 30000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  }
  setInterval(() => { if (!document.hidden) checkForUpdate(); }, 300000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); });
})();

// ---------- new versions of the site ----------
// An open tab (or one the browser kept for up to 10 minutes) would keep running old code. When the page comes back
// into view, and every 5 minutes, compare the deployed file versions with ours and reload, unless someone is typing.
const versionsIn = (html) => [...html.matchAll(/(?:src|href)="([^"]+\?v=\d+)"/g)].map((m) => m[1]).join(" ");
const MY_VERSIONS = [...document.querySelectorAll("link[href*='?v='], script[src*='?v=']")].map((e) => e.getAttribute("href") || e.getAttribute("src")).join(" ");
async function checkForUpdate() {
  try {
    const live = versionsIn(await (await fetch(location.pathname, {cache: "no-store"})).text());
    if (!live || live === MY_VERSIONS || sessionStorage.getItem("flat-review:reloaded-for") === live) return;
    const a = document.activeElement;
    const typing = /^(TEXTAREA|INPUT)$/.test(a?.tagName || "") || [...document.querySelectorAll("textarea.note, .cform textarea")].some((t) => t.value.trim());
    if (typing) return;
    sessionStorage.setItem("flat-review:reloaded-for", live); // never loop if the server still hands out the old page
    location.reload();
  } catch { /* offline: try again next time */ }
}
