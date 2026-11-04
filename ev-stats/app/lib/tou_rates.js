// Time-of-use rate lookup - a mirror of /config/custom_templates/tou_rates.jinja and the
// logic in tou-cost-card.js. The plans themselves are NOT duplicated here: they are read
// from sensor.electricity_rate's `plans` attribute so all three stay in sync.
const pad = (n) => String(n).padStart(2, '0');

class TZ {
  constructor(tz) {
    this.f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    this.cache = new Map();
  }
  parts(ms) {
    const k = Math.floor(ms / 60000);
    let p = this.cache.get(k); if (p) return p;
    const o = {}; for (const x of this.f.formatToParts(new Date(ms))) o[x.type] = x.value;
    const y = +o.year, m = +o.month, d = +o.day, h = (+o.hour) % 24;
    const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(o.weekday);
    p = { y, m, d, h, wd, ds: `${y}-${pad(m)}-${pad(d)}` };
    if (this.cache.size > 200000) this.cache.clear();
    this.cache.set(k, p); return p;
  }
}

function holidayKey(p) {
  const { m, d, wd } = p;
  if (m === 1 && d === 1) return 'new_years_day';
  if (m === 5 && wd === 0 && d > 24) return 'memorial_day';
  if (m === 7 && d === 4) return 'independence_day';
  if (m === 9 && wd === 0 && d <= 7) return 'labor_day';
  if (m === 11 && wd === 3 && d >= 22 && d <= 28) return 'thanksgiving_day';
  if (m === 12 && d === 25) return 'christmas_day';
  return '';
}

function rateInfo(p, plans) {
  const plan = plans.find((x) => x.start <= p.ds && (x.end == null || p.ds < x.end));
  if (!plan) return null;
  const hk = holidayKey(p);
  const holiday = plan.holidays.includes(hk) ? hk : '';
  const dayType = holiday ? 'holiday' : (p.wd >= 5 ? 'weekend' : 'weekday');
  const season = plan.summer_months.includes(p.m) ? 'summer' : 'non_summer';
  const per = plan.periods.find((x) => x.start <= p.h && p.h < x.end);
  const tier = dayType !== 'weekday' && per.weekend_holiday_tier ? per.weekend_holiday_tier : per.tier;
  return { plan, season, dayType, holiday, period: per.name, tier, rate: plan.rates[season][tier] };
}

/** Fetch the rate plans from Home Assistant (sensor.electricity_rate attribute `plans`). */
async function fetchPlans(haUrl, token, entity = 'sensor.electricity_rate') {
  const r = await fetch(haUrl.replace(/\/$/, '') + '/api/states/' + entity, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error(`HA ${entity}: ${r.status}`);
  const plans = (await r.json()).attributes.plans;
  if (!Array.isArray(plans) || !plans.length) throw new Error(`${entity} has no plans attribute`);
  return plans;
}

module.exports = { TZ, holidayKey, rateInfo, fetchPlans };
