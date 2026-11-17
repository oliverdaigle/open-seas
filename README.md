# Open Seas

A living globe of cruise ships, with live ship positions and weather.

**Live site:** https://oliverdaigle.github.io/open-seas/

## Where the data comes from

| Layer | Source | Cost | How often |
|---|---|---|---|
| Ship positions | [AISStream.io](https://aisstream.io) | Free, needs an API key | Every 20 minutes |
| Wind, cloud, rain | [Open-Meteo](https://open-meteo.com) forecast | Free, no key | Every 3 hours, or live in the browser |
| Waves, sea temperature | Open-Meteo Marine | Free, no key | Every 3 hours, or live in the browser |
| Tropical storms | NOAA National Hurricane Center | Free, no key | Every 20 minutes |
| Rain radar | RainViewer | Free, no key | Live in the browser |
| Satellite clouds | NASA GIBS (VIIRS) | Free, no key | Live in the browser, past days only |
| Itineraries | Typical routes for each ship (demo) | | Bundled |
| Cabin prices | Sample fares (demo) | | Bundled |

`.github/workflows/live.yml` runs `tools/collect.mjs` every 20 minutes on GitHub Actions. It writes
`data/live/*.json` and deploys the site to GitHub Pages with those files, so nothing is committed and
the repo stays small. The page reads those files first and falls back to calling the APIs itself,
then to modelled weather and demo itineraries. The **Data sources** panel shows what each layer is using.

Ships only appear live when they are within range of an AIS receiver that feeds AISStream (mostly
coastal waters). Between collections, positions are estimated from the last course and speed.
Ships that are out of range follow their demo itinerary and are labelled that way.

## Setup

1. **Pages:** Settings → Pages → Source: **GitHub Actions**.
2. **Ship positions:** sign in at [aisstream.io](https://aisstream.io) with GitHub, create an API key,
   then add it under Settings → Secrets and variables → Actions → **New repository secret**,
   named `AISSTREAM_API_KEY`.
3. Actions → **Live data** → **Run workflow** to collect right away. The run summary shows which
   ships were seen.

## Run locally

```sh
AISSTREAM_API_KEY=... node tools/collect.mjs   # Node 22+, writes data/live/
python3 -m http.server                          # then open http://localhost:8000
```
