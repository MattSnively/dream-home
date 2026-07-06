/**
 * sheet_writeback.gs — Dream Home write-back endpoint (Google Apps Script)
 *
 * Purpose:
 *   Lets the map's per-house "Your assessment" form save data back to the Google
 *   Sheet. The static site can't write to a published CSV, so it POSTs JSON to
 *   this web app, which finds the home's row by Address and updates the cells
 *   (or appends a new row if the address isn't there yet).
 *
 * It is also the endpoint the listing watcher (scripts/check_listings.py) can
 * optionally POST new listings to.
 *
 * ---------------------------------------------------------------------------
 * ONE-TIME DEPLOYMENT (do this in your Google account):
 *   1. Open your Dream Home Google Sheet.
 *   2. Extensions -> Apps Script. Delete any starter code and paste this file.
 *   3. Edit the two CONFIG values below:
 *        - SHEET_NAME:    the exact name of the tab that holds your home rows.
 *        - SHARED_SECRET: any long random string (e.g. a password-manager value).
 *   4. Click Deploy -> New deployment -> gear icon -> "Web app".
 *        - Description:    dream-home writeback
 *        - Execute as:     Me
 *        - Who has access: Anyone
 *      Click Deploy, then Authorize access and allow the permissions.
 *   5. Copy the "Web app URL" it shows you.
 *   6. Send me that URL. I'll put it (and the same SHARED_SECRET) into
 *      site/config.js so the map can talk to it.
 *
 * Note on security: the SHARED_SECRET will live in the public site/config.js, so
 * it's not truly secret — combined with the obscure URL it just deters casual or
 * accidental writes. That's an accepted trade-off for a personal, single-writer
 * project with low-value data (agreed in the Phase 2 plan).
 * ---------------------------------------------------------------------------
 */

// ==== CONFIG — edit these three ====
var SHEET_NAME = 'Sheet1';                         // <-- your Briarcliff tab's exact name
var SHARED_SECRET = 'CHANGE_ME_to_a_long_random_string';  // <-- must match site/config.js
var KEY_COLUMN = 'Address';                         // column used to locate the row


/**
 * Handle a write request. Expects a JSON body:
 *   { "token": "...", "address": "4319 N Mulberry Dr", "updates": { "Curb Appeal": 4, ... } }
 * Returns JSON: { ok: true, action: "update" | "append", address: "..." }
 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    // Reject anything without the shared secret.
    if (body.token !== SHARED_SECRET) {
      return json_({ ok: false, error: 'bad token' });
    }

    var address = (body.address || '').toString().trim();
    if (!address) return json_({ ok: false, error: 'missing address' });
    var updates = body.updates || {};

    // A lock prevents two simultaneous writes from clobbering each other.
    var lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
      if (!sheet) return json_({ ok: false, error: 'sheet tab not found: ' + SHEET_NAME });

      var data = sheet.getDataRange().getValues();
      var headers = data[0];

      // Map header name -> column index (0-based).
      var colIndex = {};
      for (var c = 0; c < headers.length; c++) {
        colIndex[String(headers[c]).trim()] = c;
      }
      if (!(KEY_COLUMN in colIndex)) {
        return json_({ ok: false, error: 'no "' + KEY_COLUMN + '" column in ' + SHEET_NAME });
      }
      var keyCol = colIndex[KEY_COLUMN];

      // Create any update columns that don't exist yet (so new fields just work).
      var headerChanged = false;
      for (var name in updates) {
        if (!(name in colIndex)) {
          headers.push(name);
          colIndex[name] = headers.length - 1;
          headerChanged = true;
        }
      }
      if (headerChanged) {
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      }

      // Find the row whose Address matches (case-insensitive, trimmed).
      var wanted = address.toLowerCase();
      var targetRow = -1;  // 1-based sheet row
      for (var r = 1; r < data.length; r++) {
        if (String(data[r][keyCol]).trim().toLowerCase() === wanted) {
          targetRow = r + 1;
          break;
        }
      }

      var action;
      if (targetRow === -1) {
        // Not found — append a fresh row with the address + the updates.
        var newRow = [];
        for (var i = 0; i < headers.length; i++) newRow.push('');
        newRow[keyCol] = address;
        for (var name in updates) newRow[colIndex[name]] = updates[name];
        sheet.appendRow(newRow);
        action = 'append';
      } else {
        // Found — update just the given cells.
        for (var name in updates) {
          sheet.getRange(targetRow, colIndex[name] + 1).setValue(updates[name]);
        }
        action = 'update';
      }

      return json_({ ok: true, action: action, address: address });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** Opening the web-app URL in a browser hits this — handy for a quick "is it live?" check. */
function doGet() {
  return json_({ ok: true, service: 'dream-home sheet writeback' });
}

/** Serialize an object as a JSON HTTP response. */
function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
