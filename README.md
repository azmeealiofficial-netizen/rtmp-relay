# RTMP Relay Server for VxD

## What this does
MDP (or any source) pushes their live feed to this server.
You pull the feed from this server into vMix.

## Deploy to Railway

1. Create a new project on Railway (https://railway.app)
2. Push this repo to GitHub and connect it to Railway
3. After deployment, go to Settings → Networking
4. Enable **TCP Proxy** on port **1935**
5. Railway will give you a public address like: `roundhouse.proxy.rlwy.net:12345`

## Give MDP this URL
```
rtmp://roundhouse.proxy.rlwy.net:PORT/live/mdpstream
```
Replace `roundhouse.proxy.rlwy.net:PORT` with your actual Railway TCP proxy address.

## Pull into vMix
1. Add Input → Stream/SRT
2. Stream Type: RTMP
3. URL: rtmp://roundhouse.proxy.rlwy.net:PORT/live/mdpstream
4. Click OK

## Monitor
Check server stats at: https://your-railway-domain:8080/stat
