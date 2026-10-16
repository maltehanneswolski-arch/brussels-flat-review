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
  for (const r of await res.json()) (latest[r.flat_id] ??= {})[r.reviewer_id] = r;
  const out = {};
  for (const [id, people] of Object.entries(latest)) {
    const yes = Object.values(people).filter((r) => r.verdict === "yes").map((r) => r.reviewer_name);
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

async function checkImmoweb(flat) {
  const page = await get("https://www.immoweb.be/en/classified/" + flat.id);
  if (page.status === 404 || page.status === 410 || (page.status === 200 && !page.url.includes(flat.id))) return {status: "removed"};
  const i = page.text.indexOf("window.classified = ");
  if (page.status !== 200 || i < 0) return {status: "unknown", note: "Immoweb answered " + page.status};
  const start = page.text.indexOf("{", i);
  const c = JSON.parse(page.text.slice(start, page.text.indexOf("};\n", start) + 1));
  const t = c.transaction || {};
  const flags = c.flags || {};
  return {
    status: flags.isSoldOrRented ? "removed" : flags.isUnderOption ? "under-option" : "online",
    rent: t.rental?.monthlyRentalPrice ?? null,
    charges: t.rental?.monthlyRentalCosts ?? null,
    available: t.availabilityDate || t.availabilityPeriodType || null
  };
}

async function checkImmovlan(flat) {
  const page = await get(flat.url);
  const text = plain(page.text);
  if (page.status === 404 || page.status === 410 || /page no longer available/i.test(text)) return {status: "removed"};
  if (page.status !== 200 || !/Rent [\d ]+ €/.test(text)) return {status: "unknown", note: "Immovlan answered " + page.status};
  const num = (re) => { const m = text.match(re); return m ? Number(m[1].replace(/\s/g, "")) : null; };
  const av = (text.match(/Availability (From \d\d\/\d\d\/\d{4}|Immediately|[A-Za-z ]{3,30}?) (?:Financial|Currently|Build|Rent|General)/) || [])[1] || null;
  return {
    status: /under option|sous option/i.test(text) ? "under-option" : "online",
    rent: num(/Rent ([\d ]+) €/),
    charges: num(/(?:Maintenance cost|Charges) ([\d ]+) €/),
    available: av ? av.replace(/^From (\d\d)\/(\d\d)\/(\d{4})$/, "$3-$2-$1").replace(/^Immediately$/, "IMMEDIATELY") : null
  };
}

async function checkVista(flat) {
  const page = await get(flat.url);
  if (page.status === 404) return {status: "removed"};
  if (page.status !== 200) return {status: "unknown", note: "Vista answered " + page.status};
  return {status: "online", pageHash: createHash("sha1").update(plain(page.text)).digest("hex").slice(0, 12)};
}

async function check(flat) {
  try {
    if (flat.kind === "vista") return await checkVista(flat);
    if (flat.source === "Immovlan") return await checkImmovlan(flat);
    return await checkImmoweb(flat);
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
  const pub = {status: now.status, rent: now.rent ?? kept.rent ?? null, charges: now.charges ?? kept.charges ?? null, available: now.available ?? kept.available ?? null, since, checked: today};
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
