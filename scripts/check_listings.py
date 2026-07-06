"""
check_listings.py

Daily listing watcher for the Briarcliff West neighborhood.

What it does, end to end:
  1. Queries the RentCast API for ACTIVE for-sale listings in a small radius
     around Briarcliff West (one request per run — well under the free tier's
     50 requests/month cap).
  2. Filters those listings down to *exactly* Briarcliff West using a
     point-in-polygon test against reference/briarcliff-west.geojson.  The raw
     dataset mixes Briarcliff West and neighbouring Claymont, so the polygon is
     what enforces the "Briarcliff West only" scope.
  3. Diffs the current active set against the last snapshot
     (data/briarcliff-west-listings.json) to find NEW listings.
  4. Emails mattsnively@gmail.com (via Gmail SMTP) when there is something new.
  5. Optionally appends new listings to the Google Sheet (only if the Apps
     Script webhook is configured — see Phase 2).  Skipped otherwise.
  6. Writes the updated snapshot back to disk.  In CI a later workflow step
     commits that snapshot so the next run has an accurate "previous" set.

Why RentCast instead of scraping Zillow/Realtor: both of those sites actively
block automated access and forbid scraping in their terms of service, so a
scraper would break quickly and put the account at risk.  RentCast is a
licensed MLS-data API with a free tier that comfortably covers one neighbourhood
checked once a day.

Design notes:
  - Standard library only (urllib / json / smtplib / email), matching the style
    of reference/pull_joco_addresses.py, so the GitHub Action needs no pip step.
  - Every network/credential failure prints a clear message and exits non-zero
    so a broken run is obvious in the Actions log rather than silently passing.

Local usage:
  # Safe test — fetch + filter + diff, but send no email and write nothing:
  RENTCAST_API_KEY=xxxx python scripts/check_listings.py --dry-run

  # See the email format even when nothing is new (emails the current matches):
  RENTCAST_API_KEY=xxxx GMAIL_ADDRESS=you@gmail.com GMAIL_APP_PASSWORD=xxxx \
      python scripts/check_listings.py --force-email

  # Normal run (what the GitHub Action does):
  RENTCAST_API_KEY=xxxx GMAIL_ADDRESS=you@gmail.com GMAIL_APP_PASSWORD=xxxx \
      python scripts/check_listings.py
"""

import argparse
import json
import os
import smtplib
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from email.message import EmailMessage

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# RentCast sale-listings endpoint.  Docs: https://developers.rentcast.io/
RENTCAST_URL = "https://api.rentcast.io/v1/listings/sale"

# Search centre for Briarcliff West.  Matches mapCenter in site/config.js so the
# map and the watcher stay pointed at the same place.  [latitude, longitude]
SEARCH_CENTER = (39.166, -94.582)

# Search radius in MILES.  We deliberately over-fetch a little (the neighbourhood
# is small) and then trim to the exact boundary with the polygon filter below.
SEARCH_RADIUS_MILES = 0.75

# Only ever pull active for-sale listings.  "Inactive" would include sold/removed
# homes, which we don't want to alert on.
LISTING_STATUS = "Active"

# Max listings RentCast returns per request (its ceiling is 500).  Briarcliff
# West will only ever have a handful active, so one page is always enough.
PAGE_LIMIT = 500

# Recipient of the alert emails.
EMAIL_TO = "mattsnively@gmail.com"

# Link back to the live map, included at the bottom of each email.
MAP_URL = "https://mattsnively.github.io/dream-home/"

# File paths, resolved relative to the repository root (this file lives in
# scripts/, so the repo root is one directory up).
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POLYGON_PATH = os.path.join(REPO_ROOT, "reference", "briarcliff-west.geojson")
SNAPSHOT_PATH = os.path.join(REPO_ROOT, "data", "briarcliff-west-listings.json")

# A descriptive User-Agent, same courtesy as the JOCO puller.
USER_AGENT = "dream-home-listing-watch/1.0"


# ---------------------------------------------------------------------------
# Geometry — point-in-polygon (no third-party dependency)
# ---------------------------------------------------------------------------

