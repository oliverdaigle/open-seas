// One place that knows the state of every data source. The "Data sources" panel renders this.
const sources = new Map(), listeners = new Set();
export const MODES = { demo: 'Demo', live: 'Live', error: 'Error', off: 'Off' };

export function defineSource(id, label, provides) { sources.set(id, { id, label, provides, mode: 'demo', detail: '', updated: null }); }
export function setSource(id, mode, detail = '', updated = Date.now()) {
  const s = sources.get(id); if (!s) return;
  Object.assign(s, { mode, detail, updated });
  listeners.forEach((fn) => fn(s));
}
export const getSources = () => [...sources.values()];
export const getSource = (id) => sources.get(id);
export const onSourceChange = (fn) => listeners.add(fn);

defineSource('ais', 'Ship positions', 'AISStream.io, collected every 20 minutes');
defineSource('itineraries', 'Itineraries', 'Schedules for past and future sailings');
defineSource('prices', 'Cabin prices', 'Sample fares');
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
