'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../lib/rollup');

const H = R.HOUR;
const T0 = Date.UTC(2026, 10, 2, 0, 0, 0); // 2026-11-02 00:00Z, an hour boundary
const s = (minutes, v) => ({ t: T0 + minutes * 60000, v });

test('samples(): numeric states only, sorted', () => {
  const out = R.samples([{ s: '5', lu: 20 }, { s: 'unknown', lu: 25 }, { s: '1.5', lu: 10 }, { s: '', lu: 30 }]);
  assert.deepEqual(out, [{ t: 10000, v: 1.5 }, { t: 20000, v: 5 }]);
});

test('integrateHours(): left-Riemann, split across the hour boundary, no phantom energy before a charge starts', () => {
  // 0 kW for 90 min, then 6 kW for 60 min, then 0
  const pw = [s(0, 0), s(90, 6), s(150, 0)];
  const kwh = R.integrateHours(pw, T0, T0 + 4 * H);
  assert.equal(Object.keys(kwh).length, 2);
  assert.ok(Math.abs(kwh[R.hourOf(T0 + H)] - 3) < 1e-9);      // 01:30-02:00 at 6 kW
  assert.ok(Math.abs(kwh[R.hourOf(T0 + 2 * H)] - 3) < 1e-9);  // 02:00-02:30 at 6 kW
  // trapezoid would have booked 90 min x 3 kW = 4.5 kWh of nothing before the charge: make sure we don't
  assert.equal(kwh[R.hourOf(T0)], undefined);
});

test('integrateHours(): a state that starts before the window counts from the window start', () => {
  const pw = [{ t: T0 - 5 * H, v: 2 }];
  const kwh = R.integrateHours(pw, T0, T0 + 2 * H);
  assert.ok(Math.abs(kwh[R.hourOf(T0)] - 2) < 1e-9 && Math.abs(kwh[R.hourOf(T0 + H)] - 2) < 1e-9);
});

test('milesByHour(): increases booked in the hour reported, glitches ignored', () => {
  const odo = [s(0, 1000), s(30, 1010.5), s(70, 1012), s(80, 5000), s(90, 1013)];
  const { mi, moves } = R.milesByHour(odo, T0, T0 + 3 * H);
  assert.equal(mi[R.hourOf(T0)], 10.5);
  assert.equal(mi[R.hourOf(T0 + H)], 1.5); // the 5000 jump is dropped; the drop back is not an increase
  assert.equal(moves.length, 2);
});

test('socByHour(): drops are battery energy (driving when the odometer moved), rises are charging', () => {
  const cap = 100; // kWh -> 1 % = 1 kWh
  const odo = [s(0, 0), s(20, 5), s(40, 10)];                    // moving 00:00-00:40
  const soc = [s(0, 80), s(20, 75), s(40, 70), s(100, 69), s(130, 79)]; // -5, -5 while moving; -1 idle; +10 charge
  const { moves } = R.milesByHour(odo, T0, T0 + 3 * H);
  const e = R.socByHour(soc, moves, cap, T0, T0 + 3 * H);
  assert.deepEqual(e[R.hourOf(T0)], { pack: 10, drive: 10, chg: 0 });
  assert.deepEqual(e[R.hourOf(T0 + H)], { pack: 1, drive: 0, chg: 0 });
  assert.deepEqual(e[R.hourOf(T0 + 2 * H)], { pack: 0, drive: 0, chg: 10 });
});

test('rowsFromRaw(): home kWh follows the assigned charger and is priced per hour; away charge is the remainder', () => {
  const north = [s(0, 0), s(60, 7.2), s(120, 0)], south = [s(0, 0), s(60, 3), s(120, 0)];
  const soc = [s(0, 50), s(60, 50), s(119, 58)]; // +8 % of 100 kWh = 8 kWh reported inside hour 1 (6.48 expected from north at 90 %)
  const rows = R.rowsFromRaw({ odo: [s(0, 1)], soc, power: { North: north, South: south }, capacityKwh: 100, efficiency: 0.9, fromMs: T0, toMs: T0 + 3 * H,
    chargerAt: () => 'North', rateAt: (h) => (h === R.hourOf(T0 + H) ? 0.02 : 0.09) });
  const r = rows[R.hourOf(T0 + H)];
  assert.equal(r.home, 7.2); assert.equal(r.cost, 0.144); assert.equal(r.chg, 8); assert.equal(r.away, 1.52); assert.equal(r.src, 'raw');
  assert.equal(rows[R.hourOf(T0)].home, 0);
  assert.equal(Object.keys(rows).length, 3);
});

