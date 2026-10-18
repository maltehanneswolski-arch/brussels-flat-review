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

// ---------- reviewer identity (kept in this browser) ----------
const me = {
  id: store("flat-review:id") || (() => { const id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); store("flat-review:id", id); return id; })(),
  get name() { return ($("#me-name").value || "").trim().slice(0, 40); }
};
$("#me-name").value = store("flat-review:name") || "";
$("#me-name").addEventListener("change", (e) => { store("flat-review:name", e.target.value.trim()); e.target.classList.remove("need"); });

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
  gnKm: 1, sort: "score", selected: null,
  rows: [], byFlat: {}, lastSync: null, status: {},
  tab: TABS[location.hash.slice(1)] || "all",
  progressRows: [], progress: {}, progressReady: true
};

function aggregate(rows) {
  const by = {};
  for (const r of rows) {
    const f = by[r.flat_id] || (by[r.flat_id] = {});
    f[r.reviewer_id] = r; // rows arrive oldest first, so the latest one per person wins
  }
  const out = {};
  for (const [flat, people] of Object.entries(by)) {
    const list = Object.values(people);
    out[flat] = {
      yes: list.filter((r) => r.verdict === "yes"),
      no: list.filter((r) => r.verdict === "no"),
      comments: list.filter((r) => r.comment).sort((a, b) => (a.created_at || "").localeCompare(b.created_at || "")),
      mine: people[me.id] || null
    };
  }
  return out;
}
const rev = (id) => state.byFlat[id] || {yes: [], no: [], comments: [], mine: null};
const score = (id) => { const r = rev(id); return r.yes.length - r.no.length; };

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
  } catch (e) {
    $("#sync").textContent = "Couldn't load reviews. Retrying…";
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
  if (!me.name) {
    const inp = $("#me-name");
    inp.classList.add("need"); inp.focus();
    toast("Add your name first so the others know who did this.");
    return false;
  }
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
  if (!me.name) {
    const inp = $("#me-name");
    inp.classList.add("need"); inp.focus();
    toast("Add your name first so we know who voted.");
    return;
  }
  const cur = rev(x.id).mine;
  const next = cur?.verdict === verdict ? "none" : verdict;
  const row = {flat_id: x.id, reviewer_id: me.id, reviewer_name: me.name, verdict: next, comment: cur?.comment || ""};
  await save(row, next === "none" ? "Vote removed." : next === "yes" ? "Marked Yes." : "Marked No.");
}
async function comment(x, text) {
  if (!me.name) {
    const inp = $("#me-name");
    inp.classList.add("need"); inp.focus();
    toast("Add your name first so we know who wrote this.");
    return false;
  }
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
    toast("Couldn't save that. Check your connection and try again.");
    refresh();
    return false;
  }
}

// Flats the daily search added in the last 2 days show in purple.
function isNew(x) {
  if (!x.added) return false;
  const days = (Date.now() - new Date(x.added + "T00:00:00").getTime()) / 86400000;
  return days >= 0 && days < 2;
}

// ---------- filters ----------
function visible(x) {
  if (state.tab === "short") return inShort(x);
  if (state.tab === "contact") return inContact(x);
  if (!state.areaOn.has(x.area)) return false;
  if (!state.cats.has(x.cat) && !isNew(x)) return false; // new flats show whatever their start date
  if (!state.furn.has(x.furnished === true ? "f" : "u")) return false;
  if (x.d != null && x.d < state.gnKm) return false;
  return true;
}
function sorted(list) {
  const by = {
    score: (a, b) => (score(b.id) - score(a.id)) || (isNew(b) - isNew(a)) || (CAT_ORDER[a.cat] - CAT_ORDER[b.cat]) || ((total(a) ?? 1e9) - (total(b) ?? 1e9)),
    price: (a, b) => ((total(a) ?? 1e9) - (total(b) ?? 1e9)),
    date: (a, b) => (CAT_ORDER[a.cat] - CAT_ORDER[b.cat]) || String(a.available || "z").localeCompare(String(b.available || "z"))
  }[state.sort];
  return list.slice().sort(by);
}

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
}

