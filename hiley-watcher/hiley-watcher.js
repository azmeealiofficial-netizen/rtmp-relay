/* ============================================================
   hiley-watcher — VxD playout agent for the Hiley TV 24/7 channel
   Runs on the playout PC (the Dell). C:\VxD\hiley-watcher
   Version 2.2 — adds the flight-board rotation (see FLIGHT BOARD below).
   Version 2.1 — see the 24 Sep post-mortem below.

   FLIGHT BOARD (2.2)
     The domestic flight board is a browser source sitting in the filler
     scene, above the video and below the news-scene frame. This script
     shows it for boardMs once the VLC playlist has finished a lap, then
     hides it again — so the loop reads videos -> board -> videos instead
     of the board landing mid-clip on its own timer.

     It is a SCENE ITEM toggle, never a scene switch, so it does not
     touch tick()'s target, the override file or the freeze watchdog.
     The page must run with ?always=1: this script owns its visibility.

     Three safeties, all of them because a board stuck over a dead
     playlist is the 3am failure nobody is awake to see:
       - boardMaxMs is a hard cap; past it the board is hidden and the
         playlist resumed whatever else is going on
       - leaving the filler scene hides it immediately
       - a fresh connection to OBS forces it hidden and the media playing,
         so a crash mid-board heals itself on restart
     Set boardSourceName to '' to switch the whole feature off.

   WHAT 2.1 CHANGED, AND WHY (incident 24 Sep 2026, 09:02–09:14)
     A press conference went live and this script never took Hiley to
     LIVE; FORCE LIVE on /hiley worked and was then undone 1–3 minutes
     later, over and over, until the operator killed the watcher and
     drove the Dell by hand. Three separate faults:

     1. THE WATCHDOG OUTRANKED THE OPERATOR. tick() exempted only
        `hold:`, so `override live` — what the FORCE LIVE button writes —
        left the freeze watchdog free to pull the scene to NEWS.
        Tapping a scene by name was SAFE and tapping FORCE LIVE was NOT,
        which is exactly backwards from how the buttons read.
        → Now ANY explicit override suspends the watchdog. Only `auto`
          lets it move the scene. An operator watching the output is a
          better judge of a dead feed than a hash of a thumbnail.

     2. THE FREEZE DETECTOR FALSE-TRIPPED ON A REAL FEED. It compared
        sha1 of a 160x90 JPEG at quality 40. At that size JPEG
        quantisation erases the sensor noise of a locked-off podium
        camera, so a healthy low-motion shot hashed identical and read
        as dead. It fired 5 times in 10 minutes on a stream that was up
        15.8 hours at 2251 kbps with 0.09% dropped frames.
        → Now a 320x180 LOSSLESS PNG, decoded here, compared by mean
          absolute pixel difference against a threshold, over a 60s
          window instead of 20s. The measured difference is logged, so
          `stillThreshold` can be tuned from the dashboard log instead
          of guessed at.
        → NOTE THE LIMIT: no pixel test can tell a holding slate from a
          dead feed. Both are a still picture. This is why fault 1
          mattered more than fault 2.

     3. A STALE OVERRIDE SILENTLY DISARMED EVERYTHING. Dashboard scene
        testing at 00:21 left override.txt on `hold:NEWS`. Nothing
        surfaced that, and 8h43m later GO LIVE was ignored.
        → A non-auto override now expires back to auto after
          `overrideTtlMs` (default 30 min), timed from override.txt's
          mtime so a restart of this script does not reset the clock,
          and it is reported to the dashboard as a note the whole time.

   WHAT IT DOES
     1. Polls the relay's event status and drives the local OBS:
        an event goes live -> LIVE scene, event ends -> resting scene.
     2. Watches the NDI source for a frozen picture and falls back.
     3. Reports itself to the relay and executes commands the
        dashboard has queued there.

   WHAT HAS NOT CHANGED, AND MUST NOT
     * PULL ONLY. Nothing inbound reaches this machine. The dashboard
       cannot talk to the Dell; it leaves commands in a mailbox on the
       relay and this script collects them. Hiley's 24/7 channel does
       not depend on anything being able to dial in here.
     * Relay unreachable -> HOLD the current scene. An internet blip
       must never cut an event. The NDI watchdog is the real safety net.
     * Rehearsals are ignored. live === true && rehearsal !== true is
       the only thing that takes over a partner's channel.
     * The watchdog FAILS OPEN. A source name that cannot be sampled
       disables the watchdog loudly rather than yanking the channel.

   OVERRIDE
     override.txt beside this script wins over everything. Contents:
        auto          follow the relay          (normal)
        live          force the LIVE scene
        filler        force the resting scene
        hold:<scene>  force a named scene       (written by the dashboard)
     It is read every second, so it also works when the relay is down,
     and it survives a restart of this script. Stop the watcher or set
     an override before testing scenes by hand — otherwise it pulls the
     scene back within a second and looks like a fault.

     Every one of those four values EXCEPT `auto` also suspends the
     freeze watchdog, and expires back to `auto` after overrideTtlMs.
   ============================================================ */

