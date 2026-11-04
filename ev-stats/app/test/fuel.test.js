'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('../lib/fuel');

const eia = fs.readFileSync(path.join(__dirname, 'eia_sample.html'), 'utf8');
const aaa = fs.readFileSync(path.join(__dirname, 'aaa_sample.html'), 'utf8');

test('parseEia(): weekly rows ascending, year rolls over for a January week on the December row', () => {
  const w = F.parseEia(eia);
  assert.ok(w.length > 150);
  assert.deepEqual(w[0], ['2023-01-02', 3.05]);
  assert.deepEqual(w[w.length - 1], ['2026-11-02', 4.102]);
  for (let i = 1; i < w.length; i++) assert.ok(w[i][0] > w[i - 1][0], `ascending at ${i}`);
  assert.ok(w.some((x) => x[0] === '2025-01-06'), 'first week of 2025 (on the 2024-Dec row) is dated 2025');
  assert.ok(w.some((x) => x[0] === '2024-01-01'));
});

test('parseAaa(): state table, metro tables, national and as-of date', () => {
  const a = F.parseAaa(aaa);
  assert.equal(a.state.name, 'Missouri');
  assert.equal(a.state.prices.regular.current, 3.817);
  assert.equal(a.state.prices.diesel.year_ago, 3.3868);
  assert.deepEqual(Object.keys(a.areas), ['Columbia', 'Kansas City (MO only)']);
  assert.equal(a.areas['Kansas City (MO only)'].premium.current, 4.6043);
  assert.equal(a.areas['Kansas City (MO only)'].midgrade.month_ago, 4.4831);
  assert.equal(a.national, 4.1493);
  assert.equal(a.as_of, '2026-11-03');
});

test('priceSeries(): AAA snapshot wins for 7 days, then EIA week containing the date', () => {
  const weekly = { regular: [['2026-10-26', 4.269], ['2026-11-02', 4.102]] };
  const daily = { '2026-11-03': { regular: 3.85 } };
  const s = F.priceSeries(weekly, daily);
  assert.deepEqual(s.price('2026-11-03', 'regular'), { price: 3.85, source: 'aaa', as_of: '2026-11-03' });
  assert.deepEqual(s.price('2026-11-09', 'regular'), { price: 3.85, source: 'aaa', as_of: '2026-11-03' });
  assert.equal(s.price('2026-11-11', 'regular').source, 'eia'); // 8 days after the snapshot
  assert.deepEqual(s.price('2026-10-30', 'regular'), { price: 4.269, source: 'eia', as_of: '2026-10-26' });
  assert.equal(s.price('2026-10-01', 'regular'), null);
  assert.equal(s.price('2026-11-03', 'diesel'), null);
});

test('series ids and urls', () => {
  assert.equal(F.EIA_SERIES('R20').diesel, 'EMD_EPD2D_PTE_R20_DPG');
  assert.ok(F.eiaUrl('X').includes('s=X&f=W'));
  assert.equal(F.aaaUrl('MO'), 'https://gasprices.aaa.com/?state=MO');
});