def load_polygon_ring():
    """
    Read the Briarcliff West boundary from the GeoJSON file and return its outer
    ring as a list of (lng, lat) tuples.

    GeoJSON stores coordinates as [longitude, latitude], and a Polygon's
    "coordinates" is a list of rings where the first ring is the outer boundary.
    We only use that outer ring.
    """
    with open(POLYGON_PATH, "r", encoding="utf-8") as f:
        geo = json.load(f)

    # Support either a bare Geometry or a Feature wrapping one.
    geometry = geo.get("geometry", geo)
    coords = geometry["coordinates"][0]  # outer ring of the first polygon
    # Normalise to plain (lng, lat) float tuples.
    return [(float(pt[0]), float(pt[1])) for pt in coords]


def point_in_polygon(lng, lat, ring):
    """
    Standard ray-casting test: is the point (lng, lat) inside the polygon `ring`?

    Casts a ray to the right and counts how many polygon edges it crosses; an odd
    count means the point is inside.  `ring` is a list of (lng, lat) vertices.
    Coordinates are treated as planar x/y, which is accurate enough at the scale
    of a single neighbourhood.
    """
    inside = False
    n = len(ring)
    j = n - 1  # start by comparing the last vertex with the first
    for i in range(n):
        xi, yi = ring[i]
        xj, yj = ring[j]
        # Does the edge (j -> i) straddle the horizontal line y = lat, and is the
        # crossing point to the right of our x (lng)?  If so, flip inside/outside.
        straddles = (yi > lat) != (yj > lat)
        if straddles:
            x_cross = (xj - xi) * (lat - yi) / (yj - yi) + xi
            if lng < x_cross:
                inside = not inside
        j = i
    return inside


# ---------------------------------------------------------------------------
# RentCast fetch
# ---------------------------------------------------------------------------

def fetch_listings(api_key):
    """
    Fetch active for-sale listings near the search centre from RentCast.

    Returns the parsed JSON, which RentCast delivers as a list of listing dicts.
    Raises SystemExit with a clear message on auth / rate-limit / network errors
    so failures are loud in the Actions log.
    """
    params = urllib.parse.urlencode({
        "latitude":  SEARCH_CENTER[0],
        "longitude": SEARCH_CENTER[1],
        "radius":    SEARCH_RADIUS_MILES,
        "status":    LISTING_STATUS,
        "limit":     PAGE_LIMIT,
    })
    url = f"{RENTCAST_URL}?{params}"

    req = urllib.request.Request(url, headers={
        "X-Api-Key":  api_key,       # RentCast authenticates via this header
        "User-Agent": USER_AGENT,
        "Accept":     "application/json",
    })

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # 401 = bad/missing key, 429 = monthly quota or rate limit exceeded.
        detail = ""
        try:
            detail = exc.read().decode("utf-8")
        except Exception:
            pass
        sys.exit(f"ERROR: RentCast returned HTTP {exc.code} {exc.reason}. {detail}")
    except urllib.error.URLError as exc:
        sys.exit(f"ERROR: could not reach RentCast: {exc.reason}")

    # RentCast returns a JSON array for this endpoint; guard against surprises.
    if not isinstance(data, list):
        sys.exit(f"ERROR: unexpected RentCast response shape: {type(data).__name__}")
    return data


# ---------------------------------------------------------------------------
# Filtering, keys, and diffing
# ---------------------------------------------------------------------------

def normalize_addr(address):
    """
    Build a stable snapshot key from an address: lowercase, collapse internal
    whitespace, and strip surrounding punctuation/space.  Used so the same home
    maps to the same key across runs even if spacing wobbles slightly.
    """
    if not address:
        return ""
    return " ".join(str(address).split()).lower().strip(" ,")


def filter_to_neighborhood(listings, ring):
    """
    Keep only listings whose coordinates fall inside the Briarcliff West polygon.

    Listings without usable coordinates are dropped with a warning — we can't
    place them, and we'd rather miss one than send a false alert for a home in a
    neighbouring subdivision.
    """
    kept = []
    for home in listings:
        lat = home.get("latitude")
        lng = home.get("longitude")
        if lat is None or lng is None:
            print(f"  ! skipping (no coordinates): {home.get('formattedAddress', '?')}")
            continue
        if point_in_polygon(float(lng), float(lat), ring):
            kept.append(home)
    return kept


