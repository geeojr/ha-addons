#!/usr/bin/env node
'use strict';
/*
 * wx-alerts - NWS watch/warning watcher for Home Assistant.
 *
 *  - Every poll it asks api.weather.gov for the active alerts covering HOME and each
 *    tracked PERSON (one request per distinct position; the NWS does the polygon/zone
 *    matching, so county-based watches match as well as storm polygons).
 *  - Each alert is classified into a LEVEL (lib/template.js): "Tornado Warning (observed)",
 *    "Tornado Emergency", "Severe Thunderstorm Warning (destructive)" ... and looked up in
 *    the rules the panel edits (announce at home? push to people? critical?).
 *  - De-duplication is by the NWS event id (VTEC office.phenomenon.significance.number),
 *    per target. Updates, continuations and cancellations of an event already alerted
 *    for that target never fire again. A person who drives INTO an existing warning is
 *    told once, because it is new for them.
 *  - Home matches: MQTT (JSON on wx/alerts/home + the spoken text on the legacy
 *    wx/alert_voice topic the existing "WX Alert Voice" automation listens to) and an HA
 *    event. Person matches: a push through that person's notify.mobile_app_* service and
 *    the same HA event.
 *  - Config panel + status at http://<this host>:7110/ (LAN only, no auth).
 *
 * Config  ~/.config/wx-alerts/config.json   State ~/.config/wx-alerts/state.json
 * Usage   node wx_alerts.js                 (pm2: ecosystem.config.cjs)
 *         node wx_alerts.js --once          one poll, then exit
 */
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const T = require('./lib/template');
const FIX = require('./test/fixtures');

const DIR = process.env.WX_ALERTS_DIR || (fs.existsSync('/data/options.json') ? '/data' : path.join(os.homedir(), '.config/wx-alerts')); // add-on: /data
const CONFIG_PATH = path.join(DIR, 'config.json');
const STATE_PATH = path.join(DIR, 'state.json');
const TYPES_PATH = path.join(DIR, 'event_types.json');
const NWS = 'https://api.weather.gov';
const ONCE = process.argv.includes('--once');
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- config ----------
const DEFAULT_RULES = (() => {
  const on = (announce, push, critical) => ({ announce, push, critical });
  const r = {};
  for (const ev of ['Tornado Warning', 'Severe Thunderstorm Warning', 'Flash Flood Warning', 'Extreme Wind Warning', 'Blizzard Warning', 'Ice Storm Warning', 'Winter Storm Warning', 'Dust Storm Warning', 'Civil Danger Warning', 'Civil Emergency Message', 'Shelter In Place Warning', 'Evacuation Immediate', 'Tornado Watch', 'Severe Thunderstorm Watch'])
    r[ev] = on(true, true, false);
  for (const ev of ['Flash Flood Watch', 'Winter Storm Watch', 'Wind Advisory', 'Winter Weather Advisory', 'Flood Warning', 'Heat Advisory', 'Excessive Heat Warning', 'Extreme Heat Warning', 'Extreme Cold Warning', 'Wind Chill Warning', 'Red Flag Warning', 'High Wind Warning'])
    r[ev] = on(false, true, false);
  for (const k of ['Tornado Warning/radar', 'Tornado Warning/observed', 'Tornado Warning/pds', 'Tornado Warning/emergency', 'Severe Thunderstorm Warning/considerable', 'Severe Thunderstorm Warning/destructive', 'Flash Flood Warning/considerable', 'Flash Flood Warning/emergency', 'Tornado Watch/pds', 'Severe Thunderstorm Watch/pds'])
    r[k] = on(true, true, /observed|pds|emergency|destructive/.test(k));
  r['Extreme Wind Warning'].critical = true;
  for (const [k, t] of Object.entries(T.DEFAULT_LEVEL_TEMPLATES)) r[k] = { ...r[k], ...t };
  return r;
})();

