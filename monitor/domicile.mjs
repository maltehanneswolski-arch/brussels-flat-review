// Does a listing say you can register your address there (domiciliation)?
//
//   node monitor/domicile.mjs [--all] [--dry]
//
// Run on its own, it reads the listing of every flat in data/flats.json that hasn't been checked yet
// (--all: every flat) and stores domicile: "yes" | "no" | null, with the sentence it's based on (domicileQuote).
// discover.mjs uses domicileFrom() on each new listing.

import {readFile, writeFile} from "node:fs/promises";

// "domiciliation" also means a direct debit in French and Dutch, so payment talk doesn't count
const MENTION = /domicil\w*|bevolkingsregister|inscription (?:à|a) la commune|inscription communale|inschrijving (?:bij|in|aan) de gemeente|regist(?:er|ration)\b[^.;!?]{0,30}\b(?:commune|municipality|town hall)|(?:official|address) registration|register (?:your address|officially|at the (?:property|address))/gi;
// "official registration" or "address registration" on its own is offered as a feature, so it counts as a yes unless negated
const FEATURE = /registration|register/i;
const PAYMENT = /bancaire|banque|\bbank|paiement|payment|betaling|virement|par domicil|via domicil|sepa/i;
const NO = /\b(?:pas|non|no|not|niet|geen|sans|without|interdite?s?|impossible|exclue?s?|refus\w*|uitgesloten|verboden|never)\b|n'est pas|n’est pas|isn't|cannot|can't|ne peut/i;
const YES = /\b(?:possible|possibilit\w*|autoris\w*|accept\w*|allowed|permitted|mogelijk\w*|toegestaan|toegelaten|oui|yes|ok|peut)\b/i;

// Returns {domicile, quote}: "yes" or "no" when the listing says so, null when it doesn't say or is unclear.
export function domicileFrom(text) {
  const t = String(text || "").replace(/\s+/g, " ");
  const verdicts = [];
  for (const m of t.matchAll(MENTION)) {
    // the clause around the mention: up to the nearest sentence, list or bracket break, at most 70 characters each side
    const win = [t.slice(Math.max(0, m.index - 70), m.index), t.slice(m.index + m[0].length, m.index + m[0].length + 70)];
    let before = win[0].split(/[.;!?•|\n(]| - /).pop();
    let after = win[1].split(/[.;!?•|\n)]| - /)[0];
    if (before === win[0] && m.index > 70) before = "…" + before.replace(/^\S*\s/, ""); // cut mid-sentence: drop the partial word
    if (after === win[1] && m.index + m[0].length + 70 < t.length) after = after.replace(/\s\S*$/, "") + "…";
    const clause = (before + m[0] + after).trim();
    if (PAYMENT.test(clause)) continue;
    verdicts.push({domicile: NO.test(clause) ? "no" : YES.test(clause) || FEATURE.test(m[0]) ? "yes" : null, quote: clause.length > 140 ? clause.slice(0, 140).replace(/\s\S*$/, "") + "…" : clause});
  }
  if (!verdicts.length) return {domicile: null, quote: null};
  const said = new Set(verdicts.map((v) => v.domicile).filter(Boolean));
  if (said.size !== 1) return {domicile: null, quote: verdicts[0].quote}; // mentioned, but unclear or contradictory
  return verdicts.find((v) => v.domicile);
}

// ---------- fill in the flats already on the map ----------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (html) => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&euro;/gi, "€").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ");

export async function listingText(flat) {
  const res = await fetch(flat.url, {headers: {"user-agent": UA, "accept-language": "en"}, signal: AbortSignal.timeout(30000)});
  const html = await res.text();
  if (res.status !== 200) return null;
  if (flat.source === "Immoweb") {
    const i = html.indexOf("window.classified = ");
    if (i < 0) return null;
    const s = html.indexOf("{", i);
    const p = JSON.parse(html.slice(s, html.indexOf("};\n", s) + 1)).property || {};
    return `${p.title || ""}. ${p.description || ""}`;
  }
  return plain(html);
}

export async function fillIn({all = false, dry = false} = {}) {
  const path = new URL("../data/flats.json", import.meta.url);
  const data = JSON.parse(await readFile(path, "utf8"));
  const tally = {yes: 0, no: 0, unknown: 0, unreadable: 0};
  for (const flat of data.flats) {
    if (!all && "domicile" in flat) continue;
    let text = null;
    try { text = await listingText(flat); } catch (e) { console.error(flat.id, e.message); }
    if (text == null) { tally.unreadable++; console.log(`${flat.id} ${flat.street}: couldn't read ${flat.url}`); continue; } // try again next run
    const d = domicileFrom(text);
    flat.domicile = d.domicile;
    flat.domicileQuote = d.quote; // the listing's own words, any language; the site shows only an English domicileNote written by hand
    tally[d.domicile || "unknown"]++;
    if (d.quote) console.log(`${flat.id} ${flat.street}: ${d.domicile ?? "unclear"} | ${d.quote}`);
    await sleep(400);
  }
  console.log(`Domiciliation possible: ${tally.yes}, not allowed: ${tally.no}, not stated: ${tally.unknown}, couldn't read: ${tally.unreadable}`);
  if (!dry) await writeFile(path, JSON.stringify(data, null, 1) + "\n");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("monitor/domicile.mjs")) await fillIn({all: process.argv.includes("--all"), dry: process.argv.includes("--dry")});
