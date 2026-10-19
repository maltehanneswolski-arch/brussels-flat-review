// Finds new rental listings that fit our rules and adds them to data/flats.json.
//
//   node monitor/discover.mjs [--report new.md] [--dry]
//
// Rules (same as the hand-picked list):
//   furnished: rent <= 1300 · unfurnished: rent <= 1000 · at least 1 bedroom, or a studio >= 30 m²
//   no rooms in shared houses · Schaerbeek: any start date · elsewhere: Dec–Jan start or no date
//   Brussels 1000, Ixelles and Woluwe: within 1 km of the areas we pinned on the first map
//
// Every listing it looks at is remembered in monitor/seen.json, so each one is judged once.
// Agency websites listed in monitor/agencies.json are checked too (see agencies.mjs).

import {readFile, writeFile} from "node:fs/promises";
import {checkAgencies} from "./agencies.mjs";
import {domicileFrom} from "./domicile.mjs";

const root = new URL("../", import.meta.url);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const TODAY = new Date().toISOString().slice(0, 10);
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const DRY = process.argv.includes("--dry");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Streets and squares we marked as good on the first map
export const PINS = [[50.86489, 4.39147], [50.84215, 4.39833], [50.84908, 4.37345], [50.84648, 4.38581], [50.86218, 4.39781], [50.85233, 4.40605],
  [50.84453, 4.40948], [50.84117, 4.38306], [50.83792, 4.38804], [50.83911, 4.37071], [50.83857, 4.40142], [50.84366, 4.37483]];
const SCHUMAN = [50.8427, 4.3826];

export function distKm(a, b) {
  const t = Math.PI / 180;
  const dx = (b[1] - a[1]) * t * Math.cos(((a[0] + b[0]) / 2) * t);
  const dy = (b[0] - a[0]) * t;
  return 6371 * Math.sqrt(dx * dx + dy * dy);
}
const nearPins = (lat, lng) => Math.min(...PINS.map((p) => distKm(p, [lat, lng])));

export const AREAS = [
  {pc: "1030", immoweb: "schaerbeek/1030", immovlan: "1030-schaarbeek", anyDate: true, mustBeNear: false, name: () => "Schaerbeek"},
  {pc: "1040", immoweb: "etterbeek/1040", immovlan: "1040-etterbeek", anyDate: false, mustBeNear: false,
    name: (lat, lng) => (lat != null && distKm(SCHUMAN, [lat, lng]) < 0.6 ? "EU quarter" : "Etterbeek")},
  {pc: "1210", immoweb: "saint-josse-ten-noode/1210", immovlan: "1210-saint-josse-ten-noode", anyDate: false, mustBeNear: false, name: () => "Saint-Josse"},
  {pc: "1000", immoweb: "bruxelles/1000", immovlan: "1000-brussels", anyDate: false, mustBeNear: true,
    name: (lat, lng) => (lat < 50.8425 && lng < 4.368 ? "Royal quarter" : "EU quarter")},
  {pc: "1050", immoweb: "ixelles/1050", immovlan: "1050-ixelles", anyDate: false, mustBeNear: true, name: () => "Ixelles"},
  {pc: "1200", immoweb: "woluwe-saint-lambert/1200", immovlan: "1200-woluwe-saint-lambert", anyDate: false, mustBeNear: true, name: () => "Woluwe-St-Lambert"}
];
export const areaFor = (pc) => AREAS.find((a) => a.pc === pc);

const ROOM = /co-?living|colocation|\bcoloc\b|flat-?share|shared (house|apartment|flat)|house to share|room in |private room|\bkot\b|chambre (meublée )?(dans|à louer dans)|kamer in/i;
const NOW_WORDS = /available (immediately|now)|immediately available|disponible (immédiatement|de suite|tout de suite)|libre (immédiatement|de suite)|direct beschikbaar|onmiddellijk beschikbaar/i;

export function startCategory(av) {
  if (!av || av === "TO_BE_DEFINED") return "ask";
  if (av === "IMMEDIATELY" || av < "2026-11-15") return "early";
  if (av <= "2027-01-31") return "fit";
  return "later";
}

