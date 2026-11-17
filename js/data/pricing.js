// PricingAdapter: cheapest cabin per sailing.
//   Demo  data/prices.demo.json  sample prices, always labelled "Demo price"
//   Live  data/prices.json       optional, same shape; no free live fare source is connected yet
// A line the scraper has reported on replaces demo prices for that line. If the scraper was blocked,
// the line shows "Price unavailable" and keeps its booking link. Nothing is ever invented in between.
import { CONFIG } from '../config.js';
import { getJSON, setSource } from './sources.js';

export class DemoPricingAdapter {
  async load() { const j = await getJSON(`${CONFIG.DATA_BASE}prices.demo.json`, 30000); return { lines: {}, prices: j.prices, generatedAt: j.generatedAt }; }
}
export class LivePricingAdapter {
  async load() {
    const j = await getJSON(`${CONFIG.DATA_BASE}prices.json`, 15000);
    if (!j || !j.lines || !Object.keys(j.lines).length) return null;
    return j;
  }
}

export class Pricing {
  constructor(lines) { this.lines = lines; this.demo = new Map(); this.live = new Map(); this.lineStatus = {}; }
  async load() {
    try { const d = await new DemoPricingAdapter().load(); for (const p of d.prices) this.demo.set(p.sailingId, p); }
    catch (e) { setSource('prices', 'error', `Demo price file failed to load: ${e.message}`); return; }
    let live = null;
    try { live = await new LivePricingAdapter().load(); } catch { live = null; }
    if (!live) { setSource('prices', 'demo', 'No free live fare source is connected, so every price is a sample. Booking links go to the real cruise line.'); return; }
    this.lineStatus = live.lines;
    for (const p of live.prices || []) this.live.set(p.sailingId, p);
    const ok = Object.entries(live.lines).filter(([, s]) => s.status === 'ok').map(([l]) => this.lines[l]?.name || l);
    const bad = Object.entries(live.lines).filter(([, s]) => !['ok', 'no-match'].includes(s.status)).map(([l]) => this.lines[l]?.name || l);
    setSource('prices', ok.length ? 'live' : bad.length ? 'error' : 'demo',
      `${ok.length ? `Live: ${ok.join(', ')}. ` : ''}${bad.length ? `Unavailable: ${bad.join(', ')}. ` : ''}Other lines show demo prices.`,
      live.generatedAt ? Date.parse(live.generatedAt) : Date.now());
  }
  // -> { state: 'live' | 'demo' | 'unavailable' | 'none', ...price fields }
  priceFor(voyage, lineId) {
    const st = this.lineStatus[lineId];
    if (st && st.status !== 'no-match') {      // no-match: the site answered, but nothing lined up with this line's itineraries, so demo stays
      const p = st.status === 'ok' ? this.live.get(voyage.id) : null;
      return p ? { state: 'live', ...p } : { state: 'unavailable', reason: st.status === 'ok' ? 'No price found for this sailing' : (st.error || 'The cruise line’s site blocked the price check') };
    }
    const d = this.demo.get(voyage.id);
    return d ? { state: 'demo', ...d } : { state: 'none' };
  }
  bookingUrl(ship, voyage) {
    const tpl = this.live.get(voyage.id)?.bookingUrl || this.lines[ship.line].book;
    if (tpl.includes('{code}') && !ship.code) return tpl.split('?')[0];
    return tpl.replaceAll('{date}', voyage.date).replaceAll('{code}', ship.code || '');
  }
}
export function money(amount, currency) {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount); }
  catch { return `${currency} ${Math.round(amount)}`; }
}
