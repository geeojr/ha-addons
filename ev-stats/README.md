# EV Stats

Per-vehicle **charging cost, efficiency and gasoline-equivalent** sensors for Home Assistant, built
from data HA already records: each vehicle's odometer and state of charge, the home chargers'
power, and the time-of-use rate plans published by `sensor.electricity_rate`.

For every vehicle and every window (`1d`, `7d`, `30d`, `365d` by default) you get
`sensor.ev_<vehicle>_<metric>_<window>`:

| Metric | Unit | Meaning |
|---|---|---|
| miles | mi | odometer increase |
| home_energy / home_cost | kWh / USD | delivered by the vehicle's home charger, priced hour by hour at the TOU rate |
| battery_energy | kWh | drawn from the pack (driving **and** idle / climate) |
| efficiency | mi/kWh | miles per kWh while driving (like the car's trip display) |
| consumption | kWh/100mi | all-in battery energy per 100 miles |
| cost_per_mile | USD/mi | home cost + estimated away charging, per mile |
| fuel_gallons / fuel_cost | gal / USD | what the same miles would have burned in the vehicle's assigned gasoline grade at its equivalent MPG, priced per day |
| savings | USD | fuel_cost − EV energy cost |

Which charger a vehicle is on comes from an `input_select` helper per vehicle (`North` / `South`
...); the gasoline grade and MPG come from helpers the add-on creates (`input_select.<name>_fuel_equivalent`,
`input_number.<name>_equivalent_mpg`), so automations and cards can change them.

**Fuel prices**: `sensor.fuel_price_regular` / `_midgrade` / `_premium` / `_diesel` (USD/gal) from
AAA's daily state/metro averages (yesterday, week-, month- and year-ago as attributes) with EIA's
weekly regional series as the history. Both are also imported as long-term statistics.

**History**: the add-on backfills from HA's hourly long-term statistics (from 2024-01-01 by default),
then re-derives the last hours from raw recorder history every few minutes. Long-term statistics
`evstats:<vehicle>_miles`, `_home_energy`, `_home_cost`, `_battery_energy`, `_fuel_gallons`,
`_fuel_cost`, `_savings` feed the statistics graph card for any period.

Everything is configured in the panel (sidebar **EV Stats**, admins only). Details in DOCS.md.
