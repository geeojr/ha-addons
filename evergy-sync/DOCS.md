# Evergy Sync

Pulls **hourly** electricity usage from Evergy's usage portal (Opower) into Home Assistant
long-term statistics, and writes a matching **cost** statistic priced hour-by-hour from the
time-of-use plans published by `sensor.electricity_rate`. Both feed the Energy dashboard.

Our own implementation (not the Opower integration): one sign-in per day over plain HTTP with
an ordinary browser user-agent, one token request, one usage request per 26-day window, and a
pause between requests. A failed sign-in (wrong password, verification step) is never retried:
you get a persistent notification and the add-on waits until the username/password options
change. Connectivity failures are simply reported and retried at the next scheduled run.

## Options

| Option | Meaning |
|---|---|
| `username` / `password` | Your evergy.com login |
| `run_at` | Daily run time, America/Chicago (`06:10`). Opower data lags about a day |
| `run_on_start` | Also run when the add-on starts, if today has not been synced yet |
| `statistic_id` | Statistic to write (`opower:<utility>_elec_<account>_energy_consumption` keeps existing history). Cost goes to the same id with `_cost` |
| `statistic_name` / `cost_statistic_name` | Display names |
| `rate_entity` | Sensor whose `plans` attribute holds the TOU rate plans |
| `account_uuid` | Opower utility account uuid; blank = auto-detect (logged on the first run) |
| `backfill_from` | `YYYY-MM-DD` to re-pull from that date on the next run; clear it afterwards |

Normally the window is the last 4 days, widened back to the day after the last successful run
(up to 60 days) so gaps are caught up automatically.

Log and state: `/data/sync.log`, `/data/last_run.json`.