// ---------- cards ----------
function voteRow(x) {
  const r = rev(x.id);
  const mine = r.mine?.verdict;
  return el("div", {class: "vote"},
    el("div", {class: "vbtns", role: "group", "aria-label": "Your vote"},
      el("button", {type: "button", class: "vb yes", "aria-pressed": String(mine === "yes"), onclick: (e) => { e.stopPropagation(); vote(x, "yes"); }}, "Yes", el("span", {class: "n"}, r.yes.length)),
      el("button", {type: "button", class: "vb no", "aria-pressed": String(mine === "no"), onclick: (e) => { e.stopPropagation(); vote(x, "no"); }}, "No", el("span", {class: "n"}, r.no.length))
    ),
    el("a", {class: "link", href: x.url, target: "_blank", rel: "noopener"}, "Open on " + x.source + " ↗")
  );
}
function whoLine(x) {
  const r = rev(x.id);
  if (!r.yes.length && !r.no.length) return null;
  const names = (list) => list.map((p) => p.reviewer_id === me.id ? "you" : p.reviewer_name).join(", ");
  return el("div", {class: "who"},
    r.yes.length ? [el("b", {class: "y"}, "Yes: "), names(r.yes)] : null,
    r.yes.length && r.no.length ? " · " : null,
    r.no.length ? [el("b", {class: "x"}, "No: "), names(r.no)] : null);
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
  if (w.status !== "removed" && w.available && x.available && w.available !== x.available) extra.push(`start now ${/^\d{4}-/.test(w.available) ? fmtDate(w.available) : w.available.toLowerCase()}`);
  return el("div", {class: "watch " + w.status}, text, extra.length ? " · " + extra.join(" · ") : null);
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
      el("button", {class: "selbtn", type: "button", "aria-expanded": String(sel), onclick: () => select(x.id)},
        el("span", {class: "price"}, priceText(x), " ", el("small", {}, x.rent == null ? "price and dates on request" : x.charges ? `${euro(x.rent)} rent + ${euro(x.charges)} charges` : "rent, charges not stated")),
        el("span", {class: "street"}, x.street)
      ),
      el("span", {class: "tags"},
        fresh ? el("span", {class: "newtag", title: "Found by the daily search on " + fmtDate(x.added)}, "New " + fmtDate(x.added)) : null,
        el("span", {class: "when " + x.cat}, whenLabel(x)))
    ),
    el("div", {class: "facts"}, facts.join(" · "), x.epc ? el("span", {class: "peb " + x.epc, title: "Energy class (PEB) " + x.epc}, "PEB " + x.epc) : null),
    watchLine(x),
    x.description || x.warning || x.lat == null ? el("p", {class: "desc"}, x.description,
      x.warning ? [" ", el("span", {class: "warn"}, x.warning)] : null,
      x.lat == null ? [" ", el("em", {}, "Address not given, so no map pin.")] : null) : null,
    x.units ? el("ul", {class: "units", "aria-label": "Units that fit two people"}, x.units.map((u) => el("li", {}, u))) : null,
    x.kind === "vista" ? el("div", {class: "contact"}, "Ask Vista for prices and free dates: ", el("span", {}, "0478 555 620"), " · ", el("span", {}, "info@vistaresidences.org")) : null,
    voteRow(x),
    whoLine(x),
    r.comments.length ? el("ul", {class: "comments", "aria-label": "Comments"}, r.comments.map((c) =>
      el("li", {}, el("b", {}, (c.reviewer_id === me.id ? "You" : c.reviewer_name) + ": "), c.comment))) : null,
    sel ? el("form", {class: "cform", onsubmit: async (e) => { e.preventDefault(); if (await comment(x, ta.value)) ta.value = ""; }},
      (ta = el("textarea", {id: "comment-" + x.id, maxlength: "500", placeholder: r.mine?.comment ? "Change your comment (empty removes it)" : "Your comment: nice street, too small, call the agent…", "aria-label": "Your comment on " + x.street})),
      el("button", {type: "submit"}, r.mine?.comment ? "Update comment" : "Post comment")) : null
  );
}

