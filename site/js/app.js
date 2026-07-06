// Dream Home — main app.
//
// Responsibilities:
//   1. Fetch the published Google Sheet CSV and parse it with PapaParse.
//   2. Normalize each row (strip dollar signs, lowercase categoricals, etc.)
//      into a clean in-memory "home" object.
//   3. Geocode every address via window.DreamHomeGeocode (Census + localStorage).
//   4. Build the parcel polygon layer via window.DreamHomeParcels (Clay County GIS).
//   5. Render fallback Leaflet circle pins for homes that couldn't be matched
//      to a parcel polygon.
//   6. Build the filter panel from the unique statuses/neighborhoods found.
//   7. Apply filters on change; update both pins and parcel coloring in place.
//   8. On parcel click (or pin click), open the KPI card.
//
// No framework, no build step. Plain DOM + Leaflet.

(function () {
    "use strict";

    // Module-scope state. Mutated by load() and the filter handlers.
    const state = {
        allHomes: [],       // all normalized homes from the Sheet
        filteredHomes: [],  // subset currently passing the active filters
        markers: new Map(), // home.id -> Leaflet circleMarker (fallback pins)
        parcelLayer: null,  // Leaflet GeoJSON layer from DreamHomeParcels
        matchedIds: new Set(), // home ids that have a matched parcel polygon
        map: null,
        localScores: {},    // address -> 1-10 score, persisted in localStorage
        localAssessments: {}, // address -> { SheetColumn: value } assessment cache
        openHomeId: null,   // id of the home whose card is open (async save guard)

        // Snapshot of the base (first-area) config fields that are overridable
        // per area.  Populated once in load() before any area switching so we
        // can always reset to defaults before applying an area's overrides.
        baseAreaConfig: null,
    };

    // localStorage key for the score cache.
    const SCORES_KEY = "dream-home-scores";

    // localStorage key for the subjective-assessment cache (mirrors SCORES_KEY).
    const ASSESS_KEY = "dream-home-assessments";

    // Subjective per-house fields Matt fills in on the map. Each maps to a Google
    // Sheet column and saves via the write-back endpoint. Adding a field here wires
    // it into the card form, the Sheet, and the local cache — no other changes.
    //   type "scale"  -> 1..max buttons    "toggle" -> Yes/No    "text" -> notes box
    const ASSESSMENT_FIELDS = [
        { key: "structureDesirability", col: "Structure Desirability", label: "Structure",           type: "scale",  max: 10 },
        { key: "curbAppeal",      col: "Curb Appeal",         label: "Curb appeal",         type: "scale",  max: 5 },
        { key: "condition",       col: "Condition",           label: "Condition",           type: "scale",  max: 5 },
        { key: "privacy",         col: "Privacy",             label: "Privacy",             type: "scale",  max: 5 },
        { key: "treeCover",       col: "Tree Cover",          label: "Tree cover",          type: "scale",  max: 5 },
        { key: "trafficNoise",    col: "Traffic Noise",       label: "Quiet (5 = silent)",  type: "scale",  max: 5 },
        { key: "cornerLot",       col: "Corner Lot",          label: "Corner lot",          type: "toggle" },
        { key: "culDeSac",        col: "Cul-de-sac",          label: "Cul-de-sac",          type: "toggle" },
        { key: "backsGreenspace", col: "Backs to Greenspace", label: "Backs to greenspace", type: "toggle" },
        { key: "assessmentNotes", col: "Assessment Notes",    label: "Notes",               type: "text" },
    ];

    // Objective home facts Matt maintains by hand (things Zillow can't auto-fill,
    // especially for off-market homes). Rendered as inline inputs in the card's
    // "Home details" grid.  type "money"/"number" -> numeric input; "text" -> text.
    const EDITABLE_FACTS = [
        { key: "priceAdjusted",    col: "List Price (Latest)", label: "List price",    type: "money" },
        { key: "squareFootage",    col: "Square Footage",      label: "Sqft",          type: "number" },
        { key: "bedrooms",         col: "Bedrooms",            label: "Beds",          type: "number" },
        { key: "bathrooms",        col: "Bathrooms",           label: "Baths",         type: "number", step: "0.5" },
        { key: "garageSpaces",     col: "Garage Spaces",       label: "Garage",        type: "number" },
        { key: "yearBuilt",        col: "Year Built",          label: "Built",         type: "number" },
        { key: "hoaMonthly",       col: "HOA fees (mo)",       label: "HOA/mo",        type: "money" },
        { key: "lotSize",          col: "Lot Size",            label: "Lot",           type: "text" },
        { key: "yardSize",         col: "Yard Size",           label: "Yard",          type: "text" },
        { key: "finishedBasement", col: "Finished Basement",   label: "Basement",      type: "text" },
        { key: "storage",          col: "Storage",             label: "Storage",       type: "text" },
        { key: "formalDining",     col: "Formal Dining",       label: "Formal dining", type: "text" },
        { key: "offices",          col: "Offices",             label: "Offices",       type: "number" },
        { key: "floors",           col: "Floors",              label: "Floors",        type: "number" },
    ];

    // Status options for the in-card dropdown. value = canonical lowercase (drives
    // the outline color via cfg.statusColors); sheet = the string written to the Sheet.
    const STATUS_OPTIONS = [
        { value: "for sale",   sheet: "For Sale",   label: "For Sale" },
        { value: "pending",    sheet: "Pending",    label: "Pending" },
        { value: "off-market", sheet: "Off-market", label: "Off-market" },
        { value: "sold",       sheet: "Sold",       label: "Sold" },
        { value: "friends",    sheet: "Friends",    label: "Friends" },
    ];

    // Every column editable in-app, used to merge the local edit cache back onto
    // homes on load (assessments + facts + status). Desirability keeps its own cache.
    const CACHE_SPECS = ASSESSMENT_FIELDS
        .concat(EDITABLE_FACTS)
        .concat([{ key: "status", col: "Status", type: "status" }]);

    const cfg = window.DREAM_HOME_CONFIG;

    // ---- Formatting helpers -----------------------------------------------

    /** Format a number as USD currency, or '—' when missing. */
    function fmtMoney(n) {
        if (n === null || n === undefined || isNaN(n)) return "—";
        return "$" + Math.round(n).toLocaleString();
    }

    /** Format a plain number with commas, or '—' when missing. */
    function fmtNum(n) {
        if (n === null || n === undefined || isNaN(n)) return "—";
        return n.toLocaleString();
    }

    /** Title-case a lowercased categorical ("for sale" → "For Sale"). */
    function titleCase(s) {
        if (!s) return "";
        return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1));
    }

    // ---- CSV normalization -----------------------------------------------

    /**
     * Parse '$1,150,000' or '998,500.00' into a Number, or null.
     * Idempotent — numeric inputs pass through unchanged.
     */
    function parseMoney(v) {
        if (v === null || v === undefined || v === "") return null;
        if (typeof v === "number") return v;
        const s = String(v).replace(/[$,]/g, "").trim();
        if (s === "" || s === "#DIV/0!" || s === "unknown") return null;
        const n = Number(s);
        return isNaN(n) ? null : n;
    }

    /** Parse a plain numeric cell, tolerating '#DIV/0!', blanks, 'unknown'. */
    function parseNum(v) {
        if (v === null || v === undefined || v === "") return null;
        if (typeof v === "number") return v;
        const s = String(v).replace(/[^\d.\-]/g, "").trim();
        if (s === "") return null;
        const n = Number(s);
        return isNaN(n) ? null : n;
    }

    /** Lowercase + trim; coerce empty/error cells to null. */
    function parseCategorical(v) {
        if (v === null || v === undefined) return null;
        const s = String(v).trim().toLowerCase();
        if (s === "" || s === "#div/0!" || s === "unknown" || s === "n/a") return null;
        return s;
    }

    /** Strip '[Updated ...]' style suffixes from an address cell. */
    function cleanAddress(v) {
        if (!v) return "";
        return String(v).replace(/\s*\[.*?\]\s*$/, "").trim();
    }

    /**
     * Build a stable, URL-safe id from an address.
     * The same algorithm used previously so cached geocode entries still match.
     */
    function homeIdFrom(address) {
        const safe = (address || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
        return safe || "unknown";
    }

    /**
     * Convert one raw Sheet row into a clean home object.
     * Missing columns become null.  Blank/formula-ghost rows return null.
     */
    function rowToHome(row) {
        const rawAddress = (row["Address"] || "").trim();
        const address = cleanAddress(rawAddress);
        if (!address) return null;

        // Compute days-on-market client-side so it's always accurate today,
        // regardless of how stale the Sheet's own computed column might be.
        let listingDate = null;
        let daysOnMarket = null;
        const rawDate = (row["Listing Date"] || "").trim();
        if (rawDate && rawDate !== "#DIV/0!") {
            const parsed = new Date(rawDate);
            if (!isNaN(parsed.getTime())) {
                listingDate = parsed;
                const ms = Date.now() - parsed.getTime();
                daysOnMarket = Math.floor(ms / (1000 * 60 * 60 * 24));
            }
        }

        // Use adjusted price if present; otherwise fall back to original.
        // We call the column "List Price (Latest)" matching the sheet schema.
        const priceOriginal = parseMoney(row["List Price (Original)"]);
        const priceAdjusted = parseMoney(row["List Price (Latest)"] || row["List Price (Adjusted)"]);
        const effectivePrice =
            priceAdjusted !== null ? priceAdjusted : priceOriginal;

        const sqft = parseNum(row["Square Footage"]);
        let pricePerSqft = null;
        if (effectivePrice !== null && sqft && sqft > 0) {
            pricePerSqft = effectivePrice / sqft;
        }

        return {
            id: homeIdFrom(address),
            address,
            addressRaw: rawAddress,
            status: parseCategorical(row["Status"]),
            neighborhood: parseCategorical(row["Neighborhood"]),
            priceOriginal,
            priceAdjusted,
            effectivePrice,
            listingDate,
            daysOnMarket,
            squareFootage: sqft,
            pricePerSqft,
            bedrooms: parseNum(row["Bedrooms"]),
            bedroomsUp: parseNum(row["Bedrooms Up"]),
            bathrooms: parseNum(row["Bathrooms"]),
            offices: parseNum(row["Offices"]),
            floors: parseNum(row["Floors"]),
            hoaMonthly: parseMoney(row["HOA fees (mo)"]),
            yearBuilt: parseNum(row["Year Built"]),
            storage: parseCategorical(row["Storage"]),
            yardSize: parseCategorical(row["Yard Size"]),
            garageSpaces: parseNum(row["Garage Spaces"]),
            formalDining: parseCategorical(row["Formal Dining"]),
            finishedBasement: parseCategorical(row["Finished Basement"]),
            lotSize: parseCategorical(row["Lot Size"]),
            previousListingNotes: (row["Previous Listing"] || "").trim(),

            // Optional photo URL — Matt pastes the Zillow listing image URL into
            // the "Photo URL" column.  When present, shown as a hero image in the
            // KPI card.  Blank = no image displayed (gracefully omitted).
            photoUrl: (row["Photo URL"] || "").trim(),

            // Manual 1-10 desirability score from the Sheet.  The app never
            // computes or infers this — Matt's eye is the source of truth.
            desirability: (function () {
                const colName = cfg.desirabilityColumn;
                const raw = row[colName];
                const n = parseNum(raw);
                if (n === null) return null;
                if (n < 1) return 1;
                if (n > 10) return 10;
                return n;
            })(),

            // Subjective assessment fields (Matt's manual entry → the Sheet).
            // Parsed generically from ASSESSMENT_FIELDS so adding a field is one line.
            ...parseAssessmentFields(row),

            // Filled by DreamHomeGeocode after CSV parse.
            lat: null,
            lon: null,
            matchedAddress: null,
        };
    }

    // ---- Zillow deep-link -----------------------------------------------

    /**
     * Construct a Zillow search URL for a given home address.
     * Zillow's deep-link format:
     *   https://www.zillow.com/homes/[address-dashes],-[city],-[state]-[zip]_rb/
     *
     * This opens Zillow's property search for the address.  If the listing exists
     * on Zillow, their search surfaces it as the top result.
     *
     * @param {Object} home Home object
     * @returns {string} Zillow URL
     */
    function zillowUrl(home) {
        const addr    = home.address.replace(/\s+/g, "-");
        const city    = (cfg.defaultCity  || "Kansas-City").replace(/\s+/g, "-");
        const state   = cfg.defaultState  || "MO";
        const zip     = cfg.defaultZip    || "";
        const slug    = [addr, city, state + (zip ? "-" + zip : "")]
            .join(",-")
            .replace(/,/g, "-");
        return `https://www.zillow.com/homes/${encodeURIComponent(slug)}_rb/`;
    }

    // ---- Data fetching ---------------------------------------------------

    /** Fetch and parse the Sheet CSV via PapaParse. */
    function fetchSheet() {
        return new Promise((resolve, reject) => {
            Papa.parse(cfg.sheetCsvUrl, {
                download: true,
                header: true,
                skipEmptyLines: true,
                complete: (results) => {
                    if (results.errors && results.errors.length > 0) {
                        console.warn("CSV parse warnings:", results.errors);
                    }
                    resolve(results.data);
                },
                error: (err) => reject(err),
            });
        });
    }

    // ---- Map setup -------------------------------------------------------

    /** Initialize Leaflet with the CartoDB Positron base map. */
    function initMap() {
        const map = L.map("map", {
            zoomControl: true,
            scrollWheelZoom: true,
        }).setView(cfg.mapCenter, cfg.mapZoom);

        // CartoDB Positron: clean white base that makes colored parcels pop.
        L.tileLayer(cfg.tileUrl, {
            maxZoom: cfg.tileMaxZoom,
            subdomains: cfg.tileSubdomains,
            attribution: cfg.tileAttribution,
        }).addTo(map);

        return map;
    }

    /** Return the hex color for a home based on its listing status. */
    function colorForStatus(status) {
        return cfg.statusColors[status] || cfg.fallbackStatusColor;
    }

    /**
     * Map a 1-10 desirability score to a circle pin radius.
     * Only used for fallback pins (homes without a matching parcel polygon).
     */
    function radiusForHome(home) {
        const r = cfg.pinRadius;
        if (home.desirability === null || home.desirability === undefined) {
            return r.unscored;
        }
        const t = (home.desirability - 1) / 9;
        return r.minScored + t * (r.maxScored - r.minScored);
    }

    /**
     * Create a Leaflet circleMarker fallback pin for homes that have coordinates
     * but couldn't be matched to a parcel polygon.  Uses a dashed stroke to
     * visually distinguish it from parcel polygons.
     */
    function makeMarker(home) {
        const marker = L.circleMarker([home.lat, home.lon], {
            radius: radiusForHome(home),
            color: "#ffffff",
            weight: 2,
            fillColor: colorForStatus(home.status),
            fillOpacity: 0.9,
            dashArray: "4 2", // dashed outline signals "no parcel data yet"
        });

        const scoreText =
            home.desirability !== null ? `  ·  ★ ${home.desirability}/10` : "";
        marker.bindTooltip(home.address + scoreText + "  (no parcel)", {
            direction: "top",
            offset: [0, -6],
        });
        marker.on("click", () => openCard(home));
        return marker;
    }

    // ---- KPI card --------------------------------------------------------

    /** Minimal HTML-escape for untrusted strings rendered into innerHTML. */
    function escapeHtml(str) {
        if (str === null || str === undefined) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    /**
     * Render the KPI card for a selected home and slide it into view.
     *
     * Layout (top to bottom):
     *   - Address + status chip + desirability chip
     *   - Hero KPI band: price | $/sqft | days on market
     *   - Compact facts grid: beds, baths, sqft, year, garage, HOA, yard, basement
     *   - Notes block (only if the Sheet has notes)
     */
    function openCard(home) {
        state.openHomeId = home.id;
        const body = document.getElementById("card-body");

        // Desirability chip — only rendered when Matt has actually rated the home.
        const scoreHtml =
            home.desirability !== null
                ? `<span class="score-chip" title="Your manual desirability score">
                       ★ ${home.desirability}/10
                   </span>`
                : "";

        // Price display: if there's an adjusted price, show it in green with
        // the original crossed out below.  Otherwise just show the single price.
        let priceHtml;
        if (home.priceAdjusted !== null && home.priceOriginal !== null &&
                home.priceAdjusted !== home.priceOriginal) {
            priceHtml = `
                <span class="kpi-value adjusted">${escapeHtml(fmtMoney(home.priceAdjusted))}</span>
                <span class="kpi-orig">${escapeHtml(fmtMoney(home.priceOriginal))}</span>`;
        } else {
            priceHtml = `<span class="kpi-value">${escapeHtml(fmtMoney(home.effectivePrice))}</span>`;
        }

        // Days on market display — if the home isn't active we don't show DOM
        // as a KPI (it's misleading for off-market/sold listings).
        const isActive = home.status === "for sale" || home.status === "pending";
        const domDisplay = isActive && home.daysOnMarket !== null
            ? home.daysOnMarket + " days"
            : "—";

        // Hero image — only rendered when a Photo URL is present in the Sheet.
        const heroImgHtml = home.photoUrl
            ? `<img class="card-hero-img"
                    src="${escapeHtml(home.photoUrl)}"
                    alt="${escapeHtml(home.address)}"
                    loading="lazy"
                    onerror="this.style.display='none'" />`
            : "";

        // Score picker — 10 numbered buttons, active one highlighted amber.
        // data-home-id lets the delegated click handler in load() find the home.
        const scoreBtns = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
            .map((n) => {
                const active = home.desirability === n ? " active" : "";
                return `<button class="score-btn${active}" data-score="${n}" type="button">${n}</button>`;
            })
            .join("");
        const clearBtn = home.desirability !== null
            ? `<button class="score-btn score-clear" data-score="" type="button" title="Clear score">×</button>`
            : "";

        body.innerHTML = `
            ${heroImgHtml}
            <h3>${escapeHtml(home.address)}</h3>
            <div class="chip-row">
                ${renderStatusSelect(home)}
                ${scoreHtml}
                ${home.neighborhood
                    ? `<span style="font-size:0.75rem;color:#6b7280;">${escapeHtml(titleCase(home.neighborhood))}</span>`
                    : ""}
            </div>
            <a class="zillow-link"
               href="${escapeHtml(zillowUrl(home))}"
               target="_blank"
               rel="noopener noreferrer">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M14 3h7v7l-2-2-9 9-4-4 9-9-1-1zm-9 14l-2 2H1v-2l2-2 2 2z"/>
                </svg>
                View on Zillow
            </a>

            <!-- Score picker: click a number to rate this home 1-10.
                 Saves instantly to localStorage; × clears the score. -->
            <div class="score-picker">
                <span class="score-picker-label">Rate this home</span>
                <div class="score-btns" data-home-id="${escapeHtml(home.id)}">
                    ${scoreBtns}${clearBtn}
                </div>
            </div>

            <!-- Hero KPI band: the three numbers Matt cares about most -->
            <div class="hero-kpi">
                <div class="kpi-cell">
                    ${priceHtml}
                    <span class="kpi-label">Price</span>
                </div>
                <div class="kpi-cell">
                    <span class="kpi-value">${escapeHtml(
                        home.pricePerSqft !== null ? fmtMoney(home.pricePerSqft) : "—"
                    )}</span>
                    <span class="kpi-label">/ sqft</span>
                </div>
                <div class="kpi-cell">
                    <span class="kpi-value">${escapeHtml(domDisplay)}</span>
                    <span class="kpi-label">On market</span>
                </div>
            </div>

            <!-- Editable home-details grid — type to edit, saves to the Sheet. -->
            <div class="card-section-title">Home details</div>
            ${renderFactsGrid(home)}

            ${renderAssessment(home)}

            ${home.previousListingNotes ? `
                <div class="card-section-title">Notes</div>
                <div class="notes-block">${escapeHtml(home.previousListingNotes)}</div>
            ` : ""}
        `;

        document.querySelector(".layout").classList.add("card-open");
        document.getElementById("home-card").setAttribute("aria-hidden", "false");
    }

    function closeCard() {
        state.openHomeId = null;
        document.querySelector(".layout").classList.remove("card-open");
        document.getElementById("home-card").setAttribute("aria-hidden", "true");
    }

    // ---- Filter panel ----------------------------------------------------

    /**
     * Build the status + neighborhood checkbox groups dynamically from the data.
     * Called once after the CSV loads so new statuses in the Sheet appear
     * automatically without any code change.
     *
     * NOTE: Does NOT add the sidebar "change" event listener — that is wired
     * once in load() to prevent duplicate listeners when switching areas.
     */
    function buildCheckboxFilters() {
        const statusSet = new Set();
        const nbSet = new Set();
        state.allHomes.forEach((h) => {
            if (h.status) statusSet.add(h.status);
            if (h.neighborhood) nbSet.add(h.neighborhood);
        });

        const statusEl = document.getElementById("filter-status");
        statusEl.innerHTML = "";
        Array.from(statusSet)
            .sort()
            .forEach((s) => {
                const label = document.createElement("label");
                const dot = `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${colorForStatus(s)};flex-shrink:0;"></span>`;
                label.innerHTML =
                    `<input type="checkbox" value="${escapeHtml(s)}" checked /> ` +
                    dot +
                    escapeHtml(titleCase(s));
                statusEl.appendChild(label);
            });

        const nbEl = document.getElementById("filter-neighborhood");
        nbEl.innerHTML = "";
        Array.from(nbSet)
            .sort()
            .forEach((n) => {
                const label = document.createElement("label");
                label.innerHTML =
                    `<input type="checkbox" value="${escapeHtml(n)}" checked /> ` +
                    escapeHtml(titleCase(n));
                nbEl.appendChild(label);
            });
    }

    /** Read current filter UI state and return a predicate function. */
    function currentFilterFn() {
        const checkedValues = (id) =>
            Array.from(
                document.querySelectorAll(`#${id} input[type="checkbox"]:checked`)
            ).map((el) => el.value);

        const allowedStatuses = new Set(checkedValues("filter-status"));
        const allowedNbs = new Set(checkedValues("filter-neighborhood"));

        const numOrNull = (id) => {
            const v = document.getElementById(id).value;
            if (v === "") return null;
            const n = Number(v);
            return isNaN(n) ? null : n;
        };

        const priceMin   = numOrNull("price-min");
        const priceMax   = numOrNull("price-max");
        const sqftMin    = numOrNull("sqft-min");
        const sqftMax    = numOrNull("sqft-max");
        const bedsMin    = numOrNull("beds-min");
        const bedsMax    = numOrNull("beds-max");
        const bathsMin   = numOrNull("baths-min");
        const bathsMax   = numOrNull("baths-max");
        const yearMin    = numOrNull("year-min");
        const yearMax    = numOrNull("year-max");
        const desirMin   = numOrNull("desir-min");
        const desirMax   = numOrNull("desir-max");
        const hideUnscored = document.getElementById("hide-unscored").checked;

        // Null home values always pass the range check — we don't want to
        // hide a home just because Matt hasn't filled in every column yet.
        const inRange = (v, min, max) => {
            if (v === null || v === undefined || isNaN(v)) return true;
            if (min !== null && v < min) return false;
            if (max !== null && v > max) return false;
            return true;
        };

        return (h) => {
            if (h.status && !allowedStatuses.has(h.status)) return false;
            if (h.neighborhood && !allowedNbs.has(h.neighborhood)) return false;
            if (!inRange(h.effectivePrice, priceMin, priceMax)) return false;
            if (!inRange(h.squareFootage, sqftMin, sqftMax)) return false;
            if (!inRange(h.bedrooms, bedsMin, bedsMax)) return false;
            if (!inRange(h.bathrooms, bathsMin, bathsMax)) return false;
            if (!inRange(h.yearBuilt, yearMin, yearMax)) return false;
            if (h.desirability === null) {
                if (hideUnscored) return false;
            } else {
                if (desirMin !== null && h.desirability < desirMin) return false;
                if (desirMax !== null && h.desirability > desirMax) return false;
            }
            return true;
        };
    }

    /**
     * Apply active filters:
     *   - Show/hide fallback circle markers
     *   - Update parcel polygon visibility via DreamHomeParcels
     *   - Update the count display
     */
    function applyFilters() {
        const predicate = currentFilterFn();
        let visible = 0;

        state.allHomes.forEach((h) => {
            const passes = predicate(h);
            if (passes) visible++;

            // Only toggle the fallback marker if this home has one.
            const marker = state.markers.get(h.id);
            if (marker) {
                if (passes) marker.addTo(state.map);
                else state.map.removeLayer(marker);
            }
        });

        state.filteredHomes = state.allHomes.filter(predicate);

        // Tell the parcel layer which home IDs are currently visible so it can
        // dim the ones that are filtered out.
        const visibleIds = new Set(state.filteredHomes.map((h) => h.id));
        window.DreamHomeParcels.updateParcelVisibility(state.parcelLayer, visibleIds);

        updateCounts(visible);
    }

    /** Reset all filter inputs, re-check every checkbox, then re-apply. */
    function clearFilters() {
        document
            .querySelectorAll('#filters input[type="number"]')
            .forEach((el) => (el.value = ""));
        document
            .querySelectorAll('#filters input[type="checkbox"]')
            .forEach((el) => (el.checked = true));
        applyFilters();
    }

    /** Update the "X of Y homes" counters in the header and footer. */
    function updateCounts(visibleCount) {
        const total = state.allHomes.length;
        const mapped = state.allHomes.filter(
            (h) => h.lat !== null && h.lon !== null
        ).length;
        const text = `${visibleCount} of ${total} homes visible (${mapped} mapped)`;
        document.getElementById("home-count").textContent = text;
        document.getElementById("footer-count").textContent = text;
    }

    // ---- Desirability score management (localStorage) --------------------

    /**
     * Read saved scores from localStorage and merge them into the homes array.
     * localStorage scores take priority over whatever is in the Sheet — they
     * represent the user's latest intent from a scoring session on the map.
     *
     * Called once after the Sheet CSV is parsed, before anything renders.
     *
     * @param {Array<Object>} homes Normalized home objects
     */
    function loadLocalScores(homes) {
        try {
            const raw = localStorage.getItem(SCORES_KEY);
            state.localScores = raw ? JSON.parse(raw) : {};
        } catch (e) {
            console.warn("Dream Home: could not read local scores —", e);
            state.localScores = {};
        }

        // Apply any saved scores on top of the Sheet values.
        homes.forEach((h) => {
            if (Object.prototype.hasOwnProperty.call(state.localScores, h.address)) {
                h.desirability = state.localScores[h.address];
            }
        });
    }

    // ---- Assessment management (subjective fields → Sheet) ----------------

    /** Parse a yes/no-ish cell into true / false / null. */
    function parseBool(v) {
        if (v === null || v === undefined || v === "") return null;
        const s = String(v).trim().toLowerCase();
        if (["yes", "y", "true", "1", "x"].includes(s)) return true;
        if (["no", "n", "false", "0"].includes(s)) return false;
        return null;
    }

    /** Convert a Sheet cell into the in-memory value for an editable field. */
    function sheetValueToField(field, raw) {
        if (raw === "" || raw === null || raw === undefined) return null;
        switch (field.type) {
            case "scale": {
                const n = parseNum(raw);
                return n === null ? null : Math.max(1, Math.min(field.max, Math.round(n)));
            }
            case "toggle": return parseBool(raw);
            case "money":  return parseMoney(raw);
            case "number": return parseNum(raw);
            case "status": return String(raw).trim().toLowerCase() || null;
            default:       return String(raw).trim() || null;  // text
        }
    }

    /** Convert an in-memory assessment value into the string written to the Sheet. */
    function assessmentToSheetValue(field, value) {
        if (value === null || value === undefined || value === "") return "";
        if (field.type === "toggle") return value ? "Yes" : "No";
        return value;  // scale number or notes string
    }

    /** Build the subjective-assessment fields for a home from its Sheet row. */
    function parseAssessmentFields(row) {
        const out = {};
        ASSESSMENT_FIELDS.forEach((f) => { out[f.key] = sheetValueToField(f, row[f.col]); });
        return out;
    }

    /**
     * Read cached assessments from localStorage and merge them onto the homes.
     * The cache holds the user's latest local intent, so it overrides Sheet values
     * (which can lag a few minutes behind a write via the published CSV).
     *
     * @param {Array<Object>} homes Normalized home objects
     */
    function loadLocalAssessments(homes) {
        try {
            const raw = localStorage.getItem(ASSESS_KEY);
            state.localAssessments = raw ? JSON.parse(raw) : {};
        } catch (e) {
            console.warn("Dream Home: could not read local assessments —", e);
            state.localAssessments = {};
        }
        homes.forEach((h) => {
            const cache = state.localAssessments[h.address];
            if (!cache) return;
            CACHE_SPECS.forEach((f) => {
                if (Object.prototype.hasOwnProperty.call(cache, f.col)) {
                    h[f.key] = sheetValueToField(f, cache[f.col]);
                }
            });
            recomputeDerived(h);  // refresh price / $-per-sqft after merging cached facts
        });
    }

    /**
     * POST column updates for an address to the Apps Script web app.
     * Sends a text/plain body so the browser treats it as a "simple" request and
     * skips the CORS preflight the Apps Script endpoint can't answer.
     * onDone(ok) (optional) reports whether the Sheet confirmed the write.
     *
     * @param {string} address
     * @param {Object} updates  { "Sheet Column": value, ... }
     * @param {Function} [onDone]
     */
    function postToSheet(address, updates, onDone) {
        const wb = cfg.sheetWriteback;
        if (!wb || !wb.url) { if (onDone) onDone(false); return; }
        fetch(wb.url, {
            method: "POST",
            // No custom headers → Content-Type defaults to text/plain → no preflight.
            body: JSON.stringify({ token: wb.token, address: address, updates: updates }),
        })
            .then(async (r) => {
                // If the JSON body is readable, trust its ok flag. Apps Script's
                // cross-origin redirect can make the body unreadable even on a
                // successful write, so a resolved-but-opaque response counts as ok.
                try { const res = await r.json(); return !!(res && res.ok); }
                catch (_) { return true; }
            })
            .then((ok) => { if (onDone) onDone(ok); })
            .catch(() => { if (onDone) onDone(false); });   // network / CORS-blocked
    }

    /** Update the small save-status line under the assessment form. */
    function setAssessStatus(msg, cls) {
        const el = document.getElementById("assess-status");
        if (el) {
            el.textContent = msg;
            el.className = "assess-status" + (cls ? " " + cls : "");
        }
    }

    /**
     * Save one assessment field: update the home, cache it locally (instant and
     * offline-safe), write through to the Sheet, and reflect the result in the UI.
     *
     * @param {Object} home
     * @param {Object} field  One entry from ASSESSMENT_FIELDS
     * @param {number|boolean|string|null} value
     */
    function saveAssessment(home, field, value) {
        // 1. In-memory.
        home[field.key] = value;

        // 2. Local cache (instant, offline-safe) via the shared edit cache.
        const sheetValue = assessmentToSheetValue(field, value);
        cacheEdit(home.address, field.col, sheetValue);

        // 3. Refresh button states for scale/toggle (skip for notes so the textarea
        //    keeps focus + scroll position); then show a saving indicator.
        if (field.type !== "text") openCard(home);
        setAssessStatus("Saving…", "pending");

        // 4. Write through to the Sheet.
        postToSheet(home.address, { [field.col]: sheetValue }, (ok) => {
            if (state.openHomeId !== home.id) return;   // user moved to another card
            setAssessStatus(
                ok ? "Saved to your Sheet ✓" : "Saved locally — Sheet sync failed",
                ok ? "ok" : "warn"
            );
        });
    }

    /**
     * Render the "Your assessment" form for a home from ASSESSMENT_FIELDS.
     * Scale fields render 1..max buttons, toggles a Yes/No pair, notes a textarea.
     */
    function renderAssessment(home) {
        const rows = ASSESSMENT_FIELDS.map((f) => {
            const cur = home[f.key];

            if (f.type === "scale") {
                let btns = "";
                for (let n = 1; n <= f.max; n++) {
                    const active = cur === n ? " active" : "";
                    btns += `<button class="assess-btn${active}" data-assess="${f.key}" data-value="${n}" type="button">${n}</button>`;
                }
                const clear = (cur !== null && cur !== undefined)
                    ? `<button class="assess-btn assess-clear" data-assess="${f.key}" data-value="" type="button" title="Clear">×</button>`
                    : "";
                return `<div class="assess-field">
                        <span class="assess-label">${f.label}</span>
                        <div class="assess-btns">${btns}${clear}</div>
                    </div>`;
            }

            if (f.type === "toggle") {
                const yes = cur === true ? " active" : "";
                const no = cur === false ? " active" : "";
                const clear = (cur !== null && cur !== undefined)
                    ? `<button class="toggle-btn toggle-clear" data-assess="${f.key}" data-value="" type="button" title="Clear">×</button>`
                    : "";
                return `<div class="assess-field">
                        <span class="assess-label">${f.label}</span>
                        <div class="assess-btns">
                            <button class="toggle-btn${yes}" data-assess="${f.key}" data-value="yes" type="button">Yes</button>
                            <button class="toggle-btn${no}" data-assess="${f.key}" data-value="no" type="button">No</button>
                            ${clear}
                        </div>
                    </div>`;
            }

            // text (notes)
            return `<div class="assess-field assess-field-text">
                    <span class="assess-label">${f.label}</span>
                    <textarea class="assess-notes" data-assess="${f.key}" rows="2"
                              placeholder="Your notes…">${escapeHtml(cur || "")}</textarea>
                </div>`;
        }).join("");

        return `
            <div class="card-section-title">Your assessment</div>
            <div class="assessment-section" data-home-id="${escapeHtml(home.id)}">
                ${rows}
                <div class="assess-status" id="assess-status"></div>
            </div>`;
    }

    // ---- Editable facts + status (objective fields → Sheet) ---------------

    /** Write one in-app edit to the shared local cache (address -> { col: value }). */
    function cacheEdit(address, col, sheetValue) {
        const cache = state.localAssessments[address] || {};
        if (sheetValue === "" || sheetValue === null || sheetValue === undefined) delete cache[col];
        else cache[col] = sheetValue;
        state.localAssessments[address] = cache;
        try { localStorage.setItem(ASSESS_KEY, JSON.stringify(state.localAssessments)); }
        catch (e) { console.warn("Dream Home: edit cache write failed —", e); }
    }

    /** Recompute derived display values (effective price, $/sqft) after an edit. */
    function recomputeDerived(home) {
        home.effectivePrice = (home.priceAdjusted !== null && home.priceAdjusted !== undefined)
            ? home.priceAdjusted : home.priceOriginal;
        home.pricePerSqft = (home.effectivePrice !== null && home.effectivePrice !== undefined && home.squareFootage)
            ? home.effectivePrice / home.squareFootage : null;
    }

    /**
     * Save one editable fact (Sqft, Price, Beds, …): parse the input, update the
     * home, refresh derived values, cache locally, re-render, and write to the Sheet.
     *
     * @param {Object} home
     * @param {Object} spec  One entry from EDITABLE_FACTS
     * @param {string} rawValue  Raw <input> value
     */
    function saveFact(home, spec, rawValue) {
        const value = (spec.type === "text")
            ? (rawValue.trim() === "" ? null : rawValue.trim())
            : (spec.type === "money" ? parseMoney(rawValue) : parseNum(rawValue));
        home[spec.key] = value;
        recomputeDerived(home);

        const sheetValue = value === null ? "" : value;
        cacheEdit(home.address, spec.col, sheetValue);
        openCard(home);
        setAssessStatus("Saving…", "pending");
        postToSheet(home.address, { [spec.col]: sheetValue }, (ok) => {
            if (state.openHomeId !== home.id) return;
            setAssessStatus(
                ok ? "Saved to your Sheet ✓" : "Saved locally — Sheet sync failed",
                ok ? "ok" : "warn"
            );
        });
    }

    /**
     * Save the listing status: update in memory, recolor the parcel outline live
     * (status drives the stroke color), cache, re-render, and write to the Sheet.
     *
     * @param {Object} home
     * @param {string|null} canonical  Canonical lowercase status, or null to clear
     */
    function saveStatus(home, canonical) {
        const opt = STATUS_OPTIONS.find((o) => o.value === canonical);
        home.status = canonical || null;
        const sheetValue = opt ? opt.sheet : (canonical || "");

        cacheEdit(home.address, "Status", sheetValue);
        // Recolor the parcel outline immediately.
        const colorSel = document.getElementById("color-by");
        window.DreamHomeParcels.updateParcelColors(state.parcelLayer, colorSel ? colorSel.value : "none");

        openCard(home);
        setAssessStatus("Saving…", "pending");
        postToSheet(home.address, { Status: sheetValue }, (ok) => {
            if (state.openHomeId !== home.id) return;
            setAssessStatus(
                ok ? "Saved to your Sheet ✓" : "Saved locally — Sheet sync failed",
                ok ? "ok" : "warn"
            );
        });
    }

    /** Render the status dropdown, tinted by the current status color. */
    function renderStatusSelect(home) {
        const known = STATUS_OPTIONS.some((o) => o.value === home.status);
        const bg = home.status ? (cfg.statusColors[home.status] || cfg.fallbackStatusColor) : "#9ca3af";
        const opts = [`<option value=""${!home.status ? " selected" : ""}>—</option>`]
            .concat(STATUS_OPTIONS.map((o) =>
                `<option value="${o.value}"${home.status === o.value ? " selected" : ""}>${o.label}</option>`))
            .concat((!known && home.status)
                ? [`<option value="${escapeHtml(home.status)}" selected>${escapeHtml(titleCase(home.status))}</option>`]
                : [])
            .join("");
        return `<select class="status-select" data-home-id="${escapeHtml(home.id)}" style="background-color:${bg}">${opts}</select>`;
    }

    /** Render the editable Home-details grid from EDITABLE_FACTS. */
    function renderFactsGrid(home) {
        const items = EDITABLE_FACTS.map((f) => {
            const val = home[f.key];
            const shown = (val === null || val === undefined) ? "" : val;
            const type = (f.type === "text") ? "text" : "number";
            const step = f.step ? ` step="${f.step}"` : (f.type === "money" ? ` step="1000"` : "");
            return `<div class="fact-item">
                    <span class="fact-label">${f.label}</span>
                    <input class="fact-input" type="${type}"${step} data-fact="${f.key}"
                           value="${escapeHtml(String(shown))}" placeholder="—" />
                </div>`;
        }).join("");
        return `<div class="facts-grid">${items}</div>`;
    }

    /**
     * Persist a new desirability score for a home, update the in-memory state,
     * re-render the parcel fill gradient, and refresh the open card so the
     * active button highlights immediately.
     *
     * Passing null clears the score (removes it from localStorage too).
     *
     * @param {Object}   home  Home object from state.allHomes
     * @param {number|null} score 1–10 integer, or null to clear
     */
    function saveLocalScore(home, score) {
        // 1. Update in-memory home object.
        home.desirability = score;

        // 2. Persist to localStorage.
        if (score === null) {
            delete state.localScores[home.address];
        } else {
            state.localScores[home.address] = score;
        }
        try {
            localStorage.setItem(SCORES_KEY, JSON.stringify(state.localScores));
        } catch (e) {
            console.warn("Dream Home: localStorage write failed —", e);
        }

        // Also write the score through to the Sheet so it's durable across devices.
        postToSheet(home.address, { [cfg.desirabilityColumn]: score === null ? "" : score });

        // 3. Re-compute per-metric ranges so the gradient rescales if this
        //    score extends or contracts the min/max.
        const colorRanges = computeColorRanges(state.allHomes);
        window.DreamHomeParcels.setColorRanges(colorRanges);

        // 4. Re-apply fill colors to the parcel layer.
        const colorMode = document.getElementById("color-by").value;
        window.DreamHomeParcels.updateParcelColors(state.parcelLayer, colorMode);

        // 5. Update the gradient legend labels (min/max may have changed).
        updateGradientLegend(colorMode, colorRanges);

        // 6. Re-render the open card so the active score button updates.
        openCard(home);
    }

    /**
     * Download a two-column CSV (Address, Desirability) containing every score
     * saved in localStorage this session.  The user pastes this into the Sheet
     * to make scores permanent.
     *
     * Alerts if no scores have been recorded yet.
     */
    function exportLocalScores() {
        const entries = Object.entries(state.localScores);
        if (!entries.length) {
            alert(
                "No scores recorded yet.\n\n" +
                "Click parcels on the map and rate them 1–10 to record scores."
            );
            return;
        }

        // Sort alphabetically by address for easier pasting into the Sheet.
        entries.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));

        const rows = [
            '"Address","Desirability"',
            ...entries.map(
                ([addr, score]) => `"${addr.replace(/"/g, '""')}",${score}`
            ),
        ];

        const csv  = rows.join("\r\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href     = url;
        a.download = "briarcliff-scores.csv";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log(`Dream Home: exported ${entries.length} scores.`);
    }

    // ---- Multi-area support ------------------------------------------------

    // These are the config fields that each area entry can override.
    // Any key listed here will be snapshotted on first load and restored
    // to the snapshot before each subsequent area's overrides are applied.
    const AREA_OVERRIDE_KEYS = [
        "sheetCsvUrl",
        "mapCenter",
        "mapZoom",
        "parcelBbox",
        "parcelStreetNames",
        "defaultCity",
        "defaultState",
        "defaultZip",
    ];

    /**
     * Apply a single area's config overrides onto the global cfg object.
     *
     * Process:
     *   1. Restore all overridable keys to their base (first-area) values.
     *   2. Copy any non-undefined fields from the area entry on top.
     *
     * This ensures switching back to area[0] (Briarcliff) fully resets any
     * fields that were changed for a different area.
     *
     * @param {Object} area  One entry from cfg.areas[]
     */
    function applyAreaConfig(area) {
        // Step 1: restore base config for overridable keys.
        AREA_OVERRIDE_KEYS.forEach((key) => {
            if (state.baseAreaConfig && key in state.baseAreaConfig) {
                cfg[key] = state.baseAreaConfig[key];
            }
        });

        // Step 2: apply this area's overrides (skip id/label and undefined values).
        Object.keys(area).forEach((key) => {
            if (key === "id" || key === "label") return;
            if (area[key] !== undefined) cfg[key] = area[key];
        });
    }

    /**
     * Populate the area-switcher <select> from config.areas and wire its
     * change handler.  Hides the control when only one area is configured.
     */
    function buildAreaSwitcher() {
        const areas    = cfg.areas;
        const switcher = document.getElementById("area-switcher");
        if (!switcher) return;

        // If there's only one area (or none), hide the switcher — no need to clutter
        // the topbar when there's nothing to switch between.
        if (!areas || areas.length <= 1) {
            switcher.hidden = true;
            return;
        }

        switcher.hidden = false;
        switcher.innerHTML = "";
        areas.forEach((area, idx) => {
            const opt       = document.createElement("option");
            opt.value       = String(idx);
            opt.textContent = area.label;
            switcher.appendChild(opt);
        });

        // Switch areas when the user picks a different neighborhood.
        switcher.addEventListener("change", () => {
            const idx  = parseInt(switcher.value, 10);
            const area = (cfg.areas || [])[idx];
            if (area) switchArea(area);
        });
    }

    /**
     * Switch to a new area: clear existing map data, apply the area's config
     * overrides, re-center the map, then reload all Sheet + parcel data.
     *
     * This is a full data reload — geocode results are cached in localStorage
     * so repeated switches don't re-hit the Census API.
     *
     * @param {Object} area  One entry from cfg.areas[]
     */
    async function switchArea(area) {
        closeCard();

        // Show loading state while clearing.
        const statusEl = document.getElementById("geocode-status");
        statusEl.textContent = `Loading ${area.label}…`;
        document.getElementById("home-count").textContent = "Loading…";

        // Remove all fallback circle pins from the map.
        state.markers.forEach((marker) => state.map.removeLayer(marker));
        state.markers.clear();

        // Remove parcel polygon layer if one is present.
        if (state.parcelLayer) {
            state.map.removeLayer(state.parcelLayer);
            state.parcelLayer = null;
        }

        // Reset in-memory data and match tracking.
        state.allHomes     = [];
        state.filteredHomes = [];
        state.matchedIds.clear();

        // Clear dynamic filter checkboxes — they'll be rebuilt from new data.
        document.getElementById("filter-status").innerHTML       = "";
        document.getElementById("filter-neighborhood").innerHTML = "";

        // Clear any open number filters so they don't bleed across areas.
        clearFilters();

        // Swap in this area's config values (bbox, sheet URL, map center, etc.).
        applyAreaConfig(area);

        // Re-center the map on the new area.
        state.map.setView(cfg.mapCenter, cfg.mapZoom);

        // Update the Sheet link in the footer to point to the new Sheet.
        updateSheetLink();

        // Reload all data for the new area.
        await loadAreaData();
    }

    /** Update the footer Sheet link to the current cfg.sheetCsvUrl. */
    function updateSheetLink() {
        const sheetLink = document.getElementById("sheet-link");
        if (!sheetLink) return;
        // Convert the CSV publish URL back to a human-readable pubhtml URL.
        sheetLink.href = (cfg.sheetCsvUrl || "")
            .replace(/\/pub(\?.*)?$/, "/pubhtml");
    }

    // ---- Per-area data loading -------------------------------------------

    /**
     * Fetch, parse, and render all data for the currently active area config.
     *
     * Called by load() on first page load, and by switchArea() whenever the
     * user picks a different neighborhood.  The map must already be initialized.
     *
     * Steps:
     *   1. Fetch + parse the Sheet CSV.
     *   2. Normalize rows into home objects; merge localStorage scores.
     *   3. Rebuild filter checkboxes from the new data.
     *   4. Launch parcel layer + geocoding in parallel.
     *      – Parcel layer is skipped when cfg.parcelBbox is null (e.g. FL areas).
     *   5. Add fallback circle pins for un-matched homes.
     *   6. Wire the Color-by dropdown and apply initial filter state.
     */
    async function loadAreaData() {
        const statusEl = document.getElementById("geocode-status");

        // Guard: if no Sheet URL is configured for this area, show a prompt.
        if (!cfg.sheetCsvUrl) {
            statusEl.textContent = "No Sheet URL — add sheetCsvUrl to config.js.";
            document.getElementById("home-count").textContent = "No data.";
            return;
        }

        // ---- Step 1: Fetch + parse CSV ----
        statusEl.textContent = "Fetching sheet…";
        let rows;
        try {
            rows = await fetchSheet();
        } catch (err) {
            console.error(err);
            statusEl.textContent = "Failed to fetch Sheet.";
            document.getElementById("home-count").textContent =
                "Sheet fetch failed. See console.";
            return;
        }

        // ---- Step 2: Normalize rows ----
        const homes = rows.map(rowToHome).filter((h) => h !== null);
        state.allHomes = homes;

        // Merge any scores saved from a previous session before anything
        // renders — localStorage scores override Sheet values.
        loadLocalScores(homes);
        loadLocalAssessments(homes);

        statusEl.textContent = `Parsed ${homes.length} homes.`;

        // ---- Step 3: Build filter checkboxes ----
        // Populate immediately so Matt can see the controls while async
        // parcel loading and geocoding run in the background.
        buildCheckboxFilters();

        // ---- Step 4: Start parcel + geocode in parallel ----
        // Both are async.  Launching together minimizes total wait time.
        // Parcels from ArcGIS are typically faster than geocoding all addresses.

        statusEl.textContent = "Loading parcels + geocoding…";

        // Only query Clay County GIS when this area has a bounding box.
        // Areas outside Clay County (e.g. Winter Park, FL) set parcelBbox: null
        // in config to skip this step entirely.
        const parcelPromise = cfg.parcelBbox
            ? window.DreamHomeParcels.buildParcelLayer(
                state.map,
                homes,
                openCard,
                (msg) => { if (msg) statusEl.textContent = msg; }
              )
            : Promise.resolve(null);

        // Geocode each home sequentially (Census API rate-limit courtesy).
        // Drop a pin as each address resolves so the map feels alive during load.
        const geocodePromise = (async () => {
            let done = 0;
            for (let i = 0; i < homes.length; i++) {
                const g = await window.DreamHomeGeocode.geocode(homes[i].address);
                Object.assign(homes[i], {
                    lat: g.lat,
                    lon: g.lon,
                    matchedAddress: g.matched,
                });
                done++;
                statusEl.textContent = `Geocoding ${done}/${homes.length}…`;
            }
        })();

        // Wait for parcels first so we know which homes are matched before
        // deciding which ones need a fallback circle pin.
        state.parcelLayer = await parcelPromise;

        // Build the matched-id set from the parcel layer.
        if (state.parcelLayer) {
            state.parcelLayer.eachLayer((featureLayer) => {
                const home = featureLayer.feature._matchedHome;
                if (home) state.matchedIds.add(home.id);
            });
        }

        // Wait for geocoding to finish, then add fallback pins for unmatched homes.
        await geocodePromise;
        homes.forEach((home) => {
            if (home.lat === null || home.lon === null) return; // couldn't geocode
            if (state.matchedIds.has(home.id)) return;          // already has a polygon

            const marker = makeMarker(home);
            state.markers.set(home.id, marker);
            marker.addTo(state.map);
        });

        // ---- Step 5: Compute per-metric ranges + wire the Color-by control ----

        // Compute min/max across all homes for each color metric so the gradient
        // scales to actual data rather than arbitrary fixed bounds.
        const colorRanges = computeColorRanges(homes);
        window.DreamHomeParcels.setColorRanges(colorRanges);

        // Rebuild the Color-by dropdown (options come from config, but the
        // gradient range labels come from the current data).
        buildColorBySelect(colorRanges);

        statusEl.textContent = "";
        applyFilters(); // sets initial count and syncs parcel colors with filters
    }

    // ---- Main entry point ------------------------------------------------

    /**
     * One-time initialization: create the map, wire all static UI buttons,
     * snapshot the base area config, populate the area switcher, then
     * delegate data loading to loadAreaData().
     */
    async function load() {
        state.map = initMap();
        // Expose the map instance so area-picker.js and dev tools can reach it.
        window.DreamHomeMap = state.map;

        // Initialize the area-picker (draws rectangles for new neighborhoods).
        // Must happen after the map is created so Leaflet.draw can attach to it.
        window.DreamHomeAreaPicker.init(state.map);

        // Snapshot overridable config fields before any area switching happens.
        // applyAreaConfig() restores this snapshot before applying each area's
        // overrides, ensuring clean round-trips between areas.
        state.baseAreaConfig = {};
        AREA_OVERRIDE_KEYS.forEach((key) => {
            state.baseAreaConfig[key] = cfg[key];
        });

        // ---- Wire static UI elements (done once; survives area switches) ----

        document.getElementById("card-close").addEventListener("click", closeCard);
        document
            .getElementById("clear-filters")
            .addEventListener("click", clearFilters);
        document.getElementById("reset-cache").addEventListener("click", () => {
            const cleared = window.DreamHomeGeocode.clearCache();
            alert(`Cleared ${cleared} cached geocode entries. Reloading…`);
            location.reload();
        });

        // "Export addresses" — enters draw mode so the user can select a
        // sub-area of the map and download only those parcel addresses.
        document
            .getElementById("export-addresses-btn")
            .addEventListener("click", startExportDrawMode);

        // "Copy boundary" — enters draw mode to capture a neighborhood boundary
        // and copy/download it as GeoJSON for reference/briarcliff-west.geojson.
        document
            .getElementById("export-boundary-btn")
            .addEventListener("click", startBoundaryDrawMode);

        // "Export scores" — downloads localStorage scores as a two-column CSV.
        document
            .getElementById("export-scores-btn")
            .addEventListener("click", exportLocalScores);

        // Score picker clicks — event delegation on the card body so the
        // listener survives openCard() re-rendering innerHTML.
        document.getElementById("card-body").addEventListener("click", (e) => {
            const btn = e.target.closest(".score-btn");
            if (!btn) return;
            const homeId = btn.closest(".score-btns").dataset.homeId;
            const home   = state.allHomes.find((h) => h.id === homeId);
            if (!home) return;
            const raw   = btn.dataset.score;
            const score = raw === "" ? null : parseInt(raw, 10);
            saveLocalScore(home, score);
        });

        // Assessment scale + toggle clicks (same delegation pattern; the assess
        // buttons use their own classes so they never collide with .score-btn).
        document.getElementById("card-body").addEventListener("click", (e) => {
            const btn = e.target.closest(".assess-btn, .toggle-btn");
            if (!btn) return;
            const section = btn.closest(".assessment-section");
            if (!section) return;
            const home = state.allHomes.find((h) => h.id === section.dataset.homeId);
            const field = ASSESSMENT_FIELDS.find((f) => f.key === btn.dataset.assess);
            if (!home || !field) return;
            const raw = btn.dataset.value;
            let value;
            if (raw === "") value = null;
            else if (field.type === "toggle") value = (raw === "yes");
            else value = parseInt(raw, 10);
            saveAssessment(home, field, value);
        });

        // Assessment notes — save on blur/change (not on every keystroke).
        document.getElementById("card-body").addEventListener("change", (e) => {
            const ta = e.target.closest(".assess-notes");
            if (!ta) return;
            const section = ta.closest(".assessment-section");
            if (!section) return;
            const home = state.allHomes.find((h) => h.id === section.dataset.homeId);
            const field = ASSESSMENT_FIELDS.find((f) => f.key === ta.dataset.assess);
            if (!home || !field) return;
            const val = ta.value.trim();
            saveAssessment(home, field, val === "" ? null : val);
        });

        // Editable home facts — save on change (the open card is the only one).
        document.getElementById("card-body").addEventListener("change", (e) => {
            const input = e.target.closest(".fact-input");
            if (!input) return;
            const home = state.allHomes.find((h) => h.id === state.openHomeId);
            const spec = EDITABLE_FACTS.find((f) => f.key === input.dataset.fact);
            if (!home || !spec) return;
            saveFact(home, spec, input.value);
        });

        // Status dropdown — save + recolor the parcel outline on change.
        document.getElementById("card-body").addEventListener("change", (e) => {
            const sel = e.target.closest(".status-select");
            if (!sel) return;
            const home = state.allHomes.find((h) => h.id === sel.dataset.homeId);
            if (!home) return;
            saveStatus(home, sel.value || null);
        });

        // Filter panel — one change listener captures all inputs (status
        // checkboxes, neighborhood checkboxes, number ranges).  Wired here
        // once rather than inside buildCheckboxFilters() to avoid stacking
        // duplicate listeners on area switches.
        document
            .getElementById("filters")
            .addEventListener("change", applyFilters);

        // Populate + wire the area switcher dropdown.
        buildAreaSwitcher();

        // Set the footer Sheet link for the initial (default) area.
        updateSheetLink();

        // Load data for the default (first) area.
        await loadAreaData();
    }

    // ---- Color-by helpers ------------------------------------------------

    /**
     * Compute the min and max of each configurable color metric across all homes.
     * Returns null for a metric if no homes have a value for it.
     *
     * @param {Array<Object>} homes Normalized home objects
     * @returns {Object} { fieldName: { min, max } | null }
     */
    function computeColorRanges(homes) {
        const ranges = {};
        (cfg.parcelColorModes || []).forEach((mode) => {
            if (!mode.field) return; // "none" mode has no field
            const values = homes
                .map((h) => h[mode.field])
                .filter((v) => v !== null && v !== undefined && !isNaN(v));
            ranges[mode.field] = values.length > 0
                ? { min: Math.min(...values), max: Math.max(...values) }
                : null;
        });
        return ranges;
    }

    /**
     * Populate the color-by <select> from config.parcelColorModes and wire its
     * change handler.  Also wires the gradient legend update.
     *
     * @param {Object} colorRanges Pre-computed ranges from computeColorRanges()
     */
    function buildColorBySelect(colorRanges) {
        const select = document.getElementById("color-by");
        if (!select) return;

        // Populate options from config — keeps HTML and JS in sync automatically.
        select.innerHTML = "";
        (cfg.parcelColorModes || []).forEach((mode) => {
            const opt = document.createElement("option");
            opt.value = mode.value;
            opt.textContent = mode.label;
            select.appendChild(opt);
        });

        // Update parcel colors + legend whenever the selection changes.
        // Use onchange (not addEventListener) so re-calling buildColorBySelect
        // on area switch replaces the previous handler instead of stacking them.
        select.onchange = () => {
            window.DreamHomeParcels.updateParcelColors(state.parcelLayer, select.value);
            // Also re-apply visibility so newly colored parcels respect active filters.
            const visibleIds = new Set(state.filteredHomes.map((h) => h.id));
            window.DreamHomeParcels.updateParcelVisibility(state.parcelLayer, visibleIds);
            updateGradientLegend(select.value, colorRanges);
        };

        // Initialize legend to hidden (default = "none").
        updateGradientLegend("none", colorRanges);
    }

    /**
     * Show or hide the gradient legend below the color-by selector, and update
     * its low/high labels with the actual min/max values from the data.
     *
     * @param {string} colorMode  Active color mode value (e.g. "bedrooms")
     * @param {Object} colorRanges Pre-computed ranges
     */
    function updateGradientLegend(colorMode, colorRanges) {
        const legend = document.getElementById("gradient-legend");
        if (!legend) return;

        if (colorMode === "none") {
            legend.hidden = true;
            return;
        }

        const modeCfg = (cfg.parcelColorModes || []).find((m) => m.value === colorMode);
        if (!modeCfg || !modeCfg.field) { legend.hidden = true; return; }

        const range = colorRanges[modeCfg.field];
        if (!range) { legend.hidden = true; return; }

        legend.hidden = false;

        // Format label values: desirability as integer, sqft with commas, others plain.
        const fmt = (v) => modeCfg.field === "squareFootage"
            ? Math.round(v).toLocaleString()
            : Math.round(v).toString();

        document.getElementById("legend-low-label").textContent  = fmt(range.min);
        document.getElementById("legend-high-label").textContent = fmt(range.max);

        // Update swatch gradient to match config colors.
        const g = cfg.parcelFillGradient;
        const swatch = legend.querySelector(".legend-swatch");
        if (swatch && g) {
            swatch.style.background = `linear-gradient(to right, ${g.low}, ${g.high})`;
        }
    }

    // ---- Address list export (draw-to-select) --------------------------------

    /**
     * Write a CSV blob to disk as a browser download.
     * Shared by both the full export and the selection export.
     *
     * @param {string[]} addresses  Title-cased address strings to include
     * @param {string}   filename   Download filename
     */
    function downloadAddressCsv(addresses, filename) {
        const cols    = cfg.templateColumns || ["Address"];
        const addrIdx = cols.indexOf("Address");

        // Header row
        const header = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(",");

        // One data row per address; all non-address columns left blank
        const dataRows = addresses.map((addr) =>
            cols
                .map((_, i) => (i === addrIdx ? `"${addr.replace(/"/g, '""')}"` : ""))
                .join(",")
        );

        const csv  = [header, ...dataRows].join("\r\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url  = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Ray-casting point-in-polygon test.
     *
     * Determines whether a lat/lng point lies inside a polygon defined by an
     * array of L.LatLng vertices.  Works for any convex or concave polygon.
     *
     * Algorithm: cast a horizontal ray from the point to the right and count
     * how many polygon edges it crosses.  An odd count means the point is
     * inside (Jordan curve theorem).
     *
     * @param {L.LatLng}   point    The point to test
     * @param {L.LatLng[]} vertices Ordered polygon vertices from Leaflet.draw
     * @returns {boolean}
     */
    function pointInPolygon(point, vertices) {
        const px = point.lat;
        const py = point.lng;
        let inside = false;

        for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
            const xi = vertices[i].lat, yi = vertices[i].lng;
            const xj = vertices[j].lat, yj = vertices[j].lng;
            // Check whether the ray from (px, py) going right crosses this edge.
            const crosses = (yi > py) !== (yj > py) &&
                px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
            if (crosses) inside = !inside;
        }
        return inside;
    }

    /**
     * Collect addresses from the already-loaded parcel layer whose centers
     * fall inside the given polygon vertices.
     *
     * Each parcel polygon has `feature._situsAddress` pre-set by buildParcelLayer().
     * We use the parcel's bounding-box center as the test point — accurate
     * enough for lot-sized polygons without needing a true centroid.
     *
     * @param {L.LatLng[]} vertices  Ordered polygon vertices from Leaflet.draw
     * @returns {string[]}           Sorted, deduplicated address list
     */
    function addressesInPolygon(vertices) {
        if (!state.parcelLayer || !vertices.length) return [];

        const seen      = new Set();
        const addresses = [];

        state.parcelLayer.eachLayer((featureLayer) => {
            const addr = featureLayer.feature._situsAddress;
            if (!addr || seen.has(addr)) return;

            const center = featureLayer.getBounds().getCenter();
            if (pointInPolygon(center, vertices)) {
                seen.add(addr);
                addresses.push(addr);
            }
        });

        // Sort numerically by street number, then alphabetically by name.
        addresses.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        return addresses;
    }

    /**
     * Shared polygon draw-mode scaffolding.
     *
     * Enters Leaflet.draw polygon mode, shows the instruction banner, and calls
     * onVertices(vertices) with the drawn shape's outer ring when the user
     * double-clicks to close it.  Escape cancels without firing the callback.
     * Both "Export addresses" and "Copy boundary" build on this so the
     * draw/cleanup/cancel logic lives in exactly one place.
     *
     * @param {object} opts
     * @param {string} opts.bannerText  Instruction text shown while drawing
     * @param {string} opts.buttonId    Toolbar button id to disable during draw
     * @param {(vertices: L.LatLng[]) => void} opts.onVertices  Outer-ring handler
     */
    function startPolygonDraw(opts) {
        const banner = document.getElementById("draw-mode-banner");
        const button = opts.buttonId ? document.getElementById(opts.buttonId) : null;

        // Guard: don't stack draw modes.
        if (banner.classList.contains("active")) return;

        banner.textContent = opts.bannerText;
        banner.classList.add("active");
        if (button) button.disabled = true;

        // Leaflet.draw polygon handler — indigo stroke to distinguish from
        // the teal area-picker rectangles.
        const drawHandler = new L.Draw.Polygon(state.map, {
            shapeOptions: {
                color:       "#6366f1",
                weight:      2,
                fillOpacity: 0.08,
            },
            // Show distance/area guide tooltip while drawing.
            showArea:   false,
            showLength: false,
        });
        drawHandler.enable();

        // Fires when the user double-clicks to close the polygon.
        function onDrawCreated(e) {
            cleanup();
            // Leaflet.draw returns nested arrays for polygons; the outer ring
            // is always index [0].
            opts.onVertices(e.layer.getLatLngs()[0]);
        }

        // Cancel on Escape key.
        function onKeydown(e) {
            if (e.key === "Escape") cleanup();
        }

        function cleanup() {
            drawHandler.disable();
            state.map.off("draw:created", onDrawCreated);
            document.removeEventListener("keydown", onKeydown);
            banner.classList.remove("active");
            if (button) button.disabled = false;
        }

        // Use map.on (not once) so cleanup() can remove it with map.off().
        // Clear any other stale draw:created listeners first to avoid conflicts
        // with area-picker's handler if a previous "+ Add area" was cancelled
        // before completing a draw.
        state.map.off("draw:created");
        state.map.on("draw:created", onDrawCreated);
        document.addEventListener("keydown", onKeydown);
    }

    /**
     * Draw a polygon to select which parcel addresses to export as a CSV.
     * (Point-in-polygon over every parcel center → download briarcliff-selection.csv.)
     */
    function startExportDrawMode() {
        startPolygonDraw({
            bannerText:
                "Click to add points, double-click to close — all parcels inside the polygon will export",
            buttonId: "export-addresses-btn",
            onVertices(vertices) {
                const addresses = addressesInPolygon(vertices);
                if (!addresses.length) {
                    alert("No parcel addresses found inside that polygon. Try a larger area.");
                    return;
                }
                downloadAddressCsv(addresses, "briarcliff-selection.csv");
                console.log(`Dream Home: exported ${addresses.length} selected addresses.`);
            },
        });
    }

    /**
     * Convert Leaflet polygon vertices into a GeoJSON Feature (Polygon).
     *
     * GeoJSON stores coordinates as [longitude, latitude] and requires the ring
     * to be closed (first point repeated at the end).  This is exactly the shape
     * scripts/check_listings.py reads to decide which listings are inside the
     * neighborhood, so the output can be pasted straight into
     * reference/briarcliff-west.geojson.
     *
     * @param {L.LatLng[]} vertices  Ordered polygon vertices from Leaflet.draw
     * @param {string}     name      Value for properties.name
     * @returns {object}             GeoJSON Feature
     */
    function verticesToGeoJson(vertices, name) {
        // 6 decimal places ≈ 11 cm precision — plenty for a neighborhood edge.
        const ring = vertices.map((v) => [
            Number(v.lng.toFixed(6)),
            Number(v.lat.toFixed(6)),
        ]);
        // Close the ring by repeating the first coordinate.
        if (ring.length) ring.push(ring[0]);

        return {
            type: "Feature",
            properties: { name: name },
            geometry: { type: "Polygon", coordinates: [ring] },
        };
    }

    /**
     * Write an arbitrary text file to disk as a browser download (no server).
     *
     * @param {string} text      File contents
     * @param {string} filename  Download filename
     * @param {string} mime      MIME type (e.g. "application/geo+json")
     */
    function downloadTextFile(text, filename, mime) {
        const blob = new Blob([text], { type: `${mime};charset=utf-8;` });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement("a");
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Draw a polygon to capture a neighborhood BOUNDARY (not an address list).
     *
     * On close, the drawn shape is turned into GeoJSON, copied to the clipboard,
     * and downloaded as briarcliff-west.geojson — the file the listing watcher
     * reads.  Paste it over reference/briarcliff-west.geojson to tighten the
     * "which listings count as Briarcliff West" filter.
     */
    function startBoundaryDrawMode() {
        startPolygonDraw({
            bannerText:
                "Trace the neighborhood edge — double-click to close. The boundary GeoJSON copies to your clipboard.",
            buttonId: "export-boundary-btn",
            onVertices(vertices) {
                if (vertices.length < 3) {
                    alert("A boundary needs at least 3 points. Try again.");
                    return;
                }
                const json = JSON.stringify(verticesToGeoJson(vertices, "Briarcliff West"), null, 2);

                // Always download a copy; also try the clipboard for convenience.
                downloadTextFile(json, "briarcliff-west.geojson", "application/geo+json");
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(json).then(
                        () => alert(`Boundary copied to clipboard (${vertices.length} points) and downloaded as briarcliff-west.geojson.`),
                        // Clipboard blocked (e.g. no HTTPS/permission) — show it to copy by hand.
                        () => window.prompt("Copy this boundary GeoJSON:", json)
                    );
                } else {
                    window.prompt("Copy this boundary GeoJSON:", json);
                }
                console.log(`Dream Home: captured boundary with ${vertices.length} points.`);
            },
        });
    }

    // Kick off once the DOM is ready.
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", load);
    } else {
        load();
    }
})();
