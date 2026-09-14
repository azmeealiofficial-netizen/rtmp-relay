# rtmp-relay — vMix API audit and obs-websocket v5 mapping

Repo confirmed: **`azmeealiofficial-netizen/rtmp-relay`** (your brief said `vxd-unified`;
the remote says otherwise). Clone at `C:\Users\produ\Documents\relay`, volleyball
files present, GitHub is current.

---

## 1. The complete vMix surface

Smaller than the brief implies. Four server endpoints, nine function calls, three
XML reads. Nothing else in the repo touches vMix.

### server.js — 4 endpoints

| Line | Endpoint | What it does |
|---|---|---|
| 32 | `POST /api/set-vmix-url` | sets `vmixProxyUrl` in memory |
| 37 | `GET /api/get-vmix-url` | reads it back |
| 42 | `GET /api/vmix` | proxies `GET {vmixUrl}/api/` → returns raw vMix XML |
| 55 | `GET /api/vmix-cmd` | proxies `GET {vmixUrl}/api/?Function=X&...` |

`vmixProxyUrl` is hardcoded to `https://vmix.vxd.news` at line 29 (deliberately —
it resets on Railway redeploys otherwise).

### Client call sites — 9 functions

| File:line | Call | Purpose |
|---|---|---|
| index.html:265 | `Cut` | CUT button |
| index.html:266 | `Fade&Duration=500` | FADE button |
| index.html:267 | `FadeToBlack` | FTB button |
| index.html:268 | `StopStreaming` | END ALL |
| index.html:416 | `GET /api/vmix` | reachability ping only, response body discarded |
| live.html:228 | `StartStreaming&Value=i` | start stream i (0–3) |
| live.html:226 | `StopStreaming&Value=i` | stop stream i |
| live.html:235 | `StopStreaming` | END ALL STREAMS |
| live.html:330 | `SetMasterVolume&Value=v` | master fader |
| live.html:340 | `MasterAudioOn` / `MasterAudioOff` | master mute |

### XML reads — 3

| File:line | XPath | Used for |
|---|---|---|
| live.html:190–193 | `vmix/streaming/@channel1..4` | four stream on/off lamps |
| live.html:346–350 | `vmix/master/@volume`, `@muted` | fader position + mute state |
| index.html:416 | *(response code only)* | CONNECTED / OFFLINE badge |

Master volume uses an amplitude curve: slider → API is `(v/100)^4 * 100`,
API → slider is `(amp/100)^0.25 * 100`.

---

## 2. The mapping

| vMix | obs-websocket v5 | Notes |
|---|---|---|
| `StartStreaming Value=0` | `StartStream` | main stream, no index |
| `StopStreaming Value=0` | `StopStream` | |
| `StartStreaming Value=1` | `SetSourceFilterEnabled {sourceName:"DHUVAS", filterName:"FB Dhuvas", filterEnabled:true}` | Branch Output |
| `StartStreaming Value=3` | `SetSourceFilterEnabled {sourceName:"Program", filterName:"PSM Monitor", ...}` | Branch Output |
| `StopStreaming` (all) | `StopStream` + `SetSourceFilterEnabled false` × N | one call per branch |
| `streaming/@channel1` | `GetStreamStatus` → `outputActive` | |
| `streaming/@channel2..4` | `GetSourceFilter` → `filterEnabled` | see §3.2 |
| `SetMasterVolume Value=v` | `SetInputVolume {inputName:"PROGRAM AUDIO", inputVolumeMul}` | see §3.3 |
| `MasterAudioOn/Off` | `SetInputMute {inputName, inputMuted}` | |
| `master/@volume` | `GetInputVolume` → `inputVolumeMul` | |
| `Cut` | `SetSceneItemEnabled` ×2 on `Program` | see §3.4 |
| `Fade Duration=500` | *(no direct equivalent)* | see §3.4 |
| `FadeToBlack` | `SetSceneItemEnabled` on an FTB black item | see §3.4 |
| *(reachability ping)* | persistent WS + `GetVersion` on connect | see §3.1 |
| bitrate / drops | `GetStats` + `GetStreamStatus` → `outputBytes` delta | |
| Facebook keys (goal 3) | `SetStreamServiceSettings` / `SetSourceFilterSettings` | |

---

## 3. Where the 1:1 mapping breaks — four things, with recommendations

### 3.1 It stops being a proxy

vMix's API is HTTP request/response, so `/api/vmix` could be a dumb pass-through.
obs-websocket is a persistent WebSocket with an auth handshake. Opening a socket
per HTTP request would be absurd (handshake + auth on every 1-second poll).

**Recommendation:** the relay holds one long-lived `OBSWebSocket` connection with
auto-reconnect, keeps the last known state in memory, and `/api/obs` serves that
cached state. The panel's polling loop doesn't change at all.

Better still, obs-websocket pushes events — `StreamStateChanged`,
`InputVolumeChanged`, `InputMuteStateChanged`, `SourceFilterEnableStateChanged`,
`CurrentProgramSceneChanged`. Subscribe to those and the cache updates itself with
no polling of OBS whatsoever. The panel keeps polling the relay; the relay stops
polling OBS. Strictly less traffic than today.

### 3.2 Branch Output has no status API

