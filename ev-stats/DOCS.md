# EV Stats

## What it computes

Every run (default every 5 minutes) the add-on reads the last hours of **raw recorder history** for
each vehicle's odometer and state-of-charge sensors and for every home charger's power sensor,
and turns them into one row per hour per vehicle:

| Row field | How |
|---|---|
| miles | odometer increases, booked in the hour they were reported |
| battery energy out | state-of-charge decreases × pack capacity; split into *driving* (the odometer moved in that interval) and *idle* (climate, Gear Guard, vampire drain) |
| battery energy in | state-of-charge increases × pack capacity (anywhere) |
| home energy | left-Riemann integral of the assigned charger's kW samples (a sample holds until the next one, so the long 0 kW gap before a charge adds nothing) |
| home cost | home energy × the TOU rate of that hour, from the `plans` attribute of the rate sensor (`sensor.electricity_rate`) |
| away energy | battery energy in − home energy × charging efficiency, floored at 0 — energy that must have come from somewhere else (DC fast charging). Only computed for hours where the home charger's data exists. The car reports its state of charge late (and an hourly mean lags by up to an hour), so an hour's unused home credit may still be claimed by the next hour before anything counts as away charging |

**Charging session check.** Consecutive hours with energy from the assigned port form a session. When
the vehicle's battery gain during the session (and up to *lag hours* after it, before the next
session — a sleeping car reports late) is below *match fraction* × wall kWh × charging efficiency,
the session was another car on that port: its kWh and cost move to `other_energy` / `other_cost` and
leave the vehicle's home charging, cost, savings and statistics. Sessions under *min kWh* or whose
largest hour is under *min peak kWh* (battery-conditioning trickle) are left alone, as are sessions
without battery data. The Status tab lists each vehicle's latest sessions with wall kWh, battery kWh,
ratio and verdict; the Vehicles tab shows who was assigned to each port over time.

On first start, after "Rebuild history", or when a vehicle's charger history is edited, the older
hours are **backfilled from HA's hourly long-term statistics** (odometer `change`, state-of-charge
hourly `mean`, charger power hourly `mean`) back to *Backfill from*. That is coarser: a charge and a
drive inside the same hour cancel out in the mean, so battery numbers for backfilled months are
estimates. A vehicle whose state-of-charge sensor has no long-term statistics (no `state_class`)
gets miles and home energy for the past but battery energy only from the raw days onwards; the
ratio metrics only use the miles of hours that have the matching data, and the Status tab says how
much of the window is covered.

### Windows and metrics

Windows are summed from the hourly rows: `Nd` = the trailing N×24 hours including the current one,
`today`, `week` (since Monday), `mtd`, `ytd`. Per window:

| Metric | Unit | Definition |
|---|---|---|
| miles | mi | Σ miles |
| home_energy | kWh | Σ home energy |
| home_cost | USD | Σ home cost |
| avg_rate | USD/kWh | home_cost / home_energy |
| away_energy | kWh | Σ away energy (battery side) |
| other_energy / other_cost | kWh / USD | Σ sessions on the assigned port booked as another vehicle's (not in home_energy / home_cost) |
| ev_cost | USD | home_cost + away_energy / efficiency × *price away from home* |
| battery_energy | kWh | Σ battery energy out (driving + idle) |
| drive_energy | kWh | Σ battery energy out while moving |
| charged_energy | kWh | Σ battery energy in |
| efficiency | mi/kWh | miles / drive_energy |
| consumption | kWh/100mi | battery_energy / miles × 100 |
| wall_consumption | kWh/100mi | home_energy / miles × 100 (only meaningful when all charging is at home) |
| cost_per_mile | USD/mi | ev_cost / miles |
| fuel_gallons | gal | Σ miles / equivalent MPG |
| fuel_cost | USD | Σ gallons × that day's price of the vehicle's grade |
| savings | USD | fuel_cost − ev_cost |
| savings_pct | % | savings / fuel_cost |
| energy_fuel_gallons | gal | Σ miles × gallons per mile from the measured driving energy (below) |
| energy_fuel_cost | USD | Σ those gallons × that day's price of the vehicle's grade |
| energy_savings | USD | energy_fuel_cost − ev_cost |
| energy_mpg | mpg | miles / energy_fuel_gallons — the MPG an engine car would need to match the EV's measured energy use |

