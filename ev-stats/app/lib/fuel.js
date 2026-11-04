'use strict';
/*
 * Fuel prices.
 *   EIA  - weekly retail prices per PADD region, back to the 1990s, no API key:
 *          https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=<series>&f=W  (HTML table)
 *   AAA  - today's / yesterday's / week-month-year-ago averages per state and metro area:
 *          https://gasprices.aaa.com/?state=XX  (HTML tables)
 * Both are parsed from the HTML with regular expressions; fixtures in test/ pin the layout.
 */
const GRADES = ['regular', 'midgrade', 'premium', 'diesel'];
const GRADE_LABEL = { regular: 'Regular', midgrade: 'Midgrade', premium: 'Premium', diesel: 'Diesel' };

// EIA series ids: EMM_EPM<R|M|P>_PTE_<area>_DPG = all-formulations retail gasoline, EMD_EPD2D_PTE_<area>_DPG = No 2 diesel.
// Areas: NUS (U.S.), R10 East Coast, R1X New England, R1Y Central Atlantic, R1Z Lower Atlantic, R20 Midwest, R30 Gulf Coast,
// R40 Rocky Mountain, R50 West Coast, R5XCA West Coast less California, SCA California, SCO Colorado, SFL Florida,
// SMA Massachusetts, SMN Minnesota, SNY New York, SOH Ohio, STX Texas, SWA Washington, Y05SF San Francisco, Y05LA Los Angeles,
// Y35NY New York City, Y44HO Houston, Y48SE Seattle, Y12CH Chicago, Y12CL Cleveland, Y08DE Denver, Y1MIA Miami, Y1BOS Boston.
const EIA_SERIES = (area) => ({ regular: `EMM_EPMR_PTE_${area}_DPG`, midgrade: `EMM_EPMM_PTE_${area}_DPG`, premium: `EMM_EPMP_PTE_${area}_DPG`, diesel: `EMD_EPD2D_PTE_${area}_DPG` });
const eiaUrl = (series) => `https://www.eia.gov/dnav/pet/hist/LeafHandler.ashx?n=PET&s=${series}&f=W`;
const aaaUrl = (state) => `https://gasprices.aaa.com/?state=${encodeURIComponent(state)}`;

const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;| /g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** EIA weekly table -> [['YYYY-MM-DD', price], ...] ascending (dates are the Monday of each week). */
function parseEia(html) {
  const out = [];
  for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
    const cells = (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) || []).map(strip);
    const m = /^(\d{4})-(\w{3})$/.exec(cells[0] || ''); if (!m) continue;
    const year = +m[1];
    for (let i = 1; i + 1 < cells.length; i += 2) {
      const d = /^(\d{1,2})\/(\d{1,2})$/.exec(cells[i]); const v = Number(cells[i + 1]);
      if (!d || !Number.isFinite(v) || !cells[i + 1]) continue;
      // the row is labelled with the month of its first week; a week on the 1st-7th of the next month keeps the row's year except Dec -> Jan
      const mon = +d[1], y = (m[2] === 'Dec' && mon === 1) ? year + 1 : year;
      out.push([`${y}-${String(mon).padStart(2, '0')}-${String(+d[2]).padStart(2, '0')}`, v]);
    }
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** AAA state page -> { state: {name, prices}, areas: {name: prices}, national, as_of } where prices = {regular: {current, yesterday, week_ago, month_ago, year_ago}, ...}. */
function parseAaa(html) {
  const tables = [];
  const re = /<table class="table-mob">([\s\S]*?)<\/table>/g; let m, last = 0;
  while ((m = re.exec(html))) {
    const before = html.slice(last, m.index); last = re.lastIndex;
    const h3 = [...before.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/g)].pop();
    const h1 = [...before.matchAll(/<h1 class="nati">([\s\S]*?)<\/h1>/g)].pop();
    const title = h3 ? strip(h3[1]) : h1 ? strip(h1[1]).replace(/\s*average gas prices.*$/i, '') : '';
    const head = (m[1].match(/<th[^>]*>[\s\S]*?<\/th>/g) || []).map(strip).map(gradeKey);
    const rows = {};
    for (const tr of m[1].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || []) {
      const cells = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) || []).map(strip);
      const key = periodKey(cells[0]); if (!key) continue;
      cells.slice(1).forEach((c, i) => { const g = head[i + 1]; const v = Number(c.replace(/[$,]/g, '')); if (g && Number.isFinite(v) && c) (rows[g] = rows[g] || {})[key] = v; });
    }
    if (Object.keys(rows).length) tables.push({ title, kind: h3 ? 'area' : 'state', prices: rows });
  }
  const state = tables.find((t) => t.kind === 'state');
  const areas = {}; for (const t of tables) if (t.kind === 'area') areas[t.title] = t.prices;
  const nat = /National Average[\s\S]*?\$(\d+\.\d+)/.exec(html);
  const asOf = /Price as of[\s\S]*?(\d{1,2}\/\d{1,2}\/\d{2,4})/.exec(html);
  return { state: state ? { name: state.title, prices: state.prices } : null, areas, national: nat ? Number(nat[1]) : null, as_of: asOf ? usDate(asOf[1]) : null };
}
function gradeKey(s) { s = s.toLowerCase(); return s.startsWith('reg') ? 'regular' : s.startsWith('mid') ? 'midgrade' : s.startsWith('prem') ? 'premium' : s.startsWith('die') ? 'diesel' : null; }
function periodKey(s) { s = (s || '').toLowerCase(); return s.startsWith('current') ? 'current' : s.startsWith('yesterday') ? 'yesterday' : s.startsWith('week') ? 'week_ago' : s.startsWith('month') ? 'month_ago' : s.startsWith('year') ? 'year_ago' : null; }
function usDate(s) { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s); if (!m) return null; const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; }

/**
 * Daily price lookup. weekly: {grade: [[date, price]...]} (EIA, ascending); daily: {date: {grade: price}} (AAA snapshots).
 * price(date, grade): the AAA snapshot on the latest date <= date if it is less than 8 days old, else the EIA week containing date.
 */
function priceSeries(weekly, daily) {
  const days = Object.keys(daily || {}).sort();
  const dayIdx = new Map(days.map((d, i) => [d, i]));
  const lastLE = (arr, d, key) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (key(arr[m]) <= d) lo = m + 1; else hi = m; } return lo - 1; };
  const dayDiff = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  return {
    price(date, grade) {
      const i = lastLE(days, date, (x) => x);
      if (i >= 0 && dayDiff(days[i], date) < 8) { const v = daily[days[i]][grade]; if (v != null) return { price: v, source: 'aaa', as_of: days[i] }; }
      const w = (weekly || {})[grade] || []; const j = lastLE(w, date, (x) => x[0]);
      if (j >= 0) return { price: w[j][1], source: 'eia', as_of: w[j][0] };
      return null;
    },
    hasDaily: (d) => dayIdx.has(d),
  };
}

module.exports = { GRADES, GRADE_LABEL, EIA_SERIES, eiaUrl, aaaUrl, parseEia, parseAaa, priceSeries, usDate };