'use strict';

const fs   = require('fs');
const path = require('path');
const OBSWebSocket = require('obs-websocket-js/json').default;

const VERSION  = '2.2';
const DIR      = __dirname;
const CFG_PATH = path.join(DIR, 'config.json');
const OVR_PATH = path.join(DIR, 'override.txt');
const LOG_PATH = path.join(DIR, 'hiley-watcher.log');
const LOG_MAX  = 5 * 1024 * 1024;

const DEFAULTS = {
  statusUrl:      'https://mix.vxd.news/api/match/status',
  syncUrl:        'https://mix.vxd.news/api/hiley/sync',
  deviceToken:    '',
  obsUrl:         'ws://127.0.0.1:4455',
  obsPassword:    '',
  liveScene:      'LIVE',
  fillerScene:    'NEWS',      // "the scene Hiley sees when nothing is live"
  ndiSourceName:  'NDI Source',
  vlcSourceName:  '',          // blank = auto-detect the first vlc_source
  keepStreaming:  false,
  pollMs:         3000,
  watchdogMs:     5000,

  // Freeze watchdog. See sampleNDI() — these are the numbers to tune,
  // and the log prints the measured difference next to the threshold.
  sampleWidth:    320,
  sampleHeight:   180,
  /* Mean abs pixel difference below this counts as still. The pipeline is
     lossless and OBS's scaler is deterministic, so two identical input
     frames give EXACTLY 0 and any real change in the picture gives more.
     The threshold therefore only has to sit above the noise floor of a
     few stuck or flickering pixels (a single one in 320x180 moves this by
     about 0.000006), not above camera noise — which is what 2.0's JPEG
     hash effectively demanded and why it tore a live feed off air. Raise
     it only if the log shows a genuinely dead feed reading above 0. */
  stillThreshold: 0.05,
  freezeMs:       60000,       // how long it must stay still to count as dead
  recoverSamples: 2,
  // freezeSamples (<= 2.0) is RETIRED. It was ~20s and it false-tripped.

  /* Flight board — a scene item in the filler scene, shown once per lap
     of the playlist. Blank source name disables the whole feature. */
  boardSourceName: '',            // e.g. 'FLIGHT BOARD'
  boardEveryLaps:  1,             // show after every N laps of the playlist
  boardMs:         60000,         // how long it stays on screen
  boardPauseMedia: true,          // pause the videos while it is up
  boardMaxMs:      180000,        // hard cap; a board up longer than this is a fault

  // Non-auto overrides revert to auto after this long. 0 disables.
  overrideTtlMs:  30 * 60 * 1000,

  agent:          'hiley-dell',
};

let CFG = Object.assign({}, DEFAULTS);

/* ---------------- logging ---------------- */
// Lines go to the file, to stdout, and into a buffer that is shipped to
// the relay on the next sync so the dashboard can show them.
let logPending = [];
function log(line) {
  const t = Date.now();
  const stamp = new Date(t).toISOString().replace('T', ' ').slice(0, 19);
  const text = stamp + '  ' + line;
  console.log(text);
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX) {
      fs.renameSync(LOG_PATH, LOG_PATH + '.1');
    }
    fs.appendFileSync(LOG_PATH, text + '\n');
  } catch (e) { /* never let logging kill the channel */ }
  logPending.push({ t, line });
  if (logPending.length > 300) logPending = logPending.slice(-300);
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    CFG = Object.assign({}, DEFAULTS, raw);
    if (!CFG.syncUrl && CFG.statusUrl) {
      CFG.syncUrl = CFG.statusUrl.replace('/api/match/status', '/api/hiley/sync');
    }
    log('config loaded — resting scene "' + CFG.fillerScene + '", live scene "' + CFG.liveScene + '"');
    // Say so out loud rather than honouring a value that caused an incident.
    if (raw.freezeSamples != null) {
      log('config: "freezeSamples" is RETIRED in 2.1 and is being ignored — ' +
          'the freeze window is now freezeMs (' + CFG.freezeMs + 'ms). Remove it from config.json.');
    }
    log('watchdog: ' + CFG.sampleWidth + 'x' + CFG.sampleHeight + ' png, still below ' +
        CFG.stillThreshold + ' mean abs diff, dead after ' + Math.round(CFG.freezeMs / 1000) + 's' +
        ' · override ttl ' + (CFG.overrideTtlMs ? Math.round(CFG.overrideTtlMs / 60000) + 'm' : 'off'));
  } catch (e) {
    log('CONFIG ERROR ' + e.message + ' — using defaults');
  }
}

/* ---------------- runtime state ---------------- */
const BOOTED = Date.now();
const obs = new OBSWebSocket();

let obsConnected = false;
let connecting   = false;          // single-flight; see the retry-storm note below
let reconnectTimer = null;
let lastConnectLogAt = 0;

