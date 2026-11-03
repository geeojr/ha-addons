'use strict';
/**
 * Evergy sign-in over plain HTTP - no browser.
 *
 * Evergy's login page embeds a PingOne "DaVinci" widget. Signing in is a short JSON
 * conversation with that widget followed by one call back to evergy.com that turns the
 * widget's token into the normal site session cookies. From there /api/sso/jwt hands out
 * the Opower bearer token used for usage reads. Sequence (one request each):
 *   1. GET  /log-in                       -> widget settings (company id, api root, policy id, ...)
 *   2. GET  {orchestrate-api}/sdktoken     -> widget access token
 *   3. GET  {api}/davinci/policy/{id}/start -> flow ids
 *   4. POST customHTMLTemplate {continue}   -> login form step
 *   5. POST customHTMLTemplate {username,password}
 *   6. POST customHTMLTemplate {continue}   -> may already carry the session token;
 *      otherwise 7/8. POST setCookieWithoutUser (complete) twice
 *   9. POST evergy.com {post_processing_api} with the token -> site session cookies
 *  10. GET  /api/sso/jwt                   -> Opower bearer (response header "jwt")
 *
 * Exactly one attempt per call. Wrong username / password is reported, never retried.
 */

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

class AuthError extends Error { constructor(m) { super(m); this.name = 'AuthError'; this.invalidAuth = true; } }

