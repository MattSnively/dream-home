// Dream Home — address geocoding via the US Census Bureau's free public API.
//
// The Sheet is keyed by street address; Leaflet needs lat/lon. We call the
// Census Geocoder once per unique address and cache the result in the browser's
// localStorage so subsequent page loads don't re-geocode. If Matt ever wants to
// bust the cache (e.g., a misgeocoded address), he can clear localStorage from
// DevTools or click the "Reset geocode cache" button in the header.

(function () {
    "use strict";

    // Key prefix for cached geocode results in localStorage. Prefixing avoids
    // collisions with any other site that happens to store things on this origin.
    const CACHE_PREFIX = "dreamhome.geocode.v1.";

    // Census Geocoder one-line-address endpoint. Returns JSON with address
    // matches including x (lon), y (lat) coordinates.
    const CENSUS_ENDPOINT =
        "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

    // "Public_AR_Current" is the most up-to-date TIGER benchmark.
    const CENSUS_BENCHMARK = "Public_AR_Current";

    // Throttle live API calls to 1 per 300ms so we don't hammer the endpoint.
    // Cached lookups aren't throttled at all.
    const MIN_DELAY_MS = 300;
    let lastCallTime = 0;

    /**
     * Build a full one-line address suitable for the Census API.
     *
     * The Sheet entries are usually just "4319 N Mulberry Dr" — we tack on
     * city/state/zip so the geocoder can find a unique match. If the Sheet
     * already contains a comma (meaning Matt typed a fuller address), we
     * leave it alone.
     *
     * @param {string} streetAddress Raw address from the Sheet
     * @returns {string} One-line address ready for the geocoder
     */
    function buildOnelineAddress(streetAddress) {
        const cfg = window.DREAM_HOME_CONFIG;
        const trimmed = (streetAddress || "").trim();
        if (trimmed.includes(",")) return trimmed;
        const parts = [trimmed, cfg.defaultCity, cfg.defaultState];
        if (cfg.defaultZip) parts.push(cfg.defaultZip);
        return parts.join(", ");
    }

    /**
     * Look up a cached geocode result.
     * @param {string} key Full one-line address
     * @returns {{lat:number|null, lon:number|null, matched:string|null} | null}
     */
    function getCached(key) {
        try {
            const raw = localStorage.getItem(CACHE_PREFIX + key);
            return raw ? JSON.parse(raw) : null;
        } catch (_) {
            // localStorage can throw if the browser is in private mode — treat
            // as a cache miss and move on.
            return null;
        }
    }

    /**
     * Persist a geocode result. We cache both successes AND failures so we
     * don't hit the API repeatedly for the same bad input.
     */
    function setCached(key, value) {
        try {
            localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
        } catch (_) {
            // Storage quota exceeded or private mode — non-fatal.
        }
    }

    /**
     * Enforce minimum delay between live API calls so we're polite.
     */
    async function throttle() {
        const now = Date.now();
        const elapsed = now - lastCallTime;
        if (elapsed < MIN_DELAY_MS) {
            await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
        }
        lastCallTime = Date.now();
    }

    /**
     * Geocode a single street address. Uses cache if possible; otherwise
     * calls the Census API and caches the result.
     *
     * @param {string} streetAddress Raw address from the Sheet
     * @returns {Promise<{lat:number|null, lon:number|null, matched:string|null}>}
     */
    async function geocode(streetAddress) {
        const oneline = buildOnelineAddress(streetAddress);

        const cached = getCached(oneline);
        if (cached) return cached;

        await throttle();

        const url = new URL(CENSUS_ENDPOINT);
        url.searchParams.set("address", oneline);
        url.searchParams.set("benchmark", CENSUS_BENCHMARK);
        url.searchParams.set("format", "json");

        let result = { lat: null, lon: null, matched: null };

        try {
            const resp = await fetch(url.toString(), {
                // Census API supports CORS so this works from a static site.
                mode: "cors",
            });
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const data = await resp.json();
            const matches = (data && data.result && data.result.addressMatches) || [];
            if (matches.length > 0) {
                const top = matches[0];
                result = {
                    // Census returns coordinates as {x: lon, y: lat}
                    lat: top.coordinates.y,
                    lon: top.coordinates.x,
                    matched: top.matchedAddress || null,
                };
            }
        } catch (err) {
            // Network or JSON failure — cache the miss and let the caller
            // show the home as "not mapped" rather than retrying on every load.
            console.warn("Geocode failed for", oneline, err);
        }

        setCached(oneline, result);
        return result;
    }

    /**
     * Geocode every home in an array concurrently (well, sequentially — the
     * throttle() above keeps us polite). Returns a copy of the array with
     * lat/lon/matched fields populated on each home.
     *
     * @param {Array<Object>} homes Array of home objects with an `address` field
     * @param {Function} onProgress Optional callback: (doneCount, totalCount) => void
     * @returns {Promise<Array<Object>>} Same homes plus lat/lon/matched fields
     */
    async function geocodeAll(homes, onProgress) {
        const out = [];
        for (let i = 0; i < homes.length; i++) {
            const h = homes[i];
            const g = await geocode(h.address);
            out.push(Object.assign({}, h, g));
            if (onProgress) onProgress(i + 1, homes.length);
        }
        return out;
    }

    /**
     * Clear the geocode cache so every address is re-fetched on the next load.
     * Wired to the "Reset cache" button in the header.
     */
    function clearCache() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
        }
        keys.forEach((k) => localStorage.removeItem(k));
        return keys.length;
    }

    // Expose on a single namespaced object so app.js can call it.
    window.DreamHomeGeocode = { geocode, geocodeAll, clearCache };
})();
