#!/bin/bash
nginx -t && nginx &
cd /app && node server.js
