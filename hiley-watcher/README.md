# hiley-watcher — playout agent for the Hiley TV 24/7 channel

Runs on the **playout PC (the Dell, `DESKTOP-M752B2S`, 192.168.18.35)** at
`C:\VxD\hiley-watcher`. Dashboard: **https://mix.vxd.news/hiley**

Kept in this repo for version control only. **The Dockerfile does not copy this
folder**, so nothing here ships to Railway — copy it to the Dell by hand.

**Version 2.1 (24 Sep 2026)** — after the press-conference incident. Nothing on
Railway changes; this folder alone. See "The 24 Sep incident" at the bottom.

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

Freeze watchdog and override expiry (2.1):

| key | default | note |
|---|---|---|
| `sampleWidth` / `sampleHeight` | 320 / 180 | the PNG the watchdog samples every `watchdogMs` |
| `stillThreshold` | `0.05` | mean absolute pixel difference below this counts as still. Identical frames give **exactly 0**, so this only has to clear a few stuck pixels — not camera noise |
| `freezeMs` | `60000` | how long the picture must stay still before it counts as a dead feed |
| `overrideTtlMs` | `1800000` | a non-`auto` override reverts to `auto` after this long. `0` disables expiry |
| ~~`freezeSamples`~~ | — | **retired in 2.1.** If it is still in `config.json` the watcher logs that it is being ignored — delete the line |

Every sync reports the last measured difference as `ndi.diff` next to
`ndi.threshold`, so `GET /api/hiley/state` is how you tune `stillThreshold`
instead of guessing at it.

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

Since 2.1, anything other than `auto`:

- **suspends the freeze watchdog.** An operator who can see the output outranks a
  pixel comparison. In 2.0 only `hold:` did this, so FORCE LIVE was the *weaker*
  button — see the incident note.
- **expires back to `auto` after `overrideTtlMs`** (30 min), timed from the file's
  mtime so restarting the watcher does not restart the clock.
- **is reported to the dashboard** as `OVERRIDE ACTIVE (<mode>) — automation
  disabled, reverts in Nm`, and logged again every 10 minutes while it lasts.

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
- **No pixel test can tell a holding slate from a dead feed.** Both are a still picture.
  A deliberate static graphic held past `freezeMs` will still be read as dead — set an
  override when that is intentional. This limit is why an override now outranks the
  watchdog rather than the other way round.
- A wrong `ndiSourceName` **disables** the watchdog after three failed samples, with a loud
  log line. It fails open on purpose — but it means a dead feed will not fall back on its own.
- **`/golive` preflight still does not check this machine.** An offline or overridden
  watcher is invisible from the Go Live page; you have to open `/hiley`.

---

## The 24 Sep incident

A press conference went live at 09:02. Hiley never went to LIVE, FORCE LIVE was undone
1–3 minutes later four times over, and the watcher was killed at 09:14 so the Dell could
be driven by hand. Three faults, all fixed in 2.1:

1. **The watchdog outranked the operator.** `tick()` exempted `hold:` but not `live`, so
   the FORCE LIVE button — the one you reach for *because* you can see the picture is
   fine — was the only one the watchdog could overrule.
2. **The freeze detector false-tripped on a healthy feed.** sha1 of a 160×90 JPEG at
   quality 40 erases the sensor noise of a locked-off podium camera. It fired 5 times in
   10 minutes on a stream that was up 15.8 h at 2251 kbps with 0.09% dropped frames.
3. **A stale override disarmed everything in silence.** Dashboard scene testing at 00:21
   left `override.txt` on `hold:NEWS`; 8 h 43 m later GO LIVE was ignored and nothing
   said why.

The log that diagnosed all three came from `GET /api/hiley/state?log=1` **after** the
watcher was dead — the relay keeps the tail. That endpoint is the first thing to read
next time, before touching the Dell.
