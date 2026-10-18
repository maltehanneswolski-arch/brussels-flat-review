// Small agencies' own websites. Each one in monitor/agencies.json says where its rental
// listings are and how to recognise a listing link; the rest is read from the listing page.
//
// For every listing page not seen before, this returns what discover.mjs needs to judge it:
//   {key, flat, text, title} or {key, skip}

import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";

const root = new URL("../", import.meta.url);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POSTCODES = ["1030", "1040", "1000", "1210", "1050", "1200"];
const COMMUNES = [
  [/schaerbeek|schaarbeek/i, "1030"], [/etterbeek/i, "1040"], [/saint-josse|sint-joost/i, "1210"],
  [/ixelles|elsene/i, "1050"], [/woluwe-saint-lambert|sint-lambrechts-woluwe|woluwe st lambert/i, "1200"],
  [/bruxelles|brussel|brussels/i, "1000"]
];

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {headers: {"user-agent": UA, "accept-language": "en,fr;q=0.9,nl;q=0.8"}, signal: AbortSignal.timeout(30000)});
      return {status: res.status, url: res.url, text: await res.text()};
    } catch (e) {
      if (attempt >= 3) throw e;
      await sleep(2000 * attempt);
    }
  }
}

export const plain = (html) => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
  .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, " \n ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&euro;/gi, "€").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&eacute;/g, "é").replace(/&egrave;/g, "è").replace(/&sup2;/g, "²")
  .replace(/[ \t\r\f\v]+/g, " ");

const money = (s) => (s == null ? null : Number(String(s).replace(/[.\s ]/g, "").replace(/,\d{2}$/, "").replace(/,/g, "")));
const first = (text, res) => { for (const re of res) { const m = text.match(re); if (m) return m; } return null; };

function postcodeOf(text) {
  const m = text.match(/\b(1030|1040|1000|1210|1050|1200)\s+[A-ZÉa-zé]/);
  if (m) return m[1];
  for (const [re, pc] of COMMUNES) if (re.test(text)) return pc;
  return null;
}

