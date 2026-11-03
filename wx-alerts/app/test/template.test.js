'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/template');
const F = require('./fixtures');
const ctx = { tz: 'America/Chicago', now: Date.parse('2026-11-01T22:45:00-05:00') };

test('levels', () => {
  assert.equal(T.levelOf(F.tornadoRadar()).key, 'Tornado Warning/radar');
  assert.equal(T.levelOf(F.tornadoObserved()).key, 'Tornado Warning/observed');
  assert.equal(T.levelOf(F.tornadoPds()).key, 'Tornado Warning/pds');
  assert.equal(T.levelOf(F.tornadoEmergency()).label, 'Tornado Emergency');
  assert.equal(T.levelOf(F.severeTstm()).key, 'Severe Thunderstorm Warning');
  assert.equal(T.levelOf(F.severeDestructive()).key, 'Severe Thunderstorm Warning/destructive');
  assert.equal(T.levelOf(F.tornadoWatch()).key, 'Tornado Watch');
  assert.equal(T.levelOf(F.tornadoWatchPds()).key, 'Tornado Watch/pds');
  assert.equal(T.levelOf(F.windAdvisory()).key, 'Wind Advisory');
  const rows = T.allLevels(['Tornado Warning', 'Wind Advisory']);
  assert.deepEqual(rows.map((r) => r.key), ['Tornado Warning', 'Tornado Warning/emergency', 'Tornado Warning/pds', 'Tornado Warning/observed', 'Tornado Warning/radar', 'Wind Advisory']);
});

test('variables', () => {
  const v = T.variables(F.tornadoPds(), ctx);
  assert.equal(v.until, '11:35 PM');
  assert.equal(v.hazards, 'a confirmed tornado, hen egg size hail (2 inch) and 75 mile per hour winds');
  assert.equal(v.pds, 'particularly dangerous situation');
  assert.equal(v.detection, 'observed');
  assert.equal(v.sender, 'Kansas City/Pleasant Hill MO');
  assert.equal(v.hazard_line, 'Tornado and golf ball size hail');
  assert.equal(v.class, 'Warning');
  const w = T.variables(F.tornadoWatch(), ctx);
  assert.equal(w.until, '4:00 AM Monday');            // ends tomorrow -> weekday added
  assert.equal(w.hazards, '');                         // watch has no hazard tags
  const s = T.variables(F.severeTstm(), ctx);
  assert.equal(s.hazards, 'quarter size hail (1 inch) and 60 mile per hour winds');
  const a = T.variables(F.windAdvisory(), ctx);
  assert.equal(a.hazards, '');
  assert.equal(a.nws_headline, 'WIND ADVISORY IN EFFECT UNTIL 6 PM CST MONDAY');
});

test('render', () => {
  const v = T.variables(F.tornadoRadar(), ctx);
  assert.equal(T.render(T.DEFAULT_TEMPLATES.voice, v),
    'Attention. A Tornado Warning has been issued for your location until 11:35 PM. Hazards include a radar indicated tornado, golf ball size hail (1.75 inch) and 70 mile per hour winds.');
  const w = T.variables(F.tornadoWatch(), { ...ctx, where: "Jennifer's location" });
  assert.equal(T.render(T.DEFAULT_TEMPLATES.voice, w), "Attention. A Tornado Watch has been issued for Jennifer's location until 4:00 AM Monday.");
  assert.equal(T.render('{hazards|no details}[ x {nope}]', w), 'no details');
  assert.equal(T.render('\\[literal\\] {event}', w), '[literal] Tornado Watch');
  assert.equal(T.render(T.DEFAULT_TEMPLATES.push_body, v), 'Until 11:35 PM · a radar indicated tornado, golf ball size hail (1.75 inch) and 70 mile per hour winds. Platte, MO; Clay, MO; Wyandotte, KS');
  const e = T.variables(F.tornadoEmergency(), ctx);
  assert.match(T.render(T.DEFAULT_LEVEL_TEMPLATES['Tornado Warning/emergency'].voice, e), /^Tornado Emergency for your location\. .*Take cover immediately\.$/);
});
