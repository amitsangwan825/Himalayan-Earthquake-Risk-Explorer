# Himalayan Earthquake Risk Explorer

Academic project developed at **Lovely Professional University, Phagwara, Punjab, India.**

An interactive map and statistics page for earthquakes across the Himalayan arc (24–37°N, 72–98°E): filters, regional views, charts, active-fault layer, safety guidance, and a sources/method section.

> **Not a prediction system.** It shows where earthquakes *have* happened. Nobody can predict the time, place or size of a future earthquake.

## Run it
1. Unzip, then double-click `index.html` (works offline for everything except live data), **or** host the folder (Netlify Drop, GitHub Pages) — live USGS data works best when hosted.
2. Open `data/config.js` and set `author: "Your Name – Reg. No."` to show it in the footer.
3. The LPU logo is already included at `assets/lpu-logo.png` (top strip and footer). Replace the file to change it.

## What is real
- **Earthquakes:** fetched live from the USGS ComCat FDSN Event API in the visitor's browser (four presets: M6+ since 1900, M5+ 25 yrs, M4.5+ 1 yr, M4+ 30 days). If offline, it uses a browser cache, then any embedded snapshot, then lets you load a CSV/GeoJSON.
- **Active faults:** GEM Global Active Faults Database (CC BY-SA 4.0).
- **Rivers, cities, peaks, land:** Natural Earth (public domain).
- No sample/fake earthquake rows are included.

## Embed a snapshot (so the page works without internet)
Download CSVs from USGS for each preset, then:
```
python3 tools/csv_to_snapshot.py since1900=a.csv y25=b.csv y1=c.csv d30=d.csv
```
This writes `data/snapshots.js`.

## LPU acknowledgement
Rule: when presenting on social media, give due acknowledgement to the university via an introductory message or the university logo. Sample caption:

> "Himalayan Earthquake Risk Explorer — an academic project developed at Lovely Professional University. Data: USGS, GEM, Natural Earth. Not a prediction tool. #LPU"

## Licences
USGS data: public domain. GEM faults: CC BY-SA 4.0 (attribute GEM). Natural Earth: public domain. Map tiles (optional toggle): © OpenTopoMap, © OpenStreetMap contributors.