let currentScene = '';
let sceneList    = [];

let relayReachable = false;
let relayLive      = false;
let relayRehearsal = false;
let relayTitle     = '';

let ndiWatchdog = 'ok';            // ok | disabled
let ndiFrozen   = false;
let ndiActive   = false;
let lastFrame   = null;            // decoded previous sample
let lastDiff    = null;            // mean abs pixel difference, last sample
let lastSampleAt = 0;
let changeCount = 0;
let stillSince  = 0;               // when the still stretch began
let sampleFails = 0;
let heldOffFallback = false;       // logged once when an override outranks a freeze

let vlcSource   = '';
let vlcItems    = [];
let vlcIndex    = null;            // see the note in reportPlaylist()
let vlcPlaying  = false;
let vlcDuration = 0;
let vlcCursor   = 0;

/* Flight board. boardEnded counts playback-ended events rather than
   trusting vlcIndex, which is null until something moves the playlist. */
let boardItemId = null;
let boardVisible = false;
let boardShownAt = 0;
let boardEnded   = 0;
let boardWarned  = false;

let streamStats = { streaming: false, streamMs: 0, bitrateKbps: 0, dropped: 0, total: 0, congestion: 0 };
let obsStats    = { cpu: 0, fps: 0, version: '' };

let results     = [];              // command outcomes awaiting the next sync
let lastOverride = null;
let noteAuth     = '';             // relay rejected the device token
let noteOverride = '';             // OVERRIDE ACTIVE — automation disabled
let overrideRemindedAt = 0;

/* ---------------- OBS connection ----------------
   obs.connect() failing ALSO fires ConnectionClosed, so a naive catch
   block plus an event handler each schedule a retry and attempts
   multiply — this produced 31 attempts in 23 seconds once. Single-flight
   flag plus exactly one timer, and connect-failure logging throttled. */
function scheduleReconnect(ms) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectOBS(); }, ms || 5000);
}

async function connectOBS() {
  if (connecting || obsConnected) return;
  connecting = true;
  try {
    await obs.connect(CFG.obsUrl, CFG.obsPassword || undefined);
    obsConnected = true;
    connecting = false;
    log('OBS connected');
    await refreshScenes();
    await detectVlcSource();
    /* Heal a crash that happened while the board was up: the scene item
       is persisted in the collection, so OBS would still be showing it. */
    boardItemId = null;
    boardVisible = false;
    if (CFG.boardSourceName) {
      await resolveBoardItem();
      if (boardItemId != null) await setBoard(false, 'startup reset');
    }
  } catch (e) {
    connecting = false;
    obsConnected = false;
    if (Date.now() - lastConnectLogAt > 60000) {
      lastConnectLogAt = Date.now();
      log('OBS connect failed: ' + e.message + ' (retrying quietly)');
    }
    scheduleReconnect(5000);
  }
}

obs.on('ConnectionClosed', () => {
  if (obsConnected) log('OBS connection closed');
  obsConnected = false;
  connecting = false;
  scheduleReconnect(5000);
});
obs.on('CurrentProgramSceneChanged', (d) => { currentScene = d.sceneName; });
obs.on('SceneListChanged', () => { refreshScenes().catch(() => {}); });
obs.on('MediaInputPlaybackEnded', (d) => {
  if (!vlcSource || d.inputName !== vlcSource) return;
  if (vlcIndex != null && vlcItems.length) {
    vlcIndex = (vlcIndex + 1) % vlcItems.length;
  }

  /* A lap is one playback-ended per playlist entry. Counting events is
     deliberate: vlcIndex is null until something moves the playlist, so
     it cannot be the trigger for anything that has to work from boot. */
  if (!CFG.boardSourceName) return;
  boardEnded += 1;
  const perLap = Math.max(1, vlcItems.length || 1) * Math.max(1, Number(CFG.boardEveryLaps) || 1);
  if (boardEnded % perLap !== 0) return;
  if (boardVisible) return;
  if (currentScene !== CFG.fillerScene) return;      // LIVE owns the screen
  setBoard(true, 'playlist lap ' + (boardEnded / perLap)).catch(() => {});
});

async function refreshScenes() {
  const r = await obs.call('GetSceneList');
  sceneList = (r.scenes || []).map(s => s.sceneName).reverse();   // OBS lists bottom-up
  currentScene = r.currentProgramSceneName || currentScene;
}

async function detectVlcSource() {
  try {
    if (CFG.vlcSourceName) { vlcSource = CFG.vlcSourceName; }
    else {
      const r = await obs.call('GetInputList');
      const hit = (r.inputs || []).find(i => i.inputKind === 'vlc_source');
      vlcSource = hit ? hit.inputName : '';
    }
    if (vlcSource) log('filler playlist source: "' + vlcSource + '"');
    else log('no VLC playlist source found — playlist card will stay hidden');
  } catch (e) {
    vlcSource = '';
    log('playlist detection failed: ' + e.message);
  }
}

