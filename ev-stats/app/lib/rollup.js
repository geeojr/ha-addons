'use strict';
/*
 * Pure math for ev-stats: turning raw Home Assistant samples (or hourly long-term statistics)
 * into one row per hour per vehicle, and summing those rows over rolling windows.
 *
 * A row is { mi, pack, drive, chg, home, cost, away, src }:
 *   mi    miles driven (odometer increase reported in that hour)
 *   pack  kWh drawn from the battery (state-of-charge decreases x capacity) - driving AND idle/climate
 *   drive kWh of `pack` that happened while the odometer was moving
 *   chg   kWh put into the battery (state-of-charge increases x capacity), anywhere
 *   home  kWh delivered by the assigned home charger (wall side)
 *   cost  USD for `home` at the time-of-use rate of that hour
 *   away  kWh (battery side) charged somewhere else: chg - home x charge efficiency, floored at 0
 *   other kWh the assigned charger delivered in a session this vehicle's battery did not take
 *         (another car on the port; validateSessions) and its cost `ocost` - not this vehicle's
 *   src   'raw' (from recorder states) or 'stat' (from hourly statistics; coarser)
 */
const HOUR = 3600000;
const hourOf = (ms) => Math.floor(ms / HOUR);
const num = (s) => { if (s == null || s === '') return null; const v = Number(s); return Number.isFinite(v) ? v : null; };
const r3 = (v) => Math.round(v * 1000) / 1000;

/** HA websocket history rows [{s, lu}] -> [{t: ms, v: number}] sorted, non-numeric states dropped. */
function samples(rows) {
  const out = [];
  for (const r of rows || []) { const v = num(r.s); if (v != null) out.push({ t: Math.round(r.lu * 1000), v }); }
  return out.sort((a, b) => a.t - b.t);
}

/** Left-Riemann integral of a kW series into per-hour kWh between fromMs and toMs (a state holds until the next sample). */
function integrateHours(pw, fromMs, toMs) {
  const out = {};
  for (let i = 0; i < pw.length; i++) {
    const a = pw[i]; const next = i + 1 < pw.length ? pw[i + 1].t : toMs;
    let t0 = Math.max(a.t, fromMs); const t1 = Math.min(next, toMs);
    if (t1 <= t0 || !(a.v > 0)) continue;
    while (t0 < t1) {
      const h = hourOf(t0); const seg = Math.min(t1, (h + 1) * HOUR) - t0;
      out[h] = (out[h] || 0) + a.v * seg / HOUR; t0 += seg;
    }
  }
  return out;
}

/** Odometer samples -> per-hour miles (an increase is booked in the hour it was reported) and the list of movement times. */
function milesByHour(odo, fromMs, toMs) {
  const mi = {}, moves = [];
  for (let i = 1; i < odo.length; i++) {
    const d = odo[i].v - odo[i - 1].v;
    if (!(d > 0) || d > 1000) continue; // 1000+ mi in one report = sensor glitch / reset
    moves.push(odo[i].t);
    if (odo[i].t < fromMs || odo[i].t >= toMs) continue;
    const h = hourOf(odo[i].t); mi[h] = (mi[h] || 0) + d;
  }
  return { mi, moves };
}

/** true when any movement time lies in (t0, t1 + slack] (a move reported exactly at t0 belongs to the previous interval). */
function movedBetween(moves, t0, t1, slack = 120000) {
  let lo = 0, hi = moves.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (moves[m] <= t0) lo = m + 1; else hi = m; }
  return lo < moves.length && moves[lo] <= t1 + slack;
}

/** State-of-charge samples (%) -> per-hour battery energy out (pack/drive) and in (chg), in kWh. */
function socByHour(soc, moves, capacityKwh, fromMs, toMs) {
  const out = {};
  const row = (h) => out[h] || (out[h] = { pack: 0, drive: 0, chg: 0 });
  for (let i = 1; i < soc.length; i++) {
    const a = soc[i - 1], b = soc[i];
    if (b.t < fromMs || b.t >= toMs) continue;
    const d = (b.v - a.v) * capacityKwh / 100;
    if (Math.abs(d) > capacityKwh) continue; // impossible jump (unit glitch)
    const h = hourOf(b.t);
    if (d < 0) { const r = row(h); r.pack += -d; if (movedBetween(moves, a.t, b.t)) r.drive += -d; }
    else if (d > 0) row(h).chg += d;
  }
  return out;
}