const DEFAULT_CONFIG = {
  ha_url: 'http://172.16.10.7:8123', ha_token: '',
  port: 7110, poll_seconds: 120,
  nws_user_agent: '(wx-alerts Home Assistant add-on)', // the NWS asks for a contact: set the nws_contact add-on option
  home: { lat: null, lon: null },            // null = read zone.home from HA each poll
  people: [],                                // filled from HA person.* on first start; edit in the panel
  rules: DEFAULT_RULES,
  templates: { ...T.DEFAULT_TEMPLATES },
  mqtt: { enabled: true, topic: 'wx/alerts/home', legacy_voice: true, legacy_voice_topic: 'wx/alert_voice' },
  ha_event: 'wx_alert',
  push: { channel: 'WX Alerts', critical_channel: 'WX Critical', url: 'https://www.weather.gov/' },
  prime_on_first_run: true,
};
let config = loadJson(CONFIG_PATH, null);
if (!config) {
  fs.mkdirSync(DIR, { recursive: true });
  config = { ...DEFAULT_CONFIG };
  saveJson(CONFIG_PATH, config);
  log('wrote default config', CONFIG_PATH);
}
// As a Home Assistant add-on the Supervisor proxies the core API and hands us a token; no config needed.
const SUPERVISOR = process.env.SUPERVISOR_TOKEN ? { ha_url: 'http://supervisor/core', ha_token: process.env.SUPERVISOR_TOKEN } : {};
const ADDON_OPTIONS = loadJson('/data/options.json', {});
if (ADDON_OPTIONS.nws_contact) SUPERVISOR.nws_user_agent = `(wx-alerts Home Assistant add-on, ${ADDON_OPTIONS.nws_contact})`;
config = { ...DEFAULT_CONFIG, ...config, ...SUPERVISOR, mqtt: { ...DEFAULT_CONFIG.mqtt, ...(config.mqtt || {}) }, push: { ...DEFAULT_CONFIG.push, ...(config.push || {}) }, templates: { ...T.DEFAULT_TEMPLATES, ...(config.templates || {}) } };
let state = loadJson(STATE_PATH, { seen: {}, primed: false, log: [], last: null });

function loadJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }
function saveJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v, null, 1)); fs.renameSync(tmp, p); try { fs.chmodSync(p, 0o600); } catch { /* ignore */ } }
const saveState = () => saveJson(STATE_PATH, state);
const saveConfig = () => saveJson(CONFIG_PATH, config);

