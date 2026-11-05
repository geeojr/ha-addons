#!/usr/bin/env node
'use strict';
/*
 * ev-stats - per-vehicle EV cost / efficiency / fuel-equivalent sensors for Home Assistant.
 *
 *  - Every poll the last few hours of RAW recorder history (odometer, state of charge, the home
 *    chargers' power) are turned into one row per hour per vehicle (lib/rollup.js): miles, battery
 *    energy out/in, home-charger kWh (the charger named by the vehicle's input_select helper) priced
 *    at the time-of-use rate of that hour (sensor.electricity_rate's plans, lib/tou_rates.js).
 *    On first start (and on "rebuild") the older hours are backfilled from hourly long-term statistics.
 *  - Rolling windows (1d, 7d, 30d, 365d ... configurable) are summed from those rows and published
 *    as sensors through MQTT discovery: sensor.ev_<vehicle>_<metric>_<window>. Every sensor of a
 *    window carries all of that window's metrics as attributes.
 *  - Fuel prices: EIA weekly retail prices per region (history to the 1990s, no key) and AAA's daily
 *    state / metro averages. Published as sensor.fuel_price_<grade>; the per-day series prices the
 *    "what would this have cost in gasoline" numbers two ways: an assumed equivalent MPG (vehicle
 *    helpers: fuel grade + MPG) and from the measured driving energy (kWh/mi -> wheel energy ->
 *    gallons at a gasoline / diesel energy content and engine efficiency; Settings).
 *  - Long-term statistics (evstats:<vehicle>_miles, _home_energy, _home_cost, _battery_energy,
 *    _fuel_gallons, _fuel_cost, _savings, _energy_fuel_gallons, _energy_fuel_cost, _energy_savings;
 *    evstats:fuel_price_<grade>) for history graphs.
 *  - Which vehicle is on which port (lib/detect.js): the chargers' status sensors' plug-ins are matched to the
 *    vehicles' plug sensors by time; the vehicle's charger helper is switched to the port, a port sensor shows
 *    the detected vehicle, and an unclaimed plug-in asks the cars with a refresh button for fresh data.
 *  - Charge estimate per vehicle: minutes / kWh to the target charge at the port's measured kW, the latest
 *    start to be done by the end of the next cheapest rate window, and a "must start before off-peak" flag.
 *  - Config panel + status on the ingress port (7120).
 *
 * Config  /data/config.json (add-on) or ~/.config/ev-stats/config.json   State /data/state.json, rollup.json, fuel.json
 * Usage   node ev_stats.js            node ev_stats.js --once
 */
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const R = require('./lib/rollup');
const F = require('./lib/fuel');
const D = require('./lib/detect');
const { TZ, rateInfo } = require('./lib/tou_rates');

const VERSION = require('./package.json').version;
const DIR = process.env.EV_STATS_DIR || (fs.existsSync('/data/options.json') ? '/data' : path.join(os.homedir(), '.config/ev-stats'));
const CONFIG_PATH = path.join(DIR, 'config.json'), STATE_PATH = path.join(DIR, 'state.json'), ROLLUP_PATH = path.join(DIR, 'rollup.json'), FUEL_PATH = path.join(DIR, 'fuel.json');
const ONCE = process.argv.includes('--once');
const HOUR = R.HOUR, DAY = 86400000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const log = (...a) => { console.log(new Date().toISOString(), ...a); if (state) { state.log.unshift({ at: Date.now(), msg: a.join(' ').slice(0, 300) }); state.log.length = Math.min(state.log.length, 120); } };

// ---------- config ----------
const METRICS = { // key: [unit, icon, label, precision]
  miles: ['mi', 'mdi:road-variant', 'Miles', 1],
  home_energy: ['kWh', 'mdi:ev-station', 'Home charging', 1],
  home_cost: ['USD', 'mdi:cash', 'Home charging cost', 2],
  avg_rate: ['USD/kWh', 'mdi:cash-clock', 'Average rate', 3],
  away_energy: ['kWh', 'mdi:map-marker-distance', 'Away charging (est.)', 1],
  ev_cost: ['USD', 'mdi:cash-multiple', 'EV energy cost', 2],
  other_energy: ['kWh', 'mdi:car-multiple', 'Charger energy not this vehicle', 1],
  other_cost: ['USD', 'mdi:cash-remove', 'Charger cost not this vehicle', 2],
  battery_energy: ['kWh', 'mdi:battery-arrow-down', 'Battery energy used', 1],
  drive_energy: ['kWh', 'mdi:car-electric', 'Driving energy', 1],
  charged_energy: ['kWh', 'mdi:battery-arrow-up', 'Energy charged', 1],
  efficiency: ['mi/kWh', 'mdi:speedometer', 'Efficiency', 2],
  consumption: ['kWh/100mi', 'mdi:gauge', 'Consumption', 1],
  wall_consumption: ['kWh/100mi', 'mdi:gauge-low', 'Wall consumption', 1],
  cost_per_mile: ['USD/mi', 'mdi:cash-fast', 'Cost per mile', 3],
  fuel_gallons: ['gal', 'mdi:gas-station', 'Fuel equivalent', 2],
  fuel_cost: ['USD', 'mdi:gas-station-outline', 'Fuel cost equivalent', 2],
  savings: ['USD', 'mdi:piggy-bank', 'Savings vs fuel', 2],
  savings_pct: ['%', 'mdi:percent', 'Savings percent', 1],
  energy_fuel_gallons: ['gal', 'mdi:gas-station', 'Fuel equivalent (energy)', 2],
  energy_fuel_cost: ['USD', 'mdi:gas-station-outline', 'Fuel cost equivalent (energy)', 2],
  energy_savings: ['USD', 'mdi:piggy-bank-outline', 'Savings vs fuel (energy)', 2],
  energy_mpg: ['mpg', 'mdi:engine', 'Equivalent MPG (energy)', 1],
};
const STAT_KEYS = { miles: ['mi', 'mi'], home_energy: ['home', 'kWh'], home_cost: ['cost', 'USD'], battery_energy: ['pack', 'kWh'], fuel_gallons: ['gal', 'gal'], fuel_cost: ['fuel', 'USD'], savings: ['save', 'USD'], energy_fuel_gallons: ['egal', 'gal'], energy_fuel_cost: ['efuel', 'USD'], energy_savings: ['esave', 'USD'], other_energy: ['other', 'kWh'], other_cost: ['ocost', 'USD'] };
const DEFAULT_VEHICLE = { id: '', name: '', enabled: true, charger_select: '', odometer: '', soc: '', capacity_kwh: 0, capacity_entity: '', charge_efficiency: 0.9, fuel_select: '', mpg_entity: '', fuel_grade: 'regular', mpg: 20, engine_efficiency: 0,
  plug_entity: '', refresh_button: '', charge_limit_entity: '', charge_limit: 80 }; // plug sensor (binary), button to ask the car for fresh data, charge target (% entity or fixed)
