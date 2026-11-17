// Settings for live data. Everything works with the defaults.
export const CONFIG = {
  // Snapshots written by the GitHub Action (tools/collect.mjs) every 20 minutes:
  // ship positions from AISStream, the Open-Meteo weather grids and NOAA storms.
  LIVE_BASE: 'data/live/',

  // Optional, for second-by-second ship positions: the wss:// address of your own relay
  // to AISStream. Leave empty to use the 20-minute snapshots above. Never put an API key here.
  AIS_PROXY_URL: '',

  // Where the JSON datasets and textures live, relative to index.html.
  DATA_BASE: 'data/',
  TEXTURE_BASE: 'assets/textures/',

  // Live weather is keyless and on by default. Set to false to force the bundled climatology.
  LIVE_WEATHER: true,
};
