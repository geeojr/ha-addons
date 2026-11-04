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
`sensor.<prefix>_<vehicle>_charger` (assigned charger; attributes `charging`, `charger_power_kw`,
`energy_mpg`, `drive_kwh_per_mile`) and `sensor.<prefix>_<vehicle>_fuel_price` (today's price of
its grade).

### Helpers

Each vehicle names its charger with an `input_select` helper you create (options = the charger
names configured on the Vehicles tab). Switching it appends an entry to the vehicle's **charger
history**; edit that history on the Vehicles tab when a vehicle used another charger in the
past, then "Apply & rebuild".

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
`GET /api/status`, `POST /api/poll`, `POST /api/rebuild {vehicle?}`, `POST /api/fuel/refresh`,
`POST /api/helpers`, `POST /api/assignments {vehicle, list:[{from, charger}]}`, `GET /api/rows?vehicle=&hours=`,
`GET /api/sessions?vehicle=&limit=`.

Data lives in the add-on's `/data`: `config.json`, `state.json`, `rollup.json` (the hourly rows),
`fuel.json`.
