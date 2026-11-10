#!/bin/bash
killall nginx 2>/dev/null
sleep 1
rm -f /etc/nginx/conf.d/default.conf

# MediaMTX (SRT) — kept alive in a loop so a crash can never take down the
# relay; nginx and node do not depend on it.
( while true; do
    /usr/local/bin/mediamtx /etc/mediamtx.yml
    echo "[mediamtx] exited ($?), restarting in 2s"
    sleep 2
  done ) &

nginx -c /etc/nginx/nginx.conf
cd /app && node server.js