/**
 * Rows for one vehicle from RAW samples.
 *   opts: { odo, soc, power: {chargerName: samples}, capacityKwh, efficiency, fromMs, toMs,
 *           chargerAt(hourIdx) -> charger name | null, rateAt(hourIdx) -> $/kWh | null }
 */
function rowsFromRaw(o) {
  const { mi, moves } = milesByHour(o.odo, o.fromMs, o.toMs);
  const e = socByHour(o.soc, moves, o.capacityKwh, o.fromMs, o.toMs);
  const kwh = {}; for (const [name, pw] of Object.entries(o.power || {})) kwh[name] = pw.length ? integrateHours(pw, o.fromMs, o.toMs) : null;
  const nosoc = !o.soc.length || !(o.capacityKwh > 0);
  const rows = {};
  for (let h = hourOf(o.fromMs); h < hourOf(o.toMs - 1) + 1; h++) {
    const ch = o.chargerAt(h); const known = !!(ch && kwh[ch]); const home = known ? kwh[ch][h] || 0 : 0;
    rows[h] = finish({ mi: mi[h] || 0, pack: e[h] ? e[h].pack : 0, drive: e[h] ? e[h].drive : 0, chg: e[h] ? e[h].chg : 0, home, src: 'raw', nosoc, nohome: !known }, o.rateAt(h), o.efficiency);
  }
  return rows;
}

/**
 * Rows from HOURLY long-term statistics (backfill). Coarser: the battery energy is the hour-to-hour
 * change of the mean state of charge, so a charge and a drive inside the same hour cancel out.
 *   stats: { odo: [{start, change}], soc: [{start, mean}], power: {chargerName: [{start, mean}]} }
 */
function rowsFromStats(o) {
  const rows = {};
  const odo = new Map((o.stats.odo || []).map((r) => [hourOf(r.start), r.change]));
  const socRows = (o.stats.soc || []).filter((r) => r.mean != null).sort((a, b) => a.start - b.start);
  const soc = new Map();
  for (let i = 1; i < socRows.length; i++) soc.set(hourOf(socRows[i].start), (socRows[i].mean - socRows[i - 1].mean) * o.capacityKwh / 100);
  const pw = {}; for (const [name, list] of Object.entries(o.stats.power || {})) pw[name] = new Map(list.map((r) => [hourOf(r.start), r.mean]));
  for (let h = hourOf(o.fromMs); h < hourOf(o.toMs - 1) + 1; h++) {
    let mi = odo.get(h); mi = mi > 0 && mi < 1000 ? mi : 0;
    const nosoc = !soc.has(h) || !(o.capacityKwh > 0); const d = nosoc ? 0 : soc.get(h);
    const ch = o.chargerAt(h); const p = ch && pw[ch] ? pw[ch].get(h) : null; const nohome = p == null;
    const home = p > 0 ? p : 0;
    const pack = d < 0 ? -d : 0;
    rows[h] = finish({ mi, pack, drive: mi > 0 ? pack : 0, chg: d > 0 ? d : 0, home, src: 'stat', nosoc, nohome }, o.rateAt(h), o.efficiency);
  }
  return rows;
}

/** Price the home energy, estimate away charging (only when the home charger's data exists), round, drop false flags. */
function finish(r, rate, eff) {
  r.cost = rate != null ? r.home * rate : 0;
  r.away = r.nohome ? 0 : Math.max(0, r.chg - r.home * (eff || 0.9));
  for (const k of ['mi', 'pack', 'drive', 'chg', 'home', 'cost', 'away']) r[k] = r3(r[k]);
  if (!r.nosoc) delete r.nosoc;
  if (!r.nohome) delete r.nohome;
  return r;
}

