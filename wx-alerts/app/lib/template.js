'use strict';
/*
 * Announcement text for one NWS alert: variables pulled from the alert, rendered
 * through a user template.
 *
 * Template syntax (kept deliberately small):
 *   {event}            a variable; unknown/empty variables render as ''
 *   {hazards|none}     '|' gives a fallback used when the variable is empty
 *   [ Hazards include {hazards}.]   a bracketed section is dropped entirely if ANY
 *                      variable inside it is empty (so sentences don't dangle)
 *   \[ \]              literal brackets
 */

const HAIL_NAMES = [ // inches -> common name, as the NWS impact statements use
  [0.25, 'pea'], [0.5, 'marble'], [0.75, 'penny'], [0.88, 'nickel'], [1.0, 'quarter'],
  [1.25, 'half dollar'], [1.5, 'ping pong ball'], [1.75, 'golf ball'], [2.0, 'hen egg'],
  [2.5, 'tennis ball'], [2.75, 'baseball'], [3.0, 'tea cup'], [4.0, 'softball'], [4.5, 'grapefruit'],
];
const hailName = (inches) => { for (const [sz, n] of HAIL_NAMES) if (Math.abs(inches - sz) < 0.07) return n; return null; };
const num = (s) => { const m = String(s ?? '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : null; };
const trimDot = (s) => String(s || '').trim().replace(/\.+$/, '');
const lower1 = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** "1.75 inch hail" -> spoken "one and three quarter inch" is TTS-hostile; say the size name when we know it. */
function hailText(inches) {
  if (inches == null || !(inches > 0)) return '';
  const n = hailName(inches);
  const size = Number.isInteger(inches) ? `${inches} inch` : `${inches.toFixed(2).replace(/0$/, '')} inch`;
  return n ? `${n} size hail (${size})` : `${size} hail`;
}

function fmtTime(iso, tz, { withDay = false } = {}) {
  if (!iso) return '';
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
  const t = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d);
  if (!withDay) return t;
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(d);
  return `${t} ${day}`;
}
const sameLocalDay = (a, b, tz) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date(a)) === f.format(new Date(b));
};

/** NWS product class from its name; every product name ends in its class. */
function alertClass(event) {
  const e = String(event || '');
  if (/warning$/i.test(e)) return 'Warning';
  if (/watch$/i.test(e)) return 'Watch';
  if (/advisory$/i.test(e)) return 'Advisory';
  if (/statement$/i.test(e)) return 'Statement';
  if (/emergency$/i.test(e)) return 'Emergency';
  return 'Other';
}

/** The "HAZARD...", "SOURCE...", "IMPACT..." lines of a warning's description. */
function sections(description) {
  const out = {};
  const re = /^\s*([A-Z][A-Z ]{2,30}?)\.\.\.(.+?)(?=\n\s*\n|\n\s*[A-Z][A-Z ]{2,30}?\.\.\.|$)/gms;
  let m;
  while ((m = re.exec(String(description || '')))) out[m[1].trim().toLowerCase()] = m[2].replace(/\s+/g, ' ').trim();
  return out;
}

/*
 * Levels: the tiers inside a product that the NWS marks with damage-threat / detection
 * tags (or, for older-style products, with text). Each level is its own row in the
 * config so "Tornado Emergency" can be louder than "Tornado Warning (radar indicated)".
 * Listed most specific first; levelOf() returns the first match.
 */
const LEVELS = {
  'Tornado Warning': [
    { sub: 'emergency', label: 'Tornado Emergency', test: (t) => t.tornadoThreat === 'catastrophic' || /TORNADO EMERGENCY/i.test(t.text) },
    { sub: 'pds', label: 'Tornado Warning (PDS)', test: (t) => t.tornadoThreat === 'considerable' || /PARTICULARLY DANGEROUS SITUATION/i.test(t.text) },
    { sub: 'observed', label: 'Tornado Warning (observed)', test: (t) => t.tornado === 'observed' },
    { sub: 'radar', label: 'Tornado Warning (radar indicated)', test: (t) => t.tornado === 'radar indicated' },
  ],
  'Severe Thunderstorm Warning': [
    { sub: 'destructive', label: 'Severe Thunderstorm Warning (destructive)', test: (t) => t.tstmThreat === 'destructive' },
    { sub: 'considerable', label: 'Severe Thunderstorm Warning (considerable)', test: (t) => t.tstmThreat === 'considerable' },
  ],
  'Flash Flood Warning': [
    { sub: 'emergency', label: 'Flash Flood Emergency', test: (t) => t.floodThreat === 'catastrophic' || /FLASH FLOOD EMERGENCY/i.test(t.text) },
    { sub: 'considerable', label: 'Flash Flood Warning (considerable)', test: (t) => t.floodThreat === 'considerable' },
  ],
  'Tornado Watch': [{ sub: 'pds', label: 'Tornado Watch (PDS)', test: (t) => /PARTICULARLY DANGEROUS SITUATION/i.test(t.text) }],
  'Severe Thunderstorm Watch': [{ sub: 'pds', label: 'Severe Thunderstorm Watch (PDS)', test: (t) => /PARTICULARLY DANGEROUS SITUATION/i.test(t.text) }],
};