// Pull the facts we need out of a listing page. Works on most agency sites (FR/NL/EN);
// a site can override any regex in agencies.json ("rentRe", "streetRe", ...).
export function parseListing(html, site = {}) {
  const text = plain(html);
  const flat = text.replace(/\s*\n\s*/g, " ");
  const re = (name, fallback) => (site[name] ? [new RegExp(site[name], "i")] : fallback);

  const rentM = first(flat, re("rentRe", [
    /(?:loyer(?: mensuel)?|rent|monthly rent|huurprijs|huur|prix|price)\s*:?\s*(?:€|EUR)?\s*([\d][\d. ]{2,6})(?:,\d{2})?\s*(?:€|EUR|eur)/i,
    /(?:€|EUR)\s*([\d][\d. ]{2,6})(?:,\d{2})?\s*(?:\/|par|per|p\.?)\s*(?:mois|month|maand|m\b)/i,
    /([\d][\d. ]{2,6})(?:,\d{2})?\s*(?:€|EUR)\s*(?:\/|par|per|p\.?)\s*(?:mois|month|maand|m\b)/i
  ]));
  const chargesM = first(flat, re("chargesRe", [
    /(?:charges|provisions?|frais communs|kosten|lasten)[^€\d]{0,30}(?:€|EUR)?\s*([\d][\d.]{0,4})(?:,\d{2})?\s*(?:€|EUR)/i,
    /\+\s*(?:€|EUR)?\s*([\d]{2,3})\s*(?:€|EUR)?\s*(?:de )?(?:charges|provision|kosten)/i
  ]));
  const bedM = first(flat, re("bedroomsRe", [
    /(?:chambres?(?: à coucher)?|bedrooms?|slaapkamers?)\s*:?\s*(\d)\b/i,
    /\b(\d)\s*(?:chambres?|ch\.|bedrooms?|bed\b|slaapkamers?|slpk)/i
  ]));
  const m2M = first(flat, re("m2Re", [
    /(?:surface habitable|living area|habitable|bewoonbare oppervlakte|surface|oppervlakte)\s*:?\s*(?:±|\+\/-|env\.?)?\s*(\d{2,3})(?:[.,]\d+)?\s*m/i,
    /(?:±|\+\/-)?\s*(\d{2,3})\s*m²/i
  ]));
  const availM = first(flat, re("availableRe", [
    /(?:disponible|libre|available|beschikbaar|vrij)\s*(?:à partir du|à partir de|dès le|le|from|vanaf|op|on)?\s*:?\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/i
  ]));
  const nowM = /(?:disponible|libre|available|beschikbaar|vrij)\s*:?\s*(?:immédiatement|de suite|tout de suite|immediately|now|onmiddellijk|direct)/i.test(flat);
  const furnishedYes = /\b(meublé|meuble|furnished|gemeubeld|gemeubileerd)\b/i.test(flat);
  const furnishedNo = /\b(non[- ]meublé|non meuble|unfurnished|niet gemeubeld|ongemeubeld)\b/i.test(flat);

  let available = null;
  if (availM) {
    const y = availM[3].length === 2 ? "20" + availM[3] : availM[3];
    available = `${y}-${availM[2].padStart(2, "0")}-${availM[1].padStart(2, "0")}`;
  } else if (nowM) available = "IMMEDIATELY";

  // Location: JSON-LD or map coordinates when the page has them
  let lat = null, lng = null;
  const geo = html.match(/"latitude"\s*:\s*"?(50\.\d{3,})"?[\s\S]{0,120}?"longitude"\s*:\s*"?(4\.\d{3,})/) ||
    html.match(/(?:data-)?lat(?:itude)?["'\s:=]+(50\.\d{3,})[\s\S]{0,120}?(?:data-)?(?:lng|lon|longitude)["'\s:=]+(4\.\d{3,})/i) ||
    html.match(/[?&](?:q|ll|center|query)=(50\.\d{3,}),\s*(4\.\d{3,})/);
  if (geo) { lat = Number(geo[1]); lng = Number(geo[2]); }
  const streetLd = (html.match(/"streetAddress"\s*:\s*"([^"]{4,80})"/) || [])[1];
  const streetM = streetLd ? [null, streetLd] : first(flat, re("streetRe", [
    /\b((?:Rue|Avenue|Av\.|Boulevard|Bd|Chaussée|Place|Square|Clos|Allée|Drève|Quai|Impasse|Parvis|Straat|Laan|Steenweg|Plein)\s+(?:de la |du |des |de l'|d'|de |van |)[A-ZÉÈ][\w'’\-éèêëàâîïôöûüç]+(?:[ \-][A-ZÉÈ][\w'’\-éèêëàâîïôöûüç]+){0,3}(?:\s+\d{1,4}[A-Za-z]?)?)/
  ]));
  const title = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || (html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";

  return {
    rent: rentM ? money(rentM[1]) : null,
    charges: chargesM ? money(chargesM[1]) : null,
    bedrooms: bedM ? Number(bedM[1]) : (/\bstudio\b/i.test(title + " " + flat.slice(0, 600)) ? 0 : null),
    m2: m2M ? Number(m2M[1]) : null,
    furnished: furnishedYes && !furnishedNo,
    available,
    postcode: postcodeOf(title + " " + flat),
    street: streetM ? streetM[1].trim() : null,
    lat, lng,
    title: plain(title).replace(/\s+/g, " ").trim().slice(0, 120),
    text: flat.slice(0, 4000)
  };
}

// Address → coordinates via OpenStreetMap (max one request a second, as their rules ask)
let lastGeocode = 0;
async function geocode(street, postcode) {
  const wait = 1100 - (Date.now() - lastGeocode);
  if (wait > 0) await sleep(wait);
  lastGeocode = Date.now();
  try {
    const q = encodeURIComponent(`${street}, ${postcode} Brussels, Belgium`);
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=be&q=${q}`, {
      headers: {"user-agent": "brussels-flat-review (github.com/maltehanneswolski-arch/brussels-flat-review)"}
    });
    const j = await res.json();
    return j[0] ? [Number(j[0].lat), Number(j[0].lon)] : null;
  } catch { return null; }
}

export async function checkAgencies(seen, known) {
  let sites;
  try { sites = JSON.parse(await readFile(new URL("monitor/agencies.json", root), "utf8")); } catch { return []; }
  const out = [];
  for (const site of sites.filter((s) => s.enabled !== false)) {
    let links = [];
    try {
      for (const listUrl of [].concat(site.rentalsUrl)) {
        const page = await get(listUrl);
        if (page.status !== 200) { console.error(`${site.name}: list page answered ${page.status}`); continue; }
        const pattern = new RegExp(site.linkPattern, "gi");
        for (const m of page.text.matchAll(/href=["']([^"'#]+)["']/gi)) {
          const href = new URL(m[1].replace(/&amp;/g, "&"), listUrl).href;
          pattern.lastIndex = 0;
          if (pattern.test(href)) links.push(href);
        }
        await sleep(800);
      }
    } catch (e) { console.error(`${site.name}: ${e.message}`); continue; }
    links = [...new Set(links)].slice(0, site.maxListings || 60);

    for (const url of links) {
      const key = url;
      if (seen.agencies[key] || known.has(key)) continue;
      try {
        const page = await get(url);
        if (page.status !== 200) { out.push({key, skip: "page answered " + page.status}); continue; }
        const p = parseListing(page.text, site);
        if (/sous option|under option|onder optie|\bloué\b|\brented\b|\bverhuurd\b/i.test(p.title + " " + p.text.slice(0, 1500))) { out.push({key, skip: "already under option or rented"}); continue; }
        if (/\b(à vendre|for sale|te koop)\b/i.test(p.title)) { out.push({key, skip: "for sale"}); continue; }
        if (!p.postcode || !POSTCODES.includes(p.postcode)) { out.push({key, skip: "outside the areas"}); continue; }
        if (p.lat == null && p.street) {
          const c = await geocode(p.street, p.postcode);
          if (c) { p.lat = c[0]; p.lng = c[1]; }
        }
        out.push({
          key,
          flat: {
            id: "ag-" + createHash("sha1").update(url).digest("hex").slice(0, 12), kind: "listing", source: site.name, url, pc: p.postcode,
            street: p.street || "Address not given", lat: p.lat, lng: p.lng, approx: false,
            furnished: p.furnished, rent: p.rent, charges: p.charges, bedrooms: p.bedrooms, m2: p.m2,
            floor: null, epc: null, lift: false, terrace: null, garden: false, available: p.available
          },
          text: `${p.title} ${p.text}`,
          title: p.title
        });
      } catch (e) { console.error(`${site.name} ${url}: ${e.message}`); }
      await sleep(800);
    }
  }
  return out;
}
