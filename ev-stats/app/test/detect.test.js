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
  assert.deepEqual(m[0].candidates, ['r1s', 'q8']); // both were within the window; r1s was closer and q8 went to South
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
