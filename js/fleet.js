// The fleet: the ships this site tracks (data/ships.json) and the cruise ports it labels (data/ports.json).
// Positions are not stored here. They come only from AIS (js/data/ais.js).
export const TRAIL = 10;            // wake samples per ship
export const REC = 8 + TRAIL * 2;   // floats per ship in a state buffer: lat, lon, hdg, sog, status, src, -, port index, then the wake
export const PORT = 1, SEA = 2;     // status: stopped (alongside, anchored or drifting) or underway

export function buildFleet(ships, ports) {
  const list = ships.map((s, index) => ({ ...s, index }));
  return { ships: list, byId: new Map(list.map((s) => [s.id, s])), ports, portCodes: Object.keys(ports) };
}
