# WX Alerts

Polls `api.weather.gov` every two minutes for the alerts covering **home** (`zone.home`) and
**each person's phone position**, classifies each alert into a level (Tornado Warning radar
indicated / observed / PDS / Tornado Emergency, Severe Thunderstorm considerable /
destructive, Flash Flood considerable / emergency, PDS watches ...) and acts on the rules you
set in the panel (sidebar **WX Alerts**, admins only):

| Match at | Does |
|---|---|
| Home, rule *Announce* | MQTT `wx/alerts/home` (JSON) + spoken text on `wx/alert_voice` + HA event `wx_alert` |
| A person, rule *Push* | push through that person's `notify.mobile_app_*` + HA event `wx_alert` |

**New alerts only**: de-duplication is by the NWS event id (VTEC) per target, so updates,
continuations and cancellations never fire again. The first run notes existing alerts silently.

Wording uses `{variables}`, `{var|fallback}` and `[ sections that vanish when empty ]`; per-level
overrides live on each row. The *Test* tab can dry-run or really send a sample product.

**SPC day 1 outlook sensors**: `sensor.wx_spc_day1_home` and `sensor.wx_spc_day1_<person>` carry the
Storm Prediction Center's categorical risk at each position as a number (0 none, 1 general
thunderstorms, 2 marginal, 3 slight, 4 enhanced, 5 moderate, 6 high) for automations; the event
`wx_spc` fires when a target's level changes. Details in DOCS.md.

Everything else is configured in the panel and stored in the add-on's `/data`.

Option `nws_contact`: an e-mail address sent in the User-Agent to api.weather.gov, which the NWS asks for so they can reach you if the client misbehaves.
