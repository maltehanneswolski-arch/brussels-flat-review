// Checks every flat that has at least one "Yes" vote and records whether its listing
// is still online, under option, removed, or changed price or start date.
//
//   node monitor/check.mjs [--report report.md]
//
// Writes data/status.json (read by the map) and monitor/state.json (last snapshot).
// With --report, writes a Markdown summary of changes to that file, only when there are changes.

import {readFile, writeFile} from "node:fs/promises";
import {createHash} from "node:crypto";

const root = new URL("../", import.meta.url);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const today = new Date().toISOString().slice(0, 10);
const reportPath = process.argv.includes("--report") ? process.argv[process.argv.indexOf("--report") + 1] : null;

const readJson = async (path, fallback) => {
  try { return JSON.parse(await readFile(new URL(path, root), "utf8")); } catch { return fallback; }
};
const euro = (n) => (n == null ? "?" : "€" + n.toLocaleString("en-US"));

// ---------- who said yes ----------
async function yesFlats() {
  const cfg = await readFile(new URL("config.js", root), "utf8");
  const url = (cfg.match(/supabaseUrl:\s*"([^"]*)"/) || [])[1];
  const key = (cfg.match(/supabaseKey:\s*"([^"]*)"/) || [])[1];
  if (!url || !key) throw new Error("No Supabase URL or key in config.js");
  const headers = {apikey: key};
  if (key.startsWith("eyJ")) headers.Authorization = "Bearer " + key;
  const res = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/reviews?select=flat_id,reviewer_id,reviewer_name,verdict,created_at&order=created_at.asc&limit=10000`, {headers});
  if (!res.ok) throw new Error("Supabase " + res.status);
  const latest = {};
  // one vote per person: by name (Malte, Lilly), falling back to the id for older rows
  for (const r of await res.json()) (latest[r.flat_id] ??= {})[(r.reviewer_name || "").trim().toLowerCase() || r.reviewer_id] = r;
  const out = {};
  for (const [id, people] of Object.entries(latest)) {
    const yes = Object.values(people).filter((r) => r.verdict === "yes" || r.verdict === "super").map((r) => r.reviewer_name);
    if (yes.length) out[id] = yes;
  }
  return out;
}

// ---------- listing checks ----------
async function get(url) {
  const res = await fetch(url, {headers: {"user-agent": UA, "accept-language": "en"}, redirect: "follow"});
  return {status: res.status, url: res.url, text: await res.text()};
}
const plain = (html) => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&euro;/gi, "€").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");

// ---------- contact details (for the Shortlist tab) ----------
// Feed relay addresses (importfrommedia.be, omniwebsites.be) don't reach a person, so they're left out.
const RELAY = /importfrommedia\.be|omniwebsites\.be|immoweb\.be|immovlan\.be|example\./i;
const PHONE = /(?:\+32\s?|\b0)(?:4\d{2}|[1-9]\d?)[\s\/.]?\d{2,3}[\s.]?\d{2}[\s.]?\d{2}\b/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
function prettyPhone(p) {
  let d = p.replace(/[^\d+]/g, "");
  if (d.startsWith("+32")) d = "0" + d.slice(3);
  if (/^04\d{8}$/.test(d)) return d.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, "$1 $2 $3 $4");
  if (/^02\d{7}$/.test(d)) return d.replace(/^(\d{2})(\d{3})(\d{2})(\d{2})$/, "$1 $2 $3 $4");
  return d.replace(/^(\d{3})(\d{2})(\d{2})(\d{2})$/, "$1 $2 $3 $4");
}
const uniq = (a) => [...new Set(a.filter(Boolean))];
const phonesIn = (text) => uniq((text.match(PHONE) || []).map(prettyPhone)).filter((p) => /^0\d{2,3} /.test(p)).slice(0, 2);
const emailsIn = (text) => uniq((text.match(EMAIL) || []).map((e) => e.toLowerCase()).filter((e) => !RELAY.test(e))).slice(0, 2);

async function checkImmoweb(flat) {
  const page = await get("https://www.immoweb.be/en/classified/" + flat.id);
  if (page.status === 404 || page.status === 410 || (page.status === 200 && !page.url.includes(flat.id))) return {status: "removed"};
  const i = page.text.indexOf("window.classified = ");
  if (page.status !== 200 || i < 0) return {status: "unknown", note: "Immoweb answered " + page.status};
  const start = page.text.indexOf("{", i);
  const c = JSON.parse(page.text.slice(start, page.text.indexOf("};\n", start) + 1));
  const t = c.transaction || {};
  const flags = c.flags || {};
  const cu = (c.customers || [])[0] || {};
  const desc = c.property?.description || "";
  const privateOwner = cu.type === "PRIVATE" || !cu.name;
  return {
    status: flags.isSoldOrRented ? "removed" : flags.isUnderOption ? "under-option" : "online",
    rent: t.rental?.monthlyRentalPrice ?? null,
    charges: t.rental?.monthlyRentalCosts ?? null,
    available: t.availabilityDate || t.availabilityPeriodType || null,
    contact: {
      who: privateOwner ? "Private owner" : cu.name.replace(/\s+/g, " ").trim(),
      kind: privateOwner ? "private" : "agency",
      phones: uniq([cu.phoneNumber, cu.mobileNumber].filter(Boolean).map(prettyPhone).concat(phonesIn(desc))).slice(0, 2),
      emails: emailsIn([cu.email || "", desc].join(" ")),
      website: privateOwner ? null : cu.website?.replace(/^http:\/\//, "https://") || null,
      form: flat.url, formLabel: "Contact form on the Immoweb listing"
    }
  };
}

async function checkImmovlan(flat) {
  const page = await get(flat.url);
  const text = plain(page.text);
  if (page.status === 404 || page.status === 410 || /page no longer available/i.test(text)) return {status: "removed"};
  if (page.status !== 200 || !/Rent [\d ]+ €/.test(text)) return {status: "unknown", note: "Immovlan answered " + page.status};
  const num = (re) => { const m = text.match(re); return m ? Number(m[1].replace(/\s/g, "")) : null; };
  const av = (text.match(/Availability (From \d\d\/\d\d\/\d{4}|Immediately|[A-Za-z ]{3,30}?) (?:Financial|Currently|Build|Rent|General)/) || [])[1] || null;
  const seller = (text.match(/([A-Z][A-Z0-9 &'.\-]{2,40}?) View all properties/) || [])[1]?.trim() || null;
  const desc = (text.match(/Description (.{0,2500})/) || [])[1] || "";
  return {
    status: /under option|sous option/i.test(text) ? "under-option" : "online",
    rent: num(/Rent ([\d ]+) €/),
    charges: num(/(?:Maintenance cost|Charges) ([\d ]+) €/),
    available: av ? av.replace(/^From (\d\d)\/(\d\d)\/(\d{4})$/, "$3-$2-$1").replace(/^Immediately$/, "IMMEDIATELY") : null,
    contact: {
      who: seller ? seller.replace(/\b([A-Z])([A-Z]+)\b/g, (_, a, b) => a + b.toLowerCase()) : "Advertiser on Immovlan",
      kind: /housinganywhere|spotahome|uniplaces/i.test(seller || "") ? "platform" : "agency",
      phones: phonesIn(desc), emails: emailsIn(desc), website: null,
      form: flat.url, formLabel: "“Contact by email” on the Immovlan listing"
    }
  };
}

async function checkVista(flat) {
  const page = await get(flat.url);
  if (page.status === 404) return {status: "removed"};
  if (page.status !== 200) return {status: "unknown", note: "Vista answered " + page.status};
  return {
    status: "online", pageHash: createHash("sha1").update(plain(page.text)).digest("hex").slice(0, 12),
    contact: {who: "Vista Residences", kind: "agency", phones: ["0478 55 56 20"], emails: ["info@vistaresidences.org"], website: "https://www.vistaresidences.org", form: null, formLabel: null}
  };
}

// A Spotahome building: online while at least one of its units is still listed under €1,300
async function checkSpotahome(flat) {
  const contact = {who: "Spotahome", kind: "platform", phones: [], emails: [], website: "https://www.spotahome.com", form: flat.url, formLabel: "Book or ask a question on the Spotahome listing"};
  const ids = flat.unitIds || [];
  if (!ids.length) return {status: "removed", contact};
  const res = await fetch(`https://www.spotahome.com/api/fe/marketplace/homecards?ids=${ids.join(",")}`, {headers: {"user-agent": UA, accept: "application/json"}});
  if (!res.ok) return {status: "unknown", note: "Spotahome answered " + res.status};
  const cards = ((await res.json()).data?.homecards || []).filter((c) => (c.pricePerMonth ?? Infinity) <= 1300);
  if (!cards.length) return {status: "removed", contact};
  return {
    status: "online", rent: Math.min(...cards.map((c) => c.pricePerMonth)), charges: null,
    available: cards.map((c) => (c.firstAvailableDate || "").slice(0, 10)).filter(Boolean).sort()[0] || null, contact
  };
}

