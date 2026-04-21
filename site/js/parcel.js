// Dream Home — parcel boundary layer.
//
// Responsibilities:
//   1. Query the Clay County ArcGIS FeatureServer for parcel polygons within a
//      configured bounding box + street-name filter (no API key required).
//   2. Normalize addresses on both sides (Sheet + county data) to match them
//      despite abbreviation differences ("Dr" vs "Drive", "N" vs "North", etc.).
//   3. Render matched parcels with:
//        • Stroke  = status color (green/yellow/grey/blue) so listing state is
//                    always visible regardless of fill mode.
//        • Fill    = one of:
//                    – transparent when colorMode is "none"
//                    – single-hue indigo gradient mapped to a selected metric
//                      (desirability, bedrooms, garage spaces, square footage)
//   4. Render unmatched parcels as faint grey outlines (map context only).
//   5. Wire hover highlighting and click-to-open-card on matched parcels.
//   6. Expose updateParcelVisibility() so filters can dim irrelevant parcels.
//   7. Expose updateParcelColors() so the "Color by" dropdown can re-fill the
//      entire layer without re-fetching from the API.
//
// No framework, no Esri Leaflet library — plain fetch + L.geoJSON().

(function () {
    "use strict";

    const cfg = window.DREAM_HOME_CONFIG;

    // Clay County ArcGIS FeatureServer — layer 0 is the parcel polygon layer.
    const FEATURE_SERVER_QUERY =
        "https://services7.arcgis.com/3c8lLdmDNevrTlaV/ArcGIS/rest/services/" +
        "ClayCountyParcelService/FeatureServer/0/query";

    // ---- Module state -------------------------------------------------------

    // Holds the current fill metric and pre-computed per-metric ranges so that
    // updateParcelColors() can re-style layers without re-reading the homes array.
    const state = {
        colorMode: "none",  // currently selected fill metric value from config
        ranges: {},         // { fieldName: { min, max } } built from Sheet homes
    };

    // ---- Address normalization ---------------------------------------------

    const ABBR = {
        dr: "drive", st: "street", ave: "avenue", av: "avenue",
        blvd: "boulevard", rd: "road", ln: "lane", ct: "court",
        pl: "place", cir: "circle", pkwy: "parkway", hwy: "highway",
        trl: "trail", ter: "terrace", terr: "terrace",
        n: "north", s: "south", e: "east", w: "west",
        ne: "northeast", nw: "northwest", se: "southeast", sw: "southwest",
    };

    /**
     * Normalize an address for fuzzy comparison:
     * lowercase, strip city/unit suffixes, expand abbreviations.
     *
     * @param {string} addr Raw address string
     * @returns {string} Normalized string
     */
    function normalizeAddress(addr) {
        if (!addr) return "";
        let s = String(addr).toLowerCase().trim();
        s = s.replace(/,\s*(kansas city|kc)[^,]*$/i, "").trim();
        s = s.replace(/\s+(apt|unit|#|suite|ste)\s*[\w-]+\s*$/i, "").trim();
        s = s.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
        return s.split(" ").map((w) => ABBR[w] || w).join(" ").trim();
    }

    // ---- Home index --------------------------------------------------------

    /**
     * Build a Map<normalizedAddress, home> for O(1) parcel-to-home lookup.
     *
     * @param {Array<Object>} homes Normalized home objects from app.js
     * @returns {Map<string, Object>}
     */
    function buildHomeIndex(homes) {
        const index = new Map();
        homes.forEach((h) => {
            const key = normalizeAddress(h.address);
            if (key) index.set(key, h);
        });
        return index;
    }

    // ---- Parcel-to-home matching -------------------------------------------

    /**
     * Reconstruct a one-line situs address from Clay County parcel field parts.
     * The service splits addresses into situs_num / situs_street_prefx /
     * situs_st_name / situs_street_sufix rather than a single formatted field.
     *
     * @param {Object} props Feature properties from ArcGIS GeoJSON
     * @returns {string} Reconstructed address
     */
    function getParcelSitusAddress(props) {
        const num    = (props.situs_num           || "").trim();
        const prefix = (props.situs_street_prefx  || "").trim();
        const name   = (props.situs_st_name       || "").trim();
        const suffix = (props.situs_street_sufix  || "").trim();
        return [num, prefix, name, suffix].filter((p) => p.length > 0).join(" ");
    }

    /**
     * Match a parcel feature to a tracked home.
     * Tries exact normalized match, then falls back to a 3-token prefix match.
     *
     * @param {Object} feature GeoJSON Feature
     * @param {Map<string, Object>} homeIndex From buildHomeIndex()
     * @returns {Object|null} Matched home, or null
     */
    function matchParcelToHome(feature, homeIndex) {
        const raw = getParcelSitusAddress(feature.properties);
        if (!raw) return null;
        const normalized = normalizeAddress(raw);
        if (homeIndex.has(normalized)) return homeIndex.get(normalized);
        const tokens = normalized.split(" ");
        if (tokens.length >= 3) {
            const prefix = tokens.slice(0, 3).join(" ");
            for (const [key, home] of homeIndex) {
                if (key.startsWith(prefix)) return home;
            }
        }
        return null;
    }

    // ---- Gradient fill logic -----------------------------------------------

    /**
     * Linearly interpolate between two hex color strings.
     * t=0 → low color, t=1 → high color.
     *
     * @param {string} hexLow  Hex color for the low end (e.g. "#e0e7ff")
     * @param {string} hexHigh Hex color for the high end (e.g. "#3730a3")
     * @param {number} t       Position in [0, 1]
     * @returns {string} Interpolated CSS rgb() string
     */
    function interpolateHex(hexLow, hexHigh, t) {
        const r1 = parseInt(hexLow.slice(1, 3), 16);
        const g1 = parseInt(hexLow.slice(3, 5), 16);
        const b1 = parseInt(hexLow.slice(5, 7), 16);
        const r2 = parseInt(hexHigh.slice(1, 3), 16);
        const g2 = parseInt(hexHigh.slice(3, 5), 16);
        const b2 = parseInt(hexHigh.slice(5, 7), 16);
        return `rgb(${Math.round(r1 + t * (r2 - r1))},${Math.round(g1 + t * (g2 - g1))},${Math.round(b1 + t * (b2 - b1))})`;
    }

    /**
     * Compute the fill color for a matched home given the current color mode.
     * Returns null when the fill should be transparent (mode=none or no data).
     *
     * @param {Object} home Matched home object
     * @returns {string|null} CSS color string, or null for transparent
     */
    function fillColorForHome(home) {
        const gradient = cfg.parcelFillGradient;
        if (!home || state.colorMode === "none") return null;

        // Find the field name for the current mode from config.
        const modeCfg = (cfg.parcelColorModes || []).find(
            (m) => m.value === state.colorMode
        );
        if (!modeCfg || !modeCfg.field) return null;

        const value = home[modeCfg.field];
        if (value === null || value === undefined || isNaN(value)) {
            return gradient.noData; // null = transparent fill
        }

        const range = state.ranges[modeCfg.field];
        if (!range) return null;

        // Map value onto [0, 1]; clamp to guard against out-of-range stray values.
        const t = range.max === range.min
            ? 0.5
            : Math.max(0, Math.min(1, (value - range.min) / (range.max - range.min)));

        return interpolateHex(gradient.low, gradient.high, t);
    }

    // ---- Leaflet style helpers ---------------------------------------------

    /**
     * Build the full Leaflet path style for a matched parcel:
     *   - color (stroke)  = status color — always visible, never changes
     *   - fillColor       = gradient color or transparent depending on mode
     *
     * Separating stroke from fill lets the user layer two information dimensions
     * simultaneously: listing status (outline) + a chosen metric (fill).
     *
     * @param {Object|null} home Matched home, or null for unmatched parcels
     * @returns {Object} Leaflet path options
     */
    function parcelStyle(home) {
        if (!home) {
            // Unmatched parcel — barely visible grey outline, no fill.
            return {
                color: "#bbbbbb",
                weight: 0.5,
                fillColor: "transparent",
                fillOpacity: 0,
                opacity: 0.4,
            };
        }

        const statusColor = cfg.statusColors[home.status] || cfg.fallbackStatusColor;
        const fillColor   = fillColorForHome(home);
        const hasFill     = fillColor !== null && fillColor !== undefined;

        return {
            color:       statusColor,  // stroke always carries status information
            weight:      2.5,          // slightly thicker than before so outline is
                                       // legible even when fill is present
            fillColor:   hasFill ? fillColor : "transparent",
            fillOpacity: hasFill ? 0.65 : 0,
            opacity:     1,
        };
    }

    /**
     * Hover style — boost stroke weight and fill opacity to signal interactivity.
     *
     * @param {Object} home Matched home object
     * @returns {Object} Leaflet path options
     */
    function parcelHoverStyle(home) {
        const base = parcelStyle(home);
        return {
            ...base,
            weight:      4,
            fillOpacity: base.fillOpacity > 0 ? Math.min(0.9, base.fillOpacity + 0.2) : 0,
        };
    }

    // ---- ArcGIS REST fetch -------------------------------------------------

    /**
     * Query the FeatureServer for parcels on the configured streets within the
     * bounding box.  Both filters are applied together:
     *   • WHERE situs_st_name IN (...) — restricts to tracked streets only,
     *     keeping results well under the 2,000-feature service cap.
     *   • Geometry envelope — prevents same-named streets in other Clay County
     *     areas from appearing.
     *
     * @param {Array<number>} bbox         [minLat, minLng, maxLat, maxLng]
     * @param {Array<string>} streetNames  Uppercase bare street names from config
     * @returns {Promise<Object>} GeoJSON FeatureCollection
     */
    async function fetchParcels(bbox, streetNames) {
        const [minLat, minLng, maxLat, maxLng] = bbox;
        const geomStr = `${minLng},${minLat},${maxLng},${maxLat}`;

        let whereClause = "1=1";
        if (streetNames && streetNames.length > 0) {
            const quoted = streetNames
                .map((n) => `'${n.replace(/'/g, "''")}'`)
                .join(",");
            whereClause = `situs_st_name IN (${quoted})`;
        }

        const url = new URL(FEATURE_SERVER_QUERY);
        url.searchParams.set("where",           whereClause);
        url.searchParams.set("geometry",        geomStr);
        url.searchParams.set("geometryType",    "esriGeometryEnvelope");
        url.searchParams.set("spatialRel",      "esriSpatialRelIntersects");
        url.searchParams.set("inSR",            "4326");
        url.searchParams.set("outSR",           "4326");
        url.searchParams.set("outFields",       "*");
        url.searchParams.set("f",               "geojson");
        url.searchParams.set("resultRecordCount", "2000");

        const resp = await fetch(url.toString(), { mode: "cors" });
        if (!resp.ok) {
            throw new Error("Parcel FeatureServer returned HTTP " + resp.status);
        }
        return resp.json();
    }

    // ---- Layer construction ------------------------------------------------

    /**
     * Fetch parcels, match them to Sheet homes, and add the GeoJSON layer to
     * the Leaflet map.
     *
     * @param {Object}   map            Leaflet map instance
     * @param {Array}    homes          Normalized home objects from app.js
     * @param {Function} onParcelClick  Callback(home) when a matched parcel is clicked
     * @param {Function} onStatusUpdate Optional callback(message) for status line
     * @returns {Promise<Object|null>} Leaflet GeoJSON layer, or null on failure
     */
    async function buildParcelLayer(map, homes, onParcelClick, onStatusUpdate) {
        const bbox        = cfg.parcelBbox;
        const streetNames = cfg.parcelStreetNames || [];

        if (onStatusUpdate) onStatusUpdate("Loading parcel boundaries…");

        let geojson;
        try {
            geojson = await fetchParcels(bbox, streetNames);
        } catch (err) {
            console.warn("Dream Home: parcel fetch failed —", err);
            if (onStatusUpdate) onStatusUpdate("Parcel data unavailable.");
            return null;
        }

        if (!geojson || !Array.isArray(geojson.features) || !geojson.features.length) {
            console.warn("Dream Home: no parcel features returned.");
            if (onStatusUpdate) onStatusUpdate("No parcels returned.");
            return null;
        }

        const homeIndex = buildHomeIndex(homes);
        let matchCount = 0;

        geojson.features.forEach((f) => {
            f._matchedHome = matchParcelToHome(f, homeIndex);
            if (f._matchedHome) matchCount++;
        });

        console.log(
            `Dream Home parcels: ${geojson.features.length} loaded, ` +
            `${matchCount} matched to Sheet entries.`
        );

        const layer = L.geoJSON(geojson, {
            style: (feature) => parcelStyle(feature._matchedHome),

            onEachFeature: (feature, featureLayer) => {
                const home = feature._matchedHome;
                if (!home) return;

                const scoreText =
                    home.desirability !== null ? `  ·  ★ ${home.desirability}/10` : "";
                featureLayer.bindTooltip(home.address + scoreText, {
                    direction: "top",
                    sticky: true,
                });

                featureLayer.on("mouseover", function () {
                    this.setStyle(parcelHoverStyle(home));
                    this.bringToFront();
                });
                featureLayer.on("mouseout", function () {
                    // Restore using current style state (respects active color mode).
                    this.setStyle(parcelStyle(home));
                });

                featureLayer.on("click", () => onParcelClick(home));
            },
        }).addTo(map);

        if (onStatusUpdate) onStatusUpdate("");
        return layer;
    }

    // ---- Dynamic color update ----------------------------------------------

    /**
     * Store per-metric min/max ranges computed from the Sheet homes.
     * Must be called once after data loads, before updateParcelColors() is useful.
     *
     * @param {Object} ranges { fieldName: { min, max } | null }
     */
    function setColorRanges(ranges) {
        state.ranges = ranges || {};
    }

    /**
     * Switch the fill metric and re-style all matched parcel polygons in place.
     * Does not re-fetch from the API.
     *
     * @param {Object|null} layer     Leaflet GeoJSON layer from buildParcelLayer()
     * @param {string}      colorMode Value from config.parcelColorModes (e.g. "bedrooms")
     */
    function updateParcelColors(layer, colorMode) {
        state.colorMode = colorMode || "none";
        if (!layer) return;

        layer.eachLayer((featureLayer) => {
            const home = featureLayer.feature._matchedHome;
            if (!home) return; // unmatched parcels stay in their fixed neutral style
            featureLayer.setStyle(parcelStyle(home));
        });
    }

    // ---- Filter visibility -------------------------------------------------

    /**
     * Dim parcel polygons whose homes are currently filtered out.
     * Filtered-in homes get their full status+fill style restored.
     *
     * @param {Object|null} layer      Leaflet GeoJSON layer
     * @param {Set<string>} visibleIds Set of home.id values passing current filters
     */
    function updateParcelVisibility(layer, visibleIds) {
        if (!layer) return;

        layer.eachLayer((featureLayer) => {
            const home = featureLayer.feature._matchedHome;
            if (!home) return;

            if (visibleIds.has(home.id)) {
                featureLayer.setStyle(parcelStyle(home));
            } else {
                featureLayer.setStyle({
                    color:       "#dddddd",
                    weight:      0.5,
                    fillOpacity: 0,
                    opacity:     0.2,
                });
            }
        });
    }

    // ---- Address export ----------------------------------------------------

    /**
     * Convert an all-caps situs address string to title case, preserving
     * common directional abbreviations (NW, NE, SW, SE, N, S, E, W) in
     * their expected uppercase form.
     *
     * Example: "4319 NW MULBERRY DR" → "4319 NW Mulberry Dr"
     *
     * @param {string} addr Raw uppercase address from ArcGIS
     * @returns {string} Title-cased address
     */
    function titleCaseAddress(addr) {
        if (!addr) return "";
        // Directionals we want to keep uppercase after title-casing.
        const DIRECTIONALS = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW"]);
        return addr
            .split(" ")
            .map((word) => {
                if (DIRECTIONALS.has(word.toUpperCase())) return word.toUpperCase();
                if (!word) return word;
                return word[0].toUpperCase() + word.slice(1).toLowerCase();
            })
            .join(" ");
    }

    /**
     * Fetch every parcel within the configured bbox + street names and return
     * a sorted, deduplicated array of clean one-line address strings.
     *
     * This is the data source for the "Export address list" button in app.js.
     * It reuses fetchParcels() and getParcelSitusAddress() so the bbox/street
     * config stays in a single place (config.js).
     *
     * @returns {Promise<string[]>} Sorted address strings, title-cased
     */
    async function fetchAllAddresses() {
        const bbox        = cfg.parcelBbox;
        const streetNames = cfg.parcelStreetNames || [];

        let geojson;
        try {
            geojson = await fetchParcels(bbox, streetNames);
        } catch (err) {
            throw new Error("Parcel service unavailable: " + err.message);
        }

        if (!geojson || !Array.isArray(geojson.features)) return [];

        // Deduplicate by lowercased key; reconstruct + title-case for display.
        const seen      = new Set();
        const addresses = [];

        geojson.features.forEach((f) => {
            const raw = getParcelSitusAddress(f.properties);
            if (!raw) return;
            const key = raw.toLowerCase().trim();
            if (seen.has(key)) return;
            seen.add(key);
            addresses.push(titleCaseAddress(raw));
        });

        // Sort numerically by street number then alphabetically by street name.
        addresses.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        return addresses;
    }

    // ---- Public API --------------------------------------------------------

    window.DreamHomeParcels = {
        buildParcelLayer,
        setColorRanges,
        updateParcelColors,
        updateParcelVisibility,
        normalizeAddress,
        fetchAllAddresses,
    };
})();
