#!/usr/bin/env node
'use strict';
/**
 * evergy_sync - Home Assistant add-on. Pulls HOURLY electricity usage from Evergy's usage
 * portal (Opower) and writes it into HA long-term statistics, plus a priced cost statistic
 * from the TOU plans published by sensor.electricity_rate.
 *
 * Rules:
 *   - Signs in ONCE per run over plain HTTP (see evergy_login.js), with a common browser string.
 *     Never retries a login. After a failed sign-in it posts a HA notification and will not try
 *     again until the username/password options change.
 *   - Gentle: one sign-in, one token request, one usage request per <=26-day window with a pause.
 *     A normal daily run is about 10 small requests.
 *   - Idempotent: rows are keyed by hour; re-imported rows overwrite.
 *   - Runs daily at `run_at` (America/Chicago) and on start-up if today has not been synced yet.
 *
 * Options (/data/options.json): username, password, run_at, statistic_id, statistic_name,
 *   cost_statistic_name, rate_entity, account_uuid (blank = auto-detect), subdomain, backfill_from,
 *   run_on_start.   Local test: OPTIONS=path HA_URL=... HA_TOKEN=... DATA_DIR=...
 *
 * CLI (inside the container or locally):  node evergy_sync.js --once [--from X] [--to Y] [--dry-run] [--cost-only] [--login]
 */
const fs = require('fs'), path = require('path');
const { TZ, rateInfo, fetchPlans } = require('./tou_rates');
const E = require('./evergy_login');

