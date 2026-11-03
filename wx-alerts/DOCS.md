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

## SPC day 1 outlook sensors

The Storm Prediction Center's **day 1 categorical outlook** is checked at home and at each
person's position and published as one sensor per target, with the risk as a plain number so
automations can compare on it:

| State | Category |
|---|---|
| 0 | none |
| 1 | General Thunderstorms |
| 2 | Marginal Risk |
| 3 | Slight Risk |
| 4 | Enhanced Risk |
| 5 | Moderate Risk |
| 6 | High Risk |

Entities: `sensor.wx_spc_day1_home` and `sensor.wx_spc_day1_<person>` (the part after `person.`;
the prefix is configurable). Attributes: `label`, `code` (TSTM/MRGL/SLGT/ENH/MDT/HIGH), `issued`,
`valid`, `expire`, `forecaster`, the position checked and the person's zone. The state is
`unknown` for a person whose phone has no position. The HA event `wx_spc` fires whenever a
target's level changes (`level`, `previous`, `target`, `entity` ...), so a person driving into a
higher-risk area is picked up within one poll.

Sensors are created through MQTT discovery (device "WX Alerts") when MQTT is enabled, so they
survive restarts; with MQTT off they are set through the states API instead and reappear after
a Home Assistant restart on the next poll. The outlook file is re-fetched at most every
`spc.poll_minutes` (default 10, conditional requests) and the *Status* tab shows the current
level for every target plus the outlook's issue/valid times. Settings live on the *People* tab.

Everything else is configured in the panel and stored in the add-on's `/data`.

Option `nws_contact`: an e-mail address sent in the User-Agent to api.weather.gov, which the NWS asks for so they can reach you if the client misbehaves.
