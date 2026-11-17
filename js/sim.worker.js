// Keeps position interpolation for the whole fleet off the main thread.
import { buildFleet, packStates } from './sim.js';
let fleet = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { fleet = buildFleet(m.data); self.postMessage({ type: 'ready' }); }
  else if (m.type === 'tick' && fleet) {
    const buf = packStates(fleet, m.t, m.trailMs);
    self.postMessage({ type: 'state', t: m.t, buf }, [buf.buffer]);
  }
};