// A flat found on an agency's own website
async function checkAgencyPage(flat) {
  const page = await get(flat.url);
  if (page.status === 404 || page.status === 410) return {status: "removed"};
  if (page.status !== 200) return {status: "unknown", note: `${flat.source} answered ${page.status}`};
  const text = plain(page.text);
  const head = text.slice(0, 4000);
  const status = /(?<![\wÀ-ÿ])(loué|rented|verhuurd)(?![\wÀ-ÿ])/i.test(head) ? "removed" : /sous[- ]option|under option|onder optie/i.test(head) ? "under-option" : "online";
  let website = null;
  try { website = new URL(flat.url).origin; } catch { /* keep null */ }
  return {
    status, rent: flat.rent, charges: flat.charges, available: flat.available,
    contact: {who: flat.source, kind: "agency", phones: phonesIn(text), emails: emailsIn(text), website, form: flat.url, formLabel: `Contact form on ${flat.source}'s listing page`}
  };
}

async function check(flat) {
  try {
    if (flat.kind === "vista") return await checkVista(flat);
    if (flat.kind === "spotahome") return await checkSpotahome(flat);
    if (flat.source === "Zimmo") return {status: "unknown", note: "Zimmo blocks automatic checks"}; // Cloudflare stops scripts; the card says so
    if (flat.source === "Immovlan") return await checkImmovlan(flat);
    if (flat.source === "Immoweb") return await checkImmoweb(flat);
    return await checkAgencyPage(flat);
  } catch (e) {
    return {status: "unknown", note: String(e.message || e).slice(0, 120)};
  }
}

