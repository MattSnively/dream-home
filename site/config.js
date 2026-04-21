// Dream Home — site configuration.
//
// This is the only file you need to edit to:
//   - Point at a different Google Sheet (sheetCsvUrl)
//   - Re-center the map on a new neighborhood (mapCenter, mapZoom, parcelBbox)
//   - Adjust status colors, filter bounds, or the desirability column name
//
// For a new area (friend's neighborhood), duplicate this block and swap in
// the new Sheet URL, map center, and bounding box. The app reads everything
// from here so the JS files stay untouched.

window.DREAM_HOME_CONFIG = {

    // ---- Data source -------------------------------------------------------

    // Published-CSV URL from Matt's Google Sheet.
    // Sheet ID and tab GID are taken from the /edit URL the user shared.
    // The sheet must be published: File → Share → Publish to web →
    // select the tab → CSV → Publish.  Without that step the fetch will
    // return an HTML login page instead of CSV data.
    sheetCsvUrl:
        "https://docs.google.com/spreadsheets/d/e/2PACX-1vR8JqN_tTCWbz5gal5y1KWKREnAzMXvTIUFv4jNVIFmOmVMQVmVsV_J5hvBmX3rMIIzOzJ6pzTVIYJ-/pub?gid=537332677&single=true&output=csv",

    // ---- Map view ---------------------------------------------------------

    // Center + zoom on initial load.  Centered on Briarcliff West at zoom 16
    // (one step closer than before — parcel polygons are easier to click at 16).
    mapCenter: [39.166, -94.582],
    mapZoom: 16,

    // CartoDB Positron: light, minimal, free, no API key needed.
    // The clean white background makes the status-colored parcel polygons pop.
    // Attribution is required by CartoDB's terms of use.
    tileUrl: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    tileAttribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' +
        ' &copy; <a href="https://carto.com/attributions">CARTO</a>',
    tileMaxZoom: 19,
    tileSubdomains: "abcd",

    // ---- Parcel boundary layer --------------------------------------------

    // Bounding box for the Clay County parcel query.
    // Format: [minLat, minLng, maxLat, maxLng].
    // Used as a geographic pre-filter combined with parcelStreetNames below.
    // The bbox alone covers ~11k parcels (over the service limit), so we always
    // use both together.  Covers Briarcliff West + Briarcliff-Claymont.
    parcelBbox: [39.15, -94.60, 39.20, -94.55],

    // Street names to query from the Clay County parcel service.
    // These are the situs_st_name values (uppercase, no prefix/suffix) for every
    // street visible in Briarcliff West and Briarcliff-Claymont.  The query uses
    // WHERE situs_st_name IN (...) so we only fetch parcels on these streets,
    // keeping the result set well under the 2,000-feature service limit.
    //
    // To add a street: append its uppercase bare name (e.g. "VIVION" for NW Vivion Rd).
    // To find an unknown name: inspect a parcel on that street at
    // https://gisweb.claycountymo.gov/ps/ and read the situs_st_name field.
    parcelStreetNames: [
        "MULBERRY",    // N Mulberry Dr / N Mulberry Ct
        "HICKORY",     // N Hickory Ln / N Hickory Ct
        "HOLLY",       // N Holly Ct
        "CLAYMONT",    // NW Claymont Dr / NW Claymont Woods Dr
        "POINTE",      // NW Pointe Dr
        "BELLEVIEW",   // N Belleview Ave
        "BRIARCLIFF",  // NW Briarcliff Ct / NW Briarcliff Ln
        "BRIAR POINT", // Briar Point (as listed in the neighborhood)
        "WILDWOOD",    // NW Wildwood Dr
        "47TH",        // NW 47th St / N 47th St
        "44TH",        // NW 44th Terrace / NW 44th St
        "43RD",        // NW 43rd Terrace / NW 43rd Ct
        "45TH",        // NW 45th St
    ],

    // ---- Geocoding defaults -----------------------------------------------

    // Default city / state / zip appended to short addresses ("4319 N Mulberry Dr")
    // before sending to the Census Geocoder.  Ignored if the address already
    // contains a comma.
    defaultCity: "Kansas City",
    defaultState: "MO",
    defaultZip: "64116",

    // ---- Status colors -----------------------------------------------------

    // Fill and stroke color for each listing status.  Used by both the parcel
    // polygon layer and the KPI card status chip.
    statusColors: {
        "for sale":   "#2ecc71",   // green  — actively listed
        "pending":    "#f1c40f",   // yellow — under contract
        "off market":  "#7f8c8d",   // grey   — not currently listed
        "off-market":  "#7f8c8d",   // grey   — hyphenated variant from the Sheet
        "sold":       "#3498db",   // blue   — closed / historical
        "friends":    "#d4a017",   // gold   — home owned by someone Matt knows
    },

    // Color for any status string not in the map above (typos, new values, etc.)
    fallbackStatusColor: "#e74c3c",

    // ---- Filter bounds (for reference — inputs are free-form) -------------

    filterBounds: {
        price:        { min: 0,    max: 2_000_000, step: 10_000 },
        squareFt:     { min: 0,    max: 10_000,    step: 100    },
        bedrooms:     { min: 0,    max: 8,         step: 1      },
        bathrooms:    { min: 0,    max: 8,         step: 0.5    },
        yearBuilt:    { min: 1900, max: 2026,      step: 1      },
        desirability: { min: 1,    max: 10,        step: 1      },
    },

    // ---- Desirability score -----------------------------------------------

    // The Google Sheet column name that holds Matt's 1-10 personal rating.
    // If the column is missing or blank, scoring features are quietly disabled.
    desirabilityColumn: "Desirability",

    // ---- Fallback circle-marker pins (un-matched homes) -------------------

    // Homes that couldn't be matched to a parcel polygon still show as circle
    // markers so they're not silently lost.  These settings control pin sizing.
    pinRadius: {
        unscored:  7,
        minScored: 5,
        maxScored: 12,
    },

    // ---- Parcel fill gradient -----------------------------------------------

    // Single-hue gradient used for the fill color when a metric is selected
    // in the "Color parcels by" control.  low = lowest value in the data;
    // high = highest value.  Indigo was chosen because it doesn't conflict
    // with any status outline color (green/yellow/grey/blue).
    parcelFillGradient: {
        low:    "#e0e7ff",  // very light indigo — low end of range
        high:   "#3730a3",  // deep indigo      — high end of range
        noData: null,       // null = transparent fill (parcel shows status outline only)
    },

    // Metrics available in the "Color parcels by" dropdown.
    // field must match a property name on the home object in app.js.
    parcelColorModes: [
        { value: "none",          label: "None (outline only)" },
        { value: "desirability",  label: "Desirability",    field: "desirability"  },
        { value: "bedrooms",      label: "Bedrooms",         field: "bedrooms"      },
        { value: "garageSpaces",  label: "Garage spaces",    field: "garageSpaces"  },
        { value: "squareFootage", label: "Square footage",   field: "squareFootage" },
    ],

    // ---- CSV template columns (used by the "Add new area" feature) ---------

    // These column names are written as headers into the downloadable Sheet
    // template so a new user starts with the same schema as Briarcliff.
    // Update this list if the Sheet schema ever changes.
    templateColumns: [
        "Address",
        "Parcel",
        "Status",
        "List Price (Original)",
        "List Price (Latest)",
        "Listing Date",
        "Days on Market",
        "Lot Size",
        "Desirability",
        "Frontage Type",
        "Square Footage",
        "Price/SqFt",
        "Neighborhood",
        "Bedrooms",
        "Bedrooms Up",
        "Bathrooms",
        "Offices",
        "Floors",
        "HOA fees (mo)",
        "Year Built",
        "Storage",
        "Yard Size",
        "Garage Spaces",
        "Formal Dining",
        "Finished Basement",
        "Previous Listing",
        "Photo URL",
    ],
};
