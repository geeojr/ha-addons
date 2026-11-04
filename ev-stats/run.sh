#!/usr/bin/with-contenv sh
# with-contenv: import the container environment (SUPERVISOR_TOKEN, options) under s6-overlay
exec node /app/ev_stats.js