const EMPTY = { mi: 0, pack: 0, drive: 0, chg: 0, home: 0, cost: 0, away: 0, other: 0, ocost: 0 };

/**
 * Charging sessions of the assigned charger: runs of consecutive hours with >= 0.2 kWh from the wall.
 * Each: { start, end (hour idx), hours, wall, cost, gained (battery kWh in during the session and up
 * to lagHours after it, before the next session: a sleeping car reports its state of charge late),
 * peak (largest hour), nosoc, other (kWh currently booked as not this vehicle's) }.
 */
function sessions(rows, lagHours = 12) {
  const hours = Object.keys(rows).map(Number).sort((a, b) => a - b);
  const out = []; let cur = null;
  const wallOf = (r) => (r.home || 0) + (r.other || 0);
  for (const h of hours) {
    const r = rows[h], wall = wallOf(r);
    if (wall >= 0.2 && cur && h === cur.end + 1) {
      cur.end = h; cur.hours++; cur.wall += wall; cur.cost += (r.cost || 0) + (r.ocost || 0); cur.other += r.other || 0; cur.peak = Math.max(cur.peak, wall);
      cur.gained += r.chg || 0; if (!r.nosoc) cur.nosoc = false;
    } else if (wall >= 0.2) {
      if (cur) out.push(cur);
      cur = { start: h, end: h, hours: 1, wall, cost: (r.cost || 0) + (r.ocost || 0), other: r.other || 0, peak: wall, gained: r.chg || 0, nosoc: !!r.nosoc };
    }
  }
  if (cur) out.push(cur);
  out.forEach((s, i) => { const stop = i + 1 < out.length ? out[i + 1].start - 1 : s.end + lagHours; for (let h = s.end + 1; h <= Math.min(stop, s.end + lagHours); h++) { const n = rows[h]; if (n) s.gained += n.chg || 0; } });
  for (const s of out) for (const k of ['wall', 'cost', 'gained', 'other', 'peak']) s[k] = r3(s[k]);
  return out;
}

/**
 * Book sessions whose battery gain does not match the wall energy as another vehicle's: their kWh and
 * cost move from home/cost to other/ocost. Re-runs from scratch every time (idempotent): a session is
 * "not this vehicle" when wall >= minKwh, its largest hour >= minPeakKwh (a thermal trickle is not a
 * session), battery data exists and gained < matchFraction x wall x efficiency. Returns the lowest
 * changed hour or null.
 *   o: { minKwh = 3, minPeakKwh = 4, matchFraction = 0.5, lagHours = 12 }
 */
function validateSessions(rows, eff, o = {}) {
  const minKwh = o.minKwh ?? 3, minPeak = o.minPeakKwh ?? 4, frac = o.matchFraction ?? 0.5;
  const before = {}; for (const [h, r] of Object.entries(rows)) if (r.other) before[h] = r.other;
  for (const r of Object.values(rows)) { if (r.other) { r.home = r3((r.home || 0) + r.other); delete r.other; } if (r.ocost) { r.cost = r3((r.cost || 0) + r.ocost); delete r.ocost; } }
  for (const s of sessions(rows, o.lagHours ?? 12)) {
    if (s.nosoc || s.wall < minKwh || s.peak < minPeak || !(s.gained < frac * s.wall * (eff || 0.9))) continue;
    for (let h = s.start; h <= s.end; h++) { const r = rows[h]; if (r.home) { r.other = r.home; delete r.home; } if (r.cost) { r.ocost = r.cost; delete r.cost; } }
  }
  let low = null;
  for (const [h, r] of Object.entries(rows)) if ((r.other || 0) !== (before[h] || 0) && (low == null || +h < low)) low = +h;
  return low;
}

/**
 * Re-estimate `away` over a whole (possibly compact) row map with a one-hour memory: the car reports
 * its state of charge late (and an hourly mean lags by up to an hour), so the battery-side rise of a
 * charge lands partly in the hour AFTER the wall delivered it. Unused home credit (home x efficiency
 * not yet matched by a state-of-charge rise) of an hour may still be claimed by the next hour; only
 * what exceeds that is charging that happened elsewhere. Returns the lowest changed hour or null.
 */
