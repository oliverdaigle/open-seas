# Open Seas

A living globe of cruise ships, drawn only from real data.

**Live site:** https://oliverdaigle.github.io/open-seas/

## Where the data comes from

| Layer | Source | How often |
|---|---|---|
| Ship positions | AIS reports from [AISStream.io](https://aisstream.io) | 10 minutes of every 15 |
| Destination and ETA | Broadcast by each ship over AIS, decoded with UN/LOCODE | 10 minutes of every 15 |
| Port calls | Worked out from AIS: moored or stopped next to a port | 10 minutes of every 15 |
| Wind, cloud, rain | [Open-Meteo](https://open-meteo.com) forecast | Every 3 hours, or live in the browser |
| Waves, sea temperature | Open-Meteo Marine | Every 3 hours, or live in the browser |
| Tropical storms | NOAA National Hurricane Center | Every 20 minutes |
| Rain radar | RainViewer | Live in the browser |
| Satellite clouds | NASA GIBS (VIIRS) | Past days, live in the browser |

A ship AIS has not heard in the last 30 days is not drawn. Between reports, a ship that has broadcast a
destination is placed along the shipping-lane route to it, timed to arrive at the ETA it broadcast (or at
its last reported speed when that ETA isn't plausible). The route follows the shipping-lane network and is
pulled straight wherever open water allows. Ships without a destination are dead-reckoned for 45 minutes
from their last course and speed, then held at their last reported position. Every estimated position is
labelled as estimated, with the age of the last real report.

AISStream's receivers are on the coast, mostly in Europe and North America, so ships far offshore go
unheard until they come back within range. Ships broadcast only their next destination, not the whole
cruise itinerary; there is no free source of published itineraries.

`.github/workflows/live.yml` runs `tools/collect.mjs` every 15 minutes on GitHub Actions. It listens
to AISStream for ten minutes, merges what it hears with the week of history already on the site,
writes `data/live/*.json` and deploys the site with those files. Nothing is committed, so the repo
stays small.

`data/seaports.json` is built from the UN/LOCODE code list (datasets/un-locode on GitHub) and is used
to turn destinations like `GIGIB` or `US PEF` into port names. `data/marnet.json` is the shipping-lane
network from [searoute-js](https://github.com/johnx25bd/searoute) (MIT), based on Eurostat's
[searoute](https://github.com/eurostat/searoute). `data/water.bin` is a 0.1° land/sea grid made from the
globe's own water mask.

Ships are matched to AIS by IMO number when the list has one. A match by name is accepted only after
the vessel's own static report confirms it is a passenger ship of about the right length, so ferries and
yachts that share a name (there is a BC ferry called Britannia) are ignored.

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
