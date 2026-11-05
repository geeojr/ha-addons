'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/detect');
const { TZ } = require('../lib/tou_rates');

const T0 = Date.UTC(2026, 10, 3, 2, 0, 0); // 2026-11-02 20:00 CST (Mon)
const row = (min, s) => ({ s, lu: (T0 + min * 60000) / 1000 });
const PLANS = [{ id: 'p', start: '2000-01-01', end: null, summer_months: [6, 7, 8, 9], holidays: [], periods: [{ name: 'Super Off-Peak', start: 0, end: 6, tier: 'sop' }, { name: 'Off-Peak AM', start: 6, end: 16, tier: 'op' }, { name: 'Peak', start: 16, end: 20, tier: 'peak', weekend_holiday_tier: 'op' }, { name: 'Off-Peak PM', start: 20, end: 24, tier: 'op' }], rates: { summer: { sop: 0.03, op: 0.12, peak: 0.36 }, non_summer: { sop: 0.02, op: 0.09, peak: 0.27 } } }];

test('transitions(): boolean transitions of a status history, unknown ignored', () => {
  const tr = D.transitions([row(0, 'available'), row(5, 'unavailable'), row(10, 'plugged_in'), row(11, 'waiting'), row(60, 'charging'), row(200, 'available')], D.chargerPlugged);
  assert.deepEqual(tr.map((t) => [(t.t - T0) / 60000, t.on]), [[10, true], [200, false]]);
  assert.deepEqual(D.transitions([row(0, 'off'), row(3, 'on')], D.binaryOn).map((t) => t.on), [true]);
});

test('matchPlugins(): closest vehicle plug within the window wins, each vehicle event once, unmatched stays null', () => {
  const chargers = { North: D.transitions([row(0, 'available'), row(10, 'plugged_in'), row(300, 'available'), row(400, 'plugged_in')], D.chargerPlugged), South: D.transitions([row(0, 'available'), row(12, 'plugged_in')], D.chargerPlugged) };
  const vehicles = { r1s: D.transitions([row(0, 'off'), row(10, 'on')], D.binaryOn), q8: D.transitions([row(0, 'off'), row(14, 'on')], D.binaryOn) };
  const m = D.matchPlugins(chargers, vehicles);
  assert.deepEqual(m.map((e) => [e.charger, (e.at - T0) / 60000, e.vehicle, e.delta_ms]), [['North', 10, 'r1s', 0], ['South', 12, 'q8', 120000], ['North', 400, null, null]]);
  assert.deepEqual(m[0].candidates, ['r1s']); assert.equal(m[0].ambiguous, false); // q8 was in the window but South claimed it
  assert.deepEqual(m[1].candidates, ['q8']); assert.equal(m[1].ambiguous, false);
  // one charger event, two unclaimed vehicle events: ambiguous only when the loser was nearly as close
  const two = D.matchPlugins({ North: chargers.South }, { r1s: D.transitions([row(0, 'off'), row(13, 'on')], D.binaryOn), q8: D.transitions([row(0, 'off'), row(14, 'on')], D.binaryOn) });
  assert.deepEqual([two[0].vehicle, two[0].ambiguous, two[0].alternatives], ['r1s', true, [{ vehicle: 'q8', delta_ms: 120000 }]]);
  const far = D.matchPlugins({ North: chargers.South }, { r1s: D.transitions([row(0, 'off'), row(12, 'on')], D.binaryOn), q8: D.transitions([row(0, 'off'), row(24, 'on')], D.binaryOn) });
  assert.deepEqual([far[0].vehicle, far[0].ambiguous, far[0].candidates], ['r1s', false, ['r1s', 'q8']]);
  // a vehicle that reported 20 minutes late is outside the default window
  const late = D.matchPlugins({ South: chargers.South }, { q8: D.transitions([row(0, 'off'), row(40, 'on')], D.binaryOn) });
  assert.equal(late[0].vehicle, null);
});

test('typicalKw(): mean of the full charging hours', () => {
  const rows = {}; const h0 = Math.floor(T0 / 3600000);
  [5.8, 5.7, 5.9, 2.1, 0.3, 5.75].forEach((v, i) => { rows[h0 - i] = { home: v }; });
  assert.equal(D.typicalKw(rows, h0), 5.79);
  assert.equal(D.typicalKw({ [h0]: { home: 5 } }, h0), null);
});

test('cheapWindow(): the next run of hours at the lowest rate', () => {
  const tz = new TZ('America/Chicago');
  const w = D.cheapWindow(PLANS, tz, T0); // 20:00 CST -> super off-peak 00:00-06:00 next
  assert.equal(new Date(w.start).toISOString(), '2026-11-03T06:00:00.000Z'); assert.equal(new Date(w.end).toISOString(), '2026-11-03T12:00:00.000Z');
  assert.deepEqual([w.rate, w.hours], [0.02, 6]);
  const inside = D.cheapWindow(PLANS, tz, Date.UTC(2026, 10, 3, 8, 30)); // 02:30 CST: window already running
  assert.equal(new Date(inside.start).toISOString(), '2026-11-03T08:30:00.000Z'); assert.equal(inside.hours, 3.5);
});