// Energy-based fuel equivalent: measured driving kWh/mi -> wheel energy -> gallons an engine would burn for it.
//   kWh per gallon: lower heating value used by the EPA for MPGe (gasoline 33.7 kWh = 115,000 BTU; diesel 37.7 kWh = 128,500 BTU)
//   engine efficiency: tank-to-wheel of a modern engine + transmission over a mixed drive cycle (gasoline ~25 %, diesel ~30 %)
//   ev efficiency: battery-to-wheel (inverter + motor + gearbox) ~88 %; regen share: part of the driving energy that was
//   recovered by regenerative braking and that an engine car would have to burn fuel for (mixed driving ~10 %)
const DEFAULT_ENERGY = { gasoline_kwh_per_gal: 33.7, diesel_kwh_per_gal: 37.7, engine_efficiency_gasoline: 0.25, engine_efficiency_diesel: 0.30, ev_drivetrain_efficiency: 0.88, regen_share: 0.10 };
const DEFAULT_CONFIG = {
  ha_url: 'http://homeassistant.local:8123', ha_token: '', port: 7120,
  poll_minutes: 5, recent_hours: 6, raw_days: 9, backfill_from: '2024-01-01',
  rate_entity: 'sensor.electricity_rate', entity_prefix: 'ev',
  windows: ['1d', '7d', '30d', '365d'],
  metrics: ['miles', 'home_energy', 'home_cost', 'battery_energy', 'efficiency', 'consumption', 'cost_per_mile', 'fuel_gallons', 'fuel_cost', 'savings', 'energy_fuel_gallons', 'energy_fuel_cost', 'energy_savings', 'energy_mpg'],
  chargers: {},   // { North: { power: 'sensor.xxx_power' }, South: {...} } - keys must match the charger helper's options
  vehicles: [],   // DEFAULT_VEHICLE shape, edited in the panel
  away_rate: 0.45, // USD/kWh assumed for charging that did not come from a home charger (DC fast charging)
  energy_model: { ...DEFAULT_ENERGY },
  // A charging session on the assigned port whose battery gain is below match_fraction x wall x efficiency is booked as another
  // vehicle's (other_energy / other_cost). Sessions under min_kwh, or whose largest hour is under min_peak_kwh (thermal trickle),
  // are left alone. lag_hours: how late a sleeping car may report the gain (also the memory of the away-charging estimate).
  session_check: { enabled: true, min_kwh: 3, min_peak_kwh: 4, match_fraction: 0.5, lag_hours: 12 },
  // Which vehicle is on which port: a charger status sensor's plug-in is matched to the vehicle whose plug sensor turned on
  // within [-before, +after] minutes. auto_assign switches the vehicle's charger helper (and its charger history) to the port.
  // An unclaimed plug-in presses the refresh button of every unplugged vehicle that has one, after refresh_after_minutes.
  detection: { enabled: true, auto_assign: true, before_minutes: 3, after_minutes: 15, refresh_after_minutes: 3, lookback_hours: 6 },
  mqtt: { enabled: true },
  statistics: { enabled: true, prefix: 'evstats' },
  fuel: { enabled: true, eia_area: 'R20', eia_area_name: 'Midwest', aaa_state: 'MO', aaa_area: 'Kansas City', poll_hours: 6, history_from: '2024-01-01', entity_prefix: 'fuel_price' },
};
let config = loadJson(CONFIG_PATH, null);
if (!config) { fs.mkdirSync(DIR, { recursive: true }); config = { ...DEFAULT_CONFIG }; saveJson(CONFIG_PATH, config); }
const SUPERVISOR = process.env.SUPERVISOR_TOKEN ? { ha_url: 'http://supervisor/core', ha_token: process.env.SUPERVISOR_TOKEN } : {};
normalizeConfig();
let state = loadJson(STATE_PATH, null) || { assignments: {}, settings: {}, published: {}, backfilled: {}, stats_cursor: {}, fuel_stats_done: {}, last: null, log: [] };
state.log = state.log || []; state.assignments = state.assignments || {}; state.ports = state.ports || {}; state.detect_done = state.detect_done || {}; state.settings = state.settings || {}; state.published = state.published || {}; state.backfilled = state.backfilled || {}; state.stats_cursor = state.stats_cursor || {}; state.fuel_stats_done = state.fuel_stats_done || {};
let rollup = loadJson(ROLLUP_PATH, {});   // { vehicleId: { hourIdx: row } }
let fuel = loadJson(FUEL_PATH, { weekly: {}, weekly_at: 0, daily: {}, aaa: null, aaa_at: 0 });
let rollupDirty = false;

function normalizeConfig() {
  config = { ...DEFAULT_CONFIG, ...config, ...SUPERVISOR, mqtt: { ...DEFAULT_CONFIG.mqtt, ...(config.mqtt || {}) }, statistics: { ...DEFAULT_CONFIG.statistics, ...(config.statistics || {}) }, fuel: { ...DEFAULT_CONFIG.fuel, ...(config.fuel || {}) }, energy_model: { ...DEFAULT_ENERGY, ...(config.energy_model || {}) }, session_check: { ...DEFAULT_CONFIG.session_check, ...(config.session_check || {}) }, detection: { ...DEFAULT_CONFIG.detection, ...(config.detection || {}) } };
  const em = config.energy_model, clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };
  const dc = config.detection; dc.enabled = dc.enabled !== false; dc.auto_assign = dc.auto_assign !== false; dc.before_minutes = clamp(dc.before_minutes, 0, 60, 3); dc.after_minutes = clamp(dc.after_minutes, 1, 120, 15); dc.refresh_after_minutes = clamp(dc.refresh_after_minutes, 0, 60, 3); dc.lookback_hours = clamp(dc.lookback_hours, 1, 48, 6);
  const sc = config.session_check; sc.enabled = sc.enabled !== false; sc.min_kwh = clamp(sc.min_kwh, 0, 100, 3); sc.min_peak_kwh = clamp(sc.min_peak_kwh, 0, 50, 4); sc.match_fraction = clamp(sc.match_fraction, 0.05, 1, 0.5); sc.lag_hours = Math.round(clamp(sc.lag_hours, 1, 48, 12));
  em.gasoline_kwh_per_gal = clamp(em.gasoline_kwh_per_gal, 20, 50, DEFAULT_ENERGY.gasoline_kwh_per_gal); em.diesel_kwh_per_gal = clamp(em.diesel_kwh_per_gal, 20, 50, DEFAULT_ENERGY.diesel_kwh_per_gal);
  em.engine_efficiency_gasoline = clamp(em.engine_efficiency_gasoline, 0.05, 0.6, DEFAULT_ENERGY.engine_efficiency_gasoline); em.engine_efficiency_diesel = clamp(em.engine_efficiency_diesel, 0.05, 0.6, DEFAULT_ENERGY.engine_efficiency_diesel);
  em.ev_drivetrain_efficiency = clamp(em.ev_drivetrain_efficiency, 0.5, 1, DEFAULT_ENERGY.ev_drivetrain_efficiency); em.regen_share = clamp(em.regen_share, 0, 0.5, DEFAULT_ENERGY.regen_share);
  config.poll_minutes = Math.max(1, Number(config.poll_minutes) || 5);
  config.recent_hours = Math.min(48, Math.max(2, Number(config.recent_hours) || 6));
  config.raw_days = Math.min(30, Math.max(1, Number(config.raw_days) || 9));
  config.entity_prefix = slug(config.entity_prefix || 'ev');
  config.fuel.entity_prefix = slug(config.fuel.entity_prefix || 'fuel_price');
  config.fuel.poll_hours = Math.max(1, Number(config.fuel.poll_hours) || 6);
  config.statistics.prefix = slug(config.statistics.prefix || 'evstats');
  config.windows = [...new Set((config.windows || []).map((w) => String(w).trim().toLowerCase()).filter(windowRange))];
  if (!config.windows.length) config.windows = [...DEFAULT_CONFIG.windows];
  config.metrics = (config.metrics || []).filter((m) => METRICS[m]); if (!config.metrics.length) config.metrics = [...DEFAULT_CONFIG.metrics];
  config.vehicles = (config.vehicles || []).map((v) => ({ ...DEFAULT_VEHICLE, ...v, id: slug(v.id || v.name || 'ev'), capacity_kwh: Number(v.capacity_kwh) || 0, charge_efficiency: Math.min(1, Math.max(0.5, Number(v.charge_efficiency) || 0.9)), mpg: Number(v.mpg) || 20, fuel_grade: F.GRADES.includes(v.fuel_grade) ? v.fuel_grade : 'regular', engine_efficiency: clamp(v.engine_efficiency, 0.05, 0.6, 0), charge_limit: clamp(v.charge_limit, 1, 100, 80) }));
  config.chargers = Object.fromEntries(Object.entries(config.chargers || {}).filter(([k, v]) => k && v && v.power).map(([k, v]) => [k.trim(), { power: String(v.power).trim(), status: String(v.status || '').trim(), max_kw: clamp(v.max_kw, 0, 100, 0) }]));
}
function slug(s) { return String(s || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase(); }
function loadJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }
function saveJson(p, v) { fs.mkdirSync(path.dirname(p), { recursive: true }); const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(v)); fs.renameSync(tmp, p); try { fs.chmodSync(p, 0o600); } catch { /* ignore */ } }
const saveState = () => saveJson(STATE_PATH, state);
const saveConfig = () => saveJson(CONFIG_PATH, config);
const saveFuel = () => saveJson(FUEL_PATH, fuel);
const saveRollup = () => { if (rollupDirty) { saveJson(ROLLUP_PATH, rollup); rollupDirty = false; } };

