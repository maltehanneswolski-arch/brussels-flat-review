// Small agencies' own websites, listed in monitor/agencies.json. Three kinds of site:
//   "html"          listing links on a plain page; each listing page is read for rent, size, date, address
//   "omnicasa"      Omnicasa sites (Gatsby): the data sits in /page-data/…/page-data.json files
//   "expertissimmo" Whise list served as JSON by the agency's own proxy
//
// For every listing not seen before, returns what discover.mjs needs to judge it:
//   {key, flat, text, title}  or  {key, skip}

import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";

const root = new URL("../", import.meta.url);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POSTCODES = ["1030", "1040", "1000", "1210", "1050", "1200"];
const COMMUNES = [
  [/schaerbeek|schaarbeek/i, "1030"], [/etterbeek/i, "1040"], [/saint-josse|sint-joost/i, "1210"],
  [/ixelles|elsene/i, "1050"], [/woluwe-saint-lambert|sint-lambrechts-woluwe|woluwe st lambert/i, "1200"],
  [/\b(bruxelles|brussel|brussels)\b/i, "1000"]
];
const ROOM_TYPE = /^\s*(gemeubileerde?\s+|furnished\s+)?(slaap)?(kamer|room|chambre)(\s+meublée)?\s*$/i;
const idFor = (url) => "ag-" + createHash("sha1").update(url).digest("hex").slice(0, 12);

async function get(url, headers = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {headers: {"user-agent": UA, "accept-language": "en,fr;q=0.9,nl;q=0.8", ...headers}, signal: AbortSignal.timeout(45000)});
      return {status: res.status, url: res.url, text: await res.text()};
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(2000 * attempt);
    }
  }
}

export const plain = (html) => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/<!--\s*-->/g, "")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&euro;/gi, "€").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&eacute;/g, "é").replace(/&egrave;/g, "è").replace(/&sup2;/g, "²")
  .replace(/[  ]/g, " ")
  .replace(/\s+/g, " ");

const money = (s) => (s == null ? null : Number(String(s).replace(/,\d{2}$/, "").replace(/[.\s,]/g, "")));
const first = (text, res) => { for (const re of res) { const m = text.match(re); if (m) return m; } return null; };
// First Brussels postcode followed by a place name ("1160 AUDERGHEM", "1030-schaerbeek"), so a flat
// outside our areas isn't mistaken for one inside them because the agency's office is in 1040.
const BXL = "1000|1020|1030|1040|1050|1060|1070|1080|1081|1082|1083|1090|1120|1130|1140|1150|1160|1170|1180|1190|1200|1210";
function postcodeIn(text) {
  const m = text.match(new RegExp(`\\b(${BXL})\\b(?=\\s*[-,]?\\s*[A-Za-zÀ-ÿ])(?!\\s*m²)`));
  if (m) return m[1];
  for (const [re, pc] of COMMUNES) if (re.test(text)) return pc;
  return null;
}

