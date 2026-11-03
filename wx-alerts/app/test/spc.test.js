'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SPC = require('../lib/spc');
const sample = require('./spc_day1_sample.json'); // real SPC day 1 file from 2026-11-03 05:34Z (TSTM with a MRGL hole)

const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const feature = (label, coordinates, type = 'Polygon') => ({ type: 'Feature', geometry: { type, coordinates }, properties: { LABEL: label, ISSUE: '202611031200', VALID: '202611031300', EXPIRE: '202611041200', FORECASTER: 'Test' } });

test('level numbering matches the SPC categories', () => {
  assert.deepEqual(SPC.LEVELS.map((l) => [l.level, l.code]), [[0, 'NONE'], [1, 'TSTM'], [2, 'MRGL'], [3, 'SLGT'], [4, 'ENH'], [5, 'MDT'], [6, 'HIGH']]);
});

test('nested areas: the highest containing area wins, holes are respected', () => {
  const o = SPC.parse({ features: [
    feature('TSTM', [square(-100, 30, -90, 40), square(-96, 34, -94, 36)]),   // general tstm with a hole
    feature('MRGL', [square(-97, 33, -93, 37)]),                               // marginal around the hole
    feature('SLGT', [square(-96, 34, -94, 36)]),                               // slight inside it
    feature('HIGH', [[square(-80, 30, -79, 31)]], 'MultiPolygon'),
  ] });
  assert.deepEqual(o.areas.map((a) => a.code), ['TSTM', 'MRGL', 'SLGT', 'HIGH']);
  assert.equal(o.valid, '2026-11-03T13:00:00.000Z');
  assert.equal(SPC.levelAt(o, 31, -99).level, 1);     // only tstm
  assert.equal(SPC.levelAt(o, 33.5, -96.5).level, 2); // marginal
  assert.equal(SPC.levelAt(o, 35, -95).level, 3);     // slight (inside the tstm hole, but slight contains it)
  assert.equal(SPC.levelAt(o, 30.5, -79.5).level, 6); // multipolygon high
  assert.deepEqual(SPC.levelAt(o, 45, -120), { level: 0, code: 'NONE', label: 'None' });
});

test('unknown labels are ignored, empty file gives level 0 everywhere', () => {
  const o = SPC.parse({ features: [feature('WHAT', [square(-100, 30, -90, 40)])] });
  assert.equal(o.areas.length, 0);
  assert.equal(SPC.levelAt(o, 35, -95).level, 0);
  assert.equal(SPC.levelAt(SPC.parse({}), 35, -95).level, 0);
});

test('real SPC file: metadata and a few known points', () => {
  const o = SPC.parse(sample);
  assert.deepEqual(o.areas.map((a) => a.code), ['TSTM', 'MRGL']);
  assert.equal(o.issued, '2026-11-03T05:34:00.000Z');
  assert.equal(o.valid, '2026-11-03T12:00:00.000Z');
  assert.equal(o.expire, '2026-11-04T12:00:00.000Z');
  assert.equal(o.forecaster, 'Broyles/Weinman');
  assert.equal(SPC.levelAt(o, 39.0, -94.6).level, 1);  // Kansas City: general thunderstorms
  assert.equal(SPC.levelAt(o, 38.6, -90.2).level, 2);  // St. Louis: marginal (inside the hole of the TSTM area)
  assert.equal(SPC.levelAt(o, 35.1, -90.0).level, 2);  // Memphis: marginal
  assert.equal(SPC.levelAt(o, 39.7, -105.0).level, 0); // Denver: nothing
  assert.equal(SPC.levelAt(o, 40.7, -74.0).level, 0);  // New York: nothing
});