function settleAway(rows, eff, lagHours = 12) {
  const hours = Object.keys(rows).map(Number).sort((a, b) => a - b);
  let credits = [], prev = null, low = null; // unmatched wall credit per hour, oldest first; a sleeping car can report hours late
  for (const h of hours) {
    const r = rows[h];
    if (h !== prev + 1 || r.nohome) credits = [];
    else credits = credits.filter((c) => h - c.h <= lagHours);
    prev = h;
    let away = 0;
    if (!r.nohome) {
      credits.push({ h, kwh: ((r.home || 0) + (r.other || 0)) * (eff || 0.9) }); // a session booked to another vehicle still explains a small gain
      let need = r.chg || 0;
      for (const c of credits) { const use = Math.min(c.kwh, need); c.kwh -= use; need -= use; if (!need) break; }
      credits = credits.filter((c) => c.kwh > 1e-9);
      away = r3(need);
    }
    if ((r.away || 0) !== away) { if (away) r.away = away; else delete r.away; if (low == null) low = h; }
  }
  return low;
}

/**
 * Gasoline-equivalent gallons per mile from measured driving energy (battery side, net of regen):
 *   wheel energy = kWh/mi x EV drivetrain efficiency / (1 - regen share)
 *   gallons/mi   = wheel energy / (kWh per gallon x engine+transmission efficiency)
 */
function gallonsPerMile(kwhPerMile, e) {
  if (!(kwhPerMile > 0) || !(e.kwhPerGal > 0) || !(e.engineEff > 0)) return null;
  return kwhPerMile * (e.evEff || 0.88) / (1 - Math.min(0.5, Math.max(0, e.regen || 0))) / (e.kwhPerGal * e.engineEff);
}

/**
 * Sum rows over [fromHour, toHour] and derive the per-window metrics. Rows may be stored sparse
 * (zero fields omitted). Ratios only use the miles of hours whose battery / charger data exists.
 *   opts: { mpg, grade, priceAt(hourIdx, grade) -> $/gal | null, efficiency, awayRate,
 *           energy: { kwhPerGal, engineEff, evEff, regen, fallbackKwhPerMile } (optional) }
 * The energy-based fuel equivalent applies one measured driving rate (kWh/mi) to every mile of the
 * window: the window's own raw hours with battery data (>= 50 mi), else its hours with any battery
 * data, else the vehicle-wide rate passed in, else the wall-side rate. (Statistics-backfilled hours
 * under-count driving energy, so their own values are not used.)
 */