/* ---------------- scene control ---------------- */
async function setScene(name) {
  if (!obsConnected || !name || name === currentScene) return;
  try {
    await obs.call('SetCurrentProgramScene', { sceneName: name });
    currentScene = name;
    log('scene -> ' + name);
  } catch (e) {
    log('scene switch FAILED (' + name + '): ' + e.message);
  }
}

/* ---------------- override file ---------------- */
/* setAt comes from the FILE'S MTIME, deliberately: the override outlives
   this process, so the expiry clock has to outlive it too. Stamping it in
   memory at startup would hand a forgotten hold: another full TTL every
   time the watcher restarted — which is how a stale hold:NEWS survived
   8h43m and swallowed a GO LIVE. */
function readOverride() {
  const blank = { mode: 'auto', held: '', setAt: 0 };
  try {
    const raw = String(fs.readFileSync(OVR_PATH, 'utf8')).trim();
    let setAt = 0;
    try { setAt = fs.statSync(OVR_PATH).mtimeMs || 0; } catch (e) { /* keep 0 */ }
    if (!raw) return blank;
    if (/^hold:/i.test(raw)) return { mode: 'hold', held: raw.slice(5).trim(), setAt };
    const m = raw.toLowerCase();
    if (m === 'live' || m === 'filler' || m === 'auto') return { mode: m, held: '', setAt };
    return blank;
  } catch (e) {
    return blank;   // no file = auto
  }
}
function overrideLabel(ovr) {
  return ovr.mode === 'hold' ? 'hold:' + ovr.held : ovr.mode;
}
function writeOverride(text) {
  try { fs.writeFileSync(OVR_PATH, text + '\n'); return true; }
  catch (e) { log('override write FAILED: ' + e.message); return false; }
}

/* ---------------- relay status ---------------- */
async function readRelay() {
  try {
    // Cache-bust. A 15-minute fetch cache once had us reading live:false
    // in the middle of a live event.
    const r = await fetch(CFG.statusUrl + (CFG.statusUrl.includes('?') ? '&' : '?') + 'cb=' + Date.now(),
      { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    relayReachable = true;
    relayLive      = !!j.live;
    relayRehearsal = !!j.rehearsal;
    relayTitle     = String(j.title || '');
  } catch (e) {
    if (relayReachable) log('relay status unreachable (' + e.message + ') — holding current scene');
    relayReachable = false;
  }
}

/* ---------------- NDI freeze watchdog ----------------
   2.0 hashed a 160x90 JPEG at quality 40 and called two identical hashes
   a dead feed. That is not a liveness test: at that size JPEG
   quantisation throws away the sensor noise that distinguishes a live
   locked-off camera from a still picture, and on 24 Sep it tore a real
   press conference off LIVE five times in ten minutes.

   2.1 asks OBS for a LOSSLESS PNG, decodes it here and compares mean
   absolute pixel difference against a threshold. Lossless is the whole
   point — a real camera always moves a little, and nothing is left to
   throw that away.

   WHAT THIS STILL CANNOT DO: distinguish a holding slate from a dead
   feed. Both are a still picture. That is a property of the problem, not
   of the code, and it is why an explicit override now outranks this
   verdict (see tick()). Failing to sample at all still disables the
   watchdog rather than pulling the channel off LIVE. */
const zlib = require('zlib');

/* Minimal PNG reader: 8-bit, non-interlaced, which is what OBS emits.
   No dependency — the Dell has exactly one (obs-websocket-js) and it
   should stay that way. Anything unexpected throws, and a throw here is
   a sample failure, which fails open. */
function decodePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, ihdr = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len  = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const at   = pos + 8;
    if (at + len > buf.length) break;
    if (type === 'IHDR') {
      ihdr = {
        width:     buf.readUInt32BE(at),
        height:    buf.readUInt32BE(at + 4),
        bitDepth:  buf[at + 8],
        colorType: buf[at + 9],
        interlace: buf[at + 12],
      };
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(at, at + len));
    } else if (type === 'IEND') break;
    pos = at + len + 4;
  }
  if (!ihdr) throw new Error('no IHDR');
  if (ihdr.bitDepth !== 8)  throw new Error('bit depth ' + ihdr.bitDepth + ' unsupported');
  if (ihdr.interlace !== 0) throw new Error('interlaced PNG unsupported');
  const CH = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!CH) throw new Error('colour type ' + ihdr.colorType + ' unsupported');
  if (!idat.length) throw new Error('no IDAT');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const w = ihdr.width, h = ihdr.height, stride = w * CH;
  if (raw.length < (stride + 1) * h) throw new Error('short pixel data');

  const out = Buffer.alloc(stride * h);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const ft   = raw[rp++];
    const row  = raw.subarray(rp, rp + stride); rp += stride;
    const base = y * stride;
    const pbase = base - stride;
    for (let i = 0; i < stride; i++) {
      const x = row[i];
      const a = i >= CH        ? out[base + i - CH]  : 0;   // left
      const b = y > 0          ? out[pbase + i]      : 0;   // up
      const c = (y > 0 && i >= CH) ? out[pbase + i - CH] : 0;
      let v;
      if (ft === 0)      v = x;
      else if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c));
      } else throw new Error('filter ' + ft + ' unsupported');
      out[base + i] = v & 0xff;
    }
  }
  return { width: w, height: h, channels: CH, pixels: out };
}

