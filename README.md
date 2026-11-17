# Open Seas

A living globe of cruise ships, drawn only from real data.

**Live site:** https://oliverdaigle.github.io/open-seas/

## Where the data comes from

| Layer | Source | How often |
|---|---|---|
| Ship positions | AIS reports from [AISStream.io](https://aisstream.io) | Every 20 minutes |
| Destination and ETA | Broadcast by each ship over AIS, decoded with UN/LOCODE | Every 20 minutes |
| Port calls | Worked out from AIS: moored or stopped next to a port | Every 20 minutes |
| Wind, cloud, rain | [Open-Meteo](https://open-meteo.com) forecast | Every 3 hours, or live in the browser |
| Waves, sea temperature | Open-Meteo Marine | Every 3 hours, or live in the browser |
| Tropical storms | NOAA National Hurricane Center | Every 20 minutes |
| Rain radar | RainViewer | Live in the browser |
| Satellite clouds | NASA GIBS (VIIRS) | Past days, live in the browser |

Nothing is simulated. A ship AIS has not heard in the last 30 days is not drawn. Between reports a
ship's position is dead-reckoned for up to 45 minutes from its last course and speed, then held at the
last reported position and labelled with its age.

AISStream's receivers are on the coast, mostly in Europe and North America, so ships far offshore go
unheard until they come back within range. Ships broadcast only their next destination, not the whole
cruise itinerary; there is no free source of published itineraries.

`.github/workflows/live.yml` runs `tools/collect.mjs` every 20 minutes on GitHub Actions. It listens
to AISStream for four minutes, merges what it hears with the week of history already on the site,
writes `data/live/*.json` and deploys the site with those files. Nothing is committed, so the repo
stays small.

`data/seaports.json` is built from the UN/LOCODE code list (datasets/un-locode on GitHub) and is used
to turn destinations like `GIGIB` or `US PEF` into port names.

## Setup

1. **Pages:** Settings → Pages → Source: **GitHub Actions**.
2. **AIS key:** sign in at [aisstream.io](https://aisstream.io) with GitHub, create an API key, and add it
   under Settings → Secrets and variables → Actions as a repository secret named `AISSTREAM_API_KEY`.
3. Actions → **Live data** → **Run workflow** to collect right away. The run summary lists the ships
   heard and where each one says it is going. Tick "Log every passenger vessel" to debug matching.

## Run locally

```sh
AISSTREAM_API_KEY=... node tools/collect.mjs   # Node 22+, writes data/live/
python3 -m http.server                          # then open http://localhost:8000
```
