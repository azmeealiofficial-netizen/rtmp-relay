#!/bin/bash
killall nginx 2>/dev/null
sleep 1
rm -f /etc/nginx/conf.d/default.conf
nginx -c /etc/nginx/nginx.conf
cd /app && node server.js