const DIR = process.env.DATA_DIR || '/data';
const OPTIONS_PATH = process.env.OPTIONS || path.join(DIR, 'options.json');
const loadJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const OPT = { run_at: '06:10', subdomain: 'kcpl', rate_entity: 'sensor.electricity_rate', run_on_start: true, ...loadJson(OPTIONS_PATH, {}) };
const HA_URL = process.env.HA_URL || (process.env.SUPERVISOR_TOKEN ? 'http://supervisor/core' : 'http://homeassistant:8123');
const HA_TOKEN = process.env.HA_TOKEN || process.env.SUPERVISOR_TOKEN || '';
const HA_WS = process.env.HA_URL ? HA_URL.replace(/^http/, 'ws') + '/api/websocket' : 'ws://supervisor/core/websocket';
const LOG = path.join(DIR, 'sync.log');
const LAST_RUN = path.join(DIR, 'last_run.json');
const LOGIN_LOCK = path.join(DIR, 'login_failed.json');
const WINDOW_DAYS = 26;           // Opower's maximum for hourly reads
const PAUSE_MS = 3000;            // between usage requests
const DAY = 86400000;
const TZNAME = 'America/Chicago';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ONCE = args.includes('--once'), DRY = args.includes('--dry-run'), COST_ONLY = args.includes('--cost-only');
const SID = OPT.statistic_id, COST_SID = OPT.cost_statistic_id || SID.replace(/_consumption$/, '_cost');
const todayLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: TZNAME });
const addDays = (ds, n) => { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => { const line = `${new Date().toISOString()} ${a.join(' ')}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch { /* ignore */ } };
const lastRun = () => loadJson(LAST_RUN, {});

// window: last 4 days, widened back to the day before the last successful sync (gap catch-up), max 60 days
function windowFor() {
  const TO = opt('--to', todayLocal());
  let from = opt('--from', null);
  if (!from) {
    from = addDays(TO, -4);
    const lastOk = lastRun().last_ok_to;
    if (lastOk && addDays(lastOk, -1) < from) from = addDays(lastOk, -1);
    if (OPT.backfill_from && OPT.backfill_from < from) from = OPT.backfill_from; // explicit backfill may exceed 60 days
    else if (from < addDays(TO, -60)) from = addDays(TO, -60);
  }
  return { FROM: from, TO };
}

// ---------- Home Assistant ----------
async function haRest(method, p, body) {
  const r = await fetch(HA_URL.replace(/\/$/, '') + p, { method, headers: { Authorization: 'Bearer ' + HA_TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`HA ${method} ${p}: ${r.status}`);
  return r.status === 204 ? null : r.json();
}
const notify = (title, message) => haRest('POST', '/api/services/persistent_notification/create', { notification_id: 'evergy_sync', title, message }).catch((e) => log('notify failed:', e.message));
const dismiss = () => haRest('POST', '/api/services/persistent_notification/dismiss', { notification_id: 'evergy_sync' }).catch(() => {});

function haWS() {
  const ws = new WebSocket(HA_WS);
  let id = 0; const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: HA_TOKEN }));
      else if (m.type === 'auth_ok') resolve();
      else if (m.type === 'auth_invalid') reject(new Error('HA auth invalid'));
      else if (m.type === 'result' && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.success ? res(m.result) : rej(new Error(JSON.stringify(m.error))); }
    };
    ws.onerror = (e) => reject(new Error('HA websocket error ' + (e.message || '')));
  });
  return {
    ready,
    call: (msg) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, ...msg })); }),
    close: () => ws.close(),
  };
}

// ---------- Evergy / Opower ----------
const credHash = () => require('crypto').createHash('sha256').update(`${OPT.username}\n${OPT.password}`).digest('hex').slice(0, 16);
function loginAllowed() {
  if (!OPT.username || !OPT.password) return { ok: false, why: 'no username/password in the add-on options' };
  if (args.includes('--login')) return { ok: true };
  const lock = loadJson(LOGIN_LOCK, null);
  if (lock && lock.cred === credHash()) return { ok: false, why: `the last sign-in attempt failed (${lock.at}: ${lock.why}); change the username/password options to try again` };
  return { ok: true };
}

async function fetchReads(FROM, TO) {
  const allowed = loginAllowed();
  if (!allowed.ok) throw Object.assign(new Error(`Not signing in: ${allowed.why}`), { needLogin: true });
  let session;
  try {
    log('signing in to Evergy (single attempt)');
    session = await E.login(OPT.username, OPT.password, log);
  } catch (e) {
    if (e.invalidAuth) {
      fs.writeFileSync(LOGIN_LOCK, JSON.stringify({ at: new Date().toISOString(), why: e.message, cred: credHash() }, null, 1));
      throw Object.assign(new Error(`${e.message}. No further sign-in attempts until the username/password options are changed.`), { needLogin: true });
    }
    throw e; // connectivity / site change: reported, retried on the next scheduled run (no credentials were rejected)
  }
  const { jar, jwt } = session;
  let uuid = OPT.account_uuid, sub = OPT.subdomain;
  if (!uuid) {
    const a = await E.accounts(jar, jwt, sub);
    sub = a.subdomain;
    log('accounts:', a.accounts.map((x) => `${x.uuid} ${x.type || ''} ${x.number || ''} ${x.resolution || ''}`).join(' | ') || 'none');
    const elec = a.accounts.find((x) => /ELEC/i.test(x.type || '')) || a.accounts[0];
    if (!elec) throw new Error('no utility accounts found for this login');
    uuid = elec.uuid;
  }
  const reads = new Map(); // epoch ms -> kWh
  let end = TO, requests = 0;
  while (end >= FROM) {
    const start = addDays(end, -(WINDOW_DAYS - 1)) < FROM ? FROM : addDays(end, -(WINDOW_DAYS - 1));
    const url = `https://${sub}.opower.com/ei/edge/apis/DataBrowser-v1/cws/utilities/${sub}/utilityAccounts/${uuid}/reads?aggregateType=hour&startDate=${start}&endDate=${end}`;
    if (requests) await sleep(PAUSE_MS);
    const r = await E.http(jar, url, { headers: { Authorization: 'Bearer ' + jwt, Accept: 'application/json' } });
    requests++;
    if (!r.ok) throw new Error(`Opower reads ${start}..${end}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    let n = 0;
    for (const rd of data.reads || []) {
      const v = rd.consumption && rd.consumption.value;
      if (v == null || !rd.startTime) continue;
      const ms = Date.parse(rd.startTime);
      if (Number.isNaN(ms)) continue;
      reads.set(ms, v); n++;
    }
    log(`reads ${start}..${end}: ${n} hourly rows`);
    end = addDays(start, -1);
  }
  return { reads, requests };
}

// ---------- import into HA statistics ----------
async function importStats(reads, sid, defaultName, defaultUnit) {
  const ha = haWS(); await ha.ready;
  try {
    const meta = (await ha.call({ type: 'recorder/get_statistics_metadata', statistic_ids: [sid] }))[0];
    const unit = meta ? meta.statistics_unit_of_measurement : defaultUnit;
    const name = defaultName || (meta && meta.name) || sid; // config name wins so the dashboard label can be tidied
    const rows = [...reads.entries()].sort((a, b) => a[0] - b[0]);
    if (!rows.length) return { imported: 0 };
    const firstMs = rows[0][0];
    // baseline: the running sum just before our first row (monthly buckets return the sum at bucket end)
    const base = await ha.call({ type: 'recorder/statistics_during_period', statistic_ids: [sid], period: 'month', types: ['sum'],
      start_time: new Date(firstMs - 400 * DAY).toISOString(), end_time: new Date(firstMs).toISOString() });
    const prev = (base[sid] || []).filter((r) => r.start < firstMs && r.sum != null);
    let sum = prev.length ? prev[prev.length - 1].sum : 0;
    log(`${sid}: baseline sum before ${new Date(firstMs).toISOString()}: ${sum.toFixed(3)} ${unit || ''} (${prev.length ? 'from existing history' : 'no earlier data'})`);
    // Existing rows inside our span whose hour has no Opower read (e.g. old daily rows on a day
    // Opower now reports nothing for) would keep a stale running total and show up as a false
    // spike. Overwrite them with a zero-change row at the correct running total instead.
    const lastMs = rows[rows.length - 1][0];
    const existing = await ha.call({ type: 'recorder/statistics_during_period', statistic_ids: [sid], period: 'hour', types: ['sum'],
      start_time: new Date(firstMs).toISOString(), end_time: new Date(lastMs + 3600000).toISOString() });
    const have = new Set(rows.map((r) => r[0]));
    const leftovers = (existing[sid] || []).map((r) => r.start).filter((s) => !have.has(s));
    if (leftovers.length) { log(`${leftovers.length} existing row(s) with no matching hourly read will be zeroed (first: ${new Date(leftovers[0]).toISOString()})`); leftovers.forEach((s) => rows.push([s, 0])); rows.sort((a, b) => a[0] - b[0]); }
    const stats = rows.map(([ms, kwh]) => { sum += kwh; return { start: new Date(ms).toISOString(), state: kwh, sum: +sum.toFixed(6) }; });
    if (DRY) { log(`DRY RUN: would import ${stats.length} rows into ${sid}, ${stats[0].start} .. ${stats[stats.length - 1].start}`); return { imported: 0, dry: stats.length }; }
    const metadata = { has_mean: false, has_sum: true, name, source: sid.split(':')[0], statistic_id: sid, unit_of_measurement: unit };
    for (let i = 0; i < stats.length; i += 1500) {
      await ha.call({ type: 'recorder/import_statistics', metadata, stats: stats.slice(i, i + 1500) });
    }
    return { imported: stats.length, first: stats[0].start, last: stats[stats.length - 1].start, kwh: rows.reduce((s, r) => s + r[1], 0) };
  } finally { ha.close(); }
}

// Load hourly consumption already stored in HA (for --cost-only re-pricing).
async function loadStoredReads(FROM, TO) {
  const ha = haWS(); await ha.ready;
  try {
    const sid = SID;
    const tz = new TZ('America/Chicago');
    const r = await ha.call({ type: 'recorder/statistics_during_period', statistic_ids: [sid], period: 'hour', types: ['change'], units: { energy: 'kWh' },
      start_time: new Date(addDays(FROM, -1) + 'T00:00:00Z').toISOString(), end_time: new Date(addDays(TO, 2) + 'T00:00:00Z').toISOString() }); // wide window; filtered to FROM..TO local below
    const reads = new Map();
    for (const row of r[sid] || []) if (row.change != null && tz.parts(row.start).ds >= FROM && tz.parts(row.start).ds <= TO) reads.set(row.start, row.change);
    return reads;
  } finally { ha.close(); }
}

// kWh per hour -> $ per hour using the TOU plans published by sensor.electricity_rate.
async function priceReads(reads) {
  const plans = await fetchPlans(HA_URL, HA_TOKEN, OPT.rate_entity);
  const tz = new TZ('America/Chicago');
  const cost = new Map(); let unpriced = 0;
  for (const [ms, kwh] of reads) {
    const ri = rateInfo(tz.parts(ms), plans);
    if (!ri) { unpriced++; continue; }
    cost.set(ms, +(kwh * ri.rate).toFixed(6));
  }
  if (unpriced) log(`${unpriced} hour(s) fell outside every rate plan and were not priced`);
  return cost;
}


// ---------- one sync run ----------
async function runSync() {
  const { FROM, TO } = windowFor();
  log(`=== sync ${FROM} .. ${TO}${DRY ? ' (dry run)' : ''}${COST_ONLY ? ' (cost only, from stored consumption)' : ''}`);
  const prev = lastRun();
  try {
    let reads, requests = 0, res = { imported: 0 };
    if (COST_ONLY) {
      reads = await loadStoredReads(FROM, TO);
      log(`loaded ${reads.size} stored hourly reads from HA`);
    } else {
      ({ reads, requests } = await fetchReads(FROM, TO));
      log(`fetched ${reads.size} hourly reads in ${requests} request(s)`);
      res = await importStats(reads, SID, OPT.statistic_name, 'kWh');
      log(`imported ${res.imported} consumption rows${res.first ? ` (${res.first} .. ${res.last}, ${res.kwh.toFixed(1)} kWh)` : ''}`);
    }
    const cost = await priceReads(reads);
    const cres = await importStats(cost, COST_SID, OPT.cost_statistic_name || ((OPT.statistic_name || '') + ' cost'), null);
    log(`imported ${cres.imported} cost rows${cres.first ? ` ($${cres.kwh.toFixed(2)})` : ''}`);
    fs.writeFileSync(LAST_RUN, JSON.stringify({ ok: true, at: new Date().toISOString(), from: FROM, to: TO, last_ok_to: DRY ? prev.last_ok_to : TO, ...res, cost_rows: cres.imported, cost_usd: cres.kwh }, null, 1));
    if (OPT.backfill_from) log('backfill_from is set in the options - clear it now that the backfill has run');
    await dismiss();
    return true;
  } catch (e) {
    log('FAILED:', e.message);
    fs.writeFileSync(LAST_RUN, JSON.stringify({ ok: false, at: new Date().toISOString(), last_ok_to: prev.last_ok_to, error: e.message }, null, 1));
    await notify(e.needLogin ? 'Evergy sync needs attention' : 'Evergy sync failed', `${e.message}\n\n(Evergy Sync add-on, ${new Date().toLocaleString('en-US', { timeZone: TZNAME })})`);
    return false;
  }
}

// ---------- scheduler ----------
function msUntil(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const now = new Date();
  for (let d = 0; d < 3; d++) {
    const ds = addDays(todayLocal(), d);
    // find the UTC instant of ds hh:mm in TZNAME by probing the offset
    const guess = new Date(`${ds}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
    const local = new Date(guess.toLocaleString('en-US', { timeZone: TZNAME }));
    const t = guess.getTime() + (guess.getTime() - local.getTime());
    if (t > now.getTime() + 1000) return t - now.getTime();
  }
  return DAY;
}

if (require.main === module) (async () => {
  if (!HA_TOKEN) { log('no HA token (SUPERVISOR_TOKEN / HA_TOKEN)'); process.exit(1); }
  if (ONCE) process.exit((await runSync()) ? 0 : 1);
  log(`evergy-sync add-on: daily at ${OPT.run_at} ${TZNAME}; statistic ${SID}`);
  if (OPT.run_on_start !== false && lastRun().last_ok_to !== todayLocal()) { log('start-up run (today not synced yet)'); await runSync(); }
  else log('start-up run skipped (already synced today or disabled)');
  for (;;) {
    const wait = msUntil(OPT.run_at);
    log(`next run in ${(wait / 3600000).toFixed(1)} h`);
    await sleep(wait);
    await runSync();
  }
})();

module.exports = { windowFor, msUntil };