// ---------- Home Assistant ----------
async function ha(method, p, body) {
  const r = await fetch(config.ha_url.replace(/\/$/, '') + p, { method, headers: { Authorization: 'Bearer ' + config.ha_token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HA ${method} ${p}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const t = await r.text(); try { return JSON.parse(t); } catch { return t; }
}
const haStates = () => ha('GET', '/api/states');
const haService = (domain, service, data) => ha('POST', `/api/services/${domain}/${service}`, data);
let haTz = 'America/Chicago', tz = new TZ(haTz);
async function haTimeZone() { try { const t = (await ha('GET', '/api/config')).time_zone; if (t && t !== haTz) { haTz = t; tz = new TZ(t); } } catch { /* keep */ } }

function haWS() {
  const url = (config.ha_url.startsWith('http://supervisor') ? 'ws://supervisor/core/websocket' : config.ha_url.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/websocket');
  const ws = new WebSocket(url);
  let id = 0; const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: config.ha_token }));
      else if (m.type === 'auth_ok') resolve();
      else if (m.type === 'auth_invalid') reject(new Error('HA auth invalid'));
      else if (m.type === 'result' && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.success ? res(m.result) : rej(new Error(JSON.stringify(m.error))); }
    };
    ws.onerror = (e) => reject(new Error('HA websocket error ' + (e.message || '')));
    ws.onclose = () => { for (const { rej } of pending.values()) rej(new Error('HA websocket closed')); pending.clear(); };
  });
  return { ready, call: (msg) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, ...msg })); }), close: () => ws.close() };
}
async function withWS(fn) { const w = haWS(); await w.ready; try { return await fn(w); } finally { w.close(); } }

/** Raw history [fromMs, toMs) -> { entity_id: [{t, v}] } (numeric samples; the state at fromMs comes first). */
async function rawHistory(w, entityIds, fromMs, toMs) {
  const out = {}; const ids = [...new Set(entityIds.filter(Boolean))];
  if (!ids.length) return out;
  const r = await w.call({ type: 'history/history_during_period', start_time: new Date(fromMs).toISOString(), end_time: new Date(toMs).toISOString(), entity_ids: ids, minimal_response: true, no_attributes: true, significant_changes_only: false });
  for (const id of ids) out[id] = R.samples(r[id] || []);
  return out;
}
/** Raw history as state strings: { entity_id: [{s, lu}] } (the state at fromMs comes first). */
async function rawStates(w, entityIds, fromMs, toMs) {
  const ids = [...new Set(entityIds.filter(Boolean))]; if (!ids.length) return {};
  const r = await w.call({ type: 'history/history_during_period', start_time: new Date(fromMs).toISOString(), end_time: new Date(toMs).toISOString(), entity_ids: ids, minimal_response: true, no_attributes: true, significant_changes_only: false });
  const out = {}; for (const id of ids) out[id] = r[id] || []; return out;
}
async function hourlyStats(w, ids, fromMs, toMs, types) {
  const out = {}; ids = [...new Set(ids.filter(Boolean))];
  if (!ids.length) return out;
  for (let a = fromMs; a < toMs; a += 90 * DAY) {
    const r = await w.call({ type: 'recorder/statistics_during_period', statistic_ids: ids, period: 'hour', types, start_time: new Date(a).toISOString(), end_time: new Date(Math.min(toMs, a + 90 * DAY)).toISOString() });
    for (const id of ids) out[id] = (out[id] || []).concat(r[id] || []);
  }
  return out;
}

// ---------- rates / assignments / vehicle settings ----------
let plans = null;
async function loadPlans(states) {
  const s = states.find((x) => x.entity_id === config.rate_entity);
  const p = s && s.attributes && s.attributes.plans;
  if (Array.isArray(p) && p.length) plans = p; else if (!plans) log(`no rate plans on ${config.rate_entity}; charging cost will be 0`);
}
const rateAt = (h) => { if (!plans) return null; const ri = rateInfo(tz.parts(h * HOUR + 1800000), plans); return ri ? ri.rate : null; };

function chargerOf(v, states) {
  const s = states.find((x) => x.entity_id === v.charger_select);
  if (!s) return null;
  const want = String(s.state).trim().toLowerCase();
  return Object.keys(config.chargers).find((k) => k.toLowerCase() === want) || null;
}
function noteAssignment(v, charger, nowMs) {
  const list = state.assignments[v.id] || (state.assignments[v.id] = []);
  const cur = list.length ? list[list.length - 1].charger : undefined;
  if (cur === charger) return false;
  list.push({ at: list.length ? Math.max(nowMs, list[list.length - 1].at + 1) : 0, charger }); // the first assignment counts from the beginning of time (backfill); later ones stay in order
  log(`${v.name}: charger -> ${charger || 'none'}`);
  return true;
}
const stateOf = (states, id) => { const s = id && states.find((x) => x.entity_id === id); return s ? s.state : null; };

/**
 * Who is on which port. Reads the last lookback_hours of the chargers' status sensors and the vehicles' plug sensors,
 * matches plug-in events (lib/detect.js), remembers the result per port (state.ports), switches the vehicle's charger
 * helper when auto_assign is on, and asks unplugged vehicles with a refresh button for fresh data when a plug-in
 * stays unclaimed. `states` is updated in place when a helper is switched so the rest of the poll sees it.
 */
async function detect(w, states, nowMs) {
  const dc = config.detection; if (!dc.enabled) return;
  const chargers = Object.entries(config.chargers).filter(([, c]) => c.status); if (!chargers.length) return;
  const vehicles = config.vehicles.filter((v) => v.enabled && v.plug_entity);
  const hist = await rawStates(w, [...chargers.map(([, c]) => c.status), ...vehicles.map((v) => v.plug_entity)], nowMs - dc.lookback_hours * HOUR, nowMs);
  const cTr = {}, vTr = {};
  for (const [name, c] of chargers) cTr[name] = D.transitions(hist[c.status], D.chargerPlugged);
  for (const v of vehicles) vTr[v.id] = D.transitions(hist[v.plug_entity], D.binaryOn);
  const events = D.matchPlugins(cTr, vTr, dc.before_minutes * 60000, dc.after_minutes * 60000);
  for (const [name, c] of chargers) {
    const last = D.lastState(hist[c.status]); const plugged = last ? D.chargerPlugged(last.s) : null;
    const port = state.ports[name] || (state.ports[name] = {});
    Object.assign(port, { status: last ? last.s : null, plugged, status_entity: c.status, updated: new Date(nowMs).toISOString() });
    if (plugged === false) { Object.assign(port, { vehicle: null, vehicle_name: null, confidence: null, since: last ? new Date(last.t).toISOString() : null }); continue; }
    const mine = events.filter((e) => e.charger === name); const ev = mine[mine.length - 1];
    if (!ev) { // plugged in since before the lookback window: keep what we knew, else trust a vehicle whose helper and plug sensor both agree
      if (!port.vehicle) { const agree = vehicles.filter((v) => D.binaryOn(stateOf(states, v.plug_entity)) && chargerOf(v, states) === name); if (agree.length === 1) Object.assign(port, { vehicle: agree[0].id, vehicle_name: agree[0].name, confidence: 'helper', since: last ? new Date(last.t).toISOString() : null }); }
      continue;
    }
    const key = `${name}@${ev.at}`;
    if (ev.vehicle) {
      const v = config.vehicles.find((x) => x.id === ev.vehicle);
      Object.assign(port, { vehicle: v.id, vehicle_name: v.name, confidence: ev.ambiguous ? 'medium' : 'high', since: new Date(ev.at).toISOString(), plug_delay_s: Math.round(ev.delta_ms / 1000) });
      if (state.detect_done[key] === v.id) continue;
      state.detect_done[key] = v.id;
      log(`${name}: ${v.name} plugged in at ${new Date(ev.at).toISOString()} (its plug sensor followed ${Math.round(ev.delta_ms / 1000)} s later${ev.alternatives.length ? '; unclaimed alternative ' + ev.alternatives.map((a) => `${a.vehicle} ${Math.round(a.delta_ms / 1000)} s`).join(', ') + (ev.ambiguous ? ' - ambiguous' : '') : ''})`);
      if (!dc.auto_assign || chargerOf(v, states) === name) continue;
      const sel = states.find((s) => s.entity_id === v.charger_select); const opt = sel && (sel.attributes.options || []).find((o) => String(o).toLowerCase() === name.toLowerCase());
      if (!opt) { log(`${v.name}: ${v.charger_select || 'no charger helper'} has no option "${name}"; not switched`); continue; }
      try { await haService('input_select', 'select_option', { entity_id: v.charger_select, option: opt }); sel.state = opt; noteAssignment(v, name, ev.at); log(`${v.name}: charger helper -> ${opt} (detected on plug-in)`); }
      catch (e) { log(`${v.name}: could not switch ${v.charger_select}: ${e.message}`); }
    } else {
      Object.assign(port, { vehicle: null, vehicle_name: null, confidence: null, since: new Date(ev.at).toISOString(), candidates: ev.candidates });
      const age = nowMs - ev.at;
      if (state.detect_done[key] || age < dc.refresh_after_minutes * 60000 || age > HOUR) continue;
      state.detect_done[key] = 'refresh';
      for (const v of vehicles) {
        if (!v.refresh_button || D.binaryOn(stateOf(states, v.plug_entity))) continue;
        try { await haService('button', 'press', { entity_id: v.refresh_button }); log(`${name}: plug-in at ${new Date(ev.at).toISOString()} unclaimed; asked ${v.name} for fresh data (${v.refresh_button})`); }
        catch (e) { log(`${v.name}: refresh failed: ${e.message}`); }
      }
    }
  }
  for (const k of Object.keys(state.detect_done)) if (nowMs - +k.split('@')[1] > 2 * DAY) delete state.detect_done[k];
}
const chargerAt = (v) => { const list = state.assignments[v.id] || []; return (h) => { const t = h * HOUR; let c = null; for (const a of list) { if (a.at <= t) c = a.charger; else break; } return c; }; };