// ---------- Home Assistant ----------
async function ha(method, p, body) {
  const r = await fetch(config.ha_url.replace(/\/$/, '') + p, { method, headers: { Authorization: 'Bearer ' + config.ha_token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HA ${method} ${p}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}
const haStates = () => ha('GET', '/api/states');
const haService = (domain, service, data) => ha('POST', `/api/services/${domain}/${service}`, data);
const haEvent = (type, data) => ha('POST', `/api/events/${type}`, data);
let haTz = 'America/Chicago';
async function haTimeZone() { try { haTz = (await ha('GET', '/api/config')).time_zone || haTz; } catch { /* keep */ } return haTz; }

// ---------- NWS ----------
async function nws(p) {
  const r = await fetch(NWS + p, { headers: { 'User-Agent': config.nws_user_agent, Accept: 'application/geo+json' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`NWS ${p}: ${r.status}`);
  return r.json();
}
let eventTypes = loadJson(TYPES_PATH, null);
async function loadEventTypes() {
  if (eventTypes && Date.now() - (eventTypes.at || 0) < 7 * 86400000) return eventTypes.list;
  try { const d = await nws('/alerts/types'); eventTypes = { at: Date.now(), list: d.eventTypes || [] }; saveJson(TYPES_PATH, eventTypes); }
  catch (e) { log('event types fetch failed:', e.message); if (!eventTypes) eventTypes = { at: 0, list: Object.keys(T.LEVELS) }; }
  return eventTypes.list;
}
const alertsAt = (lat, lon) => nws(`/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}&status=actual&message_type=alert,update`);

// ---------- matching ----------
/** Stable id of the EVENT across issue -> updates -> cancel: VTEC office.pp.s.nnnn, else the alert id. */
function eventKey(f) {
  const v = ((f.properties || {}).parameters || {}).VTEC; const s = Array.isArray(v) ? v[0] : v;
  const m = /\.(\w{4})\.(\w\w)\.(\w)\.(\d{4})\./.exec(String(s || ''));
  return m ? `${m[1]}.${m[2]}.${m[3]}.${m[4]}` : String(f.id);
}
const refIds = (f) => ((f.properties || {}).references || []).map((r) => r.identifier || r['@id']).filter(Boolean);
function ruleFor(level) { return config.rules[level.key] || config.rules[level.base] || { announce: false, push: false, critical: false }; }
function templateFor(kind, level) {
  const r = config.rules[level.key] || {}, b = config.rules[level.base] || {};
  return r[kind] || b[kind] || config.templates[kind] || T.DEFAULT_TEMPLATES[kind];
}
const expiryOf = (f) => { const p = f.properties || {}; const t = Date.parse(p.ends || p.expires || ''); return (Number.isNaN(t) ? Date.now() + 6 * 3600000 : t) + 2 * 3600000; };

function targetsFrom(states) {
  const st = {}; for (const s of states) st[s.entity_id] = s;
  const home = config.home.lat != null ? { ...config.home } : { lat: st['zone.home']?.attributes.latitude, lon: st['zone.home']?.attributes.longitude };
  const targets = [{ id: 'home', name: 'Home', where: 'your location', lat: home.lat, lon: home.lon, notify: null }];
  for (const p of config.people) {
    if (!p.enabled) continue;
    const s = st[p.person]; if (!s) { targets.push({ id: p.person, name: p.name, skipped: 'entity not found' }); continue; }
    const a = s.attributes; let lat = a.latitude, lon = a.longitude;
    if (s.state === 'home' || lat == null || lon == null) { if (s.state === 'home') { lat = home.lat; lon = home.lon; } else { targets.push({ id: p.person, name: p.name, skipped: `no GPS (state ${s.state})` }); continue; } }
    targets.push({ id: p.person, name: p.name, where: `${p.name}'s location`, lat, lon, notify: p.notify, zone: s.state });
  }
  return targets;
}

// ---------- outputs ----------
function pushData(level, rule, vars, f) {
  return { tag: `wx-${vars.level_key}-${eventKey(f)}`.replace(/[^\w.-]/g, '_'), channel: rule.critical ? config.push.critical_channel : config.push.channel,
    importance: rule.critical ? 'max' : 'high', priority: 'high', ttl: 0, sticky: !!rule.critical, notification_icon: 'mdi:weather-lightning',
    color: rule.critical ? '#c62828' : '#f57c00', url: config.push.url, group: 'wx-alerts', timeout: 6 * 3600 };
}
async function fire(target, f, level, rule, dry) {
  const vars = T.variables(f, { tz: haTz, target: target.id, where: target.where, name: target.id === 'home' ? '' : target.name });
  const voice = T.render(templateFor('voice', level), vars);
  const title = T.render(templateFor('push_title', level), vars);
  const body = T.render(templateFor('push_body', level), vars);
  const payload = { target: target.id, name: target.name, level: level.key, level_label: level.label, event: vars.event, critical: !!rule.critical, key: eventKey(f), id: f.id,
    headline: vars.headline, hazards: vars.hazards, until: vars.until, area: vars.area, severity: vars.severity, voice, title, body, sent: (f.properties || {}).sent, ends: (f.properties || {}).ends || (f.properties || {}).expires };
  const did = [];
  if (!dry) {
    if (target.id === 'home' && rule.announce && config.mqtt.enabled) {
      await haService('mqtt', 'publish', { topic: config.mqtt.topic, payload: JSON.stringify(payload) }); did.push(`mqtt:${config.mqtt.topic}`);
      if (config.mqtt.legacy_voice && config.mqtt.legacy_voice_topic) { await haService('mqtt', 'publish', { topic: config.mqtt.legacy_voice_topic, payload: voice }); did.push(`mqtt:${config.mqtt.legacy_voice_topic}`); }
    }
    if (target.id !== 'home' && rule.push && target.notify) {
      const [domain, service] = target.notify.replace(/^notify\./, 'notify.').split('.');
      await haService(domain, service, { title, message: body, data: pushData(level, rule, vars, f) }); did.push(target.notify);
    }
    if (config.ha_event) { await haEvent(config.ha_event, payload); did.push(`event:${config.ha_event}`); }
  }
  const entry = { at: new Date().toISOString(), target: target.id, name: target.name, level: level.label, key: payload.key, voice, title, body, did, dry: !!dry };
  state.log = [entry, ...state.log].slice(0, 200);
  log(`${dry ? 'DRY ' : ''}FIRE ${target.name}: ${level.label} [${payload.key}] -> ${dry ? 'nothing sent (dry run)' : did.join(', ') || 'nothing (rule off / no notify)'}`);
  return entry;
}

// ---------- poll ----------
let polling = false;
async function poll() {
  if (polling) return; polling = true;
  const started = Date.now();
  try {
    const states = await haStates();
    const targets = targetsFrom(states);
    const byPoint = new Map(); // "lat,lon" -> features
    const summary = [];
    const now = Date.now();
    for (const t of targets) {
      if (t.skipped) { summary.push({ target: t.id, name: t.name, skipped: t.skipped }); continue; }
      const pk = `${t.lat.toFixed(3)},${t.lon.toFixed(3)}`;
      if (!byPoint.has(pk)) byPoint.set(pk, alertsAt(t.lat, t.lon).then((d) => d.features || []));
      let feats; try { feats = await byPoint.get(pk); } catch (e) { summary.push({ target: t.id, name: t.name, error: e.message }); continue; }
      const seen = (state.seen[t.id] = state.seen[t.id] || {});
      const active = [];
      for (const f of feats) {
        const p = f.properties || {};
        if (p.status !== 'Actual' || p.messageType === 'Cancel') continue;
        if (Date.parse(p.expires || '') < now) continue;
        const level = T.levelOf(f), rule = ruleFor(level), key = eventKey(f);
        const wants = t.id === 'home' ? rule.announce : rule.push;
        active.push({ event: p.event, level: level.label, key, wants, messageType: p.messageType, ends: p.ends || p.expires });
        if (seen[key]) { seen[key] = Math.max(seen[key], expiryOf(f)); continue; }               // already alerted (or an update of it)
        if (refIds(f).some((id) => seen[`id:${id}`])) { seen[key] = expiryOf(f); continue; }   // update of something we saw under another key
        seen[key] = expiryOf(f); seen[`id:${f.id}`] = expiryOf(f);
        if (!state.primed) continue;                                                              // first run: take note, stay quiet
        if (!wants) continue;
        try { await fire(t, f, level, rule, false); } catch (e) { log('fire failed:', e.message); state.log = [{ at: new Date().toISOString(), target: t.id, error: e.message }, ...state.log].slice(0, 200); }
      }
      // forget keys whose alerts are long gone
      for (const [k, exp] of Object.entries(seen)) if (exp < now) delete seen[k];
      summary.push({ target: t.id, name: t.name, lat: +t.lat.toFixed(3), lon: +t.lon.toFixed(3), zone: t.zone, active });
    }
    if (!state.primed) { state.primed = true; log('primed: existing alerts noted without announcing'); }
    state.last = { at: new Date().toISOString(), ms: Date.now() - started, requests: byPoint.size, targets: summary };
    saveState();
  } catch (e) {
    log('poll failed:', e.message);
    state.last = { at: new Date().toISOString(), error: e.message };
    saveState();
  } finally { polling = false; }
}

// ---------- panel / API ----------
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 2e6) req.destroy(); }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } }); req.on('error', reject); });

