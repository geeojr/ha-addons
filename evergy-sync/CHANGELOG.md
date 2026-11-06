# Changelog

## 1.0.2
- Fix the running total jumping at the start of a sync window that began mid-month (the baseline came from the current month's statistics bucket, whose sum already included the rows being re-imported). The baseline is now the last hourly row before the window.

## 1.0.1
- Fix start-up crash on Alpine node (locale date formatting); dates are now computed locale-independently. A bad window no longer kills the scheduler loop.

## 1.0.0
- First add-on release: browser-free sign-in, hourly import, TOU cost.