function vehicleSettings(v, states) {
  const st = (id) => { const s = states.find((x) => x.entity_id === id); return s ? s.state : null; };
  let grade = v.fuel_grade, mpg = v.mpg, cap = v.capacity_kwh;
  if (v.fuel_select) { const g = F.GRADES.find((k) => String(st(v.fuel_select) || '').toLowerCase().startsWith(k.slice(0, 3))); if (g) grade = g; }
  if (v.mpg_entity) { const n = Number(st(v.mpg_entity)); if (n > 0) mpg = n; }
  if (v.capacity_entity) { const n = Number(st(v.capacity_entity)); if (n > 0) cap = n; }
  return { grade, mpg, capacity: cap, energy: energyFor(v, grade) };
}
/** Parameters of the energy-based fuel equivalent for a vehicle / grade (diesel has its own energy content and engine efficiency). */
function energyFor(v, grade) {
  const em = config.energy_model, diesel = grade === 'diesel';
  return { kwhPerGal: diesel ? em.diesel_kwh_per_gal : em.gasoline_kwh_per_gal, engineEff: v.engine_efficiency || (diesel ? em.engine_efficiency_diesel : em.engine_efficiency_gasoline), evEff: em.ev_drivetrain_efficiency, regen: em.regen_share, fallbackKwhPerMile: R.driveRate(rollup[v.id] || {}) };
}

// ---------- rollup ----------
async function recompute(w, v, set, fromMs, toMs) {
  const chargerIds = Object.values(config.chargers).map((c) => c.power);
  const raw = await rawHistory(w, [v.odometer, v.soc, ...chargerIds], fromMs, toMs);
  const power = {}; for (const [name, c] of Object.entries(config.chargers)) power[name] = raw[c.power] || [];
  const rows = R.rowsFromRaw({ odo: raw[v.odometer] || [], soc: raw[v.soc] || [], power, capacityKwh: set.capacity, efficiency: v.charge_efficiency, fromMs, toMs, chargerAt: chargerAt(v), rateAt });
  merge(v, rows);
}
async function backfill(w, v, set, fromMs, rawFromMs, toMs) {
  if (fromMs < rawFromMs) {
    const chargerIds = Object.values(config.chargers).map((c) => c.power);
    const st = await hourlyStats(w, [v.odometer, v.soc, ...chargerIds], fromMs, rawFromMs, ['mean', 'change']);
    const power = {}; for (const [name, c] of Object.entries(config.chargers)) power[name] = st[c.power] || [];
    const rows = R.rowsFromStats({ stats: { odo: st[v.odometer] || [], soc: st[v.soc] || [], power }, capacityKwh: set.capacity, efficiency: v.charge_efficiency, fromMs, toMs: rawFromMs, chargerAt: chargerAt(v), rateAt });
    merge(v, rows);
    log(`${v.name}: backfilled ${Object.keys(rows).length} hours from statistics (${new Date(fromMs).toISOString().slice(0, 10)} .. ${new Date(rawFromMs).toISOString().slice(0, 10)})`);
  }
  for (let a = Math.max(fromMs, rawFromMs); a < toMs; a += 3 * DAY) await recompute(w, v, set, a, Math.min(toMs, a + 3 * DAY));
  log(`${v.name}: rebuilt ${Math.round((toMs - Math.max(fromMs, rawFromMs)) / HOUR)} hours from raw history`);
}
function merge(v, rows) {
  const cur = rollup[v.id] || (rollup[v.id] = {});
  let low = null;
  for (const [h, full] of Object.entries(rows)) {
    const r = R.compact(full); const old = cur[h];
    if (!old || JSON.stringify(old) !== JSON.stringify(r)) { cur[h] = r; rollupDirty = true; if (low == null || +h < low) low = +h; }
  }
  if (low != null) state.stats_cursor[v.id] = Math.min(state.stats_cursor[v.id] ?? low, low);
}
/** Replace a vehicle's charger timeline ([{from: 'YYYY-MM-DD' | '', charger}]) - the first entry counts from the beginning. */
function setAssignments(v, list) {
  const names = Object.keys(config.chargers);
  const out = list.map((a) => { const [y, m, d] = String(a.from || '').split('-').map(Number); return { at: y ? localMs(y, m, d) : 0, charger: names.find((n) => n.toLowerCase() === String(a.charger || '').toLowerCase()) || null }; }).sort((a, b) => a.at - b.at);
  if (out.length) out[0].at = 0;
  state.assignments[v.id] = out; saveState();
}
/** The vehicle's latest charging sessions (newest first) with the charger that was assigned and the match verdict. */
function sessionList(v, limit = 25) {
  const at = chargerAt(v), eff = v.charge_efficiency || 0.9;
  return R.sessions(rollup[v.id] || {}, config.session_check.lag_hours).slice(-limit).reverse().map((s) => ({
    start: new Date(s.start * HOUR).toISOString(), end: new Date((s.end + 1) * HOUR).toISOString(), hours: s.hours, charger: at(s.start),
    wall_kwh: s.wall, cost: +s.cost.toFixed(2), battery_kwh: s.nosoc ? null : s.gained, ratio: s.nosoc || !s.wall ? null : +(s.gained / (s.wall * eff)).toFixed(2), peak_kwh: s.peak,
    verdict: s.other ? 'other' : s.nosoc ? 'unknown' : 'this',
  }));
}
/** Per charger port: who was assigned to it over time, from every vehicle's charger history (newest first). */
function portTimeline() {
  const out = {};
  for (const name of Object.keys(config.chargers)) out[name] = [];
  for (const v of config.vehicles) {
    const list = state.assignments[v.id] || [];
    list.forEach((a, i) => { if (a.charger && out[a.charger]) out[a.charger].push({ vehicle: v.name, from: a.at ? new Date(a.at).toISOString() : null, to: i + 1 < list.length ? new Date(list[i + 1].at).toISOString() : null }); });
  }
  for (const list of Object.values(out)) list.sort((a, b) => (b.from || '') < (a.from || '') ? -1 : 1);
  return out;
}
function earliestHour(ids) { let e = null; for (const id of ids) for (const h of Object.keys(rollup[id] || {})) if (e == null || +h < e) e = +h; return e; }