`GetSourceFilter` tells you the filter is **enabled**. It does not tell you the
RTMP connection is alive. The plugin reports health in its own dock, not over
obs-websocket.

In practice this is parity, not a regression — vMix's `channelN` was also
"streaming started", not "streaming healthy". But for the two branches that point
at **your own relay** (PSM monitor, and Dhuvas if you route it through Railway),
you already have real health detection: `/api/relay-stats` and the HLS m3u8
polling. Use filter-enabled for the lamp, relay ingest for the truth.

For Dhuvas going direct to Facebook, filter-enabled is all you get.

### 3.3 OBS has no master fader

There is no master volume in OBS — only per-input faders. So "master" has to
become a named input.

**Recommendation:** add one audio input named `PROGRAM AUDIO` that everything
routes through, and point the slider at it. `SetInputVolume` takes either
`inputVolumeMul` (linear 0.0–1.0) or `inputVolumeDb` (−100…0).

Your existing curve is `(v/100)^4`. OBS's own UI fader is cubic. Use
`inputVolumeMul = (v/100)^3` to match what OBS shows, or keep `^4` if you'd
rather the slider feel identical to vMix. Inverse for readback:
`v = 100 * Math.cbrt(mul)`.

### 3.4 CUT / FADE / FTB — the one real loss

Your design does all switching *inside* `Program`, nested two levels down. OBS's
transition machinery (Studio Mode, `TriggerStudioModeTransition`) only operates on
the **top-level program scene** — which in your design must stay pinned to `VOICE`
forever. So the transition engine is at the wrong layer and can't be used.

What actually works:

- **CUT** — `SetSceneItemEnabled` on `Program`: enable the incoming camera,
  disable the outgoing one. Instant, reliable. Maps perfectly.
- **FADE** — OBS fades a scene *item* using that item's Show/Hide Transition,
  which is configured per item in the UI and is **not settable over
  obs-websocket**. So you can't have a CUT button and a FADE button driving the
  same item.

  **Recommendation:** set every camera item's Show and Hide Transition to Fade
  300 ms once in the OBS UI, then collapse CUT and FADE into a single **TAKE**
  button. You lose the ability to choose per-take, which on a football match you
  were almost certainly not using anyway. If you genuinely need both, tell me and
  I'll do it with a duplicate item pair — it works but it doubles the source count
  and I don't recommend it on this GPU.

- **FTB** — no OBS equivalent, but trivially rebuilt: a black `color_source` at
  the top of both `VOICE` and `DHUVAS` with a Fade show transition, toggled by
  two `SetSceneItemEnabled` calls. It has to live in both scenes, not in
  `Program`, or the logos and tickers would stay up over the black. I'll add
  these to the scene collection.

### 3.5 Not a break — things that get simpler

The scoreboard, ticker, reporter lower-third and SOS overlays are all web pages
driven by your own `/api/*` state. OBS never needs to know they exist. Every
`OverlayInput1..4` concept from vMix disappears; nothing replaces it. That's a
real reduction in moving parts.

---

## 4. Your MODULE_NOT_FOUND rule — root cause found

`Dockerfile` line 22:

```dockerfile
COPY server.js ./
```

Only that one file is copied into the image. Any `require('./obs.js')` fails at
runtime because `obs.js` was never in the container. It was never a Railway or
Docker quirk — it's one line.

Your brief asks for an `obs.js` module. You can now have it, with a one-word fix
(`COPY *.js ./`). **My recommendation is still to inline it into `server.js`**:
this box runs live matches, the module is ~200 lines, and a second file buys you
nothing but a new way to break a broadcast. But the choice is yours now rather
than forced.

### One packaging gotcha

`obs-websocket-js@5.0.8` is `"type": "module"` but ships a CommonJS build. Your
`server.js` is CJS (`__dirname`, `require`). Correct import:

```js
const { default: OBSWebSocket } = require('obs-websocket-js/json');
```

Plain `require('obs-websocket-js')` resolves to the msgpack build and
`require(...)` without `.default` gives you the module namespace, not the class.
Both fail in ways that look like the library is broken.

Node in the image is 18 — fine, the package needs >16.

---

## 5. What I need before writing the code

1. **A `GetSourceFilter` dump of the Branch Output filter**, once you've created
   it on the DHUVAS scene. Its server/key settings are stored under indexed,
   per-service keys and I'd rather read the real shape than guess it — goal 3
   writes Facebook stream keys into exactly those fields. Any obs-websocket
   client will do, or I can add a one-off `/api/obs/dump` endpoint.
2. **Rung 0–2 results.** Two outputs or three changes the endpoint design, so
   I'd rather write `server.js` once.
3. **A decision on §3.4** — single TAKE button, or keep CUT and FADE separate.

Give me those and the next delivery is a complete `server.js`.

---

## 6. Security note

`vmix.vxd.news` currently fronts the vMix Web Controller with no authentication.
Repointing it at obs-websocket is an improvement — obs-websocket has a password —
but the tunnel is still public, and whoever reaches it controls your broadcast.

Set a strong password in OBS (Tools → WebSocket Server Settings), put it in the
Railway env as `OBS_WS_PASSWORD`, and consider putting Cloudflare Access in front
of the hostname. Cloudflare proxied tunnels pass WebSockets fine, so
`wss://vmix.vxd.news` → `localhost:4455` will work as-is.