async function api(req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/config') return json(res, 200, { ...config, ha_token: config.ha_token ? '••••' : '', supervised: !!process.env.SUPERVISOR_TOKEN });
  if (req.method === 'POST' && p === '/api/config') {
    const b = await readBody(req);
    for (const k of ['poll_seconds', 'people', 'rules', 'templates', 'mqtt', 'push', 'ha_event', 'home', 'nws_user_agent']) if (b[k] !== undefined) config[k] = b[k];
    if (b.ha_token && b.ha_token !== '••••' && !process.env.SUPERVISOR_TOKEN) config.ha_token = b.ha_token;
    config.poll_seconds = Math.max(60, Number(config.poll_seconds) || 120);
    saveConfig(); schedule(); return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && p === '/api/levels') return json(res, 200, { levels: T.allLevels(await loadEventTypes()), variables: T.VARIABLE_HELP, defaults: { templates: T.DEFAULT_TEMPLATES, level_templates: T.DEFAULT_LEVEL_TEMPLATES } });
  if (req.method === 'GET' && p === '/api/status') return json(res, 200, { last: state.last, primed: state.primed, log: state.log.slice(0, 50), version: VERSION, uptime_s: Math.round(process.uptime()) });
  if (req.method === 'GET' && p === '/api/ha') {
    const states = await haStates();
    const people = states.filter((s) => s.entity_id.startsWith('person.')).map((s) => ({ entity: s.entity_id, name: s.attributes.friendly_name, state: s.state, gps: s.attributes.latitude != null, source: s.attributes.source, suggested_notify: s.attributes.source ? 'notify.mobile_app_' + String(s.attributes.source).replace(/^device_tracker\./, '') : '' }));
    const services = await ha('GET', '/api/services');
    const notify = (services.find((d) => d.domain === 'notify') || { services: {} });
    return json(res, 200, { people, notify_services: Object.keys(notify.services).map((s) => 'notify.' + s).sort() });
  }
  if (req.method === 'POST' && p === '/api/preview') {
    const b = await readBody(req); const f = (FIX[b.fixture] || FIX.tornadoRadar)();
    const level = T.levelOf(f); const vars = T.variables(f, { tz: haTz, where: b.where || 'your location', name: b.name || '' });
    return json(res, 200, { level, text: T.render(b.template != null ? b.template : templateFor(b.kind || 'voice', level), vars), vars, fixtures: Object.keys(FIX).filter((k) => k !== 'tornadoUpdate') });
  }
  if (req.method === 'POST' && p === '/api/test') {
    const b = await readBody(req); const f = (FIX[b.fixture] || FIX.tornadoRadar)();
    const states = await haStates(); const t = targetsFrom(states).find((x) => x.id === (b.target || 'home'));
    if (!t || t.skipped) return json(res, 400, { error: t ? t.skipped : 'unknown target' });
    const level = T.levelOf(f); const rule = b.force ? { announce: true, push: true, critical: ruleFor(level).critical } : ruleFor(level);
    return json(res, 200, await fire(t, f, level, rule, !!b.dry));
  }
  if (req.method === 'POST' && p === '/api/poll') { await poll(); return json(res, 200, state.last); }
  if (req.method === 'POST' && p === '/api/reset-seen') { state.seen = {}; saveState(); return json(res, 200, { ok: true }); }
  json(res, 404, { error: 'not found' });
}