/* Mean absolute difference over the colour channels, alpha ignored —
   a fully transparent frame is not a moving one. Returns Infinity when
   the frames are not comparable, which reads as motion and so errs
   towards staying on air. */
function meanAbsDiff(a, b) {
  if (!a || !b) return Infinity;
  if (a.channels !== b.channels || a.pixels.length !== b.pixels.length) return Infinity;
  const pa = a.pixels, pb = b.pixels, n = pa.length;
  const step = a.channels;
  const lim  = (step === 4) ? 3 : (step === 2 ? 1 : step);   // drop alpha
  let sum = 0, count = 0;
  for (let i = 0; i + step <= n; i += step) {
    for (let k = 0; k < lim; k++) {
      const d = pa[i + k] - pb[i + k];
      sum += d < 0 ? -d : d;
      count++;
    }
  }
  return count ? sum / count : Infinity;
}

async function sampleNDI() {
  if (!obsConnected || ndiWatchdog === 'disabled') return;
  const now = Date.now();
  let frame;
  try {
    const r = await obs.call('GetSourceScreenshot', {
      sourceName: CFG.ndiSourceName,
      imageFormat: 'png',
      imageWidth:  CFG.sampleWidth,
      imageHeight: CFG.sampleHeight,
    });
    const data = String(r.imageData || '');
    const b64  = data.slice(data.indexOf(',') + 1);
    frame = decodePNG(Buffer.from(b64, 'base64'));
    sampleFails = 0;
  } catch (e) {
    sampleFails += 1;
    if (sampleFails >= 3 && ndiWatchdog !== 'disabled') {
      ndiWatchdog = 'disabled';
      ndiFrozen = false;
      log('NDI WATCHDOG DISABLED — cannot sample "' + CFG.ndiSourceName + '" (' + e.message +
          '). Failing open: a dead feed will NOT fall back on its own.');
    }
    return;
  }

  const prev = lastFrame;
  const prevAt = lastSampleAt;
  lastFrame = frame;
  lastSampleAt = now;
  if (!prev) return;                       // nothing to compare the first sample to

  const diff = meanAbsDiff(prev, frame);
  lastDiff = Number.isFinite(diff) ? diff : null;

  if (diff > CFG.stillThreshold) {
    stillSince = 0;
    changeCount += 1;
    ndiActive = true;
    if (ndiFrozen && changeCount >= CFG.recoverSamples) {
      ndiFrozen = false;
      heldOffFallback = false;
      log('NDI recovered (diff ' + diff.toFixed(2) + ')');
    }
    return;
  }

  // Still. The stretch began at the PREVIOUS sample, not this one.
  changeCount = 0;
  if (!stillSince) stillSince = prevAt || now;
  if (!ndiFrozen && (now - stillSince) >= CFG.freezeMs) {
    ndiFrozen = true;
    ndiActive = false;
    log('NDI FROZEN — still for ' + Math.round((now - stillSince) / 1000) + 's ' +
        '(diff ' + diff.toFixed(2) + ' vs threshold ' + CFG.stillThreshold + ')' +
        '; will fall back off LIVE unless an override is set');
  }
}

/* ---------------- stats ---------------- */
async function readStats() {
  if (!obsConnected) { streamStats.streaming = false; return; }
  try {
    const s = await obs.call('GetStreamStatus');
    streamStats = {
      streaming:  !!s.outputActive,
      streamMs:   Number(s.outputDuration || 0),
      bitrateKbps: 0,
      dropped:    Number(s.outputSkippedFrames || 0),
      total:      Number(s.outputTotalFrames || 0),
      congestion: Number(s.outputCongestion || 0),
    };
    // OBS reports cumulative bytes; turn that into a rate.
    const bytes = Number(s.outputBytes || 0);
    const now = Date.now();
    if (readStats._lastAt && bytes >= readStats._lastBytes) {
      const dt = (now - readStats._lastAt) / 1000;
      if (dt > 0.5) streamStats.bitrateKbps = ((bytes - readStats._lastBytes) * 8) / dt / 1000;
      else streamStats.bitrateKbps = readStats._lastRate || 0;
    }
    if (!readStats._lastAt || (now - readStats._lastAt) > 500) {
      readStats._lastAt = now; readStats._lastBytes = bytes;
    }
    readStats._lastRate = streamStats.bitrateKbps;
  } catch (e) { /* transient */ }

  try {
    const g = await obs.call('GetStats');
    obsStats.cpu = Number(g.cpuUsage || 0);
    obsStats.fps = Number(g.activeFps || 0);
  } catch (e) { /* transient */ }

  if (!obsStats.version) {
    try { obsStats.version = (await obs.call('GetVersion')).obsVersion || ''; } catch (e) {}
  }
}