test('chargeEstimate(): minutes, finish, latest start and the start-early flag', () => {
  const tz = new TZ('America/Chicago'); const w = D.cheapWindow(PLANS, tz, T0);
  const e = D.chargeEstimate({ soc: 40, target: 85, capacityKwh: 127.2, efficiency: 0.9, kw: 5.76, nowMs: T0, window: w });
  assert.equal(e.battery_kwh, 57.24); assert.equal(e.needed_kwh, 63.6); assert.equal(e.minutes, 663);  // 11 h 3 min > the 6 h window
  assert.equal(e.start_early, true); assert.equal(e.latest_start, '2026-11-03T00:57:00.000Z');          // 18:57 CST, before the window
  const small = D.chargeEstimate({ soc: 70, target: 85, capacityKwh: 127.2, efficiency: 0.9, kw: 5.76, nowMs: T0, window: w });
  assert.equal(small.start_early, false); assert.equal(small.minutes, 221); assert.equal(small.latest_start, '2026-11-03T08:19:00.000Z');
  assert.equal(D.chargeEstimate({ soc: 90, target: 85, capacityKwh: 100, efficiency: 0.9, kw: 5, nowMs: T0, window: w }).minutes, 0);
  assert.equal(D.chargeEstimate({ soc: 50, target: 85, capacityKwh: 100, efficiency: 0.9, kw: null, nowMs: T0, window: w }).minutes, null);
  assert.equal(D.chargeEstimate({ soc: 'unknown', target: 85, capacityKwh: 100 }), null);
});

test('matchPlugins(): a plug report after the window is a late (low) match unless the port was unplugged first', () => {
  const ch = { South: D.transitions([row(0, 'available'), row(10, 'plugged_in')], D.chargerPlugged) };
  const q8 = { q8: D.transitions([row(0, 'off'), row(40, 'on')], D.binaryOn) };
  const m = D.matchPlugins(ch, q8, 3 * 60000, 15 * 60000, 2 * 60000, 6 * 3600000);
  assert.deepEqual([m[0].vehicle, m[0].late, m[0].delta_ms], ['q8', true, 30 * 60000]);
  const gone = D.matchPlugins({ South: D.transitions([row(0, 'available'), row(10, 'plugged_in'), row(30, 'available')], D.chargerPlugged) }, q8, 3 * 60000, 15 * 60000, 2 * 60000, 6 * 3600000);
  assert.equal(gone[0].vehicle, null);
});

test('resolvePort(): manual beats detection until the port is unplugged; detecting / unclaimed / history', () => {
  const ev = { at: T0 + 10 * 60000, vehicle: 'r1s', delta_ms: 0, ambiguous: false };
  const base = { plugged: true, statusT: T0 + 10 * 60000, ev, unplugs: [], prev: {}, fallback: null, nowMs: T0 + 60 * 60000, afterMs: 15 * 60000 };
  assert.deepEqual(D.resolvePort(base), { occupant: 'r1s', confidence: 'high', since: ev.at, clearOverride: false });
  // set by hand while plugged: applies from the plug-in
  const man = D.resolvePort({ ...base, override: { value: 'unknown', at: T0 + 30 * 60000 } });
  assert.deepEqual([man.occupant, man.confidence, man.since], ['unknown', 'manual', ev.at]);
  // unplugged after it was set: cleared, port free
  const off = D.resolvePort({ ...base, plugged: false, unplugs: [T0 + 50 * 60000], override: { value: 'unknown', at: T0 + 30 * 60000 } });
  assert.deepEqual([off.occupant, off.clearOverride], [null, true]);
  // preset while free survives the plug-in that follows, and is cleared by the unplug after it
  const preset = { value: 'q8', at: T0 + 5 * 60000 };
  assert.equal(D.resolvePort({ ...base, plugged: false, ev: null, override: preset }).preset, true);
  assert.deepEqual([D.resolvePort({ ...base, override: preset }).occupant, D.resolvePort({ ...base, override: preset }).since], ['q8', ev.at]);
  // unclaimed: detecting inside the window, unknown after it
  const un = { ...ev, vehicle: null, delta_ms: null };
  assert.deepEqual([D.resolvePort({ ...base, ev: un, nowMs: ev.at + 5 * 60000 }).occupant, D.resolvePort({ ...base, ev: un, nowMs: ev.at + 5 * 60000 }).confidence], [undefined, 'detecting']);
  assert.equal(D.resolvePort({ ...base, ev: un }).occupant, 'unknown');
  assert.equal(D.resolvePort({ ...base, ev: { ...ev, late: true } }).confidence, 'low');
  // plugged since before the lookback: the last result, else the charger history
  assert.deepEqual(D.resolvePort({ ...base, ev: null, prev: { occupant: 'q8', confidence: 'high', since: T0 } }).occupant, 'q8');
  assert.deepEqual([D.resolvePort({ ...base, ev: null, fallback: 'r1s' }).occupant, D.resolvePort({ ...base, ev: null, fallback: 'r1s' }).confidence], ['r1s', 'history']);
  assert.equal(D.resolvePort({ ...base, plugged: null }).occupant, undefined);
});
