# hiley-watcher — playout agent for the Hiley TV 24/7 channel

Runs on the **playout PC (the Dell, `DESKTOP-M752B2S`, 192.168.18.35)** at
`C:\VxD\hiley-watcher`. Dashboard: **https://mix.vxd.news/hiley**

Kept in this repo for version control only. **The Dockerfile does not copy this
folder**, so nothing here ships to Railway — copy it to the Dell by hand.

---

## Install / upgrade on the Dell

```powershell
cd C:\VxD\hiley-watcher

# first time only
npm init -y
npm install obs-websocket-js

# copy hiley-watcher.js, install.ps1 and config.example.json in, then:
Copy-Item config.example.json config.json   # and fill it in
node hiley-watcher.js                       # watch it for a minute

# once it looks right, run it at logon (ELEVATED shell):
Set-ExecutionPolicy -Scope Process Bypass -Force
.\install.ps1
```

`install.ps1` registers a **Scheduled Task at logon**, not a service — deliberately.
OBS runs in the interactive session and obs-websocket listens on `127.0.0.1` there;
a LocalSystem service sits in a different session and cannot reach it. Same trap as
cloudflared reading the systemprofile config. **The Dell needs auto-login**, or "at
logon" never happens after a power cut, which is the case this exists for.

## config.json

Everything in `config.example.json`. The two that matter most:

| key | note |
|---|---|
| `deviceToken` | must equal `HILEY_TOKEN` on Railway, or every sync 401s and the dashboard shows the Dell as offline |
| `fillerScene` | the scene Hiley sees when nothing is live. It is **`NEWS`**, not FILLER — the key name is historical |
| `keepStreaming` | `false` while testing. `true` for 24/7: the watcher restarts the encoder whenever OBS stops |
| `vlcSourceName` | leave blank to auto-detect the first `vlc_source` input |

## override.txt

Sits beside the script, read every second, wins over everything, survives a restart.

```
auto          follow the relay        (normal)
live          force the LIVE scene
filler        force the resting scene
hold:NEWS     force a named scene     (what the dashboard writes when you tap a scene)
```

**Stop the watcher or set an override before testing scenes by hand** — otherwise it
pulls the scene back within a second and looks like a fault.

## What the dashboard can and cannot do

Every button on `/hiley` **enqueues** a command on the relay. Nothing dials in to the
Dell — the watcher collects commands on its next sync (~3 s). So:

- round-trip is up to one poll interval; the page says QUEUED until the Dell reports back
- commands **expire after 2 minutes**. Five angry taps while the Dell is offline must not
  all fire at 3am when it comes back
- if Railway is down, the dashboard is dead but **the channel is not** — the watcher holds
  its current scene and keeps streaming

## Known limits

- **OBS does not report which VLC playlist entry is playing.** The "now playing" line is
  only known once this script has moved the playlist itself (restart / next / previous) or
  seen a playback-ended event. Before that it shows blank rather than guessing.
- A **static full-screen graphic held for 20 s false-trips the freeze watchdog**. Use an
  override when that is intentional.
- A wrong `ndiSourceName` **disables** the watchdog after three failed samples, with a loud
  log line. It fails open on purpose — but it means a dead feed will not fall back on its own.