test('rowsFromStats(): hourly means -> rows, mean-to-mean SOC change, odometer change', () => {
  const st = { odo: [{ start: T0, change: 12 }, { start: T0 + H, change: 0 }], soc: [{ start: T0, mean: 70 }, { start: T0 + H, mean: 64 }, { start: T0 + 2 * H, mean: 70 }], power: { South: [{ start: T0 + 2 * H, mean: 6.6 }] } };
  const rows = R.rowsFromStats({ stats: st, capacityKwh: 100, efficiency: 0.9, fromMs: T0, toMs: T0 + 3 * H, chargerAt: () => 'South', rateAt: () => 0.1 });
  assert.equal(rows[R.hourOf(T0)].mi, 12);
  assert.deepEqual([rows[R.hourOf(T0 + H)].pack, rows[R.hourOf(T0 + H)].drive], [6, 0]); // no miles that hour -> idle
  const c = rows[R.hourOf(T0 + 2 * H)];
  assert.equal(c.chg, 6); assert.equal(c.home, 6.6); assert.equal(c.cost, 0.66); assert.equal(c.away, 0.06); assert.equal(c.src, 'stat'); // 6 - 6.6 x 0.9
});

test('windowMetrics(): sums, derived efficiencies and the fuel comparison', () => {
  const h0 = R.hourOf(T0);
  const rows = {
    [h0]: { mi: 30, pack: 12, drive: 10, chg: 0, home: 0, cost: 0, away: 0, src: 'raw' },
    [h0 + 1]: { mi: 0, pack: 0, drive: 0, chg: 20, home: 20, cost: 0.4, away: 2, src: 'raw' },
    [h0 + 5]: { mi: 10, pack: 5, drive: 5, chg: 0, home: 0, cost: 0, away: 0, src: 'stat' },
  };
  const m = R.windowMetrics(rows, h0, h0 + 5, { mpg: 20, grade: 'regular', priceAt: () => 4, efficiency: 0.9, awayRate: 0.45 });
  assert.equal(m.miles, 40); assert.equal(m.home_energy, 20); assert.equal(m.home_cost, 0.4); assert.equal(m.avg_rate, 0.02);
  assert.equal(m.battery_energy, 17); assert.equal(m.drive_energy, 15);
  assert.equal(m.efficiency, 2.67);            // 40 mi / 15 kWh
  assert.equal(m.consumption, 42.5);           // 17 kWh / 40 mi
  assert.equal(m.fuel_gallons, 2); assert.equal(m.fuel_cost, 8);
  assert.equal(m.ev_cost, 1.4);                // 0.4 + 2/0.9*0.45
  assert.equal(m.savings, 6.6); assert.equal(m.cost_per_mile, 0.035);
  assert.deepEqual([m.hours, m.raw_hours], [3, 2]);
});

test('coverage flags: no SOC data / no charger data are excluded from the ratios and never priced as away charging', () => {
  const rows = R.rowsFromRaw({ odo: [s(0, 0), s(30, 20)], soc: [], power: { North: [] }, capacityKwh: 100, efficiency: 0.9, fromMs: T0, toMs: T0 + H, chargerAt: () => 'North', rateAt: () => 0.1 });
  const r = rows[R.hourOf(T0)];
  assert.equal(r.nosoc, true); assert.equal(r.nohome, true); assert.equal(r.mi, 20);
  const st = R.rowsFromStats({ stats: { odo: [{ start: T0, change: 10 }], soc: [], power: {} }, capacityKwh: 100, efficiency: 0.9, fromMs: T0, toMs: T0 + H, chargerAt: () => 'North', rateAt: () => 0.1 });
  assert.equal(st[R.hourOf(T0)].nohome, true);
  const h0 = R.hourOf(T0);
  const m = R.windowMetrics({ [h0]: r, [h0 + 1]: { mi: 10, pack: 5, drive: 5, chg: 0, home: 4, cost: 0.1, away: 0, src: 'raw' } }, h0, h0 + 1, { mpg: 20, grade: 'regular', priceAt: () => 4, efficiency: 0.9, awayRate: 0.45 });
  assert.equal(m.miles, 30); assert.equal(m.miles_with_battery_data, 10); assert.equal(m.miles_with_charger_data, 10);
  assert.equal(m.efficiency, 2); assert.equal(m.consumption, 50); assert.equal(m.wall_consumption, 40); assert.equal(m.away_energy, 0);
  // storage form round-trips
  assert.deepEqual(R.expand(R.compact(r)), { ...R.EMPTY, mi: 20, src: 'raw', nosoc: true, nohome: true });
  assert.deepEqual(R.compact({ ...R.EMPTY, src: 'stat' }), { src: 'stat' });
});

test('windowMetrics(): no miles -> ratio metrics are null, not NaN', () => {
  const m = R.windowMetrics({}, 0, 10, { mpg: 20, grade: 'regular', priceAt: () => null, efficiency: 0.9, awayRate: 0 });
  assert.equal(m.efficiency, null); assert.equal(m.cost_per_mile, null); assert.equal(m.savings, 0); assert.equal(m.miles, 0);
});