### Fuel equivalent from energy

The `fuel_*` metrics assume an MPG. The `energy_*` metrics instead start from what the EV measurably
used: the driving rate (kWh per mile from the state-of-charge drops while the odometer moved) is
turned into the fuel an engine would burn for the same work,

```
wheel energy per mile = kWh/mi × EV drivetrain efficiency ÷ (1 − regen share)
gallons per mile      = wheel energy per mile ÷ (kWh per gallon × engine efficiency)
```

with the parameters on the Settings tab: gasoline 33.7 kWh/gal and diesel 37.7 kWh/gal (the lower
heating values the EPA uses for MPGe), engine + transmission efficiency 25 % (gasoline) / 30 %
(diesel) over a mixed drive cycle, EV drivetrain 88 % (battery → wheels), regen share 10 % (part of
the measured driving energy that was recovered braking energy, which an engine car would have to burn
fuel for; 0 to ignore). A vehicle can override the engine efficiency on the Vehicles tab (a diesel
grade helper selects the diesel values). The rate applied to a window's miles is the window's own raw
hours with battery data (≥ 50 mi), else its hours with any battery data, else the vehicle-wide rate
(from all raw hours), else the wall-side rate; statistics-backfilled hours under-count driving energy
(see above), so their own values are never used. The coverage line on the Status tab names the basis. as `sensor.<prefix>_<vehicle>_<metric>_<window>` (prefix `ev`),
one device per vehicle. Every sensor of a window carries **all** of that window's metrics plus
`vehicle`, `charger`, `fuel_grade`, `mpg_equivalent`, `capacity_kwh`, `from`, `to`, `hours`,
`raw_hours`, `energy_basis`, `energy_kwh_per_mile` and the energy parameters as attributes, so a
card can show the breakdown from any one of them. Two live sensors per vehicle:
`sensor.<prefix>_<vehicle>_charger` (the port it is on now, from its charger history; attributes `charging`, `charger_power_kw`,
`energy_mpg`, `drive_kwh_per_mile`, `plugged`, `detected_port`, the charge estimate) and `sensor.<prefix>_<vehicle>_fuel_price` (today's price of
its grade).

### Which port each vehicle uses

The add-on keeps every vehicle's **charger history** itself: port detection (below) and the port selects write
it, and you can edit it on the Vehicles tab when a vehicle used another charger in the past, then "Apply & rebuild".
A port taken by another vehicle, detected or chosen by hand, takes that port off the vehicle that had it. Unplugging
changes nothing. Versions before 1.3.0 read an `input_select` helper per vehicle; it is no longer used and can be deleted.

### Port detection

Give each charger its **status sensor** (any state other than `available` / `unavailable` /
`unknown` counts as plugged in) and each vehicle its **plug sensor** (`binary_sensor`). Every run
looks at the last *lookback hours* of both: a charger's plug-in is matched to the vehicle whose plug
sensor turned on closest in time, within *before* / *after* minutes, each vehicle event used once.
The result is kept per port and published as `select.<prefix>_charger_<port>_vehicle`: the vehicle's name,
`Unknown` while something nobody claimed is plugged in, or `None` when the port is free. Attributes: `status`,
`plugged`, `since`, `confidence`, `plug_delay_s`, `manual`, `candidates`. Confidence:

| Confidence | Meaning |
|---|---|
| manual | chosen by hand (beats everything until the port is unplugged) |
| high | the only unclaimed vehicle plug-in inside the window |
| medium | another unclaimed vehicle plug-in was within 2 minutes of the winner |
| low | the vehicle's plug sensor reported after the window, before the port was unplugged |
| history | plugged in since before the lookback; the one plugged-in vehicle whose history says this port |
| unclaimed / detecting | nobody claimed the plug-in (yet) |
| conflict | the detected vehicle was chosen by hand on another port |

With *assign vehicles to the detected port* on, the vehicle's charger history gets an entry at the plug-in time,
so the hourly rows follow the port from then on (those hours are recomputed).

**Choosing by hand.** Pick a vehicle, or `Unknown` for a car that isn't tracked, in the select or in the panel's
Ports table. The choice applies from the current plug-in and is cleared when that port is unplugged. Chosen while the
port is free, it waits for the next plug-in. `Auto` drops the choice and goes back to detection. The add-on receives
the select through Home Assistant's websocket (`mqtt/subscribe` on `ev/stats/ports/+/set`).

