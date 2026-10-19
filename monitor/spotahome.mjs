// Furnished flats booked online through Spotahome (spotahome.com), read from the API their map uses.
//
// Spotahome hides house numbers, so the map gets one card per street and postcode (a "building")
// that lists the units fitting our rules. Each daily run recomputes the buildings: new ones are
// added in purple, existing ones get their unit list refreshed, and a building whose units all
// stopped fitting keeps its card with a warning.

import {areaFor, get, judge} from "./discover.mjs";

const API = "https://www.spotahome.com/api/fe/marketplace";
const TODAY = new Date().toISOString().slice(0, 10);

async function json(url) {
  const r = await get(url, "application/json");
  if (r.status !== 200) throw new Error(`Spotahome ${r.status} for ${url.slice(0, 80)}`);
  return JSON.parse(r.text);
}

// Every Brussels listing under €1,300 with its details ("homecard")
export async function spotahomeCards() {
  const markers = (await json(`${API}/markers/brussels?budget=0-1300`)).data || [];
  const ids = [...new Set(markers.filter((m) => m.minimumPrice <= 1300).map((m) => m.adId))];
  const cards = [];
  for (let i = 0; i < ids.length; i += 40) cards.push(...((await json(`${API}/homecards?ids=${ids.slice(i, i + 40).join(",")}`)).data?.homecards || []));
  return cards;
}

const cleanStreet = (s) => (s || "").replace(/,.*$/, "").replace(/\/.*$/, "").replace(/\s+/g, " ").trim();
// Street name without the type word or language, so "Av. de la Brabançonne" and "Avenue de la Brabançonne" match
export const streetKey = (s) => cleanStreet(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/\bboite.*$/, "").replace(/straat|laan|plein|\bav\b\.?|avenue|\brue\b|chaussee|chau\.|place|\bpl\b\.?|square|boulevard|\bbd\b\.?/g, "")
  .replace(/[^a-z]+/g, " ").trim();

// One Spotahome listing in our shape, plus the reason it doesn't fit (null when it does)
export function spotUnit(c) {
  const pc = c.location?.postalCode;
  const capacity = c.capacity?.unit ?? c.capacity?.group ?? null;
  const f = {
    pc, rent: c.pricePerMonth ?? c.monthlyPrice?.minimumPrice ?? null, furnished: true,
    bedrooms: c.type === "studio" ? 0 : c.numberOfBedrooms ?? null, m2: c.area || null,
    lat: c.location?.coord?.[1] ?? null, lng: c.location?.coord?.[0] ?? null,
    available: (c.firstAvailableDate || "").slice(0, 10) || null
  };
  // Spotahome lists units a year ahead; even in Schaerbeek, where any date goes, March 2027 or later is no use
  const why = c.type === "room" || c.sharedRoom ? "room in a shared flat"
    : capacity != null && capacity < 2 ? "for 1 person only"
    : f.available > "2027-02-28" ? "starts after February"
    : judge(f, c.type === "studio" ? "studio" : "");
  return {why, unit: {...f, id: String(c.adId), type: c.type, url: "https://www.spotahome.com" + c.url, text: c.homecardDescription || c.description || ""}};
}

// Groups the fitting units into buildings. Units that are already on the map under another site are left out.
export function spotBuildings(cards, flats) {
  const others = flats.filter((g) => g.source !== "Spotahome" && g.street && g.street !== "Address not given");
  const groups = {};
  for (const c of cards) {
    const {why, unit} = spotUnit(c);
    if (why) continue;
    const street = cleanStreet(c.location.street);
    if (others.some((g) => streetKey(g.street) === streetKey(street) && Math.abs((g.rent || 0) - unit.rent) <= 60)) continue;
    (groups[`${unit.pc}-${streetKey(street).replace(/ /g, "-")}`] ||= {street, units: []}).units.push(unit);
  }
  return Object.entries(groups).map(([key, g]) => {
    const units = g.units.sort((a, b) => a.rent - b.rent);
    const lat = +(units.reduce((s, u) => s + u.lat, 0) / units.length).toFixed(5);
    const lng = +(units.reduce((s, u) => s + u.lng, 0) / units.length).toFixed(5);
    const label = (u) => `${u.type === "studio" ? "Studio" : u.bedrooms + "-bed"}${u.m2 ? `, ${u.m2} m²` : ""}, €${u.rent.toLocaleString("en-US")}${u.available ? ", from " + u.available.split("-").reverse().join("/") : ""}`;
    return {
      id: "spot-" + key, kind: "spotahome", source: "Spotahome", url: units[0].url,
      area: areaFor(units[0].pc).name(lat, lng), street: g.street, lat, lng, approx: true,
      furnished: true, rent: units[0].rent, charges: null, bedrooms: null, m2: null, floor: null, epc: null, lift: false, terrace: null, garden: false,
      available: units.map((u) => u.available).filter(Boolean).sort()[0] || null,
      units: units.map(label), unitIds: units.map((u) => u.id),
      description: `Furnished flats booked online through Spotahome: you reserve on their site and pay their booking fee, without a viewing first. ${units.length === 1 ? "One unit fits" : units.length + " units fit"} the rules; the price shown is the cheapest. Bills are usually extra.`,
      text: units.map((u) => u.text).join(" ")
    };
  });
}

// Puts the buildings into the flats list: returns the new ones (callers add `added` and the domiciliation).
export function mergeSpotahome(flats, buildings) {
  const added = [];
  let refreshed = 0;
  const current = new Set(buildings.map((b) => b.id));
  for (const b of buildings) {
    const {text, ...flat} = b;
    const old = flats.find((f) => f.id === b.id);
    if (!old) { added.push({...flat, text}); continue; }
    if (JSON.stringify(old.units) !== JSON.stringify(flat.units)) refreshed++;
    Object.assign(old, {units: flat.units, unitIds: flat.unitIds, rent: flat.rent, available: flat.available, lat: flat.lat, lng: flat.lng, url: flat.url, description: flat.description});
    delete old.warning;
  }
  for (const f of flats) {
    if (f.source !== "Spotahome" || current.has(f.id) || !f.units?.length) continue;
    f.units = []; f.unitIds = [];
    f.warning = `No unit here fits the rules any more (checked ${TODAY.split("-").reverse().join("/")}).`;
    refreshed++;
  }
  return {added, refreshed};
}