const VERSION = require('./package.json').version;
const PUBLIC = path.join(__dirname, 'public');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'text/plain', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { json(res, 500, { error: e.message }); }
});

// ---------- main ----------
let timer = null;
function schedule() { clearInterval(timer); timer = setInterval(() => poll().catch(() => {}), config.poll_seconds * 1000); }
module.exports = { eventKey, refIds, ruleFor, templateFor, targetsFrom, expiryOf, DEFAULT_RULES, _config: () => config, _state: () => state };
if (require.main === module) (async () => {
  if (!config.ha_token) { log('no ha_token in', CONFIG_PATH); process.exit(1); }
  await haTimeZone();
  await loadEventTypes();
  if (!config.people.length) { // first start: every person with a phone, enabled
    try {
      const states = await haStates();
      config.people = states.filter((s) => s.entity_id.startsWith('person.') && s.attributes.source).map((s) => ({ person: s.entity_id, name: String(s.attributes.friendly_name || s.entity_id).split(' ')[0], enabled: true, notify: 'notify.mobile_app_' + String(s.attributes.source).replace(/^device_tracker\./, '') }));
      saveConfig(); log('people from HA:', config.people.map((p) => `${p.name} -> ${p.notify}`).join('; '));
    } catch (e) { log('could not list people:', e.message); }
  }
  if (!config.prime_on_first_run) state.primed = true;
  await poll();
  if (ONCE) { log('once: done'); process.exit(0); }
  schedule();
  server.listen(config.port, '0.0.0.0', () => log(`wx-alerts ${VERSION} panel on http://0.0.0.0:${config.port}/  poll every ${config.poll_seconds}s  tz ${haTz}`));
})();