function tags(feature) {
  const p = feature.properties || {}; const prm = p.parameters || {};
  const first = (k) => String((Array.isArray(prm[k]) ? prm[k][0] : prm[k]) ?? '').toLowerCase();
  return {
    tornado: first('tornadoDetection'), tornadoThreat: first('tornadoDamageThreat'),
    tstmThreat: first('thunderstormDamageThreat'), floodThreat: first('flashFloodDamageThreat'),
    text: `${p.headline || ''}\n${first('NWSheadline')}\n${p.description || ''}`,
  };
}

/** { key, label, base, sub } - key is "<event>" or "<event>/<sub>"; config rows are keyed by it. */
function levelOf(feature) {
  const event = String((feature.properties || {}).event || '');
  const t = tags(feature);
  for (const lv of LEVELS[event] || []) if (lv.test(t)) return { key: `${event}/${lv.sub}`, label: lv.label, base: event, sub: lv.sub };
  return { key: event, label: event, base: event, sub: '' };
}

/** Every config row: each product from the NWS list, followed by its levels. */
function allLevels(eventTypes) {
  const out = [];
  for (const ev of eventTypes) {
    out.push({ key: ev, label: ev, base: ev, sub: '', class: alertClass(ev) });
    for (const lv of LEVELS[ev] || []) out.push({ key: `${ev}/${lv.sub}`, label: lv.label, base: ev, sub: lv.sub, class: alertClass(ev) });
  }
  return out;
}

/**
 * All template variables for one alert feature.
 * `ctx`: { tz, now, target: 'home' | person name, where: 'your location' | 'Jennifer's location' }
 */
function variables(feature, ctx = {}) {
  const p = feature.properties || {};
  const prm = p.parameters || {};
  const first = (k) => (Array.isArray(prm[k]) ? prm[k][0] : prm[k]) ?? '';
  const tz = ctx.tz || 'America/Chicago';
  const now = ctx.now || Date.now();
  const sec = sections(p.description);

  const hailIn = num(first('maxHailSize'));
  const windMph = num(first('maxWindGust'));
  const tornado = String(first('tornadoDetection') || '').toLowerCase();       // "radar indicated" | "observed" | "possible"
  const tstm = String(first('thunderstormDamageThreat') || '').toLowerCase();  // "considerable" | "destructive"
  const flood = String(first('flashFloodDamageThreat') || '').toLowerCase();   // "considerable" | "catastrophic"
  const hail = hailText(hailIn);
  const wind = windMph ? `${Math.round(windMph)} mile per hour winds` : '';
  const hz = [];
  if (tornado) hz.push(tornado === 'observed' ? 'a confirmed tornado' : `a ${tornado} tornado`);
  if (hail) hz.push(hail);
  if (wind) hz.push(wind);
  if (flood) hz.push(`${flood} flash flooding`);
  let hazards = hz.join(', ').replace(/, ([^,]*)$/, ' and $1');
  if (!hazards && sec.hazard) hazards = lower1(trimDot(sec.hazard));
  const endIso = p.ends || p.expires;
  const until = fmtTime(endIso, tz, { withDay: !!endIso && !sameLocalDay(endIso, now, tz) });
  const lv = levelOf(feature);
  const t = tags(feature);
  const pds = lv.sub === 'pds' || t.tornadoThreat === 'considerable' || /PARTICULARLY DANGEROUS SITUATION/i.test(t.text) ? 'particularly dangerous situation' : '';
  const emergency = lv.sub === 'emergency' ? lv.label : '';

  return {
    event: p.event || '',
    class: alertClass(p.event),
    level: lv.label, level_key: lv.key,
    detection: tornado, pds, emergency,
    damage_threat: t.tornadoThreat || tstm || flood,
    until,
    until_time: fmtTime(endIso, tz),
    issued: fmtTime(p.sent || p.effective, tz),
    hazards, hail, wind,
    tornado, threat: tstm || flood,
    hazard_line: trimDot(sec.hazard), source_line: trimDot(sec.source), impact_line: trimDot(sec.impact),
    motion: trimDot(first('eventMotionDescription') ? '' : (sec['moving'] || '')) || '',
    area: p.areaDesc || '',
    headline: p.headline || '',
    nws_headline: first('NWSheadline') || '',
    description: String(p.description || '').replace(/\s+/g, ' ').trim(),
    instruction: String(p.instruction || '').replace(/\s+/g, ' ').trim(),
    sender: String(p.senderName || '').replace(/^NWS\s+/i, ''),
    severity: p.severity || '', certainty: p.certainty || '', urgency: p.urgency || '',
    message_type: p.messageType || '',
    target: ctx.target || 'home',
    where: ctx.where || 'your location',
    name: ctx.name || '',
    id: feature.id || '',
  };
}