/* ---------------- playlist ----------------
   OBS does not tell anyone which entry of a VLC source is playing —
   GetMediaInputStatus gives state, duration and cursor but no filename.
   So the index here is only known when THIS script put it somewhere:
   a restart sets it to 0, next/previous move it, and the playback-ended
   event advances it. Before any of that it reports blank rather than
   guessing, which is the honest answer. */
async function readPlaylist() {
  if (!obsConnected || !vlcSource) { vlcItems = []; return; }
  try {
    const s = await obs.call('GetInputSettings', { inputName: vlcSource });
    const pl = (s.inputSettings && s.inputSettings.playlist) || [];
    vlcItems = pl.map(x => String((x && x.value) || x || ''));
  } catch (e) { /* leave the last known list */ }
  try {
    const m = await obs.call('GetMediaInputStatus', { inputName: vlcSource });
    vlcPlaying  = m.mediaState === 'OBS_MEDIA_STATE_PLAYING';
    vlcDuration = Number(m.mediaDuration || 0);
    vlcCursor   = Number(m.mediaCursor || 0);
  } catch (e) { /* not all builds answer for vlc_source */ }
}

async function mediaAction(action) {
  if (!vlcSource) throw new Error('no filler playlist source on this machine');
  const map = {
    next:     'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_NEXT',
    previous: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PREVIOUS',
    restart:  'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART',
    pause:    'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE',
    play:     'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY',
  };
  if (!map[action]) throw new Error('unknown playlist action ' + action);
  await obs.call('TriggerMediaInputAction', { inputName: vlcSource, mediaAction: map[action] });
  if (vlcItems.length) {
    if (action === 'restart') vlcIndex = 0;
    else if (action === 'next' && vlcIndex != null) vlcIndex = (vlcIndex + 1) % vlcItems.length;
    else if (action === 'previous' && vlcIndex != null) vlcIndex = (vlcIndex - 1 + vlcItems.length) % vlcItems.length;
  }
}

/* ---------------- flight board ---------------- */
async function resolveBoardItem() {
  if (!CFG.boardSourceName || !obsConnected) { boardItemId = null; return; }
  try {
    const r = await obs.call('GetSceneItemId', {
      sceneName: CFG.fillerScene,
      sourceName: CFG.boardSourceName,
    });
    boardItemId = r.sceneItemId;
    if (!boardWarned) log('flight board item "' + CFG.boardSourceName + '" found in ' + CFG.fillerScene);
  } catch (e) {
    boardItemId = null;
    if (!boardWarned) {
      boardWarned = true;
      log('flight board DISABLED — no source "' + CFG.boardSourceName +
          '" in scene "' + CFG.fillerScene + '": ' + e.message);
    }
  }
}

async function setBoard(on, why) {
  if (!CFG.boardSourceName || !obsConnected) return;
  if (boardItemId == null) await resolveBoardItem();
  if (boardItemId == null) return;
  try {
    await obs.call('SetSceneItemEnabled', {
      sceneName: CFG.fillerScene,
      sceneItemId: boardItemId,
      sceneItemEnabled: !!on,
    });
  } catch (e) {
    // most often the item was deleted or renamed under us
    boardItemId = null;
    log('flight board ' + (on ? 'show' : 'hide') + ' FAILED: ' + e.message);
    return;
  }
  boardVisible = !!on;
  boardShownAt = on ? Date.now() : 0;

  /* Pause the videos underneath, so the clip the board covers is not
     simply lost every lap. Failure to pause is not a reason to abandon
     the board — it just means the viewer sees a clip start behind it. */
  if (CFG.boardPauseMedia && vlcSource) {
    try { await mediaAction(on ? 'pause' : 'play'); }
    catch (e) { log('flight board: could not ' + (on ? 'pause' : 'resume') + ' the playlist: ' + e.message); }
  }
  log('flight board ' + (on ? 'SHOWN' : 'hidden') + (why ? ' (' + why + ')' : ''));
}