def load_snapshot():
    """
    Load the previous snapshot of active listings.  Returns the dict of
    { address_key: listing }.  Missing or unreadable file => empty dict (treated
    as "we've never seen anything", so the first run reports all current homes).
    """
    if not os.path.exists(SNAPSHOT_PATH):
        return {}
    try:
        with open(SNAPSHOT_PATH, "r", encoding="utf-8") as f:
            snap = json.load(f)
        return snap.get("listings", {})
    except (json.JSONDecodeError, OSError) as exc:
        print(f"  ! could not read snapshot ({exc}); treating as empty")
        return {}


def save_snapshot(current_by_key):
    """
    Write the current active set to the snapshot file (creating data/ if needed).
    We store the full listing objects so a future version can detect price
    changes without another API call.
    """
    os.makedirs(os.path.dirname(SNAPSHOT_PATH), exist_ok=True)
    payload = {
        "updated":  datetime.now(timezone.utc).isoformat(),
        "listings": current_by_key,
    }
    with open(SNAPSHOT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
        f.write("\n")


def diff_new(current_by_key, previous_by_key):
    """
    Return the list of listings that are active now but were not in the previous
    snapshot.  This covers both brand-new listings and homes that went off-market
    and came back.
    """
    return [
        home for key, home in current_by_key.items()
        if key not in previous_by_key
    ]


# ---------------------------------------------------------------------------
# Email
# ---------------------------------------------------------------------------

def money(value):
    """Format a number as US currency, or an em dash when missing."""
    if value in (None, ""):
        return "—"
    try:
        return "${:,.0f}".format(float(value))
    except (TypeError, ValueError):
        return str(value)


def deep_links(home):
    """
    Build handy 'look this up' links for a listing.  These are ordinary search
    URLs (not scraping): Zillow's address search, Realtor.com's search, and a
    plain Google search as a reliable fallback.
    """
    address = home.get("formattedAddress") or home.get("addressLine1") or ""
    zillow = "https://www.zillow.com/homes/" + urllib.parse.quote(address) + "_rb/"
    realtor = ("https://www.realtor.com/realestateandhomes-search/"
               + urllib.parse.quote(address.replace(",", "").replace(" ", "-")))
    google = "https://www.google.com/search?q=" + urllib.parse.quote(address + " for sale")
    return zillow, realtor, google


def build_email_html(homes, mode, new_keys=None):
    """
    Render the HTML body listing each home with its key facts and lookup links.

    mode:
      "alert"   -> just the new listings ("New listing(s) detected").
      "summary" -> the weekly Friday roundup of ALL active listings; any that are
                   new since the last run get a red NEW badge.
    new_keys: set of normalized addresses considered new (for the badge).
    """
    new_keys = new_keys or set()
    if mode == "summary":
        intro = (f"Your weekly Briarcliff West summary — {len(homes)} active "
                 f"listing(s) right now:") if homes else (
                 "Your weekly Briarcliff West summary — no active listings right "
                 "now. Still watching.")
    else:  # alert
        intro = "New Briarcliff West listing(s) detected:"

    rows = []
    for home in homes:
        address = home.get("formattedAddress") or home.get("addressLine1") or "Unknown address"
        key = normalize_addr(home.get("formattedAddress") or home.get("addressLine1"))
        beds = home.get("bedrooms")
        baths = home.get("bathrooms")
        sqft = home.get("squareFootage")
        listed = home.get("listedDate") or home.get("createdDate") or "—"
        zillow, realtor, google = deep_links(home)

        # Flag new listings inside the weekly summary so they still stand out.
        new_badge = ('<span style="background:#dc2626;color:#fff;font-size:11px;'
                     'font-weight:700;padding:1px 6px;border-radius:4px;margin-left:6px;">'
                     'NEW</span>') if key in new_keys else ""

        facts = " · ".join(part for part in [
            f"{beds} bd" if beds not in (None, "") else "",
            f"{baths} ba" if baths not in (None, "") else "",
            f"{int(sqft):,} sqft" if sqft not in (None, "") else "",
        ] if part)

        rows.append(f"""
          <div style="margin:0 0 18px;padding:14px 16px;border:1px solid #e5e7eb;border-radius:10px;">
            <div style="font-size:16px;font-weight:600;color:#111827;">{address}{new_badge}</div>
            <div style="font-size:18px;font-weight:700;color:#047857;margin:4px 0;">{money(home.get('price'))}</div>
            <div style="font-size:13px;color:#6b7280;">{facts or '&nbsp;'}</div>
            <div style="font-size:12px;color:#9ca3af;margin-top:4px;">Listed: {listed}</div>
            <div style="margin-top:8px;font-size:13px;">
              <a href="{zillow}" style="color:#2563eb;text-decoration:none;">Zillow</a> &nbsp;·&nbsp;
              <a href="{realtor}" style="color:#2563eb;text-decoration:none;">Realtor.com</a> &nbsp;·&nbsp;
              <a href="{google}" style="color:#2563eb;text-decoration:none;">Google</a>
            </div>
          </div>""")

    return f"""\
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;max-width:560px;margin:0 auto;padding:8px;">
  <h2 style="font-size:18px;">🏡 Dream Home — Briarcliff West</h2>
  <p style="font-size:14px;color:#374151;">{intro}</p>
  {''.join(rows)}
  <p style="font-size:13px;color:#6b7280;margin-top:20px;">
    Open the map: <a href="{MAP_URL}" style="color:#2563eb;">{MAP_URL}</a>
  </p>
  <p style="font-size:11px;color:#9ca3af;">Sent by check_listings.py · data from RentCast</p>
</body></html>"""


def send_email(homes, mode, new_keys, gmail_address, gmail_app_password):
    """
    Send an email via Gmail SMTP over SSL.  mode is "alert" (only the new
    listings) or "summary" (the weekly Friday roundup of all active listings,
    with new ones flagged).  Requires a Gmail App Password with 2-Step
    Verification enabled.
    """
    count = len(homes)
    n_new = len(new_keys or set())
    if mode == "summary":
        if count == 0:
            subject = "📋 Weekly Briarcliff West summary — no active listings"
        else:
            new_note = f" · {n_new} new" if n_new else ""
            subject = f"📋 Weekly Briarcliff West summary — {count} active{new_note}"
    else:  # alert
        plural = "s" if count != 1 else ""
        subject = f"🏡 {count} new Briarcliff West listing{plural}"

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = gmail_address
    msg["To"] = EMAIL_TO
    # Plain-text fallback for clients that don't render HTML.
    msg.set_content(
        f"{count} listing(s). View the map at {MAP_URL} "
        "(enable HTML to see the formatted details)."
    )
    msg.add_alternative(build_email_html(homes, mode, new_keys), subtype="html")

    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
            smtp.login(gmail_address, gmail_app_password)
            smtp.send_message(msg)
    except smtplib.SMTPAuthenticationError:
        sys.exit("ERROR: Gmail rejected the login. Check GMAIL_ADDRESS and that "
                 "GMAIL_APP_PASSWORD is a valid App Password (not your normal password).")
    except OSError as exc:
        sys.exit(f"ERROR: could not send email: {exc}")
    print(f"  → email sent to {EMAIL_TO}: {subject!r}")


# ---------------------------------------------------------------------------
# Optional Google Sheet auto-append (Phase 2 bridge)
# ---------------------------------------------------------------------------

def post_to_sheet(homes, webhook_url, webhook_token):
    """
    Append new listings to the Google Sheet via the Apps Script web app, if it's
    configured.  This is the bridge to Phase 2 (in-app data entry): the same
    endpoint that the map's edit form will use.  If the webhook isn't set up yet
    this is silently skipped, so Phase 1 works on its own.
    """
    if not webhook_url or not webhook_token:
        return  # not configured — nothing to do

    for home in homes:
        body = json.dumps({
            "token":   webhook_token,
            "address": home.get("formattedAddress") or home.get("addressLine1") or "",
            "updates": {
                "Status":             "For Sale",
                "List Price (Latest)": home.get("price", ""),
                "Bedrooms":           home.get("bedrooms", ""),
                "Bathrooms":          home.get("bathrooms", ""),
                "Square Footage":     home.get("squareFootage", ""),
                "Year Built":         home.get("yearBuilt", ""),
                "Listing Date":       home.get("listedDate", ""),
            },
        }).encode("utf-8")

        req = urllib.request.Request(
            webhook_url, data=body,
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp.read()
            print(f"  → sheet updated: {home.get('formattedAddress', '?')}")
        except (urllib.error.URLError, OSError) as exc:
            # A Sheet write failure should not fail the whole alert run.
            print(f"  ! sheet update failed for {home.get('formattedAddress', '?')}: {exc}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def is_friday_central():
    """
    True if it's Friday in Matt's timezone (America/Chicago) — the day we send the
    weekly summary. Falls back to a UTC check if the tz database is missing (the
    cron fires at 13:00 UTC, the same weekday as Central at that hour).
    """
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/Chicago")).weekday() == 4  # Mon=0 … Fri=4
    except Exception:
        return datetime.now(timezone.utc).weekday() == 4


def main():
    parser = argparse.ArgumentParser(description="Briarcliff West new-listing watcher")
    parser.add_argument("--dry-run", action="store_true",
                        help="Fetch/filter/diff only. Send no email and write no snapshot.")
    parser.add_argument("--force-email", action="store_true",
                        help="Send the weekly summary now (all current actives), regardless of the day.")
    args = parser.parse_args()

    # --- Credentials from the environment (set as GitHub Action secrets) -----
    api_key = os.environ.get("RENTCAST_API_KEY")
    if not api_key:
        sys.exit("ERROR: RENTCAST_API_KEY is not set. Add it as an environment "
                 "variable (locally) or repo secret (GitHub Actions).")
    gmail_address = os.environ.get("GMAIL_ADDRESS")
    gmail_app_password = os.environ.get("GMAIL_APP_PASSWORD")
    webhook_url = os.environ.get("SHEET_WEBHOOK_URL")
    webhook_token = os.environ.get("SHEET_WEBHOOK_TOKEN")

    # --- 1. Fetch + 2. Filter to the neighbourhood --------------------------
    print("Fetching active listings from RentCast…")
    raw = fetch_listings(api_key)
    print(f"  {len(raw)} listing(s) within {SEARCH_RADIUS_MILES} mi of centre")

    ring = load_polygon_ring()
    matched = filter_to_neighborhood(raw, ring)
    print(f"  {len(matched)} inside the Briarcliff West polygon")

    # --- 3. Diff against the previous snapshot ------------------------------
    current_by_key = {normalize_addr(
        h.get("formattedAddress") or h.get("addressLine1")): h for h in matched}
    previous_by_key = load_snapshot()
    new_listings = diff_new(current_by_key, previous_by_key)
    print(f"  {len(new_listings)} NEW vs last snapshot")
    for home in new_listings:
        print(f"    + {home.get('formattedAddress', '?')} — {money(home.get('price'))}")

    # --- Dry run stops here (no side effects) -------------------------------
    friday = is_friday_central()
    if args.dry_run:
        print(f"Dry run (weekly-summary day = {friday}): no email sent, snapshot not written.")
        return

    # --- 4. Email -----------------------------------------------------------
    # Alert-only on most days; on Fridays send the weekly summary of all active
    # listings instead (any new ones flagged). --force-email forces the summary.
    new_keys = {normalize_addr(h.get("formattedAddress") or h.get("addressLine1"))
                for h in new_listings}

    if friday or args.force_email:
        if not gmail_address or not gmail_app_password:
            sys.exit("ERROR: GMAIL_ADDRESS and GMAIL_APP_PASSWORD must be set to send email.")
        actives = sorted(current_by_key.values(),
                         key=lambda h: (h.get("price") or 0), reverse=True)
        send_email(actives, "summary", new_keys, gmail_address, gmail_app_password)
    elif new_listings:
        if not gmail_address or not gmail_app_password:
            sys.exit("ERROR: GMAIL_ADDRESS and GMAIL_APP_PASSWORD must be set to send email.")
        send_email(new_listings, "alert", new_keys, gmail_address, gmail_app_password)
    else:
        print("  nothing new — no email.")

    # --- 5. Optional Sheet append (only new listings, only if configured) ---
    if new_listings:
        post_to_sheet(new_listings, webhook_url, webhook_token)

    # --- 6. Persist the current set for next time ---------------------------
    save_snapshot(current_by_key)
    print("Snapshot written. Done.")


if __name__ == "__main__":
    main()
