// One place that knows the state of every data source. The "Data sources" panel renders this.
const sources = new Map(), listeners = new Set();
export const MODES = { live: 'Live', waiting: 'Waiting', demo: 'Modelled', error: 'Unavailable', off: 'Off' };

export function defineSource(id, label, provides) { sources.set(id, { id, label, provides, mode: 'waiting', detail: '', updated: null }); }
export function setSource(id, mode, detail = '', updated = Date.now()) {
  const s = sources.get(id); if (!s) return;
  Object.assign(s, { mode, detail, updated });
  listeners.forEach((fn) => fn(s));
}
export const getSources = () => [...sources.values()];
export const getSource = (id) => sources.get(id);
export const onSourceChange = (fn) => listeners.add(fn);

defineSource('ais', 'Ship positions', 'AIS reports from AISStream.io, collected every 20 minutes');
defineSource('voyages', 'Destinations and ETAs', 'Broadcast by each ship over AIS');
defineSource('wind', 'Wind, cloud and rain grid', 'Open-Meteo forecast');
defineSource('marine', 'Waves and sea temperature', 'Open-Meteo Marine');
defineSource('clouds', 'Cloud imagery', 'NASA GIBS (VIIRS true colour)');
defineSource('radar', 'Rain radar', 'RainViewer');
defineSource('storms', 'Tropical storms', 'NOAA National Hurricane Center (Atlantic and eastern Pacific)');

// fetch with a timeout, so a dead source turns into a clean fallback instead of a hung layer
export async function getJSON(url, ms = 9000) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