function renderList() {
  const list = $("#list");
  const vis = sorted(state.flats.filter(visible));
  const hidden = state.flats.filter((x) => x.d != null && x.d < state.gnKm && state.areaOn.has(x.area)).length;
  const reviewers = new Set(Object.values(state.byFlat).flatMap((r) => [...r.yes, ...r.no, ...r.comments]).map((p) => p.reviewer_id)).size;
  const fresh = state.flats.filter(isNew).length;
  $("#count").textContent = `${vis.length} of ${state.flats.length} flats` + (fresh ? ` · ${fresh} new` : "") + (hidden ? ` · ${hidden} hidden near Gare du Nord` : "") + (reviewers ? ` · ${reviewers} reviewer${reviewers > 1 ? "s" : ""}` : "");
  $("#sync").textContent = db.shared && state.lastSync ? "Updated " + state.lastSync.toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit"}) : "";
  const keepScroll = list.scrollTop;
  const typing = document.activeElement?.id?.startsWith("comment-") ? {id: document.activeElement.id, v: document.activeElement.value} : null;
  list.replaceChildren(...(vis.length ? vis.map(card) : [el("div", {class: "empty"}, "No flats match these filters. Turn an area or start date back on.")]));
  list.scrollTop = keepScroll;
  if (typing) { const t = document.getElementById(typing.id); if (t) { t.value = typing.v; t.focus(); } }
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
    ["Price", x.rent == null ? "On request" : `${euro(total(x))} a month (${euro(x.rent)} rent${x.charges ? ` + ${euro(x.charges)} charges` : ", charges not stated"})`],
    ["Size", x.m2 ? x.m2 + " m²" : "Not given"],
    ["Rooms", x.bedrooms === 0 ? "Studio" : x.bedrooms ? `${x.bedrooms} bedroom${x.bedrooms > 1 ? "s" : ""}` : "Not given"],
    ["Furnished", x.furnished === true ? "Yes" : x.furnished === false ? "No" : "Not stated"],
    ["Start", whenLabel(x)],
    ["Location", [x.street, x.area, x.d != null ? x.d.toFixed(1) + " km from Gare du Nord" : null].filter(Boolean).join(" · ")],
    x.floor != null ? ["Floor", floorLabel(x.floor) + (x.lift ? ", lift" : "")] : null,
    x.epc ? ["Energy", "PEB " + x.epc] : null,
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
    c.kind === "platform" ? el("p", {class: "hint"}, "HousingAnywhere handles this one: you book and pay through their site. Ask your questions through the listing's email form first.") : null,
    c.pending ? el("p", {class: "hint"}, "The phone number and email appear after the next daily check, around 08:20.") : null
  );
}

