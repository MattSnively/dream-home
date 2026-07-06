# scripts/

## check_listings.py — Briarcliff West listing watcher

Queries RentCast for active listings near Briarcliff West, filters to the exact
neighbourhood polygon (`reference/briarcliff-west.geojson`), diffs against the last snapshot
(`data/briarcliff-west-listings.json`), and emails `mattsnively@gmail.com` on anything new.
Runs daily via `.github/workflows/listing-watch.yml`. Standard library only — no `pip install`.

### One-time setup (do these once)

**1. RentCast API key**
- Sign up at <https://app.rentcast.io/> and open the **API** section.
- Choose the **Developer (free)** tier and copy your API key (~50 requests/month; this watcher
  uses ~30).

**2. Gmail App Password** (so the script can send mail as you)
- Google Account → **Security** → turn on **2-Step Verification** if it isn't already.
- Security → **App passwords** → create one (name it e.g. "dream-home") → copy the 16 characters.
- This is NOT your normal Gmail password; the normal password will be rejected.

**3. Add repo secrets** (GitHub → repo → **Settings → Secrets and variables → Actions → New**)

| Secret | Value |
| --- | --- |
| `RENTCAST_API_KEY` | key from step 1 |
| `GMAIL_ADDRESS` | the Gmail you'll send from (can be `mattsnively@gmail.com`) |
| `GMAIL_APP_PASSWORD` | 16-char app password from step 2 |
| `SHEET_WEBHOOK_URL` | *(optional, Phase 2)* Apps Script web-app URL |
| `SHEET_WEBHOOK_TOKEN` | *(optional, Phase 2)* shared secret for that endpoint |

**4. Refine the neighbourhood boundary** — `reference/briarcliff-west.geojson` ships with an
approximate rectangle so the watcher works immediately. Tighten it: open the map, trace the
real Briarcliff West edge with the freeform-polygon draw tool, export the GeoJSON, and replace
the `coordinates` in that file.

### Test it

```bash
# Safe: fetch + filter + diff only. Sends no email, writes nothing.
RENTCAST_API_KEY=xxxx python scripts/check_listings.py --dry-run

# See the email format now (emails the current matches even if none are new):
RENTCAST_API_KEY=xxxx GMAIL_ADDRESS=you@gmail.com GMAIL_APP_PASSWORD=xxxx \
    python scripts/check_listings.py --force-email
```

Then, after adding the repo secrets, trigger the workflow once by hand:
GitHub → **Actions → Briarcliff West listing watch → Run workflow**. A green run + an email
confirms the pipeline. From then on it runs daily at 13:00 UTC (≈ 8am CT).