/* ---------------- commands from the dashboard ---------------- */
async function runCommand(c) {
  const arg = String(c.arg || '');
  switch (c.cmd) {
    case 'override':
      if (!writeOverride(arg)) throw new Error('could not write override.txt');
      log('override set to ' + arg + ' from the dashboard');
      return;

    case 'scene':
      if (!sceneList.includes(arg)) throw new Error('no scene named "' + arg + '" in this collection');
      if (!writeOverride('hold:' + arg)) throw new Error('could not write override.txt');
      await setScene(arg);
      log('scene held on ' + arg + ' from the dashboard');
      return;

    case 'stream':
      if (!obsConnected) throw new Error('OBS is not connected');
      if (arg === 'start') {
        if (streamStats.streaming) return;
        await obs.call('StartStream');
        log('stream STARTED from the dashboard');
      } else if (arg === 'stop') {
        if (!streamStats.streaming) return;
        await obs.call('StopStream');
        log('stream STOPPED from the dashboard');
      } else if (arg === 'restart') {
        if (streamStats.streaming) { await obs.call('StopStream'); }
        await new Promise(r => setTimeout(r, 2500));   // Rumble needs the old session gone
        await obs.call('StartStream');
        log('stream RESTARTED from the dashboard');
      }
      return;

    case 'playlist':
      await readPlaylist();
      await mediaAction(arg);
      log('playlist ' + arg + ' from the dashboard');
      return;

    case 'reload':
      loadConfig();
      if (obsConnected) { await refreshScenes(); await detectVlcSource(); }
      log('config reloaded from the dashboard');
      return;

    default:
      throw new Error('unknown command ' + c.cmd);
  }
}

/* ---------------- sync with the relay ---------------- */
async function sync() {
  const ovr = readOverride();
  const body = {
    agent: CFG.agent,
    version: VERSION,
    host: require('os').hostname(),
    bootedAt: BOOTED,
    override: ovr.mode,
    held: ovr.held,
    overrideSetAt: ovr.setAt || 0,
    overrideTtlMs: Number(CFG.overrideTtlMs || 0),
    keepStreaming: !!CFG.keepStreaming,
    note: [noteAuth, noteOverride].filter(Boolean).join(' · '),
    relay: { reachable: relayReachable, live: relayLive, rehearsal: relayRehearsal, title: relayTitle },
    obs: {
      connected: obsConnected,
      streaming: streamStats.streaming,
      scene: currentScene,
      scenes: sceneList,
      streamMs: streamStats.streamMs,
      bitrateKbps: streamStats.bitrateKbps,
      dropped: streamStats.dropped,
      total: streamStats.total,
      cpu: obsStats.cpu,
      fps: obsStats.fps,
      congestion: streamStats.congestion,
      version: obsStats.version,
    },
    ndi: {
      source: CFG.ndiSourceName,
      active: ndiActive,
      frozen: ndiFrozen,
      watchdog: ndiWatchdog,
      stillMs: stillSince ? Date.now() - stillSince : 0,
      // diff and threshold ride along so the numbers can be tuned from
      // the dashboard instead of guessed at.
      diff: lastDiff,
      threshold: Number(CFG.stillThreshold),
      freezeMs: Number(CFG.freezeMs),
    },
    playlist: {
      source: vlcSource,
      playing: vlcPlaying,
      current: (vlcIndex != null && vlcItems[vlcIndex]) ? vlcItems[vlcIndex] : '',
      durationMs: vlcDuration,
      positionMs: vlcCursor,
      items: vlcItems,
    },
    board: {
      source: CFG.boardSourceName || '',
      enabled: !!CFG.boardSourceName && boardItemId != null,
      visible: boardVisible,
      upMs: boardVisible ? Date.now() - boardShownAt : 0,
      showMs: Number(CFG.boardMs || 0),
      laps: Math.floor(boardEnded / Math.max(1, (vlcItems.length || 1) * Math.max(1, Number(CFG.boardEveryLaps) || 1))),
    },
    logs: logPending,
    results,
  };

  let j;
  try {
    const r = await fetch(CFG.syncUrl, {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        CFG.deviceToken ? { 'x-hiley-token': CFG.deviceToken } : {}
      ),
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      if (r.status === 401) {
        noteAuth = 'relay rejected the device token';
        if (!sync._warned401) { sync._warned401 = true; log('SYNC 401 — HILEY_TOKEN on Railway and deviceToken here do not match'); }
      }
      return;
    }
    sync._warned401 = false;
    noteAuth = '';
    j = await r.json();
  } catch (e) {
    return;   // relay down; the channel carries on regardless
  }

  // Only clear what the relay actually accepted.
  logPending = [];
  results = [];

  for (const c of (j.commands || [])) {
    try {
      await runCommand(c);
      results.push({ id: c.id, cmd: c.cmd, arg: c.arg, ok: true, error: '' });
    } catch (e) {
      log('command ' + c.cmd + ' ' + c.arg + ' FAILED: ' + e.message);
      results.push({ id: c.id, cmd: c.cmd, arg: c.arg, ok: false, error: e.message });
    }
  }
}