// ---------- windows ----------
function windowRange(key, nowMs = Date.now()) {
  const nowH = R.hourOf(nowMs); const m = /^(\d+)d$/.exec(key);
  if (m) return +m[1] > 0 ? { from: nowH - +m[1] * 24 + 1, to: nowH, label: `${m[1]}d` } : null;
  const p = tz.parts(nowMs);
  const startOf = (y, mo, d) => R.hourOf(localMs(y, mo, d));
  if (key === 'today') return { from: startOf(p.y, p.m, p.d), to: nowH, label: 'today' };
  if (key === 'mtd') return { from: startOf(p.y, p.m, 1), to: nowH, label: 'month to date' };
  if (key === 'ytd') return { from: startOf(p.y, 1, 1), to: nowH, label: 'year to date' };
  if (key === 'week') { const back = (p.wd + 7) % 7; return { from: R.hourOf(localMs(p.y, p.m, p.d) - back * DAY), to: nowH, label: 'this week' }; }
  return null;
}
/** UTC ms of local midnight of y-m-d in the HA time zone. */
function localMs(y, m, d) {
  let t = Date.UTC(y, m - 1, d, 12);
  for (let i = 0; i < 3; i++) { const p = tz.parts(t); const off = Date.UTC(p.y, p.m - 1, p.d, p.h) - Math.floor(t / 60000) * 60000; t -= off; if (!off) break; }
  const p = tz.parts(t); return t - p.h * HOUR - (Math.floor(t / 60000) % 60) * 60000;
}
const dayKey = (h) => tz.parts(h * HOUR + 1800000).ds;

function priceSeries() { return F.priceSeries(fuel.weekly, fuel.daily); }
function metricsFor(v, set, series, nowMs) {
  const rows = rollup[v.id] || {}; const out = {};
  const priceAt = (h, grade) => { const p = series.price(dayKey(h), grade); return p ? p.price : null; };
  for (const key of config.windows) {
    const wr = windowRange(key, nowMs); if (!wr) continue;
    const m = R.windowMetrics(rows, wr.from, wr.to, { mpg: set.mpg, grade: set.grade, priceAt, efficiency: v.charge_efficiency, awayRate: config.away_rate, energy: set.energy });
    out[key] = { ...m, window: key, window_label: wr.label, from: new Date(wr.from * HOUR).toISOString(), to: new Date((wr.to + 1) * HOUR).toISOString() };
  }
  return out;
}

// ---------- publishing (MQTT discovery) ----------
const mqttPub = (topic, payload, retain = true) => haService('mqtt', 'publish', { topic, payload: typeof payload === 'string' ? payload : JSON.stringify(payload), retain });
const discoveryFresh = new Set(); // devices whose discovery this process already sent

async function publishVehicle(v, set, metrics, live) {
  const pre = config.entity_prefix, base = `ev/stats/${v.id}`;
  const comps = {};
  for (const key of config.windows) for (const m of config.metrics) {
    const [unit, icon, label, prec] = METRICS[m];
    comps[`${m}_${key}`] = { platform: 'sensor', name: `${label} ${key}`, unique_id: `ev_stats_${v.id}_${m}_${key}`, default_entity_id: `sensor.${pre}_${v.id}_${m}_${key}`, state_topic: `${base}/${key}`, value_template: `{{ value_json.${m} if value_json.${m} is not none else 'unknown' }}`, json_attributes_topic: `${base}/${key}`, unit_of_measurement: unit, icon, state_class: 'measurement', suggested_display_precision: prec };
  }
  comps.charger = { platform: 'sensor', name: 'Charger', unique_id: `ev_stats_${v.id}_charger`, default_entity_id: `sensor.${pre}_${v.id}_charger`, state_topic: `${base}/now`, value_template: "{{ value_json.charger or 'none' }}", json_attributes_topic: `${base}/now`, icon: 'mdi:ev-plug-ccs1' };
  comps.plugged = { platform: 'binary_sensor', name: 'Plugged in', unique_id: `ev_stats_${v.id}_plugged`, default_entity_id: `binary_sensor.${pre}_${v.id}_plugged`, state_topic: `${base}/now`, value_template: "{{ 'ON' if value_json.plugged else 'OFF' }}", device_class: 'plug', availability_topic: `${base}/now`, availability_template: "{{ 'online' if value_json.plugged is not none else 'offline' }}" };
  comps.charge_time_to_target = { platform: 'sensor', name: 'Charge time to target', unique_id: `ev_stats_${v.id}_charge_time_to_target`, default_entity_id: `sensor.${pre}_${v.id}_charge_time_to_target`, state_topic: `${base}/now`, value_template: "{{ value_json.charge_minutes if value_json.charge_minutes is not none else 'None' }}", json_attributes_topic: `${base}/now`, unit_of_measurement: 'min', device_class: 'duration', icon: 'mdi:timer-sand', state_class: 'measurement' };
  comps.charge_needed = { platform: 'sensor', name: 'Charge needed to target', unique_id: `ev_stats_${v.id}_charge_needed`, default_entity_id: `sensor.${pre}_${v.id}_charge_needed`, state_topic: `${base}/now`, value_template: "{{ value_json.charge_needed_kwh if value_json.charge_needed_kwh is not none else 'None' }}", unit_of_measurement: 'kWh', device_class: 'energy', icon: 'mdi:battery-charging-medium', state_class: 'measurement', suggested_display_precision: 1 };
  comps.charge_latest_start = { platform: 'sensor', name: 'Charge latest start', unique_id: `ev_stats_${v.id}_charge_latest_start`, default_entity_id: `sensor.${pre}_${v.id}_charge_latest_start`, state_topic: `${base}/now`, value_template: "{{ value_json.charge_latest_start if value_json.charge_latest_start else 'None' }}", device_class: 'timestamp', icon: 'mdi:clock-start' };
  comps.charge_start_early = { platform: 'binary_sensor', name: 'Charge must start before off-peak', unique_id: `ev_stats_${v.id}_charge_start_early`, default_entity_id: `binary_sensor.${pre}_${v.id}_charge_start_early`, state_topic: `${base}/now`, value_template: "{{ 'ON' if value_json.charge_start_early else 'OFF' }}", icon: 'mdi:clock-alert-outline', json_attributes_topic: `${base}/now` };
  comps.fuel_price = { platform: 'sensor', name: 'Fuel price equivalent', unique_id: `ev_stats_${v.id}_fuel_price`, default_entity_id: `sensor.${pre}_${v.id}_fuel_price`, state_topic: `${base}/now`, value_template: "{{ value_json.fuel_price if value_json.fuel_price is not none else 'unknown' }}", unit_of_measurement: 'USD/gal', icon: 'mdi:gas-station', state_class: 'measurement', suggested_display_precision: 3 };
  const dev = `ev_stats_${v.id}`;
  if (!discoveryFresh.has(dev) || JSON.stringify(Object.keys(comps)) !== JSON.stringify(state.published[dev] || [])) {
    const payload = { device: { identifiers: [dev], name: v.name, manufacturer: 'geeojr/ha-addons', model: 'EV Stats add-on', sw_version: VERSION }, origin: { name: 'ev-stats', sw_version: VERSION, support_url: 'https://github.com/geeojr/ha-addons' }, components: { ...comps } };
    for (const k of state.published[dev] || []) if (!comps[k]) payload.components[k] = { platform: 'sensor' }; // removes a component that is no longer configured
    await mqttPub(`homeassistant/device/${dev}/config`, payload);
    state.published[dev] = Object.keys(comps); discoveryFresh.add(dev);
  }
  for (const [key, m] of Object.entries(metrics)) await mqttPub(`${base}/${key}`, { ...m, vehicle: v.name, charger: live.charger, fuel_grade: set.grade, mpg_equivalent: set.mpg, capacity_kwh: set.capacity, charge_efficiency: v.charge_efficiency, away_rate: config.away_rate, kwh_per_gallon: set.energy.kwhPerGal, engine_efficiency: set.energy.engineEff, ev_drivetrain_efficiency: set.energy.evEff, regen_share: set.energy.regen, updated: new Date().toISOString() });
  await mqttPub(`${base}/now`, live);
}
/** One "Chargers" device: sensor.<prefix>_charger_<port>_vehicle = detected vehicle name | unknown (plugged, nobody claimed it) | none. */
async function publishPorts() {
  const pre = config.entity_prefix, dev = 'ev_stats_chargers', comps = {};
  const names = Object.keys(config.chargers).filter((n) => config.chargers[n].status); if (!names.length) return;
  for (const n of names) comps[slug(n)] = { platform: 'sensor', name: `${n} vehicle`, unique_id: `ev_stats_charger_${slug(n)}_vehicle`, default_entity_id: `sensor.${pre}_charger_${slug(n)}_vehicle`, state_topic: `ev/stats/ports/${slug(n)}`, value_template: "{{ value_json.vehicle_name if value_json.vehicle_name else ('unknown' if value_json.plugged else 'none') }}", json_attributes_topic: `ev/stats/ports/${slug(n)}`, icon: 'mdi:ev-station' };
  if (!discoveryFresh.has(dev) || JSON.stringify(Object.keys(comps)) !== JSON.stringify(state.published[dev] || [])) {
    const payload = { device: { identifiers: [dev], name: 'Chargers', manufacturer: 'geeojr/ha-addons', model: 'EV Stats add-on', sw_version: VERSION }, origin: { name: 'ev-stats', sw_version: VERSION, support_url: 'https://github.com/geeojr/ha-addons' }, components: { ...comps } };
    for (const k of state.published[dev] || []) if (!comps[k]) payload.components[k] = { platform: 'sensor' };
    await mqttPub(`homeassistant/device/${dev}/config`, payload);
    state.published[dev] = Object.keys(comps); discoveryFresh.add(dev);
  }
  for (const n of names) await mqttPub(`ev/stats/ports/${slug(n)}`, { port: n, ...(state.ports[n] || { plugged: null, vehicle: null, vehicle_name: null }) });
}
async function publishFuel(prices) {
  const pre = config.fuel.entity_prefix, dev = 'ev_stats_fuel', comps = {};
  for (const g of F.GRADES) comps[g] = { platform: 'sensor', name: F.GRADE_LABEL[g], unique_id: `ev_stats_fuel_${g}`, default_entity_id: `sensor.${pre}_${g}`, state_topic: 'ev/fuel/prices', value_template: `{{ value_json.${g}.price if value_json.${g} is defined and value_json.${g}.price is not none else 'unknown' }}`, json_attributes_topic: 'ev/fuel/prices', json_attributes_template: `{{ value_json.${g} | tojson }}`, unit_of_measurement: 'USD/gal', icon: g === 'diesel' ? 'mdi:truck' : 'mdi:gas-station', state_class: 'measurement', suggested_display_precision: 3 };
  if (!discoveryFresh.has(dev) || JSON.stringify(Object.keys(comps)) !== JSON.stringify(state.published[dev] || [])) {
    await mqttPub(`homeassistant/device/${dev}/config`, { device: { identifiers: [dev], name: 'Fuel prices', manufacturer: 'geeojr/ha-addons', model: 'EV Stats add-on', sw_version: VERSION }, origin: { name: 'ev-stats', sw_version: VERSION, support_url: 'https://github.com/geeojr/ha-addons' }, components: comps });
    state.published[dev] = Object.keys(comps); discoveryFresh.add(dev);
  }
  await mqttPub('ev/fuel/prices', prices);
}

