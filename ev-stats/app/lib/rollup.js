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

const EMPTY = { mi: 0, pack: 0, drive: 0, chg: 0, home: 0, cost: 0, away: 0 };

/**
 * Sum rows over [fromHour, toHour] and derive the per-window metrics. Rows may be stored sparse
 * (zero fields omitted). Ratios only use the miles of hours whose battery / charger data exists.
 *   opts: { mpg, grade, priceAt(hourIdx, grade) -> $/gal | null, efficiency, awayRate }
 */
function windowMetrics(rows, fromHour, toHour, o) {
  const s = { ...EMPTY }; let gallons = 0, fuelCost = 0, hours = 0, priced = 0, rawHours = 0, miSoc = 0, miHome = 0;
  for (let h = fromHour; h <= toHour; h++) {
    const r = rows[h]; if (!r) continue; hours++; if (r.src === 'raw') rawHours++;
    for (const k of Object.keys(EMPTY)) s[k] += r[k] || 0;
    const mi = r.mi || 0;
    if (!r.nosoc) miSoc += mi;
    if (!r.nohome) miHome += mi;
    if (mi > 0 && o.mpg > 0) {
      const g = mi / o.mpg; gallons += g;
      const p = o.priceAt(h, o.grade); if (p != null) { fuelCost += g * p; priced += mi; }
    }
  }
  const awayWall = s.away / (o.efficiency || 0.9);
  const evCost = s.cost + awayWall * (o.awayRate || 0);
  const m = {
    miles: r3(s.mi),
    home_energy: r3(s.home), home_cost: r2(s.cost),
    avg_rate: s.home > 0.01 ? r4(s.cost / s.home) : null,
    away_energy: r3(s.away), ev_cost: r2(evCost),
    battery_energy: r3(s.pack), drive_energy: r3(s.drive), charged_energy: r3(s.chg),
    efficiency: s.drive > 0.1 && miSoc > 0 ? r2(miSoc / s.drive) : null,            // mi/kWh while driving
    consumption: miSoc > 0.5 && s.pack > 0 ? r1(s.pack / miSoc * 100) : null,       // kWh/100mi all-in (driving + idle)
    wall_consumption: miHome > 0.5 && s.home > 0 ? r1(s.home / miHome * 100) : null, // kWh/100mi from the home charger
    cost_per_mile: s.mi > 0.5 ? r3(evCost / s.mi) : null,
    fuel_gallons: r2(gallons), fuel_cost: r2(fuelCost),
    savings: r2(fuelCost - evCost),
    savings_pct: fuelCost > 0 ? r1((fuelCost - evCost) / fuelCost * 100) : null,
    hours, raw_hours: rawHours, miles_priced: r3(priced), miles_with_battery_data: r3(miSoc), miles_with_charger_data: r3(miHome),
  };
  return m;
}

/** Storage form: zero fields and false flags dropped. expand() restores the full row. */
function compact(r) { const c = { src: r.src }; for (const k of Object.keys(EMPTY)) if (r[k]) c[k] = r[k]; if (r.nosoc) c.nosoc = true; if (r.nohome) c.nohome = true; return c; }
function expand(c) { return { ...EMPTY, ...(c || {}) }; }
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100, r4 = (v) => Math.round(v * 10000) / 10000;

module.exports = { HOUR, hourOf, num, samples, integrateHours, milesByHour, movedBetween, socByHour, rowsFromRaw, rowsFromStats, windowMetrics, compact, expand, EMPTY };
