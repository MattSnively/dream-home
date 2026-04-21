# Dream Home

Personal house-hunting map for KC Northland (ZIP 64116). Currently tracking
**Briarcliff West
**Briarcliff - Claymont (current neighborhood)

## What this is (and isn't)

A living document for a long-term, casual house search. 
Ad-hoc price history on priority houses, but not a complete archive of both neighborhoods
Web-based with a google sheets back end. Light data viz elements
Detail pane for quick house highlights

## Architecture

```
Google Sheet (published as CSV)
**needs update here
```

## Data source

The Google Sheet's published-CSV URL lives in `site/config.js`. Matt owns the
Sheet at <https://docs.google.com/spreadsheets/d/e/2PACX-1vR8JqN_tTCWbz5gal5y1KWKREnAzMXvTIUFv4jNVIFmOmVMQVmVsV_J5hvBmX3rMIIzOzJ6pzTVIYJ-/pubhtml>.

Expected columns are documented in `reference/sheet_config.json`. If Matt
renames or removes a column the app tolerates it (missing columns render as
blank in the card; the filter panel just won't use them).
Columns will be added in development but hopefully not added once the initial engineering is done.

## Running locally

Let's revisit this--possible web-based via GitHub and GitHub Actions (powered by cloudflare)

## Geocoding

Addresses from the Sheet are geocoded in the browser via the US Census
Geocoder (free, keyless, CORS-friendly). Results are cached in localStorage
keyed by the full one-line address, so each unique address is looked up exactly
once per browser. If the geocoder fails for an address, the home still shows
up in the card list with a "not mapped" indicator.

## Feature roadmap

### v1a — map + cards + filters
- [ ] `site/index.html` + `site/css/styles.css` + `site/js/app.js`
- [ ] Leaflet map of 64116 with a pin per Sheet row
- [ ] Click a pin -> slide-out card with all Sheet columns for that home
- [ ] Filter panel: price range, beds, baths (0.5 step), sqft, year built,
      status checkboxes, neighborhood checkboxes

### Desirability scoring (v1a — manual)

Matt adds a `Lot Desirability` column to the Sheet with values 1–10 (blank = not
rated yet). The app reads it, shows it as a prominent chip on the card, changes pin color by score (red-green diverging), and supports filtering by min/max score
plus a "Hide unscored homes" toggle.

This is deliberately manual. Inferred scoring (cul-de-sac = good, big lot =
good) produces answers that look right on paper but feel wrong in person.
Matt's eye is the source of truth.

### v2 (later, only if v1 proves useful)
- [ ] Clay County parcel polygons as a lot-boundary layer
- [ ] Price-history chart per home
- [ ] Watchlist/notes layer beyond what the Sheet already provides

## Decisions intentionally NOT made here

- Lots more discussion needed. Please enter plan mode before attacking this project again.