// Returns null when the flat fits, otherwise the reason it doesn't.
export function judge(f, text = "") {
  const area = areaFor(f.pc);
  if (!area) return "outside the areas";
  if (f.rent == null) return "no price";
  if (f.furnished === true ? f.rent > 1300 : f.rent > 1000) return "over budget";
  if (ROOM.test(text)) return "room in a shared house";
  const studio = !f.bedrooms || /\bstudio\b/i.test(text.slice(0, 160)); // portals often count a studio as "1 bedroom"
  if (studio && !(f.m2 >= 30)) return "studio under 30 m² or size unknown";
  if (f.m2 && f.m2 < 28) return "under 28 m², too small for two";
  if (area.mustBeNear) {
    if (f.lat == null) return "no address, can't tell if it's near our areas";
    if (nearPins(f.lat, f.lng) > 1.0) return "more than 1 km from our areas";
  }
  if (!area.anyDate) {
    const cat = startCategory(f.available);
    if (cat === "early" || cat === "later") return "starts outside Dec–Jan";
    if (cat === "ask" && NOW_WORDS.test(text)) return "available now";
  }
  return null;
}

// The site shows English only, so the listing's own title (often French or Dutch) isn't copied;
// the card's facts line already gives size, rooms and furnishing.
export function summary() {
  return `Found automatically on ${TODAY.slice(8)}/${TODAY.slice(5, 7)}, not checked by hand yet.`;
}

export async function get(url, accept) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {headers: {"user-agent": UA, "accept-language": "en", ...(accept ? {accept} : {})}, signal: AbortSignal.timeout(30000)});
      return {status: res.status, url: res.url, text: await res.text()};
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(2000 * attempt); // dropped connections happen now and then
    }
  }
}
const plain = (html) => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&euro;/gi, "€").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");

// ---------- Immoweb ----------
export async function immowebIds(area) {
  const ids = [];
  for (let page = 1; page <= 15; page++) {
    const r = await get(`https://www.immoweb.be/en/search-results/apartment/for-rent/${area.immoweb}?countries=BE&maxPrice=1300&orderBy=newest&page=${page}`, "application/json");
    if (r.status !== 200) break;
    const results = JSON.parse(r.text).results || [];
    if (!results.length) break;
    for (const x of results) if (x.property?.subtype !== "KOT") ids.push(String(x.id));
    await sleep(300);
  }
  return ids;
}
async function immowebFlat(id, pc) {
  const r = await get("https://www.immoweb.be/en/classified/" + id);
  const i = r.text.indexOf("window.classified = ");
  if (r.status !== 200 || i < 0) return null;
  const s = r.text.indexOf("{", i);
  const c = JSON.parse(r.text.slice(s, r.text.indexOf("};\n", s) + 1));
  if (c.flags?.isUnderOption || c.flags?.isSoldOrRented) return {skip: "already under option"};
  const p = c.property || {}, t = c.transaction || {}, rent = t.rental || {}, l = p.location || {};
  const f = {
    id, kind: "listing", source: "Immoweb", url: "https://www.immoweb.be/en/classified/" + id, pc,
    street: [l.street, l.number].filter(Boolean).join(" ") || "Address not given",
    lat: l.latitude ?? null, lng: l.longitude ?? null, approx: false,
    furnished: rent.isFurnished === true, rent: rent.monthlyRentalPrice ?? null, charges: rent.monthlyRentalCosts ?? null,
    bedrooms: p.bedroomCount ?? null, m2: p.netHabitableSurface ?? null, floor: l.floor ?? null,
    epc: t.certificates?.epcScore || null, lift: !!(p.building?.hasLift ?? p.hasLift), terrace: p.terraceSurface || (p.hasTerrace ? true : null), garden: !!p.hasGarden,
    available: t.availabilityDate || t.availabilityPeriodType || null
  };
  return {flat: f, text: `${p.title || ""} ${p.description || ""}`, title: p.title};
}

