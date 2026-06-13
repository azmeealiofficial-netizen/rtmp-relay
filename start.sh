#!/bin/bash
nginx &
cd /app && node server.js