// ---------- fuel prices ----------
async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,*/*' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
}
async function refreshFuel(force) {
  if (!config.fuel.enabled) return;
  const now = Date.now();
  if (force || now - (fuel.weekly_at || 0) > 24 * HOUR) {
    try {
      const series = F.EIA_SERIES(config.fuel.eia_area); const weekly = {};
      for (const g of F.GRADES) { weekly[g] = F.parseEia(await fetchText(F.eiaUrl(series[g]))).filter((x) => x[0] >= (config.fuel.history_from || '2000-01-01')); if (!weekly[g].length) throw new Error(`EIA ${series[g]}: no rows parsed`); }
      fuel.weekly = weekly; fuel.weekly_at = now; fuel.eia_error = null;
      log(`EIA weekly prices (${config.fuel.eia_area_name || config.fuel.eia_area}): latest week ${weekly.regular[weekly.regular.length - 1][0]} regular $${weekly.regular[weekly.regular.length - 1][1]}`);
    } catch (e) { fuel.eia_error = e.message; fuel.weekly_at = now - 24 * HOUR + 2 * HOUR; log('EIA fetch failed:', e.message); } // retry in 2 h
  }
  if (force || now - (fuel.aaa_at || 0) > config.fuel.poll_hours * HOUR) {
    try {
      const a = F.parseAaa(await fetchText(F.aaaUrl(config.fuel.aaa_state)));
      const want = String(config.fuel.aaa_area || '').toLowerCase();
      const areaName = want ? Object.keys(a.areas).find((k) => k.toLowerCase().startsWith(want)) : null;
      const prices = areaName ? a.areas[areaName] : a.state ? a.state.prices : null;
      if (!prices) throw new Error(`AAA: no prices for ${config.fuel.aaa_area || config.fuel.aaa_state}`);
      fuel.aaa = { at: now, as_of: a.as_of, area: areaName || (a.state && a.state.name), state_name: a.state && a.state.name, state: a.state && a.state.prices, area_prices: prices, national: a.national, areas: Object.keys(a.areas) };
      fuel.aaa_at = now;
      const day = tz.parts(now).ds; const snap = { source: 'aaa', area: fuel.aaa.area };
      for (const g of F.GRADES) if (prices[g] && prices[g].current != null) snap[g] = prices[g].current;
      fuel.daily[day] = snap;
      log(`AAA ${fuel.aaa.area}: regular $${prices.regular && prices.regular.current} premium $${prices.premium && prices.premium.current} diesel $${prices.diesel && prices.diesel.current}`);
    } catch (e) { fuel.aaa_error = e.message; fuel.aaa_at = now - config.fuel.poll_hours * HOUR + HOUR; log('AAA fetch failed:', e.message); }
  }
  saveFuel();
}
function fuelSnapshot() {
  const series = priceSeries(); const today = tz.parts(Date.now()).ds; const out = { updated: new Date().toISOString(), area: fuel.aaa && fuel.aaa.area, as_of: fuel.aaa && fuel.aaa.as_of, national_regular: fuel.aaa && fuel.aaa.national, eia_area: config.fuel.eia_area_name || config.fuel.eia_area };
  for (const g of F.GRADES) {
    const p = series.price(today, g); const a = fuel.aaa && fuel.aaa.area_prices && fuel.aaa.area_prices[g]; const s = fuel.aaa && fuel.aaa.state && fuel.aaa.state[g]; const w = (fuel.weekly[g] || []).slice(-1)[0];
    out[g] = { price: p ? p.price : null, source: p ? p.source : null, as_of: p ? p.as_of : null, grade: F.GRADE_LABEL[g], area: fuel.aaa && fuel.aaa.area, yesterday: a && a.yesterday, week_ago: a && a.week_ago, month_ago: a && a.month_ago, year_ago: a && a.year_ago, state_avg: s && s.current, state_name: fuel.aaa && fuel.aaa.state_name, eia_weekly: w ? w[1] : null, eia_week_of: w ? w[0] : null, eia_area: out.eia_area };
  }
  return out;
}

// ---------- long-term statistics ----------
async function importVehicleStats(w, v, set, series) {
  if (!config.statistics.enabled) return;
  const rows = rollup[v.id] || {}; const hours = Object.keys(rows).map(Number).sort((a, b) => a - b);
  if (!hours.length) return;
  const e = set.energy, gpm = R.gallonsPerMile(e.fallbackKwhPerMile, e) || 0; // vehicle-wide measured rate applied to every hour's miles
  const settingKey = `v2|${set.grade}|${set.mpg}|${config.away_rate}|${v.charge_efficiency}|${gpm.toFixed(5)}`;
  if (state.settings[v.id] !== settingKey) { state.settings[v.id] = settingKey; state.stats_cursor[v.id] = hours[0]; }
  const from = state.stats_cursor[v.id]; if (from == null) return;
  const per = {}; for (const k of Object.keys(STAT_KEYS)) per[k] = [];
  const sums = {}; for (const k of Object.keys(STAT_KEYS)) sums[k] = 0;
  for (const h of hours) {
    const r = R.expand(rows[h]); const p = series.price(dayKey(h), set.grade); const gal = set.mpg > 0 ? r.mi / set.mpg : 0; const fuelCost = p ? gal * p.price : 0;
    const egal = gpm * r.mi, efuel = p ? egal * p.price : 0, evCost = r.cost + r.away / (v.charge_efficiency || 0.9) * config.away_rate;
    const vals = { miles: r.mi, home_energy: r.home, home_cost: r.cost, battery_energy: r.pack, fuel_gallons: gal, fuel_cost: fuelCost, savings: fuelCost - evCost, energy_fuel_gallons: egal, energy_fuel_cost: efuel, energy_savings: efuel - evCost, other_energy: r.other, other_cost: r.ocost };
    for (const k of Object.keys(STAT_KEYS)) { sums[k] += vals[k]; if (h >= from) per[k].push({ start: new Date(h * HOUR).toISOString(), state: +vals[k].toFixed(4), sum: +sums[k].toFixed(4) }); }
  }
  for (const [k, [, unit]] of Object.entries(STAT_KEYS)) {
    const sid = `${config.statistics.prefix}:${v.id}_${k}`;
    const metadata = { has_mean: false, has_sum: true, name: `${v.name} ${METRICS[k][2].toLowerCase()}`, source: config.statistics.prefix, statistic_id: sid, unit_of_measurement: unit };
    for (let i = 0; i < per[k].length; i += 1500) await w.call({ type: 'recorder/import_statistics', metadata, stats: per[k].slice(i, i + 1500) });
  }
  if (per.miles.length > config.recent_hours + 2) log(`${v.name}: imported ${per.miles.length} hours into ${Object.keys(STAT_KEYS).length} statistics`);
  delete state.stats_cursor[v.id];
}
async function importFuelStats(w, force) {
  if (!config.statistics.enabled || !config.fuel.enabled) return;
  const series = priceSeries(); const from = config.fuel.history_from || '2024-01-01';
  const today = tz.parts(Date.now()).ds; const days = [];
  for (let t = Date.parse(from + 'T12:00:00Z'); ; t += DAY) { const d = new Date(t).toISOString().slice(0, 10); if (d > today) break; days.push(d); }
  for (const g of F.GRADES) {
    const sid = `${config.statistics.prefix}:fuel_price_${g}`; const done = force ? {} : (state.fuel_stats_done[sid] || {});
    const stats = [];
    for (const d of days) {
      const p = series.price(d, g); if (!p) continue;
      const key = `${p.source}:${p.price}`; if (done[d] === key) continue;
      const [y, m, dd] = d.split('-').map(Number); stats.push({ start: new Date(localMs(y, m, dd)).toISOString(), mean: p.price, min: p.price, max: p.price }); done[d] = key;
    }
    if (!stats.length) continue;
    const metadata = { has_mean: true, has_sum: false, name: `Fuel price ${F.GRADE_LABEL[g].toLowerCase()}`, source: config.statistics.prefix, statistic_id: sid, unit_of_measurement: 'USD/gal' };
    for (let i = 0; i < stats.length; i += 1500) await w.call({ type: 'recorder/import_statistics', metadata, stats: stats.slice(i, i + 1500) });
    state.fuel_stats_done[sid] = done;
    if (stats.length > 3) log(`fuel price ${g}: imported ${stats.length} daily rows into ${sid}`);
  }
}

// ---------- poll ----------
let polling = false, lastErr = null;
async function poll(opts = {}) {
  if (polling) return state.last; polling = true;
  const t0 = Date.now();
  try {
    await haTimeZone();
    const states = await haStates(); await loadPlans(states);
    await refreshFuel(opts.fuelForce);
    const now = Date.now(); const series = priceSeries(); const results = {};
    await withWS(async (w) => {
      try { await detect(w, states, now); } catch (e) { log('detection failed:', e.message); }
      const cheap = D.cheapWindow(plans, tz, now);
      for (const v of config.vehicles) {
        if (!v.enabled || !v.odometer) continue;
        const set = vehicleSettings(v, states); const charger = chargerOf(v, states);
        noteAssignment(v, charger, now);
        if (!set.capacity) log(`${v.name}: no battery capacity configured; battery energy will be 0`);
        const rawFrom = now - config.raw_days * DAY;
        if (opts.rebuild === v.id || opts.rebuild === 'all' || !rollup[v.id] || !Object.keys(rollup[v.id]).length) {
          rollup[v.id] = {}; rollupDirty = true;
          await backfill(w, v, set, Date.parse((config.backfill_from || '2024-01-01') + 'T00:00:00Z'), rawFrom, now);
          state.backfilled[v.id] = { at: now, from: config.backfill_from };
          state.stats_cursor[v.id] = earliestHour([v.id]);
        } else {
          await recompute(w, v, set, R.hourOf(now - config.recent_hours * HOUR) * HOUR, now);
        }
        const sc = config.session_check;
        const lowV = R.validateSessions(rollup[v.id], v.charge_efficiency, sc.enabled ? { minKwh: sc.min_kwh, minPeakKwh: sc.min_peak_kwh, matchFraction: sc.match_fraction, lagHours: sc.lag_hours } : { minKwh: Infinity });
        const lowA = R.settleAway(rollup[v.id], v.charge_efficiency, sc.lag_hours);
        const low = lowV == null ? lowA : lowA == null ? lowV : Math.min(lowV, lowA);
        if (low != null) { rollupDirty = true; state.stats_cursor[v.id] = Math.min(state.stats_cursor[v.id] ?? low, low); }
        set.energy = energyFor(v, set.grade); // the vehicle-wide driving rate may have changed with the new rows
        const metrics = metricsFor(v, set, series, now);
        const pw = charger && config.chargers[charger] ? states.find((x) => x.entity_id === config.chargers[charger].power) : null;
        const price = series.price(tz.parts(now).ds, set.grade);
        const gpm = R.gallonsPerMile(set.energy.fallbackKwhPerMile, set.energy);
        // charge estimate: live port kW while charging, else the port's measured typical kW, else the configured max
        const liveKw = pw ? R.num(pw.state) : null;
        const kw = liveKw > 0.5 ? liveKw : (D.typicalKw(rollup[v.id], R.hourOf(now)) || (charger && config.chargers[charger].max_kw) || null);
        const target = v.charge_limit_entity ? R.num(stateOf(states, v.charge_limit_entity)) : v.charge_limit;
        const est = D.chargeEstimate({ soc: R.num(stateOf(states, v.soc)), target, capacityKwh: set.capacity, efficiency: v.charge_efficiency, kw, nowMs: now, window: cheap });
        const port = Object.entries(state.ports).find(([, p]) => p.vehicle === v.id && p.plugged);
        const live = { charger, charger_power_kw: liveKw, charging: pw ? liveKw > 0.1 : null, plugged: v.plug_entity ? D.binaryOn(stateOf(states, v.plug_entity)) : null, detected_port: port ? port[0] : null,
          soc: R.num(stateOf(states, v.soc)), target_soc: target, charge_minutes: est ? est.minutes : null, charge_needed_kwh: est ? est.needed_kwh : null, charge_kw: est ? est.kw : null, charge_kw_source: liveKw > 0.5 ? 'live' : kw ? 'measured' : null,
          charge_finish: est ? est.finish : null, charge_latest_start: est ? est.latest_start : null, charge_start_early: est ? est.start_early : null, charge_start_in_minutes: est ? est.start_in_minutes ?? null : null,
          cheap_window_start: est ? est.window_start : null, cheap_window_end: est ? est.window_end : null, cheap_window_hours: est ? est.window_hours : null, cheap_rate: cheap ? cheap.rate : null,
          fuel_grade: set.grade, fuel_price: price ? price.price : null, fuel_price_source: price ? price.source : null, mpg_equivalent: set.mpg, energy_mpg: gpm ? +(1 / gpm).toFixed(1) : null, drive_kwh_per_mile: set.energy.fallbackKwhPerMile ? +set.energy.fallbackKwhPerMile.toFixed(3) : null, capacity_kwh: set.capacity, charge_efficiency: v.charge_efficiency, updated: new Date().toISOString() };
        results[v.id] = { name: v.name, charger, settings: set, metrics, live, hours: Object.keys(rollup[v.id]).length, first_hour: earliestHour([v.id]), sessions: sessionList(v, 25) };
        if (config.mqtt.enabled) await publishVehicle(v, set, metrics, live);
        await importVehicleStats(w, v, set, series);
      }
      await importFuelStats(w, opts.rebuild === 'all');
    });
    if (config.mqtt.enabled && config.fuel.enabled) await publishFuel(fuelSnapshot());
    if (config.mqtt.enabled) await publishPorts();
    state.last = { at: now, ms: Date.now() - t0, vehicles: results, ports: state.ports, fuel: fuelSnapshot(), error: null };
    lastErr = null;
  } catch (e) {
    lastErr = e.message; log('poll failed:', e.message);
    state.last = { ...(state.last || {}), at: Date.now(), error: e.message };
  } finally { saveRollup(); saveState(); polling = false; }
  return state.last;
}

// ---------- helpers in HA ----------
async function ensureHelpers(states) {
  const made = [];
  await withWS(async (w) => {
    for (const v of config.vehicles) {
      if (!v.fuel_select) {
        const name = `${v.name} fuel equivalent`; const eid = 'input_select.' + slug(name);
        if (!states.find((s) => s.entity_id === eid)) await w.call({ type: 'input_select/create', name, options: F.GRADES.map((g) => F.GRADE_LABEL[g]), initial: F.GRADE_LABEL[v.fuel_grade], icon: 'mdi:gas-station' });
        v.fuel_select = eid; made.push(eid);
      }
      if (!v.mpg_entity) {
        const name = `${v.name} equivalent MPG`; const eid = 'input_number.' + slug(name);
        if (!states.find((s) => s.entity_id === eid)) await w.call({ type: 'input_number/create', name, min: 5, max: 100, step: 0.5, initial: v.mpg, mode: 'box', unit_of_measurement: 'mpg', icon: 'mdi:gas-station-outline' });
        v.mpg_entity = eid; made.push(eid);
      }
    }
  });
  if (made.length) { saveConfig(); log('helpers:', made.join(', ')); }
  return made;
}

// ---------- panel / API ----------
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 2e6) req.destroy(); }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } }); req.on('error', reject); });

async function api(req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/config') return json(res, 200, { ...config, ha_token: config.ha_token ? '••••' : '', supervised: !!process.env.SUPERVISOR_TOKEN, metric_defs: METRICS, grades: F.GRADES });
  if (req.method === 'POST' && p === '/api/config') {
    const b = await readBody(req);
    for (const k of ['poll_minutes', 'recent_hours', 'raw_days', 'backfill_from', 'rate_entity', 'entity_prefix', 'windows', 'metrics', 'chargers', 'vehicles', 'away_rate', 'energy_model', 'session_check', 'detection', 'mqtt', 'statistics', 'fuel']) if (b[k] !== undefined) config[k] = b[k];
    if (b.ha_url && !process.env.SUPERVISOR_TOKEN) config.ha_url = b.ha_url;
    if (b.ha_token && b.ha_token !== '••••' && !process.env.SUPERVISOR_TOKEN) config.ha_token = b.ha_token;
    config.away_rate = Math.max(0, Number(config.away_rate) || 0);
    normalizeConfig(); saveConfig(); schedule();
    return json(res, 200, { ok: true, config: { ...config, ha_token: config.ha_token ? '••••' : '' } });
  }
  if (req.method === 'GET' && p === '/api/sessions') { const v = config.vehicles.find((x) => x.id === url.searchParams.get('vehicle')); return v ? json(res, 200, { vehicle: v.id, sessions: sessionList(v, Number(url.searchParams.get('limit')) || 200) }) : json(res, 404, { error: 'unknown vehicle' }); }
  if (req.method === 'GET' && p === '/api/status') return json(res, 200, { last: state.last, error: lastErr, assignments: state.assignments, ports: state.ports, port_timeline: portTimeline(), backfilled: state.backfilled, log: state.log.slice(0, 60), version: VERSION, uptime_s: Math.round(process.uptime()), tz: haTz, fuel: { weekly_at: fuel.weekly_at, aaa_at: fuel.aaa_at, eia_error: fuel.eia_error, aaa_error: fuel.aaa_error, areas: fuel.aaa && fuel.aaa.areas, weeks: fuel.weekly.regular ? fuel.weekly.regular.length : 0, days: Object.keys(fuel.daily).length }, polling });
  if (req.method === 'POST' && p === '/api/poll') return json(res, 200, await poll());
  if (req.method === 'POST' && p === '/api/rebuild') { const b = await readBody(req); return json(res, 200, await poll({ rebuild: b.vehicle || 'all' })); }
  if (req.method === 'POST' && p === '/api/fuel/refresh') return json(res, 200, await poll({ fuelForce: true }));
  if (req.method === 'POST' && p === '/api/helpers') { const states = await haStates(); return json(res, 200, { created: await ensureHelpers(states), vehicles: config.vehicles }); }
  if (req.method === 'GET' && p === '/api/ha') {
    const states = await haStates(); const pick = (f) => states.filter(f).map((s) => ({ entity: s.entity_id, name: s.attributes.friendly_name || s.entity_id, state: s.state, unit: s.attributes.unit_of_measurement || '' })).sort((a, b) => a.entity.localeCompare(b.entity));
    return json(res, 200, {
      selects: pick((s) => s.entity_id.startsWith('input_select.')), numbers: pick((s) => s.entity_id.startsWith('input_number.')),
      distance: pick((s) => s.entity_id.startsWith('sensor.') && (s.attributes.device_class === 'distance' || /odometer|mileage/i.test(s.entity_id))),
      battery: pick((s) => s.entity_id.startsWith('sensor.') && (s.attributes.device_class === 'battery' || /state_of_charge|soc/i.test(s.entity_id))),
      power: pick((s) => s.entity_id.startsWith('sensor.') && s.attributes.device_class === 'power'),
      energy_storage: pick((s) => s.entity_id.startsWith('sensor.') && s.attributes.device_class === 'energy_storage'),
      rate: pick((s) => s.entity_id.startsWith('sensor.') && s.attributes.plans),
      status: pick((s) => s.entity_id.startsWith('sensor.') && /status|_state$|charging_state|connection/i.test(s.entity_id) && !Number.isFinite(Number(s.state))),
      binary: pick((s) => s.entity_id.startsWith('binary_sensor.')),
      buttons: pick((s) => s.entity_id.startsWith('button.')),
      limits: pick((s) => (s.entity_id.startsWith('number.') || s.entity_id.startsWith('sensor.')) && /limit|target/i.test(s.entity_id) && s.attributes.unit_of_measurement === '%'),
    });
  }
  if (req.method === 'GET' && p === '/api/rows') { // recent hourly rows for one vehicle (debug / panel)
    const id = url.searchParams.get('vehicle'); const n = Math.min(24 * 31, Number(url.searchParams.get('hours')) || 72);
    const rows = rollup[id] || {}; const nowH = R.hourOf(Date.now()); const out = [];
    for (let h = nowH - n + 1; h <= nowH; h++) if (rows[h]) out.push({ start: new Date(h * HOUR).toISOString(), ...R.expand(rows[h]) });
    return json(res, 200, out);
  }
  if (req.method === 'POST' && p === '/api/assignments') { // { vehicle, list: [{from, charger}] } then rebuild that vehicle
    const b = await readBody(req); const v = config.vehicles.find((x) => x.id === b.vehicle);
    if (!v) return json(res, 400, { error: 'unknown vehicle' });
    setAssignments(v, Array.isArray(b.list) ? b.list : []);
    return json(res, 200, await poll({ rebuild: v.id }));
  }
  json(res, 404, { error: 'not found' });
}
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
function schedule() { clearInterval(timer); timer = setInterval(() => poll().catch(() => {}), config.poll_minutes * 60000); }
module.exports = { windowRange, localMs, METRICS, STAT_KEYS, _config: () => config };
if (require.main === module) (async () => {
  if (!config.ha_token) { log('no ha_token in', CONFIG_PATH); process.exit(1); }
  await haTimeZone();
  log(`ev-stats ${VERSION}: ${config.vehicles.length} vehicle(s), chargers ${Object.keys(config.chargers).join(', ') || 'none'}, tz ${haTz}`);
  if (config.vehicles.length) { try { await ensureHelpers(await haStates()); } catch (e) { log('helpers:', e.message); } }
  await poll();
  if (ONCE) { log('once: done'); process.exit(0); }
  schedule();
  server.listen(config.port, '0.0.0.0', () => log(`panel on http://0.0.0.0:${config.port}/  poll every ${config.poll_minutes} min`));
})();
