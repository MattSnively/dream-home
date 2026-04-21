// Dream Home — "Add new area" feature.
//
// Responsibilities:
//   1. Wire the "+ Add area" button to activate Leaflet.draw's rectangle tool.
//   2. Show a banner while the user is in draw mode.
//   3. When the user finishes drawing, open the instruction modal.
//   4. On "Download template", generate a CSV file with the standard 26-column
//      header row (from config.js) and trigger a browser download.
//   5. Cancel/close cleans up the drawn rectangle and returns to normal mode.
//
// This file is intentionally isolated from app.js so the area-picker logic
// doesn't tangle with the home-data loading and filter state.

(function () {
    "use strict";

    const cfg = window.DREAM_HOME_CONFIG;

    // State: track the drawn rectangle layer so we can remove it on cancel.
    let drawnRect = null;
    let drawControl = null;
    let drawHandler = null;

    // ---- CSV template generator ------------------------------------------

    /**
     * Generate a CSV file containing only the header row from config.templateColumns
     * plus two blank example rows to show the expected format.
     *
     * The downloaded file is named "dream-home-template.csv" and opens directly
     * in Excel/Google Sheets without any conversion step.
     *
     * @returns {void} Triggers a browser download.
     */
    function downloadTemplate() {
        const columns = cfg.templateColumns || [];

        // Build CSV rows: header + 2 blank example rows so the user
        // can see the expected format without guessing column types.
        const headerRow = columns.map(quoteCell).join(",");
        const exampleRow1 = columns.map((col) => {
            // Provide a format hint in the first example row.
            if (col === "Address") return quoteCell("1234 N Example Dr");
            if (col === "Status") return quoteCell("For Sale");
            if (col === "Neighborhood") return quoteCell("My Neighborhood");
            if (col.startsWith("List Price")) return quoteCell("$500000");
            if (col === "Listing Date") return quoteCell("2026-01-15");
            if (col === "Bedrooms") return quoteCell("4");
            if (col === "Bathrooms") return quoteCell("3");
            if (col === "Square Footage") return quoteCell("2500");
            if (col === "Year Built") return quoteCell("2002");
            if (col === "Desirability") return quoteCell("7");
            return quoteCell(""); // leave optional fields blank
        }).join(",");
        const blankRow = columns.map(() => quoteCell("")).join(",");

        const csvContent = [headerRow, exampleRow1, blankRow].join("\r\n");

        // Trigger download via a temporary <a> element — no server needed.
        const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "dream-home-template.csv";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);

        // Revoke the object URL after a short delay to free memory.
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    /**
     * Wrap a value in CSV double-quotes, escaping any internal double-quotes.
     * Per RFC 4180: a double-quote inside a field is escaped as two double-quotes.
     *
     * @param {string} val Cell value
     * @returns {string} Quoted cell string
     */
    function quoteCell(val) {
        const s = String(val === null || val === undefined ? "" : val);
        return '"' + s.replace(/"/g, '""') + '"';
    }

    // ---- Modal management -----------------------------------------------

    /** Open the "new area selected" modal. */
    function openModal() {
        const backdrop = document.getElementById("area-modal");
        backdrop.classList.add("open");
        // Focus the download button so keyboard users can act immediately.
        document.getElementById("area-modal-download").focus();
    }

    /** Close the modal and clean up any drawn rectangle. */
    function closeModal() {
        document.getElementById("area-modal").classList.remove("open");
        if (drawnRect) {
            drawnRect.remove();
            drawnRect = null;
        }
    }

    // ---- Draw mode -------------------------------------------------------

    /**
     * Activate Leaflet.draw's rectangle tool so the user can drag out
     * a bounding box over their target neighborhood.
     *
     * @param {Object} map Leaflet map instance
     */
    function startDrawMode(map) {
        // Show the instructional banner at the top of the map.
        document.getElementById("draw-mode-banner").classList.add("active");

        // Create a temporary FeatureGroup to hold the drawn shape.
        // Leaflet.draw requires a FeatureGroup as its edit layer.
        const drawnItems = new L.FeatureGroup().addTo(map);

        // Initialize the Leaflet.draw rectangle handler.
        drawHandler = new L.Draw.Rectangle(map, {
            shapeOptions: {
                color: "#1d4ed8",
                weight: 2,
                fillColor: "#1d4ed8",
                fillOpacity: 0.12,
                dashArray: "6 4",
            },
        });
        drawHandler.enable();

        // Listen for the draw:created event — fires when the user releases
        // the mouse after dragging out a rectangle.
        map.once("draw:created", function (e) {
            drawnRect = e.layer;
            drawnItems.addLayer(drawnRect);
            stopDrawMode(map);
            openModal();
        });

        // If the user presses Escape or clicks outside, cancel draw mode.
        map.once("draw:drawstop", function () {
            stopDrawMode(map);
        });
    }

    /**
     * Deactivate draw mode and hide the instructional banner.
     *
     * @param {Object} map Leaflet map instance
     */
    function stopDrawMode(map) {
        document.getElementById("draw-mode-banner").classList.remove("active");
        if (drawHandler) {
            drawHandler.disable();
            drawHandler = null;
        }
    }

    // ---- Initialization --------------------------------------------------

    /**
     * Wire all the area-picker UI elements once the map is available.
     * Called by app.js after the Leaflet map is initialized.
     *
     * @param {Object} map Leaflet map instance
     */
    function init(map) {
        // "+ Add area" button in the topbar.
        const addAreaBtn = document.getElementById("add-area-btn");
        addAreaBtn.addEventListener("click", () => {
            startDrawMode(map);
        });

        // Modal: "Download template" button.
        document.getElementById("area-modal-download").addEventListener("click", () => {
            downloadTemplate();
            // Keep the modal open so the user can re-download or read the steps.
        });

        // Modal: "Cancel" button + modal-close (×) button.
        document.getElementById("area-modal-cancel").addEventListener("click", closeModal);
        document.getElementById("area-modal-close").addEventListener("click", closeModal);

        // Clicking the backdrop outside the modal box also closes it.
        document.getElementById("area-modal").addEventListener("click", function (e) {
            if (e.target === this) closeModal();
        });

        // Escape key closes the modal or cancels draw mode.
        document.addEventListener("keydown", function (e) {
            if (e.key !== "Escape") return;
            const backdrop = document.getElementById("area-modal");
            if (backdrop.classList.contains("open")) {
                closeModal();
            } else if (drawHandler) {
                stopDrawMode(map);
            }
        });
    }

    // Expose init so app.js can call it after the map is ready.
    window.DreamHomeAreaPicker = { init };
})();
