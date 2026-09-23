/* ============================================================
   hiley-watcher — VxD playout agent for the Hiley TV 24/7 channel
   Runs on the playout PC (the Dell). C:\VxD\hiley-watcher
   Version 2.0 — adds the /hiley dashboard link.

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
   ============================================================ */

'use strict';

const fs   = require('fs');
const path = require('path');
const OBSWebSocket = require('obs-websocket-js/json').default;

const VERSION  = '2.0';
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
  freezeSamples:  4,           // ~20s of identical frames = dead feed
  recoverSamples: 2,
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
let lastHash    = '';
let sameCount   = 0;
let changeCount = 0;
let stillSince  = 0;
let sampleFails = 0;

let vlcSource   = '';
let vlcItems    = [];
let vlcIndex    = null;            // see the note in reportPlaylist()
let vlcPlaying  = false;
let vlcDuration = 0;
let vlcCursor   = 0;

let streamStats = { streaming: false, streamMs: 0, bitrateKbps: 0, dropped: 0, total: 0, congestion: 0 };
let obsStats    = { cpu: 0, fps: 0, version: '' };

let results     = [];              // command outcomes awaiting the next sync
let lastOverride = null;
let note = '';

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
  if (vlcSource && d.inputName === vlcSource && vlcIndex != null && vlcItems.length) {
    vlcIndex = (vlcIndex + 1) % vlcItems.length;
  }
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
function readOverride() {
  try {
    const raw = String(fs.readFileSync(OVR_PATH, 'utf8')).trim();
    if (!raw) return { mode: 'auto', held: '' };
    if (/^hold:/i.test(raw)) return { mode: 'hold', held: raw.slice(5).trim() };
    const m = raw.toLowerCase();
    if (m === 'live' || m === 'filler' || m === 'auto') return { mode: m, held: '' };
    return { mode: 'auto', held: '' };
  } catch (e) {
    return { mode: 'auto', held: '' };   // no file = auto
  }
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
   A live camera never produces two pixel-identical frames. A static
   full-screen graphic held for 20s WOULD false-trip — use the override
   for that. Failing to sample at all disables the watchdog rather than
   pulling the channel off LIVE. */
const crypto = require('crypto');

async function sampleNDI() {
  if (!obsConnected || ndiWatchdog === 'disabled') return;
  try {
    const r = await obs.call('GetSourceScreenshot', {
      sourceName: CFG.ndiSourceName,
      imageFormat: 'jpg',
      imageWidth: 160,
      imageHeight: 90,
      imageCompressionQuality: 40,
    });
    sampleFails = 0;
    const h = crypto.createHash('sha1').update(String(r.imageData || '')).digest('hex');
    if (h === lastHash) {
      changeCount = 0;
      sameCount += 1;
      if (!stillSince) stillSince = Date.now();
      if (!ndiFrozen && sameCount >= CFG.freezeSamples) {
        ndiFrozen = true;
        ndiActive = false;
        log('NDI FROZEN — ' + sameCount + ' identical samples; falling back off LIVE');
      }
    } else {
      sameCount = 0;
      stillSince = 0;
      changeCount += 1;
      ndiActive = true;
      if (ndiFrozen && changeCount >= CFG.recoverSamples) {
        ndiFrozen = false;
        log('NDI recovered');
      }
    }
    lastHash = h;
  } catch (e) {
    sampleFails += 1;
    if (sampleFails >= 3) {
      ndiWatchdog = 'disabled';
      ndiFrozen = false;
      log('NDI WATCHDOG DISABLED — cannot sample "' + CFG.ndiSourceName + '" (' + e.message +
          '). Failing open: a dead feed will NOT fall back on its own.');
    }
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
    keepStreaming: !!CFG.keepStreaming,
    note,
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
    },
    playlist: {
      source: vlcSource,
      playing: vlcPlaying,
      current: (vlcIndex != null && vlcItems[vlcIndex]) ? vlcItems[vlcIndex] : '',
      durationMs: vlcDuration,
      positionMs: vlcCursor,
      items: vlcItems,
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
        note = 'relay rejected the device token';
        if (!sync._warned401) { sync._warned401 = true; log('SYNC 401 — HILEY_TOKEN on Railway and deviceToken here do not match'); }
      }
      return;
    }
    sync._warned401 = false;
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
  const ovr = readOverride();
  const label = ovr.mode === 'hold' ? 'hold:' + ovr.held : ovr.mode;
  if (label !== lastOverride) {
    if (lastOverride !== null) log('override -> ' + label);
    lastOverride = label;
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

  // The watchdog outranks everything except an explicit hold: if the LIVE
  // picture is frozen, do not sit on a frozen frame on a partner's channel.
  if (target === CFG.liveScene && ndiFrozen && ovr.mode !== 'hold') {
    target = CFG.fillerScene;
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