function messageText(x, lang) {
  const ref = x.source === "Immoweb" ? `Immoweb ${x.id}` : x.source === "Immovlan" ? `Immovlan ${x.id.toUpperCase()}` : x.url;
  const name = me.name || (lang === "fr" ? "[votre nom]" : "[your name]");
  if (lang === "fr") {
    const price = x.rent != null ? `, ${x.rent} €${x.charges ? ` + ${x.charges} € de charges` : ""}` : "";
    return `Bonjour,\n\nNous sommes intéressés par l'appartement ${x.street} (${x.area})${price}, annonce ${ref}.\n\nEst-il toujours disponible pour une entrée en décembre ou en janvier ? Serait-il possible de le visiter dans les prochains jours ?\n\nNous sommes deux. [Une phrase sur vous : travail, durée prévue du bail.]\n\nBien à vous,\n${name}`;
  }
  const price = x.rent != null ? `, €${x.rent}${x.charges ? ` + €${x.charges} charges` : ""}` : "";
  return `Hello,\n\nWe are interested in the flat at ${x.street} (${x.area})${price}, listing ${ref}.\n\nIs it still available for a move-in in December or January? Could we visit it in the coming days?\n\nWe are two people. [One line about you: work, how long you plan to stay.]\n\nKind regards,\n${name}`;
}
function messageBox(x) {
  const lang = state.msgLang[x.id] || "fr";
  const ta = el("textarea", {class: "msg", rows: "10", id: "msg-" + x.id, "aria-label": "Message to send"});
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
function noteField(x) {
  return el("input", {type: "text", class: "note", id: "note-" + x.id, maxlength: "500", placeholder: "Note for the others (optional): left a voicemail, viewing only on weekends…", "aria-label": "Note on " + x.street});
}
const noteOf = (x) => document.getElementById("note-" + x.id)?.value || "";

function stepsBlock(items, actions) {
  return el("div", {class: "steps"},
    el("div", {class: "cb-title"}, "Next steps"),
    el("ol", {}, items.map((t) => el("li", {}, t))),
    actions ? el("div", {class: "actions"}, actions) : null);
}

function historyBox(x) {
  const steps = state.progress[x.id];
  if (!steps?.length) return null;
  return el("details", {class: "history"}, el("summary", {}, `History (${steps.length})`),
    el("ul", {}, steps.slice().reverse().map((s) => el("li", {},
      el("span", {class: "hdate"}, fmtStamp(s.created_at)), " ", el("b", {}, s.reviewer_id === me.id ? "You" : s.reviewer_name), ": ",
      STAGE[s.stage]?.label || s.stage, s.happens_at ? ` (${fmtWhen(s.happens_at)})` : "", s.note ? ` · ${s.note}` : ""))));
}

function headerOf(x, idPrefix) {
  const st = stageOf(x);
  const ls = lastStep(x);
  return el("div", {class: "chead"},
    el("button", {class: "selbtn", type: "button", onclick: () => select(x.id)},
      el("span", {class: "price"}, priceText(x)),
      el("span", {class: "street"}, `${x.street} · ${x.area}`)),
    el("span", {class: "stage s-" + st, title: ls ? `${STAGE[st].label} since ${fmtStamp(ls.created_at)}` : STAGE[st].label}, STAGE[st].label));
}

function shortCard(x) {
  const st = stageOf(x);
  const ls = lastStep(x);
  const c = contactOf(x);
  const how = c.phones?.length ? `Call ${c.phones[0]}` : c.emails?.length ? `Email ${c.emails[0]}` : "Use the contact form on the listing";
  const yes = rev(x.id).yes.map((p) => p.reviewer_id === me.id ? "you" : p.reviewer_name).join(", ");
  const steps = st === "contacted"
    ? stepsBlock([
        `Contacted on ${fmtStamp(ls.created_at)} by ${ls.reviewer_id === me.id ? "you" : ls.reviewer_name}${ls.note ? ` (${ls.note})` : ""}. Waiting for their reply.`,
        "Agencies usually answer within one or two working days.",
        "No answer after two working days? Call again, or try the other channel (phone or form).",
        "When they answer, press “We heard back”: the flat moves to In contact."
      ], [btn("We heard back", "primary", () => addProgress(x, "heard_back", noteOf(x))),
          btn("Save note", "", () => noteOf(x).trim() ? addProgress(x, "contacted", noteOf(x), "", "Note saved.") : toast("Write a note first.")),
          btn("No longer available", "", () => addProgress(x, "dropped", noteOf(x) || "No longer available"))])
    : stepsBlock([
        "Open the listing and check the photos and the full description.",
        `${how}, or send the message below.`,
        "Ask whether it's still free for a December or January start, when you can visit, and what the charges cover.",
        "Then press “We contacted them”, so the others don't contact them twice."
      ], [btn("We contacted them", "primary", () => addProgress(x, "contacted", noteOf(x))),
          btn("Not for us", "", () => addProgress(x, "dropped", noteOf(x) || "Not for us"))]);
  return el("article", {class: "card big" + (state.selected === x.id ? " sel" : ""), role: "listitem", id: "scard-" + x.id},
    headerOf(x),
    watchLine(x),
    factsGrid(x),
    x.warning ? el("p", {class: "desc warn"}, x.warning) : null,
    el("div", {class: "who"}, el("b", {class: "y"}, "Yes from: "), yes || "nobody yet"),
    contactBox(x),
    st === "to_contact" ? messageBox(x) : null,
    steps,
    noteField(x),
    historyBox(x));
}

const VIEWING_CHECK = "At the viewing, check the heating and hot water, damp or mould, noise from the street and neighbours, daylight, phone signal, storage (cellar, bike room) and where the meters are.";
function contactCard(x) {
  const st = stageOf(x);
  const ls = lastStep(x);
  const viewingAt = [...(state.progress[x.id] || [])].reverse().find((s) => s.stage === "viewing" && s.happens_at)?.happens_at;
  let steps;
  if (st === "heard_back") {
    const dt = el("input", {type: "datetime-local", class: "when-input", id: "when-" + x.id, "aria-label": "Viewing date and time"});
    steps = stepsBlock([
      `They answered on ${fmtStamp(ls.created_at)}${ls.note ? ` (${ls.note})` : ""}.`,
      "Book a viewing. Before you go, ask: what the charges cover, the lease length, the deposit (in Brussels at most 2 months' rent on a blocked bank account), whether you can register your address there, and the exact move-in date.",
      "Enter the viewing date and press “Viewing booked”."
    ], [dt, btn("Viewing booked", "primary", () => dt.value ? addProgress(x, "viewing", noteOf(x), dt.value) : toast("Pick the viewing date and time first.")),
        btn("Not for us", "", () => addProgress(x, "dropped", noteOf(x) || "Not for us"))]);
  } else if (st === "viewing") {
    steps = stepsBlock([
      `Viewing ${viewingAt ? "on " + fmtWhen(viewingAt) : "booked"}. Take ID and proof of income (last 3 payslips or an employment contract).`,
      VIEWING_CHECK,
      "Ask for the energy certificate (PEB) and last year's charges statement.",
      "Afterwards, press “We've visited” and add a note on what you thought."
    ], [btn("We've visited", "primary", () => addProgress(x, "viewed", noteOf(x))),
        btn("New date", "", () => addProgress(x, "heard_back", noteOf(x) || "Viewing moved", "", "Pick the new date above.")),
        btn("Not for us", "", () => addProgress(x, "dropped", noteOf(x) || "Not for us"))]);
  } else if (st === "viewed") {
    steps = stepsBlock([
      "Decide together. If it's a yes, apply quickly: good flats go within days.",
      "Send copies of both IDs, the last 3 payslips or employment contracts, and a reference from your current landlord if you have one.",
      "Ask for the draft lease and when the check-in inventory (état des lieux) would be done."
    ], [btn("Application sent", "primary", () => addProgress(x, "applied", noteOf(x))),
        btn("Not for us", "", () => addProgress(x, "dropped", noteOf(x) || "Not for us after the visit"))]);
  } else if (st === "applied") {
    steps = stepsBlock([
      `Applied on ${fmtStamp(ls.created_at)}. Waiting for the landlord's answer.`,
      "Meanwhile, ask your bank about a rental deposit account (a blocked account, at most 2 months' rent) and get a home insurance quote: landlords usually want proof of both before handing over the keys.",
      "Read the draft lease: duration, notice period, who pays which charges, indexation."
    ], [btn("Lease signed", "primary", () => addProgress(x, "signed", noteOf(x))),
        btn("They chose someone else", "", () => addProgress(x, "dropped", noteOf(x) || "Landlord chose someone else"))]);
  } else {
    steps = stepsBlock([
      "Do the check-in inventory (état des lieux) with the landlord before moving in, and keep a copy.",
      "Register your address at the commune within 8 days of moving in.",
      "Set up electricity, gas and internet in your names, and take meter readings on day one."
    ], null);
  }
  return el("article", {class: "card big" + (state.selected === x.id ? " sel" : ""), role: "listitem", id: "ccard-" + x.id},
    headerOf(x),
    el("ol", {class: "stepper", "aria-label": "Progress"}, STEPPER.map((s) => el("li", {class: s === st ? "now" : STEPPER.indexOf(s) < STEPPER.indexOf(st) ? "past" : ""}, STAGE[s].pin))),
    watchLine(x),
    factsGrid(x),
    steps,
    st !== "signed" ? noteField(x) : null,
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
  const flats = state.flats.filter(inShort).sort((a, b) => (stageOf(a) === "contacted") - (stageOf(b) === "contacted") || (rev(b.id).yes.length - rev(a.id).yes.length) || ((total(a) ?? 1e9) - (total(b) ?? 1e9)));
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
  $("#main").classList.toggle("wide", state.tab !== "all");
}
function setTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  state.selected = null;
  history.replaceState(null, "", tab === "all" ? location.pathname + location.search : "#" + (tab === "short" ? "shortlist" : tab));
  map.closePopup();
  renderAll();
  setTimeout(() => { map.invalidateSize(); fitVisible(); }, 50);
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
  if (pts.length > 1) map.fitBounds(L.latLngBounds(pts), {padding: [40, 40], maxZoom: 15});
  else if (pts.length === 1) map.setView(pts[0], 15);
}

// ---------- map ----------
const map = L.map("map", {minZoom: 12, maxZoom: 18});
map.attributionControl.setPrefix(false);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
}).addTo(map);
const zone = L.circle(GN, {radius: 1000, className: "gn-zone", interactive: false}).addTo(map);
L.marker(GN, {icon: L.divIcon({className: "pw", html: '<span class="gn">Gare du Nord</span>', iconSize: [0, 0]}), interactive: false, keyboard: false}).addTo(map);
const layer = L.layerGroup().addTo(map);
const markers = {};
let popupFor = null;

