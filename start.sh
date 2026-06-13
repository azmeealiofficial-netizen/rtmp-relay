#!/bin/bash
rm -f /etc/nginx/conf.d/default.conf
nginx -c /etc/nginx/nginx.conf
cd /app && node server.js
