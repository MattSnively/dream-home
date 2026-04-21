# Dream Home

A personal, local-only house-hunting map for the Kansas City Northland.

Open `site/index.html` in a browser, or:

```bash
python -m http.server 8000 -d site/
# -> http://localhost:8000
```

The page fetches Matt's published Google Sheet, geocodes each address via the
free US Census Geocoder (results cached in your browser's localStorage), and
renders everything as a filterable Leaflet map.

See [CLAUDE.md](CLAUDE.md) for full architecture and roadmap.
