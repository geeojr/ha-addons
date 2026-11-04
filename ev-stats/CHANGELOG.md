# Changelog

## 1.1.0
- Energy-based fuel equivalent next to the assumed-MPG one: the measured driving kWh/mi becomes the gallons an engine would burn for the same work (gasoline / diesel energy content, engine and EV drivetrain efficiency, regen share - Settings, per-vehicle engine efficiency override). New metrics `energy_fuel_gallons`, `energy_fuel_cost`, `energy_savings`, `energy_mpg`; statistics `evstats:<vehicle>_energy_fuel_gallons`, `_energy_fuel_cost`, `_energy_savings`.
- Charging session check: a session on the vehicle's port that its battery demonstrably did not take (gain below half of wall × efficiency) is booked as another vehicle's (`other_energy`, `other_cost`, statistics `_other_energy`, `_other_cost`) and leaves the vehicle's cost and savings. Sessions table per vehicle on the Status tab, port timeline on the Vehicles tab, `GET /api/sessions`.
- Away-charging estimate no longer books the lag of the state-of-charge report (an hourly mean, or a sleeping car reporting hours late) as DC fast charging: unused home-charger credit is kept for up to *lag hours*.

## 1.0.0
- First release: hourly per-vehicle rows (miles, battery energy out/in, home charger kWh priced at the TOU rate, estimated away charging) from raw recorder history, backfilled from hourly statistics; rolling-window sensors via MQTT discovery; long-term statistics `evstats:*`; EIA weekly + AAA daily fuel prices with history; fuel grade / MPG helpers per vehicle; ingress panel.