function windowMetrics(rows, fromHour, toHour, o) {
  const s = { ...EMPTY }; let gallons = 0, fuelCost = 0, hours = 0, priced = 0, rawHours = 0, miSoc = 0, miHome = 0, rawMi = 0, rawDrive = 0;
  const seen = [];
  for (let h = fromHour; h <= toHour; h++) {
    const r = rows[h]; if (!r) continue; hours++; if (r.src === 'raw') rawHours++;
    for (const k of Object.keys(EMPTY)) s[k] += r[k] || 0;
    const mi = r.mi || 0;
    if (!r.nosoc) { miSoc += mi; if (r.src === 'raw') { rawMi += mi; rawDrive += r.drive || 0; } }
    if (!r.nohome) miHome += mi;
    let p = null;
    if (mi > 0) {
      p = o.priceAt(h, o.grade);
      if (o.mpg > 0) { const g = mi / o.mpg; gallons += g; if (p != null) { fuelCost += g * p; priced += mi; } }
    }
    if (o.energy && mi > 0) seen.push({ mi, p });
  }
  const awayWall = s.away / (o.efficiency || 0.9);
  const evCost = s.cost + awayWall * (o.awayRate || 0);
  // energy-based fuel equivalent
  let eGal = 0, eCost = 0, basis = null, rate = null;
  if (o.energy) {
    const e = o.energy;
    if (rawMi >= 50 && rawDrive > 0) { rate = rawDrive / rawMi; basis = 'raw'; }
    else if (miSoc >= 50 && s.drive > 0) { rate = s.drive / miSoc; basis = 'battery'; }
    else if (e.fallbackKwhPerMile > 0) { rate = e.fallbackKwhPerMile; basis = 'vehicle'; }
    else if (miHome >= 50 && s.home > 0) { rate = s.home * (o.efficiency || 0.9) / miHome; basis = 'wall'; }
    const gpm = gallonsPerMile(rate, e);
    if (gpm) for (const { mi, p } of seen) { const g = gpm * mi; eGal += g; if (p != null) eCost += g * p; }
    else basis = null;
  }
  const m = {
    miles: r3(s.mi),
    home_energy: r3(s.home), home_cost: r2(s.cost),
    avg_rate: s.home > 0.01 ? r4(s.cost / s.home) : null,
    away_energy: r3(s.away), ev_cost: r2(evCost),
    other_energy: r3(s.other), other_cost: r2(s.ocost),
    battery_energy: r3(s.pack), drive_energy: r3(s.drive), charged_energy: r3(s.chg),
    efficiency: s.drive > 0.1 && miSoc > 0 ? r2(miSoc / s.drive) : null,            // mi/kWh while driving
    consumption: miSoc > 0.5 && s.pack > 0 ? r1(s.pack / miSoc * 100) : null,       // kWh/100mi all-in (driving + idle)
    wall_consumption: miHome > 0.5 && s.home > 0 ? r1(s.home / miHome * 100) : null, // kWh/100mi from the home charger
    cost_per_mile: s.mi > 0.5 ? r3(evCost / s.mi) : null,
    fuel_gallons: r2(gallons), fuel_cost: r2(fuelCost),
    savings: r2(fuelCost - evCost),
    savings_pct: fuelCost > 0 ? r1((fuelCost - evCost) / fuelCost * 100) : null,
    energy_fuel_gallons: basis ? r2(eGal) : null, energy_fuel_cost: basis ? r2(eCost) : null,
    energy_savings: basis ? r2(eCost - evCost) : null,
    energy_mpg: basis && eGal > 0.01 ? r1(s.mi / eGal) : null,
    energy_basis: basis, energy_kwh_per_mile: basis ? r3(rate) : null,
    hours, raw_hours: rawHours, miles_priced: r3(priced), miles_with_battery_data: r3(miSoc), miles_with_charger_data: r3(miHome),
  };
  return m;
}

/** Vehicle-wide driving kWh/mi for the energy-based fuel equivalent: raw hours with battery data (>= 50 mi), else all hours with battery data. */
function driveRate(rows) {
  let rawMi = 0, rawDrive = 0, mi = 0, drive = 0;
  for (const r of Object.values(rows)) {
    if (r.nosoc || !(r.mi > 0)) continue;
    mi += r.mi; drive += r.drive || 0;
    if (r.src === 'raw') { rawMi += r.mi; rawDrive += r.drive || 0; }
  }
  if (rawMi >= 50 && rawDrive > 0) return rawDrive / rawMi;
  if (mi >= 50 && drive > 0) return drive / mi;
  return null;
}

/** Storage form: zero fields and false flags dropped. expand() restores the full row. */
function compact(r) { const c = { src: r.src }; for (const k of Object.keys(EMPTY)) if (r[k]) c[k] = r[k]; if (r.nosoc) c.nosoc = true; if (r.nohome) c.nohome = true; return c; }
function expand(c) { return { ...EMPTY, ...(c || {}) }; }
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100, r4 = (v) => Math.round(v * 10000) / 10000;

module.exports = { HOUR, hourOf, num, samples, integrateHours, milesByHour, movedBetween, socByHour, rowsFromRaw, rowsFromStats, sessions, validateSessions, settleAway, gallonsPerMile, driveRate, windowMetrics, compact, expand, EMPTY };