function pillHtml(x) {
  const s = score(x.id);
  const r = rev(x.id);
  const consensus = r.yes.length + r.no.length ? (s > 0 ? "c-yes" : s < 0 ? "c-no" : "") : "";
  const gone = state.status[x.id]?.status === "removed" ? "gone" : "";
  const cls = ["pill", x.cat, x.kind === "vista" ? "vista" : "", x.approx ? "approx" : "", isNew(x) ? "new" : "", consensus, gone, state.selected === x.id ? "sel" : ""].join(" ");
  const label = x.kind === "vista" ? "Vista" : x.rent == null ? "Ask" : euro(total(x));
  const st = stageOf(x);
  if (state.tab !== "all" && STAGE[st]) return `<span class="${cls} st-${st}">${label}<span class="s">${STAGE[st].pin}</span></span>`;
  const tally = r.yes.length + r.no.length ? `<span class="s">${r.yes.length}✓ ${r.no.length}✗</span>` : isNew(x) ? `<span class="s">new</span>` : "";
  return `<span class="${cls}">${label}${tally}</span>`;
}
function popupContent(x) {
  return el("div", {class: "pop"},
    el("div", {class: "price"}, priceText(x)),
    el("div", {class: "street"}, x.street + " · " + x.area),
    el("div", {class: "facts"}, state.tab === "all" ? whenLabel(x) : `${STAGE[stageOf(x)].label} · ${whenLabel(x)}`),
    state.tab === "all" ? voteRow(x) : el("a", {class: "link", href: x.url, target: "_blank", rel: "noopener"}, "Open on " + x.source + " ↗"));
}
function renderMarkers() {
  layer.clearLayers();
  for (const x of state.flats) {
    const mk = markers[x.id];
    if (!mk) continue;
    mk.setIcon(L.divIcon({className: "pw", html: pillHtml(x), iconSize: [0, 0]}));
    mk.setZIndexOffset(state.selected === x.id ? 1000 : score(x.id) * 10 + (isNew(x) ? 8 : 0) + (x.cat === "fit" ? 5 : 0));
    if (visible(x)) layer.addLayer(mk);
  }
  zone.setRadius(Math.max(state.gnKm, 0.01) * 1000);
  zone.setStyle({opacity: state.gnKm > 0 ? 1 : 0, fillOpacity: state.gnKm > 0 ? 0.07 : 0});
  if (popupFor && markers[popupFor]?.isPopupOpen()) markers[popupFor].setPopupContent(popupContent(state.flats.find((f) => f.id === popupFor)));
}
function select(id, fromMap) {
  state.selected = state.selected === id && !fromMap ? null : id;
  renderAll();
  const x = state.flats.find((f) => f.id === id);
  if (state.selected && x?.lat != null) {
    if (!fromMap) map.panTo([x.lat, x.lng]);
    popupFor = id;
    markers[id].bindPopup(popupContent(x), {offset: [0, -22], autoPanPadding: [20, 20]}).openPopup();
  } else { map.closePopup(); popupFor = null; }
  const prefix = {all: "card-", short: "scard-", contact: "ccard-"}[state.tab];
  if (state.selected && fromMap && matchMedia("(min-width: 901px)").matches) document.getElementById(prefix + id)?.scrollIntoView({block: "nearest", behavior: "smooth"});
}
map.on("popupclose", () => { popupFor = null; });

function renderAll() {
  renderTabs();
  if (state.tab === "all") { renderChips(); renderList(); }
  else if (state.tab === "short") renderShort();
  else renderContact();
  renderMarkers();
}

// ---------- controls ----------
$("#gn-range").addEventListener("input", (e) => {
  state.gnKm = +e.target.value;
  $("#gn-out").textContent = state.gnKm ? state.gnKm.toFixed(1) + " km" : "Off";
  renderList(); renderMarkers();
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
  if (state.tab !== "all") fitVisible(); // the shortlist is only known once the votes are in
  if (db.shared) {
    setInterval(() => { if (!document.hidden) refresh(); }, 30000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  }
})();