// ---------- Immovlan ----------
export async function immovlanLinks(area) {
  const links = new Set();
  for (let page = 1; page <= 12; page++) {
    const r = await get(`https://immovlan.be/en/real-estate?transactiontypes=for-rent&propertytypes=apartment,flat,studio,duplex,penthouse,loft&towns=${area.immovlan}&maxprice=1300&noindex=1&page=${page}`);
    const before = links.size;
    for (const m of r.text.matchAll(/href="([^"]*\/detail\/[^"]*for-rent\/[^"]+)"/g)) links.add(new URL(m[1], "https://immovlan.be").href);
    if (links.size === before) break;
    await sleep(300);
  }
  return [...links];
}
async function immovlanFlat(url, pc) {
  const r = await get(url);
  const text = plain(r.text);
  if (r.status !== 200 || !/Rent [\d ]+ €/.test(text)) return null;
  const num = (re) => { const m = text.match(re); return m ? Number(m[1].replace(/\s/g, "")) : null; };
  const ll = r.text.match(/"latitude"\s*:\s*"?([\d.]+)"?[\s\S]{0,80}?"longitude"\s*:\s*"?([\d.]+)/);
  let lat = ll ? Number(ll[1]) : null, lng = ll ? Number(ll[2]) : null;
  if (lat != null && (lat < 50.7 || lat > 51)) { lat = null; lng = null; } // some listings carry placeholder coordinates
  const title = (r.text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1]?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "";
  const desc = (text.match(/Description (.{0,1500})/) || [])[1] || "";
  const avRaw = (text.match(/Availability (From \d\d\/\d\d\/\d{4}|Immediately|[A-Za-z ]{3,30}?) (?:Financial|Currently|Build|Rent|General)/) || [])[1] || null;
  const furnField = (text.match(/Furnished (Yes|No)/) || [])[1];
  const furnished = furnField ? furnField === "Yes" : /\b(fully furnished|furnished (flat|apartment|studio)|entièrement meublé|meublé)\b/i.test(desc) && !/unfurnished|non meublé/i.test(desc);
  const street = ((text.match(/for rent, [^ ]+ \w+ (.{2,60}?) , \d{4}/) || [])[1] || "").trim();
  const code = url.split("/").pop();
  const f = {
    id: code, kind: "listing", source: "Immovlan", url, pc,
    street: street && street !== "-" ? street : "Address not given",
    lat, lng, approx: false, furnished,
    rent: num(/Rent ([\d ]+) €/), charges: num(/(?:Maintenance cost|Charges) ([\d ]+) €/),
    bedrooms: num(/Number of bedrooms (\d+)/), m2: num(/Livable surface (\d+)/), floor: null, epc: null,
    lift: false, terrace: /Terrace Yes/.test(text) ? (num(/Surface terrace (\d+)/) || true) : null, garden: /Garden Yes/.test(text),
    available: avRaw ? avRaw.replace(/^From (\d\d)\/(\d\d)\/(\d{4})$/, "$3-$2-$1").replace(/^Immediately$/, "IMMEDIATELY") : null
  };
  if (/under option|sous option/i.test(text.slice(0, 4000))) return {skip: "already under option"};
  return {flat: f, text: `${title} ${desc}`, page: text, title: title.replace(/ [A-Z]{3}\d+$/, "").replace(/^(Apartment|Studio|Duplex|Flat|Penthouse|Loft) for rent, .*$/i, "")};
}

// Same flat already on the map under another site?
export function duplicateOf(f, flats) {
  return flats.find((g) => g.rent === f.rent && (
    (f.m2 && g.m2 === f.m2 && (g.charges ?? null) === (f.charges ?? null) && (g.available ?? null) === (f.available ?? null)) ||
    (f.lat != null && g.lat != null && distKm([f.lat, f.lng], [g.lat, g.lng]) < 0.15) ||
    (f.street !== "Address not given" && g.street && g.street.toLowerCase().split(/[ ,]/)[0] === f.street.toLowerCase().split(/[ ,]/)[0] && g.street.toLowerCase().includes(f.street.toLowerCase().split(" ").slice(0, 3).join(" ")))
  ));
}

// ---------- run ----------
export async function main() {
  const data = JSON.parse(await readFile(new URL("data/flats.json", root), "utf8"));
  const seenPath = new URL("monitor/seen.json", root);
  let seen;
  try { seen = JSON.parse(await readFile(seenPath, "utf8")); } catch { seen = {immoweb: {}, immovlan: {}, agencies: {}}; }
  const known = new Set(data.flats.map((f) => f.id));
  const added = [], looked = {immoweb: 0, immovlan: 0, agencies: 0};

  const consider = (found, site, key) => {
    if (!found || found.skip) { seen[site][key] = TODAY + (found?.skip ? " " + found.skip : " unreadable"); return; }
    const f = found.flat;
    const why = judge(f, found.text);
    const dup = why ? null : duplicateOf(f, data.flats);
    seen[site][key] = TODAY + " " + (why || (dup ? "same as " + dup.id : "added"));
    if (why || dup) return;
    const area = areaFor(f.pc);
    const dom = domicileFrom(found.page || found.text); // the whole Immovlan page: the domiciliation line is often far down
    const flat = {...f, area: area.name(f.lat, f.lng), description: summary(), domicile: dom.domicile, domicileQuote: dom.quote, added: TODAY};
    delete flat.pc;
    data.flats.push(flat); known.add(flat.id); added.push(flat);
  };

  for (const area of AREAS) {
    for (const id of await immowebIds(area)) {
      if (known.has(id) || seen.immoweb[id]) continue;
      looked.immoweb++;
      try { consider(await immowebFlat(id, area.pc), "immoweb", id); } catch (e) { console.error("immoweb", id, e.message); }
      await sleep(400);
    }
    for (const url of await immovlanLinks(area)) {
      const code = url.split("/").pop();
      if (known.has(code) || seen.immovlan[code]) continue;
      looked.immovlan++;
      try { consider(await immovlanFlat(url, area.pc), "immovlan", code); } catch (e) { console.error("immovlan", code, e.message); }
      await sleep(400);
    }
  }

  try {
    for (const found of await checkAgencies(seen, known)) {
      looked.agencies++;
      consider(found, "agencies", found.key);
    }
  } catch (e) { console.error("agencies:", e.message); }

  console.log(`Looked at ${looked.immoweb} Immoweb, ${looked.immovlan} Immovlan and ${looked.agencies} agency listings not seen before.`);
  console.log(added.length ? `Added ${added.length}:` : "Nothing new fits the rules.");
  for (const f of added) console.log(`- ${f.street} (${f.area}) ${f.rent == null ? "price on request" : "€" + (f.rent + (f.charges || 0))}, ${f.available || "no date"}: ${f.url}`);

  if (!DRY) {
    data.checked = TODAY;
    await writeFile(seenPath, JSON.stringify(seen, null, 0).replace(/","/g, '",\n"') + "\n");
    await writeFile(new URL("data/flats.json", root), JSON.stringify(data, null, 1) + "\n");
  }
  const report = arg("--report");
  if (report && added.length) {
    const when = (av) => !av || av === "TO_BE_DEFINED" ? "no start date" : av === "IMMEDIATELY" ? "free now" : "from " + new Date(av + "T00:00:00").toLocaleDateString("en-GB", {day: "numeric", month: "short", year: "numeric"});
    const lines = added.map((f) => `- [${f.street} (${f.area})](${f.url}): ${f.rent == null ? "price on request" : `€${(f.rent + (f.charges || 0)).toLocaleString("en-US")} a month`}, ${f.furnished ? "furnished" : "unfurnished"}, ${f.bedrooms ? f.bedrooms + "-bed" : "studio"}${f.m2 ? ", " + f.m2 + " m²" : ""}, ${when(f.available)} · ${f.source}`);
    await writeFile(report, [`**${added.length} new flat${added.length > 1 ? "s" : ""}** fit the rules today. They show in purple on the map for 2 days.`, "", ...lines, ""].join("\n"));
  }
  return added;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("monitor/discover.mjs")) await main();