/** Minimal cookie jar keyed by host suffix; enough for evergy.com + pingone. */
class Jar {
  constructor() { this.cookies = new Map(); } // key host|name -> { name, value, domain }
  store(url, setCookies) {
    const host = new URL(url).hostname;
    for (const sc of setCookies || []) {
      const [pair, ...attrs] = sc.split(';');
      const eq = pair.indexOf('='); if (eq < 0) continue;
      const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
      let domain = host;
      for (const a of attrs) { const [k, v] = a.trim().split('='); if (/^domain$/i.test(k) && v) domain = v.replace(/^\./, ''); }
      const expired = attrs.some((a) => /^max-age=0$/i.test(a.trim())) || attrs.some((a) => /^expires=/i.test(a.trim()) && Date.parse(a.trim().slice(8)) < Date.now());
      if (expired) this.cookies.delete(domain + '|' + name); else this.cookies.set(domain + '|' + name, { name, value, domain });
    }
  }
  header(url) {
    const host = new URL(url).hostname;
    return [...this.cookies.values()].filter((c) => host === c.domain || host.endsWith('.' + c.domain)).map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

/** fetch with cookies, manual redirects (so cookies survive them) and a timeout. */
async function http(jar, url, { method = 'GET', headers = {}, body, redirect = true, timeout = 30000 } = {}) {
  let u = url;
  for (let hop = 0; hop < 6; hop++) {
    const h = { 'User-Agent': USER_AGENT, Accept: 'application/json, text/html;q=0.9, */*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', ...headers };
    const ck = jar.header(u); if (ck) h.Cookie = ck;
    const r = await fetch(u, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    jar.store(u, r.headers.getSetCookie ? r.headers.getSetCookie() : []);
    if (redirect && r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      u = new URL(r.headers.get('location'), u).href; method = 'GET'; body = undefined; continue;
    }
    return r;
  }
  throw new Error('too many redirects for ' + url);
}

function widgetSettings(html) {
  const m = html.match(/<div[^>]*class="[^"]*davinci-widget-wrapper[^"]*"[^>]*>/);
  if (!m) throw new Error('login page has no davinci widget (site changed?)');
  const attr = (k) => { const a = m[0].match(new RegExp(`data-davinci-${k}="([^"]*)"`)); return a ? a[1] : null; };
  const s = { company_id: attr('company-id'), sk_api_key: attr('sk-api-key'), api_root: attr('api-root'), policy_id: attr('policy-id'), post_processing_api: attr('post-processing-api'), datasource_item_id: attr('datasource-item-id') };
  for (const [k, v] of Object.entries(s)) if (!v) throw new Error(`login widget is missing ${k}`);
  return s;
}

async function json(r, what) {
  const t = await r.text();
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${t.slice(0, 160)}`);
  try { return JSON.parse(t); } catch { throw new Error(`${what}: not JSON: ${t.slice(0, 120)}`); }
}

/**
 * Sign in; resolves { jar, jwt } (the Opower bearer). Throws AuthError (invalidAuth) for a bad
 * username/password or if the site asks for something else (a verification step), plain Error
 * for connectivity / site-change problems.
 */
async function login(username, password, log = () => {}) {
  const jar = new Jar();
  const page = await http(jar, 'https://www.evergy.com/log-in');
  const w = widgetSettings(await page.text());
  const api = (p) => `${w.api_root}/${w.company_id}/davinci/${p}`;
  const widget = (p, body, extra = {}) => http(jar, api(p), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://www.evergy.com', Referer: 'https://www.evergy.com/', ...extra }, body: JSON.stringify(body), redirect: false });

  const sdk = await json(await http(jar, `${w.api_root.replace('auth', 'orchestrate-api')}/v1/company/${w.company_id}/sdktoken`, { headers: { 'x-sk-api-key': w.sk_api_key, Origin: 'https://www.evergy.com', Referer: 'https://www.evergy.com/' } }), 'widget token');
  let token = sdk.access_token;
  const start = await json(await http(jar, api(`policy/${w.policy_id}/start`), { headers: { Authorization: 'Bearer ' + token, Origin: 'https://www.evergy.com', Referer: 'https://www.evergy.com/' } }), 'start flow');
  let { id, connectionId, flowId } = start;
  const form = await json(await widget(`connections/${connectionId}/capabilities/customHTMLTemplate`, { id, eventName: 'continue' }, { interactionId: start.interactionId }), 'login form');
  id = form.id;
  if (!username || !password) return { jar, step: 'form', settings: w }; // probe mode: everything before credentials works

  const sub = await json(await widget(`connections/${connectionId}/capabilities/customHTMLTemplate`, {
    id, eventName: 'continue',
    nextEvent: { constructType: 'skEvent', eventName: 'continue', params: [], eventType: 'post', postProcess: {} },
    parameters: { buttonType: 'form-submit', buttonValue: 'submit', username, password },
  }), 'submit credentials');
  if (sub.flowId && sub.flowId !== flowId) throw new AuthError('Evergy rejected the username (no such user)');
  if (sub.id === id) throw new AuthError('Evergy rejected the password');
  if (sub.httpResponseCode && sub.httpResponseCode >= 400) throw new AuthError(`Evergy sign-in refused: ${sub.message || sub.httpResponseCode}`);
  id = sub.id;

  const next = await json(await widget(`connections/${connectionId}/capabilities/customHTMLTemplate`, { id, eventName: 'continue' }), 'after credentials');
  id = next.id; connectionId = next.connectionId || connectionId;
  if (next.access_token) token = next.access_token;
  else {
    const c1 = await json(await widget(`connections/${connectionId}/capabilities/setCookieWithoutUser`, { eventName: 'complete', parameters: {}, id }), 'complete 1');
    id = c1.id;
    const c2 = await json(await widget(`connections/${connectionId}/capabilities/setCookieWithoutUser`, { eventName: 'complete', parameters: {}, id }), 'complete 2');
    id = c2.id; token = c2.access_token;
    if (!token) {
      const hint = JSON.stringify(c2).slice(0, 200);
      throw new AuthError(/verif|otp|mfa|code/i.test(hint) ? `Evergy asked for a verification step: ${hint}` : `no session token from Evergy: ${hint}`);
    }
  }
  const post = await http(jar, 'https://www.evergy.com' + w.post_processing_api, { method: 'POST', headers: { 'Content-Type': 'application/json', Referer: 'https://www.evergy.com/log-in' }, body: JSON.stringify({ Token: token, DataSourceItemId: w.datasource_item_id }) });
  if (!post.ok) throw new Error(`Evergy session hand-off failed: HTTP ${post.status} ${(await post.text()).slice(0, 160)}`);
  log('signed in to evergy.com');
  const jwt = await opowerToken(jar);
  return { jar, jwt };
}

/** Opower bearer for the current evergy.com session. */
async function opowerToken(jar) {
  const r = await http(jar, 'https://www.evergy.com/api/sso/jwt');
  const jwt = (r.headers.get('jwt') || '').replace(/^Bearer /, '');
  if (!r.ok || !jwt) throw Object.assign(new Error(`no Opower token from Evergy (HTTP ${r.status})`), { noSession: true });
  return jwt;
}

/** Opower subdomain + utility account list for this login (one call each). */
async function accounts(jar, jwt, subdomainHint) {
  let subdomain = subdomainHint;
  try {
    const r = await http(jar, 'https://www.evergy.com/sc-api/account/getaccountpremiseselector?isWidgetPage=false&hasNoSelector=false');
    const d = await json(r, 'account selector');
    const dom = d && d[0] && d[0].oPowerDomain; if (dom) subdomain = dom.split('.')[0];
  } catch (e) { if (!subdomain) throw e; }
  const r = await http(jar, `https://${subdomain}.opower.com/ei/edge/apis/multi-account-v1/cws/${subdomain}/customers/current`, { headers: { Authorization: 'Bearer ' + jwt } });
  const cur = await json(r, 'Opower customer');
  const list = (cur.utilityAccounts || []).map((a) => ({ uuid: a.uuid, number: a.utilityAccountId || a.preferredUtilityAccountId, type: a.meterType, resolution: a.readResolution }));
  return { subdomain, accounts: list };
}

module.exports = { login, opowerToken, accounts, http, Jar, AuthError, USER_AGENT };
