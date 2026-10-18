# Brussels Flat Review

A map of rental flats for two people in Brussels, starting December 2026 or January 2027, where friends can mark each flat **Yes** or **No** and leave a comment.

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

Every morning a GitHub Action ([`monitor.yml`](.github/workflows/monitor.yml)) does two things:

1. **Finds new flats.** [`monitor/discover.mjs`](monitor/discover.mjs) searches Immoweb, Immovlan and the agency websites in [`monitor/agencies.json`](monitor/agencies.json). It adds every listing that fits the rules above to `data/flats.json`. New flats show **in purple** on the map for 2 days. Each listing is judged once; the verdicts are kept in `monitor/seen.json`.
2. **Watches the Yes flats** (see below).

When there is news, the Action opens one GitHub issue, so you get a notification. You can also start it by hand from the **Actions** tab (**Daily flat check → Run workflow**), or run it locally:

```bash
node monitor/discover.mjs
```

## How to review

1. Type your name at the top, so we know who voted.
2. Click a price on the map or a card in the list.
3. Press **Yes** or **No**. Press it again to take your vote back.
4. Open a card to leave a comment.

Map pins turn green when a flat has more Yes than No votes, and red when it has more No.

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

Listing details belong to the sites they come from and may have changed since 16 October 2026. Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