// ---------- compare and record ----------
const LABEL = {online: "still online", "under-option": "under option (someone is ahead of you)", removed: "listing removed, probably rented", unknown: "could not be checked"};

const {flats} = await readJson("data/flats.json", {flats: []});
const state = await readJson("monitor/state.json", {flats: {}});
const yes = await yesFlats();
const changes = [];
const status = {updated: today, flats: {}};

for (const [id, voters] of Object.entries(yes)) {
  const flat = flats.find((f) => f.id === id);
  if (!flat) continue;
  const prev = state.flats[id];
  const now = await check(flat);
  const name = `[${flat.street} (${flat.area})](${flat.url})`;

  if (now.status === "unknown") {
    // keep the last known state; one failed check is not news
    status.flats[id] = prev ? {...prev.public, checked: today, note: now.note} : {status: "unknown", checked: today, note: now.note};
    if (prev) state.flats[id] = {...prev, last_checked: today};
    continue;
  }

  const lines = [];
  if (!prev) {
    lines.push(`now watching it (Yes from ${voters.join(", ")}): ${LABEL[now.status]}, ${euro(now.rent)} rent`);
  } else {
    if (prev.status !== now.status) lines.push(`${LABEL[prev.status]} → **${LABEL[now.status]}**`);
    if (now.status !== "removed") {
      if (prev.rent !== now.rent && now.rent != null) lines.push(`rent ${euro(prev.rent)} → **${euro(now.rent)}**`);
      if (prev.charges !== now.charges && now.charges != null) lines.push(`charges ${euro(prev.charges)} → **${euro(now.charges)}**`);
      if (prev.available !== now.available && now.available != null) lines.push(`start date ${prev.available ?? "?"} → **${now.available}**`);
      if (prev.pageHash && now.pageHash && prev.pageHash !== now.pageHash) lines.push("their page changed, check which units are free");
    }
  }
  const changed = !prev || lines.length > 0;
  const kept = now.status === "removed" && prev ? {rent: prev.rent, charges: prev.charges, available: prev.available, pageHash: prev.pageHash} : {};
  const since = changed ? today : prev.public?.since || today;
  const pub = {status: now.status, rent: now.rent ?? kept.rent ?? null, charges: now.charges ?? kept.charges ?? null, available: now.available ?? kept.available ?? null, since, checked: today,
    contact: now.contact ?? prev?.public?.contact ?? null};
  state.flats[id] = {...kept, ...now, status: now.status, first_watched: prev?.first_watched || today, last_checked: today, public: pub};
  status.flats[id] = pub;
  if (lines.length) changes.push({name, lines, alert: !!prev});
}

await writeFile(new URL("monitor/state.json", root), JSON.stringify(state, null, 1) + "\n");
await writeFile(new URL("data/status.json", root), JSON.stringify(status, null, 1) + "\n");

const watched = Object.keys(status.flats).length;
console.log(`Watching ${watched} flat${watched === 1 ? "" : "s"} with a Yes vote.`);
for (const c of changes) console.log(`- ${c.name.replace(/\]\(.*\)$/, "]").slice(1, -1)}: ${c.lines.join("; ").replace(/\*\*/g, "")}`);
if (!changes.length) console.log("No changes since the last check.");

const alerts = changes.filter((c) => c.alert);
if (reportPath && alerts.length) {
  const md = [`Checked on ${today}. ${alerts.length} of the ${watched} flats you said Yes to changed:`, "",
    ...alerts.map((c) => `- ${c.name}: ${c.lines.join("; ")}`), "",
    "Map: https://maltehanneswolski-arch.github.io/brussels-flat-review/"].join("\n");
  await writeFile(reportPath, md + "\n");
}