A plug-in nobody claimed after *refresh after minutes* presses the **refresh button** of every unplugged vehicle that
has one (the Audi needs that nudge); the vehicle's plug sensor then usually turns on within the *after* window.

### Charge estimate

Per vehicle: `sensor.<prefix>_<vehicle>_charge_time_to_target` (minutes to the charge target),
`_charge_needed` (wall kWh), `_charge_latest_start` (timestamp: the latest start that finishes by the
end of the next cheapest rate window), `binary_sensor.<prefix>_<vehicle>_charge_start_early` (on when
the cheapest window alone is too short, i.e. start before it) and `binary_sensor.<prefix>_<vehicle>_plugged`.
The target is the vehicle's **charge target entity** (a `number` or `sensor` in %) or a fixed value;
the power is the port's live kW while charging, otherwise the mean of the vehicle's full charging hours
over the last 30 days (≥ 90 % of its best hour), otherwise the charger's *max kW*. Attributes on the
live sensors: `soc`, `target_soc`, `charge_kw`, `charge_kw_source`, `charge_finish`,
`cheap_window_start`, `cheap_window_end`, `cheap_window_hours`, `cheap_rate`, `charge_start_in_minutes`.
The cheapest window is the next run of hours at the lowest rate of the next 48 hours of the TOU plan
(Super Off-Peak 00:00–06:00 on Evergy's plan).

The add-on creates two helpers per vehicle if they are missing: `input_select.<name>_fuel_equivalent`
(Regular / Midgrade / Premium / Diesel) and `input_number.<name>_equivalent_mpg`. Change them from
a card or an automation; the fuel comparison and the fuel statistics re-price on the next run.

### Long-term statistics

With *Long-term statistics* on, hourly rows are imported as external statistics (source `evstats`)
so the statistics graph card can show any period: `evstats:<vehicle>_miles` (mi), `_home_energy`
(kWh), `_home_cost` (USD), `_battery_energy` (kWh), `_fuel_gallons` (gal), `_fuel_cost` (USD),
`_savings` (USD), `_energy_fuel_gallons` (gal), `_energy_fuel_cost` (USD), `_energy_savings`
(USD), `_other_energy` (kWh), `_other_cost` (USD). Only hours that changed are re-imported each run; a change of grade, MPG, efficiency, away
price or of the vehicle-wide driving rate re-imports the whole series.

## Fuel prices

| Source | What | How often |
|---|---|---|
| EIA (`eia.gov`, no API key) | weekly retail prices for a region: regular, midgrade, premium, No 2 diesel, from the 1990s | once a day |
| AAA (`gasprices.aaa.com`) | today's / yesterday's / week-, month-, year-ago state and metro averages | every 6 hours (configurable) |

`sensor.<prefix>_regular` / `_midgrade` / `_premium` / `_diesel` (prefix `fuel_price`) state is
the price used **today**: the AAA metro (or state) average, falling back to the EIA week. Attributes:
`source`, `as_of`, `area`, `yesterday`, `week_ago`, `month_ago`, `year_ago`, `state_avg`,
`state_name`, `eia_weekly`, `eia_week_of`, `eia_area`.

The per-day series used for the fuel comparison is the AAA snapshot recorded on that day (snapshots
are kept from the day the add-on starts; one is used for up to 7 days), otherwise the EIA week that
contains the day. It is imported daily as `evstats:fuel_price_<grade>` from *History from*.

## Panel / API

Sidebar **EV Stats** (ingress, admins). Tabs: Status (every vehicle's windows, coverage, fuel prices,
recompute / rebuild / refresh), Vehicles (chargers, vehicles, charger history, helper creation),
Fuel prices, Settings, Log. Endpoints under the ingress URL: `GET /api/config`, `POST /api/config`,
`GET /api/status`, `POST /api/poll`, `POST /api/port {port, value}`, `POST /api/rebuild {vehicle?}`, `POST /api/fuel/refresh`,
`POST /api/helpers`, `POST /api/assignments {vehicle, list:[{from, charger}]}`, `GET /api/rows?vehicle=&hours=`,
`GET /api/sessions?vehicle=&limit=`.

Data lives in the add-on's `/data`: `config.json`, `state.json`, `rollup.json` (the hourly rows),
`fuel.json`.
