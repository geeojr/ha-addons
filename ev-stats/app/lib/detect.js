'use strict';
/*
 * Pure logic for "which vehicle is on which port" and "how long until the target charge":
 *   - plug-in events of the chargers' status sensors are matched to the vehicles' plug sensors by time
 *   - a charge estimate from state of charge, target, capacity and the port's measured kW, placed
 *     against the next cheapest rate window
 */
const { rateInfo } = require('./tou_rates');
const HOUR = 3600000, MIN = 60000;

/** History rows [{s, lu}] -> transitions [{t (ms), on (bool), from, to}] of a boolean-ish state (isOn(s)). unknown/unavailable are ignored. */
function transitions(rows, isOn) {
  const out = []; let prev = null;
  for (const r of rows || []) {
    const s = String(r.s); if (s === 'unknown' || s === 'unavailable' || s === '') continue;
    const on = !!isOn(s);
    if (prev !== null && on !== prev.on) out.push({ t: Math.round(r.lu * 1000), on, from: prev.s, to: s });
    prev = { on, s };
  }
  return out;
}
const chargerPlugged = (s) => !['available', 'unavailable', 'unknown', 'off', 'idle', 'disconnected', 'not_connected', 'none', ''].includes(String(s).toLowerCase());
const binaryOn = (s) => ['on', 'true', 'connected', 'plugged', 'plugged_in', 'locked'].includes(String(s).toLowerCase());

/**
 * Match each charger plug-in (on-transition) to the vehicle whose plug sensor turned on closest in time,
 * within [-beforeMs, +afterMs]; every vehicle transition is used at most once, closest pairs first.
 *   chargers: { name: [transitions] }   vehicles: { id: [transitions] }
 * -> [{ charger, at, vehicle | null, delta_ms | null, candidates, alternatives: [{vehicle, delta_ms}], ambiguous }] sorted by time;
 *    candidates/alternatives hold only vehicle events no other charger event claimed
 */
function matchPlugins(chargers, vehicles, beforeMs = 3 * MIN, afterMs = 15 * MIN, closeMs = 2 * MIN) {
  const events = [];
  for (const [name, list] of Object.entries(chargers)) for (const tr of list) if (tr.on) events.push({ charger: name, at: tr.t, vehicle: null, delta_ms: null, candidates: [] });
  const pairs = [];
  for (const e of events) for (const [vid, list] of Object.entries(vehicles)) for (const tr of list) {
    if (!tr.on) continue; const d = tr.t - e.at;
    if (d >= -beforeMs && d <= afterMs) { pairs.push({ e, vid, t: tr.t, d }); e.candidates.push(vid); }
  }
  pairs.sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
  const usedV = new Set();
  for (const p of pairs) {
    const key = p.vid + '@' + p.t;
    if (p.e.vehicle || usedV.has(key)) continue;
    p.e.vehicle = p.vid; p.e.delta_ms = p.d; usedV.add(key);
  }
  // Only vehicle events nobody else claimed count as alternatives; the match is ambiguous when one of
  // them was nearly as close (within `closeMs` of the winner's own delay).
  for (const e of events) {
    const alts = pairs.filter((p) => p.e === e && p.vid !== e.vehicle && !usedV.has(p.vid + '@' + p.t));
    e.alternatives = alts.map((p) => ({ vehicle: p.vid, delta_ms: p.d }));
    e.candidates = [...new Set([...(e.vehicle ? [e.vehicle] : []), ...alts.map((p) => p.vid)])];
    e.ambiguous = !!e.vehicle && alts.some((p) => Math.abs(p.d) - Math.abs(e.delta_ms) < closeMs);
  }
  return events.sort((a, b) => a.at - b.at);
}

/** Current plug state of a charger from its history: the last known status (null when none). */
function lastState(rows) { for (let i = (rows || []).length - 1; i >= 0; i--) { const s = String(rows[i].s); if (s !== 'unknown' && s !== 'unavailable' && s !== '') return { s, t: Math.round(rows[i].lu * 1000) }; } return null; }

/**
 * Typical kW a vehicle gets from its port: the mean of its full charging hours (home kWh within 90 % of the
 * best hour) over the last `days` days of rows; null when there are fewer than 3 such hours.
 */
function typicalKw(rows, nowHour, days = 30) {
  const vals = [];
  for (const [h, r] of Object.entries(rows)) if (+h > nowHour - days * 24 && r.home > 0.5) vals.push(r.home);
  if (vals.length < 3) return null;
  const max = Math.max(...vals); const full = vals.filter((v) => v >= 0.9 * max);
  return full.length >= 3 ? Math.round(full.reduce((a, b) => a + b, 0) / full.length * 100) / 100 : null;
}

/**
 * The next window of the cheapest rate tier: scans hour by hour from nowMs over `horizonHours`, takes the lowest
 * rate seen, and returns the first run of hours at that rate that ends after now: { start, end (ms), rate, hours }.
 */
function cheapWindow(plans, tz, nowMs, horizonHours = 48) {
  if (!plans || !plans.length) return null;
  const h0 = Math.floor(nowMs / HOUR); const rates = [];
  for (let i = 0; i < horizonHours; i++) { const ri = rateInfo(tz.parts((h0 + i) * HOUR + 1800000), plans); rates.push(ri ? ri.rate : null); }
  const min = Math.min(...rates.filter((r) => r != null)); if (!Number.isFinite(min)) return null;
  let i = rates.findIndex((r) => r === min); if (i < 0) return null;
  let j = i; while (j + 1 < rates.length && rates[j + 1] === min) j++;
  const start = (h0 + i) * HOUR, end = (h0 + j + 1) * HOUR;
  return { start: Math.max(start, i === 0 ? nowMs : start), end, rate: min, hours: (end - Math.max(start, i === 0 ? nowMs : start)) / HOUR };
}

/**
 * Charge estimate. o: { soc, target (%), capacityKwh, efficiency (wall->battery), kw (wall), nowMs, window: cheapWindow() }
 * -> { needed_kwh (wall side), minutes, finish (ISO, if started now), latest_start (ISO, to be done by the window end),
 *      start_early (the window alone is too short), window_start, window_end, window_hours }
 */
function chargeEstimate(o) {
  const soc = Number(o.soc), target = Number(o.target);
  if (!(o.capacityKwh > 0) || !Number.isFinite(soc) || !Number.isFinite(target)) return null;
  const battery = Math.max(0, target - soc) / 100 * o.capacityKwh;
  const wall = battery / (o.efficiency || 0.9);
  const kw = o.kw > 0 ? o.kw : null;
  const minutes = kw ? Math.round(wall / kw * 60) : null;
  const w = o.window || null;
  const out = { battery_kwh: r2(battery), needed_kwh: r2(wall), kw, minutes, finish: kw ? new Date(o.nowMs + minutes * MIN).toISOString() : null, latest_start: null, start_early: null, window_start: w ? new Date(w.start).toISOString() : null, window_end: w ? new Date(w.end).toISOString() : null, window_hours: w ? r2(w.hours) : null };
  if (w && kw) {
    const latest = w.end - minutes * MIN;
    out.latest_start = new Date(latest).toISOString();
    out.start_early = latest < w.start;            // the cheap window is not long enough: start before it
    out.start_in_minutes = Math.max(0, Math.round((latest - o.nowMs) / MIN));
  }
  return out;
}
const r2 = (v) => Math.round(v * 100) / 100;

module.exports = { transitions, chargerPlugged, binaryOn, matchPlugins, lastState, typicalKw, cheapWindow, chargeEstimate };
