"""
build_briarcliff_west_boundary.py

Derive the Briarcliff West boundary polygon from the curated address list, so
the neighborhood is defined by the parcels Matt actually cares about rather than
a hand-drawn guess.

What it does:
  1. Reads every numbered address from reference/briarcliff-selection.csv.
  2. Geocodes them in one shot via the US Census BATCH geocoder (free, keyless).
  3. Computes the convex hull of the resulting points and buffers it outward a
     little so parcels right on the edge aren't clipped.
  4. Writes the result to reference/briarcliff-west.geojson — the exact file that
     scripts/check_listings.py reads to decide which listings count as Briarcliff
     West.

Why this instead of drawing by hand: a hand-traced polygon is easy to get wrong
(we tried — it missed the whole eastern half of the neighborhood). Building the
boundary from the same address list the map already uses guarantees it matches
the curated dataset.

Note: briarcliff-selection.csv is the input. If that list changes, re-run this to
refresh the boundary:
  python reference/build_briarcliff_west_boundary.py
"""

import csv
import io
import json
import os
import urllib.request
import uuid

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Paths resolved relative to the repo root (this file lives in reference/).
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INPUT_CSV = os.path.join(REPO_ROOT, "reference", "briarcliff-selection.csv")
OUTPUT_GEOJSON = os.path.join(REPO_ROOT, "reference", "briarcliff-west.geojson")

# City/state/zip appended to the bare street addresses before geocoding.
CITY, STATE, ZIP = "Kansas City", "MO", "64116"

# Census batch geocoder — up to 10,000 addresses per POST, CSV response.
CENSUS_BATCH_URL = "https://geocoding.geo.census.gov/geocoder/locations/addressbatch"
CENSUS_BENCHMARK = "Public_AR_Current"

# How far to push the hull outward from its centroid, in degrees (~80 m).
# Keeps edge parcels safely inside without reaching the noise streets (N Oak
# Trafficway etc.) which sit well east of the neighborhood.
BUFFER_DEGREES = 0.0008


# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

def read_addresses():
    """Return the unique, house-numbered addresses from the selection CSV."""
    addrs = []
    with open(INPUT_CSV, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            a = (row.get("Address") or "").strip()
            # Skip street-only rows ("N Hickory Ct") — they don't geocode to a point.
            if a and a[0].isdigit():
                addrs.append(a)
    return sorted(set(addrs), key=str.lower)


def geocode_batch(addresses):
    """
    Geocode a list of street addresses via the Census batch endpoint.
    Returns a list of (lng, lat) tuples for the addresses that matched.
    """
    # Build the input CSV the batch API expects: id, street, city, state, zip
    buf = io.StringIO()
    writer = csv.writer(buf)
    for i, addr in enumerate(addresses):
        writer.writerow([i, addr, CITY, STATE, ZIP])
    file_content = buf.getvalue()

    # Assemble a multipart/form-data body by hand (stdlib has no helper for it).
    boundary = uuid.uuid4().hex
    parts = [
        f"--{boundary}",
        'Content-Disposition: form-data; name="benchmark"', "", CENSUS_BENCHMARK,
        f"--{boundary}",
        'Content-Disposition: form-data; name="addressFile"; filename="addresses.csv"',
        "Content-Type: text/csv", "", file_content,
        f"--{boundary}--", "",
    ]
    body = "\r\n".join(parts).encode("utf-8")

    req = urllib.request.Request(
        CENSUS_BATCH_URL, data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        result_csv = resp.read().decode("utf-8")

    # Response columns: id, input, matchIndicator, matchType, matchedAddr,
    #                   "lng,lat", tigerLineId, side
    points = []
    for row in csv.reader(io.StringIO(result_csv)):
        if len(row) >= 6 and row[2] == "Match" and row[5]:
            lng, lat = row[5].split(",")
            points.append((float(lng), float(lat)))
    return points


def convex_hull(points):
    """
    Andrew's monotone-chain convex hull. Returns the hull vertices in
    counter-clockwise order (open ring — first point not repeated).
    """
    pts = sorted(set(points))
    if len(pts) <= 2:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


def buffer_and_close(hull):
    """
    Push each hull vertex outward from the centroid by BUFFER_DEGREES and close
    the ring (repeat the first point). Returns a list of [lng, lat] pairs.
    """
    cx = sum(p[0] for p in hull) / len(hull)
    cy = sum(p[1] for p in hull) / len(hull)
    ring = []
    for x, y in hull:
        dx, dy = x - cx, y - cy
        dist = (dx * dx + dy * dy) ** 0.5 or 1.0
        ring.append([
            round(x + dx / dist * BUFFER_DEGREES, 6),
            round(y + dy / dist * BUFFER_DEGREES, 6),
        ])
    ring.append(ring[0])  # close the ring
    return ring


def main():
    addresses = read_addresses()
    print(f"Read {len(addresses)} unique numbered addresses from the selection.")

    print("Geocoding via Census batch endpoint…")
    points = geocode_batch(addresses)
    print(f"  matched {len(points)} of {len(addresses)}")

    hull = convex_hull(points)
    ring = buffer_and_close(hull)
    lngs = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    print(f"Hull: {len(hull)} vertices | "
          f"extent lng {min(lngs):.4f}..{max(lngs):.4f} lat {min(lats):.4f}..{max(lats):.4f}")

    geojson = {
        "type": "Feature",
        "properties": {
            "name": "Briarcliff West",
            "_derived": ("Convex hull of geocoded briarcliff-selection.csv "
                         "addresses (Census batch geocoder), buffered ~80 m. "
                         "Regenerate with reference/build_briarcliff_west_boundary.py."),
        },
        "geometry": {"type": "Polygon", "coordinates": [ring]},
    }
    with open(OUTPUT_GEOJSON, "w", encoding="utf-8") as f:
        json.dump(geojson, f, indent=2)
        f.write("\n")
    print(f"Wrote {OUTPUT_GEOJSON}")


if __name__ == "__main__":
    main()