// Pull the facts out of a listing page (FR/NL/EN). A site can override any pattern in agencies.json.
export function parseListing(html, site = {}, url = "") {
  const text = plain(html);
  const re = (name, fallback) => (site[name] ? [new RegExp(site[name], "i")] : fallback);

  const rentM = first(text, re("rentRe", [
    /(?:loyer(?: mensuel)?|monthly rent|rent|huurprijs|huur|prix|price)\s*:?\s*(?:€|EUR)?\s*(\d{1,2}[. ]?\d{3}|\d{3,4})(?:,\d{2})?\s*(?:€|EUR|eur|\/)/i,
    /(?:€|EUR)\s*(\d{1,2}[. ]?\d{3}|\d{3,4})(?:,\d{2})?\s*(?:\/|par|per|p\.?)\s*(?:mois|month|maand|m\b)/i,
    /(\d{1,2}[. ]?\d{3}|\d{3,4})(?:,\d{2})?\s*(?:€|EUR)\s*(?:\/|par|per|p\.?)\s*(?:mois|month|maand|m\b)/i
  ]));
  const chargesM = first(text, re("chargesRe", [
    /(?:charges|provisions?|frais communs|loads|kosten|lasten)[^€\d]{0,35}(?:€|EUR)\s*(\d{2,4})/i,
    /(?:charges|provisions?|frais communs|loads|kosten|lasten)[^€\d]{0,35}(\d{2,4})(?:,\d{2})?\s*(?:€|EUR)/i
  ]));
  const bedM = first(text, re("bedroomsRe", [
    /(?:chambres?(?: à coucher)?|bedrooms?|slaapkamers?)\s*:?\s*(\d)\b/i,
    /\b(\d)\s*(?:chambres?|ch\.|bedrooms?|slaapkamers?|slpk)\b/i
  ]));
  // Size: a labelled living area if there is one; otherwise the largest "NN m²" on the page
  // (the first one is often a single room, e.g. "séjour de 22 m²").
  let m2M = first(text, re("m2Re", [
    /(?:surface habitable|superficie habitable|living area|habitable|bewoonbare oppervlakte|surface|superficie|oppervlakte)\s*:?\s*(?:±|\+\/-|env\.?)?\s*(\d{2,3})(?:[.,]\d+)?\s*m(?:²|2|\b)/i,
    /(?<![\d.,])(\d{2,3})(?:[.,]\d+)?\s*m² habitables/i
  ]));
  if (!m2M) {
    const sizes = [...text.slice(0, 8000).matchAll(/(?<![\d.,])(\d{2,3})(?:[.,]\d+)?\s*m²/gi)].map((m) => Number(m[1])).filter((n) => n >= 15 && n <= 200);
    if (sizes.length) m2M = [null, String(Math.max(...sizes))];
  }
  const AV = "(?:disponibilit[ée]|disponible|libre(?: d'occupation)?|availability|available|beschikbaar(?:heid)?|vrij)";
  const LEAD = "\\s*(?:à partir du|à partir de|dès le|le|from|vanaf|op|on)?\\s*:?\\s*";
  const availM = first(text, re("availableRe", [
    new RegExp(AV + LEAD + "(\\d{1,2})[\\/.\\-](\\d{1,2})[\\/.\\-](\\d{2,4})", "i")
  ]));
  // "libre le 1er décembre", "disponible à partir du 6 octobre 2026", "Available from November 30, 2026"
  const MONTHS = {janvier: 1, january: 1, januari: 1, février: 2, fevrier: 2, february: 2, februari: 2, mars: 3, march: 3, maart: 3, avril: 4, april: 4,
    mai: 5, may: 5, mei: 5, juin: 6, june: 6, juni: 6, juillet: 7, july: 7, juli: 7, août: 8, aout: 8, august: 8, augustus: 8, septembre: 9, september: 9,
    octobre: 10, october: 10, oktober: 10, novembre: 11, november: 11, décembre: 12, decembre: 12, december: 12};
  const MN = Object.keys(MONTHS).join("|");
  const dayFirst = text.match(new RegExp(AV + LEAD + "(\\d{1,2})(?:er|st|nd|rd|th)?\\s+(" + MN + ")\\b\\s*(\\d{4})?", "i"));
  const monthFirst = text.match(new RegExp(AV + LEAD + "(" + MN + ")\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?", "i"));
  const named = dayFirst ? {d: dayFirst[1], m: MONTHS[dayFirst[2].toLowerCase()], y: dayFirst[3]} : monthFirst ? {d: monthFirst[2], m: MONTHS[monthFirst[1].toLowerCase()], y: monthFirst[3]} : null;
  const nowM = new RegExp(AV + "\\s*:?\\s*(?:immédiatement|de suite|tout de suite|immediately|now|onmiddellijk|direct)", "i").test(text);

  let furnished;
  const furnField = text.match(/(?:meublé|furnished|gemeubeld)\s*:?\s*(oui|non|yes|no|ja|nee)\b/i);
  if (site.furnishedRe) furnished = new RegExp(site.furnishedRe, "i").test(text);
  else if (furnField) furnished = /^(oui|yes|ja)$/i.test(furnField[1]);
  // (?<![\wÀ-ÿ]) instead of \b: in JavaScript \b doesn't see "é" as part of a word
  else furnished = /(?<![\wÀ-ÿ])(meublée?|furnished|gemeubeld|gemeubileerd)(?![\wÀ-ÿ])/i.test(text.slice(0, 3000)) &&
    !/(?<![\wÀ-ÿ])(non[- ]meublée?|unfurnished|niet gemeubeld|ongemeubeld)(?![\wÀ-ÿ])/i.test(text);

  let available = null;
  if (availM) {
    const y = availM[3].length === 2 ? "20" + availM[3] : availM[3];
    available = `${y}-${availM[2].padStart(2, "0")}-${availM[1].padStart(2, "0")}`;
  } else if (named && named.m) {
    const now = new Date();
    const y = named.y || (named.m < now.getMonth() + 1 ? now.getFullYear() + 1 : now.getFullYear());
    available = `${y}-${String(named.m).padStart(2, "0")}-${String(named.d).padStart(2, "0")}`;
  } else if (nowM) available = "IMMEDIATELY";

  let lat = null, lng = null;
  const geo = html.match(/"latitude"\s*:\s*"?(50\.\d{3,})"?[\s\S]{0,120}?"longitude"\s*:\s*"?(4\.\d{3,})/) ||
    html.match(/(?:data-)?lat(?:itude)?["'\s:=]+(50\.\d{3,})[\s\S]{0,120}?(?:data-)?(?:lng|lon|longitude)["'\s:=]+(4\.\d{3,})/i) ||
    html.match(/[?&](?:q|ll|center|query|destination)=(50\.\d{3,}),\s*(4\.\d{3,})/);
  if (geo) { lat = Number(geo[1]); lng = Number(geo[2]); }
  const streetLd = (html.match(/"streetAddress"\s*:\s*"([^"]{4,80})"/) || [])[1];
  const streetM = streetLd ? [null, streetLd] : first(text, re("streetRe", [
    /\b((?:Rue|Avenue|Boulevard|Chaussée|Place|Square|Clos|Allée|Drève|Quai|Impasse|Parvis)\s+(?:de la |du |des |de l'|d'|de |)[A-ZÉÈ][\w'’\-éèêëàâîïôöûüç]+(?:[ \-][A-ZÉÈ][\w'’\-éèêëàâîïôöûüç]+){0,3}(?:\s+\d{1,4}[A-Za-z]?)?)/,
    /\b([A-Z][\w'’\-éèëç]+(?:straat|laan|steenweg|plein))(?:\s+\d{1,4})?/
  ]));
  const title = plain((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "").trim();

  return {
    rent: rentM ? money(rentM[1]) : null,
    charges: chargesM ? money(chargesM[1]) : null,
    bedrooms: bedM ? Number(bedM[1]) : (/\bstudio\b/i.test(title) ? 0 : null),
    m2: m2M ? Number(m2M[1]) : null,
    furnished,
    available,
    postcode: site.postcodeFrom === "url"
      ? postcodeIn(decodeURIComponent(url)) || postcodeIn(title)
      : postcodeIn(title) || postcodeIn(decodeURIComponent(url)) || postcodeIn(text.slice(0, 6000)),
    // some sites never show the street; there the first street on the page is the agency's own office
    street: site.noStreet ? null : streetM ? streetM[1].trim() : null,
    lat, lng,
    title: title.slice(0, 120),
    text: text.slice(0, 5000)
  };
}

// Address → coordinates via OpenStreetMap (at most one request a second, as their usage rules ask)
let lastGeocode = 0;
async function geocode(street, postcode) {
  const wait = 1100 - (Date.now() - lastGeocode);
  if (wait > 0) await sleep(wait);
  lastGeocode = Date.now();
  try {
    const q = encodeURIComponent(`${street}, ${postcode} Bruxelles, Belgique`);
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=be&q=${q}`, {
      headers: {"user-agent": "brussels-flat-review (https://github.com/maltehanneswolski-arch/brussels-flat-review)"}
    });
    const j = await res.json();
    return j[0] ? [Number(j[0].lat), Number(j[0].lon)] : null;
  } catch { return null; }
}

const flatFrom = (site, url, f) => ({
  id: idFor(url), kind: "listing", source: site.name, url, pc: f.postcode,
  street: f.street || "Address not given", lat: f.lat ?? null, lng: f.lng ?? null, approx: false,
  furnished: !!f.furnished, rent: f.rent ?? null, charges: f.charges ?? null, bedrooms: f.bedrooms ?? null, m2: f.m2 ?? null,
  floor: null, epc: null, lift: false, terrace: null, garden: false, available: f.available ?? null
});

// ---------- "html" sites ----------
async function htmlSite(site, seen) {
  let links = [];
  for (const listUrl of [].concat(site.rentalsUrl)) {
    const page = await get(listUrl);
    if (page.status !== 200) { console.error(`${site.name}: list page answered ${page.status}`); continue; }
    const attr = site.linkAttr || "href";
    const pattern = new RegExp(site.linkPattern, "i");
    for (const m of page.text.matchAll(new RegExp(`${attr}=["']([^"'#]+)["']`, "gi"))) {
      const href = new URL(m[1].replace(/&amp;/g, "&"), listUrl).href;
      if (pattern.test(href)) links.push(href);
    }
    await sleep(800);
  }
  links = [...new Set(links)].slice(0, site.maxListings || 80);
  const out = [];
  for (const url of links) {
    if (seen.agencies[url]) continue;
    const page = await get(url);
    if (page.status !== 200) { out.push({key: url, skip: "page answered " + page.status}); continue; }
    const p = parseListing(page.text, site, url);
    if (/sous[- ]option|under option|onder optie|(?<![\wÀ-ÿ])(loué|rented|verhuurd)(?![\wÀ-ÿ])/i.test(p.title + " " + url)) { out.push({key: url, skip: "already under option or rented"}); continue; }
    if (/\b(à vendre|for sale|te koop)\b/i.test(p.title)) { out.push({key: url, skip: "for sale"}); continue; }
    if (!POSTCODES.includes(p.postcode)) { out.push({key: url, skip: "outside the areas"}); continue; }
    if (p.lat == null && p.street) {
      const c = await geocode(p.street, p.postcode);
      if (c) { p.lat = c[0]; p.lng = c[1]; }
    }
    out.push({key: url, flat: flatFrom(site, url, p), text: `${p.title} ${p.text}`, title: p.title});
    await sleep(800);
  }
  return out;
}

// ---------- Omnicasa (Gatsby) sites ----------
function collect(o, test, acc = []) {
  if (Array.isArray(o)) o.forEach((v) => collect(v, test, acc));
  else if (o && typeof o === "object") { if (test(o)) acc.push(o); else Object.values(o).forEach((v) => collect(v, test, acc)); }
  return acc;
}
async function omnicasaSite(site, seen) {
  const base = site.website.replace(/\/+$/, "");
  const list = await get(base + site.listData);
  if (list.status !== 200) { console.error(`${site.name}: list data answered ${list.status}`); return []; }
  const byId = new Map();
  for (const o of collect(JSON.parse(list.text), (x) => "ID" in x && "Price" in x && "Zip" in x)) if (!byId.has(o.ID)) byId.set(o.ID, o);
  const sitemap = (await get(base + "/sitemap/sitemap-0.xml")).text;
  const urlFor = (id) => {
    const all = [...sitemap.matchAll(new RegExp(`<loc>([^<]*/${id}/)</loc>`, "g"))].map((m) => m[1]);
    return all.find((u) => /\/en\//.test(u)) || all.find((u) => /\/fr\//.test(u)) || all[0];
  };
  const out = [];
  for (const o of byId.values()) {
    if (o.Goal !== 1 || /verhuurd|loué|rented/i.test(o.SubStatusName || "")) continue;
    const zip = String(o.Zip);
    const type = `${o.MainTypeName || ""} ${o.TypeDescription || ""}`;
    const furnished = /gemeubeld|gemeubileerd|furnished|meublé/i.test(type) && !/niet gemeubeld|unfurnished|non meublé/i.test(type);
    if (!POSTCODES.includes(zip) || !o.Price || o.Price > (furnished ? 1300 : 1000)) continue;
    const url = urlFor(o.ID);
    if (!url || seen.agencies[url]) continue;
    if (ROOM_TYPE.test(o.TypeDescription || "")) { out.push({key: url, skip: "room in a shared house"}); continue; }
    if (/optie|option/i.test(o.SubStatusName || "")) { out.push({key: url, skip: "already under option"}); continue; }
    let detail = {};
    try {
      const d = await get(`${base}/page-data${new URL(url).pathname}page-data.json`);
      detail = collect(JSON.parse(d.text), (x) => x.ID === o.ID && "DateFree" in x)[0] || {};
    } catch { /* list data is enough to judge most flats */ }
    const lat = Number(o.GoogleX), lng = Number(o.GoogleY);
    const okGeo = lat > 50.7 && lat < 51 && lng > 4.2 && lng < 4.6;
    const available = detail.DateFree ? detail.DateFree.slice(0, 10) : /immediate/i.test(detail.FreeWhenSoldName || "") ? "IMMEDIATELY" : null;
    const f = {
      postcode: zip, street: [o.Street, o.HouseNumber].filter(Boolean).join(" ") || null,
      lat: okGeo ? lat : null, lng: okGeo ? lng : null, furnished, rent: o.Price,
      charges: detail.ChargesRenter || null, bedrooms: o.NumberOfBedRooms ?? null, m2: o.SurfaceTotal || null, available
    };
    if (f.lat == null && f.street) { const c = await geocode(f.street, zip); if (c) { f.lat = c[0]; f.lng = c[1]; } }
    out.push({key: url, flat: flatFrom(site, url, f), text: `${o.TypeDescription || ""} ${(o.DescriptionA || "").slice(0, 2000)}`, title: ""});
    await sleep(600);
  }
  return out;
}

// ---------- Expertissimmo (Whise list through the agency's own proxy) ----------
const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['\s]+/g, "-");
async function expertissimmoSite(site, seen) {
  const filter = {Filter: {LanguageId: "fr-BE", CategoryIds: [2], PurposeIds: [2], PurposeStatusIds: [2], ShowDetails: false}, Page: {Offset: 0, Limit: 100}, Sort: [{Field: "updateDateTime", Ascending: false}]};
  const r = await get("https://expertissimmo.eu/proxy/https://api.whise.eu/v1/estates/list/proxydata/EstateServiceGetEstateListRequest=" + encodeURIComponent(JSON.stringify(filter)));
  if (r.status !== 200) { console.error(`${site.name}: list answered ${r.status}`); return []; }
  const out = [];
  for (const e of JSON.parse(r.text).estates || []) {
    const pcGuess = postcodeIn(e.city || "");
    const furnished = e.furnished === 1;
    if (!pcGuess || e.purposeStatus?.id !== 2 || !e.price || e.price > (furnished ? 1300 : 1000)) continue;
    const url = `https://expertissimmo.eu/fr/nos-biens/a-louer/${e.id}/${e.category?.id ?? 2}-${slug(e.city)}`;
    if (seen.agencies[url]) continue;
    const page = await get(url);
    const p = page.status === 200 ? parseListing(page.text, site, url) : {};
    const f = {...p, postcode: p.postcode && POSTCODES.includes(p.postcode) ? p.postcode : pcGuess, furnished, rent: e.price, bedrooms: e.rooms ?? p.bedrooms, m2: e.area || p.m2};
    if (f.lat == null && f.street) { const c = await geocode(f.street, f.postcode); if (c) { f.lat = c[0]; f.lng = c[1]; } }
    out.push({key: url, flat: flatFrom(site, url, f), text: `${p.title || ""} ${p.text || ""}`, title: p.title || ""});
    await sleep(800);
  }
  return out;
}

const KINDS = {html: htmlSite, omnicasa: omnicasaSite, expertissimmo: expertissimmoSite};

export async function checkAgencies(seen, known, only) {
  let sites;
  try { sites = JSON.parse(await readFile(new URL("monitor/agencies.json", root), "utf8")); } catch { return []; }
  const out = [];
  for (const site of sites.filter((s) => s.enabled !== false && (!only || s.name === only))) {
    try {
      const found = await KINDS[site.type || "html"](site, seen);
      out.push(...found);
      console.log(`${site.name}: ${found.length} listing${found.length === 1 ? "" : "s"} to judge`);
    } catch (e) { console.error(`${site.name}: ${e.message}`); }
  }
  return out;
}
