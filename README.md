# Brussels Flat Review

A map of rental flats for two people in Brussels, starting December 2026 or January 2027, where Malte and Lilly mark each flat **Super yes**, **Yes** or **No** and leave a comment.

**Live site:** https://maltehanneswolski-arch.github.io/brussels-flat-review/

## What's on the map

Hand-picked on 16 October 2026, then topped up every day:

- **Schaerbeek (1030):** flats with any start date.
- **Etterbeek, the EU quarter and Squares, Saint-Josse, Ixelles near Place du Luxembourg, Woluwe-Saint-Lambert near Montgomery, and the Royal quarter:** flats that start in December or January, or that give no date.
- **Vista Residences:** 5 buildings of furnished flats around Square Ambiorix, Schuman and Saint-Josse. Their site has no prices or dates, so ask them.

The rules for every listing:

- Furnished: rent up to €1,300 a month.
- Unfurnished: rent up to €1,000 a month.
- At least one bedroom, or a studio of at least 30 m².
- No single rooms in shared houses.

The price shown is rent plus monthly charges. Each flat links to its listing on [Immoweb](https://www.immoweb.be), [Immovlan](https://immovlan.be), an agency's own website, or [Vista Residences](https://www.vistaresidences.org).

## The daily check

Twice a day, at 06:00 and 16:00 Brussels time, a GitHub Action ([`monitor.yml`](.github/workflows/monitor.yml)) does two things:

1. **Finds new flats.** [`monitor/discover.mjs`](monitor/discover.mjs) searches Immoweb, Immovlan and the agency websites in [`monitor/agencies.json`](monitor/agencies.json). It adds every listing that fits the rules above to `data/flats.json`. New flats show **in purple** on the map for 2 days, and the strip above the list counts the flats that are new since your last visit (one tap shows only those). Each listing is judged once; the verdicts are kept in `monitor/seen.json`. It also reads whether the listing says you can register your address there (**domiciliation**): possible, not allowed, or not stated ([`monitor/domicile.mjs`](monitor/domicile.mjs)). The site shows English only, so a listing's own French or Dutch wording isn't copied onto it.
2. **Watches the Yes flats** (see below).

**Agency websites checked:** Immoschmidt, Immo Clicking, Realty Belgium, Immo2gether, Grant Properties, Immo 2A, Macnash (Montgomery and Sud), Bathim, Trevi (first 10 pages), Vaneau Lecobel (East and Centre), Immobilière Petitjean, Trior, Everest Properties, Homeside, Nadimmo, Eventimmo and Expertissimmo. Each site's address and reading rules are in `monitor/agencies.json`; the reading code is [`monitor/agencies.mjs`](monitor/agencies.mjs).

**Not covered**, because their listings only load through JavaScript, need a site key, or aren't online: Latour et Petit, MyImmo, We Invest, Oralis, Capital Rent, BBF, CH Invest, Gestilex, Hermanns, Stéphane Schweitzer, Pearl Immo, J&J Properties and Skyline.

When there is news, the Action opens one GitHub issue, so you get a notification. You can also start it by hand from the **Actions** tab (**Daily flat check → Run workflow**), or run it locally:

```bash
node monitor/discover.mjs
```

## How to review

1. Pick **Malte** or **Lilly** at the top, so the other knows who voted. Lilly's view has a slight purple tint.
2. Click a price on the map or a card in the list.
3. Press **★ Super yes**, **Yes** or **No**. Press it again to take your vote back. A Super yes counts double when sorting by votes.
4. Open a card to leave a comment.

A green dot on a map pin means more Yes than No votes, a red dot more No, and a star a Super yes.

## From Yes to keys: the Shortlist and In contact tabs

- **Shortlist** lists every flat with a Yes vote, with a map of just those flats. Each card has the price, size, rooms, furnishing, start date and location, plus **how to reach them**: who listed it (agency, private owner or booking platform), phone, email, the listing's contact form and the agency's website. There's a ready-to-copy message in French or English. Press **We contacted them** once you've reached out, then **We heard back** when they reply. Each card has a **Notes** section for what the agent said, questions to ask and how the viewing went.
- **In contact** takes those flats further: book a viewing (with date), visit, apply, sign. Every step says what to bring, check and ask. Flats you drop go to **Not going ahead**, where you can bring them back.

Everyone sees the same progress. It is stored in a second Supabase table: run [`supabase/progress.sql`](supabase/progress.sql) once in the SQL Editor, after `schema.sql`. The daily check collects the contact details for every Yes flat.

## Watching the Yes flats

As part of the daily check, [`monitor/check.mjs`](monitor/check.mjs) looks at every flat with at least one Yes vote and records whether the listing is:

- still online,
- under option (someone else is ahead),
- removed (usually rented),
- or changed its rent, charges or start date.

The result goes into `data/status.json`, and the map shows it on each watched flat. When something changes, the Action opens a GitHub issue, so you get a notification. To run a check by hand:

```bash
node monitor/check.mjs
```

## Shared reviews

Votes and comments are stored in a Supabase database, so everyone sees everyone's reviews. Without a database in `config.js`, reviews stay in each visitor's own browser. To connect a different database:

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor**, paste [`supabase/schema.sql`](supabase/schema.sql) and run it.
3. Open **Project Settings → API** and copy the **Project URL** and the **anon** (or **publishable**) key.
4. Paste both into [`config.js`](config.js) and push.

Super yes votes need one change to that table: run [`supabase/super-yes.sql`](supabase/super-yes.sql) once in the SQL Editor (a new database set up with `schema.sql` already has it).

The anon key is meant to be public. With the schema above, visitors can only read reviews and add new ones; they can't change or delete anything.

## Run it locally

It's a static site with no build step:

```bash
python -m http.server 8000
```

Then open http://localhost:8000.

## Files

| File | What it holds |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app |
| `data/flats.json` | The listings |
| `config.js` | Supabase connection for shared reviews |
| `supabase/schema.sql` | Database table and access rules |
| `supabase/super-yes.sql` | One-time update that allows Super yes votes |
| `monitor/domicile.mjs` | Reads domiciliation from the listings (`node monitor/domicile.mjs` fills in flats not checked yet) |

Listing details belong to the sites they come from and may have changed since 16 October 2026. Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
