#!/bin/bash
rm -f /etc/nginx/conf.d/default.conf
nginx
cd /app && node server.js