/** Render a template against a variable map (see syntax above). */
function render(template, vars) {
  const str = String(template || '');
  const sub = (s) => s.replace(/\{([a-z_]+)(?:\|([^}]*))?\}/gi, (_, k, fb) => {
    const v = vars[k.toLowerCase()];
    return v == null || v === '' ? (fb ?? '') : String(v);
  });
  // bracketed sections: drop when any variable inside is empty (fallbacks count as present)
  let out = str.replace(/\\\[/g, '\u0001').replace(/\\\]/g, '\u0002');
  out = out.replace(/\[([^\[\]]*)\]/g, (_, inner) => {
    const missing = [...inner.matchAll(/\{([a-z_]+)(?:\|([^}]*))?\}/gi)].some(([, k, fb]) => {
      const v = vars[k.toLowerCase()]; return (v == null || v === '') && fb == null;
    });
    return missing ? '' : sub(inner);
  });
  out = sub(out).replace(/\u0001/g, '[').replace(/\u0002/g, ']');
  return out.replace(/[ \t]+/g, ' ').replace(/ +([.,;!?])/g, '$1').replace(/\s+\n/g, '\n').trim();
}

const DEFAULT_TEMPLATES = {
  voice: 'Attention. A {event} has been issued for {where} until {until}.[ This is a {pds}.][ Hazards include {hazards}.]',
  push_title: '{level}',
  push_body: 'Until {until}[ · {hazards}].[ {area}]',
};
/** Per-level wording that ships by default; the panel can change or clear any of it. */
const DEFAULT_LEVEL_TEMPLATES = {
  'Tornado Warning/observed': { voice: 'Attention. A Tornado Warning is in effect for {where} until {until}. A tornado has been observed.[ Hazards include {hazards}.] Take cover now.' },
  'Tornado Warning/pds': { voice: 'Attention. A particularly dangerous situation. A Tornado Warning is in effect for {where} until {until}.[ Hazards include {hazards}.] Take cover now.' },
  'Tornado Warning/emergency': { voice: 'Tornado Emergency for {where}. A tornado emergency has been declared until {until}.[ Hazards include {hazards}.] This is a life threatening situation. Take cover immediately.', push_title: 'TORNADO EMERGENCY' },
  'Severe Thunderstorm Warning/destructive': { voice: 'Attention. A destructive Severe Thunderstorm Warning has been issued for {where} until {until}.[ Hazards include {hazards}.] Treat this storm like a tornado.' },
  'Flash Flood Warning/emergency': { voice: 'Flash Flood Emergency for {where} until {until}. This is a life threatening situation. Move to higher ground now.', push_title: 'FLASH FLOOD EMERGENCY' },
};

const VARIABLE_HELP = [
  ['event', 'Product name, e.g. "Tornado Warning"'],
  ['level', 'The matched level, e.g. "Tornado Emergency", "Tornado Warning (observed)"; same as {event} when there is no tier'],
  ['detection', 'Tornado detection: "radar indicated" / "observed" / "possible"'],
  ['pds', '"particularly dangerous situation" when the product is PDS-tagged, else empty'],
  ['emergency', '"Tornado Emergency" / "Flash Flood Emergency", else empty'],
  ['damage_threat', 'considerable / destructive / catastrophic'],
  ['class', 'Warning / Watch / Advisory / Statement / Other'],
  ['until', 'Local end time, e.g. "11:35 PM" (adds the weekday if not today)'],
  ['until_time', 'End time only, never a weekday'],
  ['issued', 'Local time the alert was sent'],
  ['hazards', 'Spoken hazard list from the alert parameters: tornado detection, hail size, wind gusts, flood threat; falls back to the HAZARD... line'],
  ['hail', 'e.g. "golf ball size hail (1.75 inch)"'],
  ['wind', 'e.g. "70 mile per hour winds"'],
  ['tornado', '"radar indicated" / "observed" / "possible" / empty'],
  ['threat', 'Damage threat tag: considerable / destructive / catastrophic'],
  ['hazard_line', 'The HAZARD... line of the product text'],
  ['source_line', 'The SOURCE... line'],
  ['impact_line', 'The IMPACT... line'],
  ['area', 'Counties / areas named in the alert'],
  ['headline', 'NWS one-line headline'],
  ['nws_headline', 'The product\'s NWSheadline parameter (watches, advisories)'],
  ['instruction', 'The call-to-action text (can be long)'],
  ['description', 'The full product text (long - what the old feed read out)'],
  ['sender', 'Issuing office, e.g. "Kansas City/Pleasant Hill MO"'],
  ['severity', 'Extreme / Severe / Moderate / Minor'],
  ['where', '"your location" at home; "<name>\'s location" for a person'],
  ['name', 'The person\'s name (empty for home)'],
];

module.exports = { variables, render, alertClass, sections, hailText, fmtTime, levelOf, allLevels, LEVELS, DEFAULT_TEMPLATES, DEFAULT_LEVEL_TEMPLATES, VARIABLE_HELP };