/* ---------------- the decision ---------------- */
async function tick() {
  let ovr = readOverride();
  const now = Date.now();

  /* Expire a forgotten override. On 24 Sep a hold:NEWS left behind by
     dashboard testing at 00:21 swallowed the 09:02 GO LIVE in silence.
     An override is an operator standing at the desk; when they walk
     away, the automation has to come back on by itself. */
  const ttl = Number(CFG.overrideTtlMs || 0);
  if (ttl > 0 && ovr.mode !== 'auto' && ovr.setAt && (now - ovr.setAt) > ttl) {
    const ageM = Math.round((now - ovr.setAt) / 60000);
    log('OVERRIDE EXPIRED — "' + overrideLabel(ovr) + '" was set ' + ageM +
        'm ago; reverting to auto and following the relay again');
    writeOverride('auto');
    ovr = { mode: 'auto', held: '', setAt: now };
  }

  const label = overrideLabel(ovr);
  if (label !== lastOverride) {
    /* Log the STARTING value too. 2.0 suppressed the first one, so after the
       24 Sep restart the log could not say whether the watcher came up on
       auto or on the hold:NEWS left over from the night before — the single
       fact that would have named fault 3 in seconds. */
    if (lastOverride !== null) log('override -> ' + label);
    else log('override at startup: ' + label +
             (ovr.setAt ? ' (override.txt last written ' +
              Math.round((now - ovr.setAt) / 60000) + 'm ago)' : ' (no override.txt)'));
    lastOverride = label;
    overrideRemindedAt = 0;
  }

  /* Say loudly, and keep saying, that the automation is off. */
  if (ovr.mode !== 'auto') {
    const leftM = ttl > 0 ? Math.max(0, Math.ceil((ttl - (now - ovr.setAt)) / 60000)) : 0;
    noteOverride = 'OVERRIDE ACTIVE (' + label + ') — automation disabled' +
                   (ttl > 0 ? ', reverts in ' + leftM + 'm' : ', no expiry');
    if (now - overrideRemindedAt > 600000) {
      overrideRemindedAt = now;
      log('override still active: ' + noteOverride);
    }
  } else {
    noteOverride = '';
    overrideRemindedAt = 0;
  }

  let target = null;

  if (ovr.mode === 'hold')        target = ovr.held;
  else if (ovr.mode === 'live')   target = CFG.liveScene;
  else if (ovr.mode === 'filler') target = CFG.fillerScene;
  else {
    // auto — follow the relay, but never on a rehearsal, and never on a
    // reading we could not take.
    if (!relayReachable) target = null;                       // hold
    else target = (relayLive && !relayRehearsal) ? CFG.liveScene : CFG.fillerScene;
  }

  /* The watchdog only acts in auto. 2.0 exempted `hold:` but not `live`,
     so FORCE LIVE — the button an operator reaches for precisely when
     they can see the picture is fine — was the one that let the watchdog
     win. It undid four FORCE LIVEs in nine minutes on 24 Sep. A person
     watching the output beats a pixel difference; if they have forced a
     scene, they own the channel until the override expires. */
  if (target === CFG.liveScene && ndiFrozen && ovr.mode === 'auto') {
    target = CFG.fillerScene;
  } else if (ndiFrozen && ovr.mode !== 'auto' && !heldOffFallback) {
    heldOffFallback = true;
    log('watchdog says the NDI picture is still, but override "' + label +
        '" is set — holding the forced scene and NOT falling back');
  }

  /* Flight board, before the scene is set: it must never be left visible
     on a scene that is about to change, and never outlive its cap. */
  if (CFG.boardSourceName && boardVisible) {
    const upMs = now - boardShownAt;
    const cap  = Math.max(Number(CFG.boardMs) || 0, Number(CFG.boardMaxMs) || 0);
    if (target && target !== CFG.fillerScene)      await setBoard(false, 'scene leaving ' + CFG.fillerScene);
    else if (upMs >= (Number(CFG.boardMs) || 60000)) await setBoard(false, 'its time is up');
    else if (upMs >= cap)                            await setBoard(false, 'HARD CAP — it should already have gone');
  }

  if (target) await setScene(target);

  if (CFG.keepStreaming && obsConnected && !streamStats.streaming) {
    try { await obs.call('StartStream'); log('keepStreaming: restarted the encoder'); }
    catch (e) { log('keepStreaming restart failed: ' + e.message); }
  }
}

/* ---------------- loops ---------------- */
log('hiley-watcher ' + VERSION + ' starting in ' + DIR);
loadConfig();
connectOBS();

let busy = false;
setInterval(async () => {
  if (busy) return;                 // never let two cycles overlap
  busy = true;
  try {
    await readRelay();
    await readStats();
    await readPlaylist();
    await tick();
    await sync();
  } catch (e) {
    log('cycle error: ' + e.message);
  } finally { busy = false; }
}, CFG.pollMs || DEFAULTS.pollMs);

setInterval(() => { sampleNDI().catch(() => {}); }, CFG.watchdogMs || DEFAULTS.watchdogMs);

process.on('unhandledRejection', (e) => log('unhandled rejection: ' + (e && e.message ? e.message : e)));
process.on('uncaughtException',  (e) => log('uncaught exception: ' + (e && e.message ? e.message : e)));
