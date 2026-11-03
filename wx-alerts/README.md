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

Everything is configured in the panel and stored in the add-on's `/data`. No options needed.
