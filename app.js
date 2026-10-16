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
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
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

// ---------- state ----------
const state = {
  flats: [], areas: [], checked: "2026-10-16",
  areaOn: new Set(), cats: new Set(["fit", "ask", "later"]), furn: new Set(["f", "u"]),
  gnKm: 1, sort: "score", selected: null,
  rows: [], byFlat: {}, lastSync: null
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

async function refresh() {
  try {
    state.rows = await db.load();
    state.byFlat = aggregate(state.rows);
    state.lastSync = new Date();
    renderAll();
  } catch (e) {
    $("#sync").textContent = "Couldn't load reviews. Retrying…";
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

// ---------- filters ----------
function visible(x) {
  if (!state.areaOn.has(x.area)) return false;
  if (!state.cats.has(x.cat)) return false;
  if (!state.furn.has(x.furnished === true ? "f" : "u")) return false;
  if (x.d != null && x.d < state.gnKm) return false;
  return true;
}
function sorted(list) {
  const by = {
    score: (a, b) => (score(b.id) - score(a.id)) || (CAT_ORDER[a.cat] - CAT_ORDER[b.cat]) || ((total(a) ?? 1e9) - (total(b) ?? 1e9)),
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
  return el("article", {class: "card" + (sel ? " sel" : ""), role: "listitem", id: "card-" + x.id},
    el("div", {class: "chead"},
      el("button", {class: "selbtn", type: "button", "aria-expanded": String(sel), onclick: () => select(x.id)},
        el("span", {class: "price"}, priceText(x), " ", el("small", {}, x.rent == null ? "price and dates on request" : x.charges ? `${euro(x.rent)} rent + ${euro(x.charges)} charges` : "rent, charges not stated")),
        el("span", {class: "street"}, x.street)
      ),
      el("span", {class: "when " + x.cat}, whenLabel(x))
    ),
    el("div", {class: "facts"}, facts.join(" · "), x.epc ? el("span", {class: "peb " + x.epc, title: "Energy class (PEB) " + x.epc}, "PEB " + x.epc) : null),
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
  const reviewers = new Set(state.rows.filter((r) => r.verdict !== "none" || r.comment).map((r) => r.reviewer_id)).size;
  $("#count").textContent = `${vis.length} of ${state.flats.length} flats` + (hidden ? ` · ${hidden} hidden near Gare du Nord` : "") + (reviewers ? ` · ${reviewers} reviewer${reviewers > 1 ? "s" : ""}` : "");
  $("#sync").textContent = db.shared && state.lastSync ? "Updated " + state.lastSync.toLocaleTimeString("en-GB", {hour: "2-digit", minute: "2-digit"}) : "";
  const keepScroll = list.scrollTop;
  const typing = document.activeElement?.id?.startsWith("comment-") ? {id: document.activeElement.id, v: document.activeElement.value} : null;
  list.replaceChildren(...(vis.length ? vis.map(card) : [el("div", {class: "empty"}, "No flats match these filters. Turn an area or start date back on.")]));
  list.scrollTop = keepScroll;
  if (typing) { const t = document.getElementById(typing.id); if (t) { t.value = typing.v; t.focus(); } }
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
  const cls = ["pill", x.cat, x.kind === "vista" ? "vista" : "", x.approx ? "approx" : "", consensus, state.selected === x.id ? "sel" : ""].join(" ");
  const label = x.kind === "vista" ? "Vista" : euro(total(x));
  const tally = r.yes.length + r.no.length ? `<span class="s">${r.yes.length}✓ ${r.no.length}✗</span>` : "";
  return `<span class="${cls}">${label}${tally}</span>`;
}
function popupContent(x) {
  return el("div", {class: "pop"},
    el("div", {class: "price"}, priceText(x)),
    el("div", {class: "street"}, x.street + " · " + x.area),
    el("div", {class: "facts"}, whenLabel(x)),
    voteRow(x));
}
function renderMarkers() {
  layer.clearLayers();
  for (const x of state.flats) {
    const mk = markers[x.id];
    if (!mk) continue;
    mk.setIcon(L.divIcon({className: "pw", html: pillHtml(x), iconSize: [0, 0]}));
    mk.setZIndexOffset(state.selected === x.id ? 1000 : score(x.id) * 10 + (x.cat === "fit" ? 5 : 0));
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
  if (state.selected && fromMap && matchMedia("(min-width: 901px)").matches) document.getElementById("card-" + id)?.scrollIntoView({block: "nearest", behavior: "smooth"});
}
map.on("popupclose", () => { popupFor = null; });

function renderAll() { renderChips(); renderList(); renderMarkers(); }

// ---------- controls ----------
$("#gn-range").addEventListener("input", (e) => {
  state.gnKm = +e.target.value;
  $("#gn-out").textContent = state.gnKm ? state.gnKm.toFixed(1) + " km" : "Off";
  renderList(); renderMarkers();
});
$("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });

// ---------- boot ----------
(async () => {
  const data = await (await fetch("data/flats.json")).json();
  state.checked = data.checked;
  state.areas = data.areas;
  state.areaOn = new Set(data.areas);
  state.flats = data.flats.map((x) => ({...x, cat: catOf(x, data.checked), d: x.lat != null ? distKm(x.lat, x.lng) : null}));
  $("#checked").textContent = fmtDate(data.checked) + " " + data.checked.slice(0, 4);
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
  const pts = state.flats.filter((x) => x.lat != null && visible(x)).map((x) => [x.lat, x.lng]);
  map.fitBounds(L.latLngBounds(pts), {padding: [30, 30]});
  await refresh();
  if (db.shared) {
    setInterval(() => { if (!document.hidden) refresh(); }, 30000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  }
})();
