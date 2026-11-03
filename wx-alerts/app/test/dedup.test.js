'use strict';
// Runs the service module against a scratch config dir (never the real one).
const fs = require('fs'), os = require('os'), path = require('path');
process.env.WX_ALERTS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-alerts-test-'));
fs.writeFileSync(path.join(process.env.WX_ALERTS_DIR, 'config.json'), JSON.stringify({ ha_token: 'x' }));
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../wx_alerts');
const T = require('../lib/template');
const F = require('./fixtures');

test('event key is the VTEC event id, shared by issue and update', () => {
  const a = F.tornadoRadar(), u = F.tornadoUpdate(a);
  assert.equal(W.eventKey(a), 'KEAX.TO.W.0042');
  assert.equal(W.eventKey(u), 'KEAX.TO.W.0042');
  assert.notEqual(a.id, u.id);
  assert.deepEqual(W.refIds(u), [a.id]);
  const noVtec = F.windAdvisory(); delete noVtec.properties.parameters.VTEC;
  assert.equal(W.eventKey(noVtec), noVtec.id);
});

test('rules resolve by level, then base product, then off', () => {
  assert.equal(W.ruleFor(T.levelOf(F.tornadoEmergency())).critical, true);
  assert.equal(W.ruleFor(T.levelOf(F.tornadoRadar())).critical, false);
  assert.equal(W.ruleFor(T.levelOf(F.severeTstm())).announce, true);
  assert.equal(W.ruleFor(T.levelOf(F.windAdvisory())).announce, false);
  assert.equal(W.ruleFor(T.levelOf(F.windAdvisory())).push, true);
  assert.deepEqual(W.ruleFor({ key: 'Volcano Warning/x', base: 'Volcano Warning' }), { announce: false, push: false, critical: false });
  // level wording overrides the global template; a base-only product uses the global one
  assert.match(W.templateFor('voice', T.levelOf(F.tornadoEmergency())), /^Tornado Emergency for/);
  assert.equal(W.templateFor('voice', T.levelOf(F.tornadoRadar())), T.DEFAULT_TEMPLATES.voice);
  assert.equal(W.templateFor('push_title', T.levelOf(F.tornadoEmergency())), 'TORNADO EMERGENCY');
});

test('targets: home from zone.home, people at home use home coords, no-GPS people are skipped', () => {
  const cfg = W._config();
  cfg.people = [{ person: 'person.a', name: 'A', enabled: true, notify: 'notify.mobile_app_a' }, { person: 'person.b', name: 'B', enabled: true, notify: 'notify.mobile_app_b' }, { person: 'person.c', name: 'C', enabled: true }, { person: 'person.d', name: 'D', enabled: false }];
  const states = [
    { entity_id: 'zone.home', attributes: { latitude: 39.2, longitude: -94.6 } },
    { entity_id: 'person.a', state: 'home', attributes: { latitude: 39.2001, longitude: -94.6001 } },
    { entity_id: 'person.b', state: 'not_home', attributes: { latitude: 38.9, longitude: -94.5 } },
    { entity_id: 'person.c', state: 'unknown', attributes: {} },
  ];
  const t = W.targetsFrom(states);
  assert.deepEqual(t.map((x) => [x.id, x.lat, x.lon, x.skipped || null]), [['home', 39.2, -94.6, null], ['person.a', 39.2, -94.6, null], ['person.b', 38.9, -94.5, null], ['person.c', undefined, undefined, 'no GPS (state unknown)']]);
  assert.equal(t[2].where, "B's location");
});
