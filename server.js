const express = require('express');
const path = require('path');
const app = express();
const PORT = 8080;

app.use(express.json({ limit: '3mb' })); // 3mb headroom for base64 reporter photos
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// PIN AUTHENTICATION
//
// One shared PIN, set as GOLIVE_PIN. A correct PIN mints a signed
// cookie; every state-changing request must present one.
//
// Design notes, because each of these is a decision someone will
// later wonder about:
//
//  * If GOLIVE_PIN is UNSET the relay runs wide open and preflight
//    says so loudly. Failing closed would mean a forgotten env var
//    bricks /golive at kickoff, and in this system a locked-out
//    operator at kickoff is worse than an open panel.
//  * The cookie is an HMAC over its own expiry — stateless, so a
//    Railway restart mid-event does NOT sign anybody out. Sessions
//    are not stored anywhere.
//  * The signing secret derives from the PIN, so changing the PIN
//    invalidates every outstanding session for free.
//  * GET stays open: OBS browser sources (scorebug, volleybug,
//    tagbug) poll unauthenticated and must never see a 401.
//  * Field reporters are exempt where they need to be — SOS and
//    message-ack come from phones that will never hold the PIN.
// ============================================================
const crypto = require('crypto');

const GOLIVE_PIN   = String(process.env.GOLIVE_PIN || '').trim();
const AUTH_HOURS   = Number(process.env.GOLIVE_SESSION_HOURS || 12);
const AUTH_COOKIE  = 'vxd_auth';
const AUTH_SECRET  = process.env.GOLIVE_SECRET
  || (GOLIVE_PIN + '|' + (process.env.FB_APP_SECRET || 'vxd-relay-fallback'));

// POSTs that must work without a PIN. Reporters in the field carry
// no credentials; an SOS button that 401s is worse than useless.
const AUTH_EXEMPT = new Set(['/api/auth/login', '/api/auth/logout', '/api/sos', '/api/msg/ack']);

const authRequired = () => !!GOLIVE_PIN;

function authSign(expires) {
  return crypto.createHmac('sha256', AUTH_SECRET).update(String(expires)).digest('hex').slice(0, 32);
}
function authMint() {
  const expires = Date.now() + AUTH_HOURS * 3600 * 1000;
  return { token: expires + '.' + authSign(expires), expires };
}
function authVerify(token) {
  if (!token || typeof token !== 'string') return null;
  const [expStr, sig] = token.split('.');
  const expires = Number(expStr);
  if (!expires || !sig) return null;
  if (Date.now() > expires) return null;
  const good = authSign(expires);
  // Constant-time compare; lengths already match by construction.
  if (sig.length !== good.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  return { expires };
}
function readCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function setAuthCookie(res, token, maxAgeSec) {
  res.setHeader('Set-Cookie',
    AUTH_COOKIE + '=' + encodeURIComponent(token) +
    '; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=' + maxAgeSec);
}

// A 4-6 digit PIN is guessable in minutes without this.
const authFails = new Map();   // ip -> { n, until }
function authThrottled(ip) {
  const rec = authFails.get(ip);
  if (!rec) return 0;
  if (Date.now() > rec.until) { authFails.delete(ip); return 0; }
  return rec.n >= 8 ? Math.ceil((rec.until - Date.now()) / 1000) : 0;
}
function authFail(ip) {
  const rec = authFails.get(ip) || { n: 0, until: 0 };
  rec.n += 1;
  rec.until = Date.now() + 15 * 60 * 1000;
  authFails.set(ip, rec);
}

app.use((req, res, next) => {
  if (!authRequired()) return next();
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (AUTH_EXEMPT.has(req.path)) return next();
  if (authVerify(readCookie(req, AUTH_COOKIE))) return next();
  res.status(401).json({ error: 'PIN required', authRequired: true });
});

app.post('/api/auth/login', (req, res) => {
  if (!authRequired()) return res.json({ ok: true, authRequired: false });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
  const wait = authThrottled(ip);
  if (wait) return res.status(429).json({ error: 'Too many attempts. Try again in ' + Math.ceil(wait / 60) + ' min.' });
  const pin = String((req.body && req.body.pin) || '');
  const a = Buffer.from(pin), b = Buffer.from(GOLIVE_PIN);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) { authFail(ip); return res.status(401).json({ error: 'Wrong PIN' }); }
  authFails.delete(ip);
  const { token, expires } = authMint();
  setAuthCookie(res, token, AUTH_HOURS * 3600);
  res.json({ ok: true, expires });
});

app.post('/api/auth/logout', (req, res) => {
  setAuthCookie(res, '', 0);
  res.json({ ok: true });
});

app.get('/api/auth/status', (req, res) => {
  const s = authVerify(readCookie(req, AUTH_COOKIE));
  res.json({ authRequired: authRequired(), authed: !authRequired() || !!s, expires: s ? s.expires : null });
});

// ============================================================
// OPTIONAL POSTGRESQL PERSISTENCE
// If DATABASE_URL is set (Railway Postgres), reporters + ticker
// settings persist across deploys. If it's not set (or pg isn't
// installed), the server still runs fine using in-memory only —
// it just resets on deploy, like before. No crash either way.
// ============================================================
let pool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    const url = process.env.DATABASE_URL;
    const useSSL = /sslmode=require/.test(url) || /\.rlwy\.net/.test(url);
    pool = new Pool({ connectionString: url, ssl: useSSL ? { rejectUnauthorized: false } : false });
  } catch (e) {
    console.error('pg not available, using in-memory:', e.message);
    pool = null;
  }
}

// ============================================================
// OBS CONTROL (obs-websocket v5) — replaces the vMix HTTP API
//
// Inlined here on purpose. The Dockerfile does `COPY server.js ./`
// and nothing else, so a separate obs.js would MODULE_NOT_FOUND on
// Railway. Change that COPY to `COPY *.js ./` if you ever want to
// split this out.
//
// The relay holds ONE long-lived websocket to OBS and keeps the last
// known state in memory. The panel polls the relay exactly as it
// always did; the relay never polls OBS — obs-websocket pushes
// events instead. Strictly less traffic than the old vMix setup.
// ============================================================
let OBSWebSocket = null;
try {
  // v5 is "type": "module" but ships a CJS build; default export is the class.
  OBSWebSocket = require('obs-websocket-js/json').default;
} catch (e) {
  console.error('obs-websocket-js unavailable, OBS control disabled:', e.message);
}

const OBS_URL      = process.env.OBS_WS_URL      || 'wss://vmix.vxd.news';
const OBS_PASSWORD = process.env.OBS_WS_PASSWORD || '';

// These must match the OBS scene collection ("VxD Broadcast").
const OBS_SCENE_VOICE   = process.env.OBS_SCENE_VOICE   || 'VOICE';
const OBS_SCENE_DHUVAS  = process.env.OBS_SCENE_DHUVAS  || 'DHUVAS';
const OBS_SCENE_PROGRAM = process.env.OBS_SCENE_PROGRAM || 'Program';
const OBS_BRANCH_FILTER = process.env.OBS_BRANCH_FILTER || 'Branch Output';
// Second Branch Output filter, on the VOICE scene, pushing to YouTube.
// Separate encode from the main stream — see the load note in the docs.
const OBS_YT_FILTER     = process.env.OBS_YT_FILTER     || 'YouTube';
// Third Branch Output filter, on the Program scene, writing the CLEAN feed
// to a local file. Program carries no branding, so it is the only picture on
// this box worth re-editing from. OBS's own Record button cannot be pointed
// at it: native recording always takes the main output, which is the branded
// VOICE scene. Leave the filter's server and key blank — Branch Output runs
// as recording-only when there is no connection info.
const OBS_REC_FILTER    = process.env.OBS_REC_FILTER    || 'Record';
const OBS_AUDIO_INPUT   = process.env.OBS_AUDIO_INPUT   || 'CAM — PSM (NDI)';
const OBS_FTB_VOICE     = process.env.OBS_FTB_VOICE     || 'FTB — Black (VOICE)';
const OBS_FTB_DHUVAS    = process.env.OBS_FTB_DHUVAS    || 'FTB — Black (DHUVAS)';

// Only scene items whose name starts with this take part in TAKE.
// Overlays ("OVL — ...") are left alone.
const OBS_CAM_PREFIX = process.env.OBS_CAM_PREFIX || 'CAM';

const obs = OBSWebSocket ? new OBSWebSocket() : null;

const obsState = {
  connected: false,
  streaming: false,
  branchLive: false,       // Branch Output filter enabled (Dhuvas -> Facebook)
  ytLive: false,           // Branch Output filter enabled (VOICE -> YouTube)
  recording: false,        // clean-feed recording running
  recMode: 'none',         // 'branch' (clean Program) | 'native' (branded) | 'none'
  ftb: false,
  currentScene: '',
  cams: [],                // [{ id, name, live }] inside Program
  volume: 100,             // 0-100 slider position
  muted: false,
  obsVersion: '',
  stats: {
    cpu: 0, fps: 0, renderTime: 0,
    renderMissed: 0, renderTotal: 0,
    outputSkipped: 0, outputTotal: 0,
    droppedFrames: 0, totalFrames: 0,
    bitrate: 0, bytes: 0,
  },
  lastError: '',
  lastUpdate: 0,
};

// vMix used amplitude = (v/100)^4. OBS's own fader is cubic, so the cube
// keeps the slider feeling familiar AND matches what the OBS UI shows.
const sliderToMul = (v) => Math.pow(Math.max(0, Math.min(100, v)) / 100, 3);
const mulToSlider = (m) => Math.round(Math.cbrt(Math.max(0, Math.min(1, m))) * 100);

let obsReconnectTimer = null;
let obsBackoff = 2000;
let lastBytes = 0, lastBytesAt = 0;

async function obsRefreshScene() {
  if (!obs || !obsState.connected) return;
  try {
    const items = await obs.call('GetSceneItemList', { sceneName: OBS_SCENE_PROGRAM });
    obsState.cams = (items.sceneItems || [])
      .filter((i) => String(i.sourceName || '').startsWith(OBS_CAM_PREFIX))
      .map((i) => ({ id: i.sceneItemId, name: i.sourceName, live: !!i.sceneItemEnabled }))
      .reverse(); // top of the OBS list first — matches what the operator sees
  } catch (e) { obsState.lastError = 'scene: ' + e.message; }

  try {
    const f = await obs.call('GetSourceFilter', {
      sourceName: OBS_SCENE_DHUVAS, filterName: OBS_BRANCH_FILTER,
    });
    obsState.branchLive = !!f.filterEnabled;
  } catch (e) { /* filter may not exist yet — not fatal */ }

  try {
    const y = await obs.call('GetSourceFilter', {
      sourceName: OBS_SCENE_VOICE, filterName: OBS_YT_FILTER,
    });
    obsState.ytLive = !!y.filterEnabled;
  } catch (e) { obsState.ytLive = false; /* no YouTube filter — not fatal */ }

  // Which recorder are we actually driving? The Branch Output filter on
  // Program is preferred because it is the only one that produces the clean
  // feed. If it is absent we fall back to OBS's own recorder, which captures
  // the branded VOICE output — still useful, but not the same file. recMode
  // is carried all the way to the panel so nothing ever labels a branded
  // recording "clean".
  try {
    const r = await obs.call('GetSourceFilter', {
      sourceName: OBS_SCENE_PROGRAM, filterName: OBS_REC_FILTER,
    });
    obsState.recMode = 'branch';
    obsState.recording = !!r.filterEnabled;
  } catch (e) {
    try {
      const rs = await obs.call('GetRecordStatus');
      obsState.recMode = 'native';
      obsState.recording = !!rs.outputActive;
    } catch (e2) {
      obsState.recMode = 'none';
      obsState.recording = false;
    }
  }

  try {
    const v = await obs.call('GetInputVolume', { inputName: OBS_AUDIO_INPUT });
    obsState.volume = mulToSlider(v.inputVolumeMul);
    const m = await obs.call('GetInputMute', { inputName: OBS_AUDIO_INPUT });
    obsState.muted = !!m.inputMuted;
  } catch (e) { /* audio input may be named differently — not fatal */ }

  try {
    const ftb = await obs.call('GetSceneItemId', {
      sceneName: OBS_SCENE_VOICE, sourceName: OBS_FTB_VOICE,
    });
    const en = await obs.call('GetSceneItemEnabled', {
      sceneName: OBS_SCENE_VOICE, sceneItemId: ftb.sceneItemId,
    });
    obsState.ftb = !!en.sceneItemEnabled;
  } catch (e) { /* no FTB source — not fatal */ }

  obsState.lastUpdate = Date.now();
}

async function obsPollStats() {
  if (!obs || !obsState.connected) return;
  try {
    const s = await obs.call('GetStats');
    obsState.stats.cpu = Math.round((s.cpuUsage || 0) * 10) / 10;
    obsState.stats.fps = Math.round((s.activeFps || 0) * 100) / 100;
    obsState.stats.renderTime = Math.round((s.averageFrameRenderTime || 0) * 100) / 100;
    obsState.stats.renderMissed = s.renderSkippedFrames || 0;
    obsState.stats.renderTotal = s.renderTotalFrames || 0;
    obsState.stats.outputSkipped = s.outputSkippedFrames || 0;
    obsState.stats.outputTotal = s.outputTotalFrames || 0;
  } catch (e) { /* ignore */ }

  try {
    const st = await obs.call('GetStreamStatus');
    obsState.streaming = !!st.outputActive;
    obsState.stats.droppedFrames = st.outputSkippedFrames || 0;
    obsState.stats.totalFrames = st.outputTotalFrames || 0;
    const now = Date.now();
    const bytes = st.outputBytes || 0;
    if (lastBytesAt && bytes >= lastBytes && now > lastBytesAt) {
      obsState.stats.bitrate = Math.round(((bytes - lastBytes) * 8) / ((now - lastBytesAt) / 1000) / 1000);
    }
    lastBytes = bytes; lastBytesAt = now;
    obsState.stats.bytes = bytes;
  } catch (e) { /* ignore */ }

  // Branch Output does not report through obs-websocket at all, so in branch
  // mode filter-enabled IS the lamp — the same fidelity the Dhuvas and
  // YouTube lamps have always had. Native mode gets the real thing.
  if (obsState.recMode === 'native') {
    try {
      const rs = await obs.call('GetRecordStatus');
      obsState.recording = !!rs.outputActive;
    } catch (e) { /* ignore */ }
  }
}

function obsScheduleReconnect() {
  if (obsReconnectTimer) return;
  obsReconnectTimer = setTimeout(() => {
    obsReconnectTimer = null;
    obsConnect();
  }, obsBackoff);
  obsBackoff = Math.min(obsBackoff * 2, 30000);
}

async function obsConnect() {
  if (!obs) return;
  try {
    const info = await obs.connect(OBS_URL, OBS_PASSWORD || undefined, { rpcVersion: 1 });
    obsState.connected = true;
    obsState.obsVersion = (info && info.obsWebSocketVersion) || '';
    obsState.lastError = '';
    obsBackoff = 2000;
    console.log('OBS connected:', OBS_URL, 'ws v' + obsState.obsVersion);

    try {
      const cur = await obs.call('GetCurrentProgramScene');
      obsState.currentScene = cur.sceneName || cur.currentProgramSceneName || '';
    } catch (e) { /* ignore */ }

    await obsRefreshScene();
    await obsPollStats();
  } catch (e) {
    obsState.connected = false;
    obsState.lastError = e.message;
    obsScheduleReconnect();
  }
}

if (obs) {
  obs.on('ConnectionClosed', () => {
    obsState.connected = false;
    obsState.streaming = false;
    obsScheduleReconnect();
  });
  obs.on('ConnectionError', (e) => {
    obsState.connected = false;
    obsState.lastError = (e && e.message) ? e.message : 'connection error';
  });
  obs.on('StreamStateChanged', (e) => { obsState.streaming = !!e.outputActive; });
  obs.on('CurrentProgramSceneChanged', (e) => { obsState.currentScene = e.sceneName; });
  obs.on('SceneItemEnableStateChanged', (e) => {
    if (e.sceneName === OBS_SCENE_PROGRAM) {
      const c = obsState.cams.find((x) => x.id === e.sceneItemId);
      if (c) c.live = !!e.sceneItemEnabled;
    }
    if (e.sceneName === OBS_SCENE_VOICE) obsRefreshScene();
  });
  obs.on('SourceFilterEnableStateChanged', (e) => {
    if (e.sourceName === OBS_SCENE_DHUVAS && e.filterName === OBS_BRANCH_FILTER) {
      obsState.branchLive = !!e.filterEnabled;
    }
    if (e.sourceName === OBS_SCENE_VOICE && e.filterName === OBS_YT_FILTER) {
      obsState.ytLive = !!e.filterEnabled;
    }
    if (e.sourceName === OBS_SCENE_PROGRAM && e.filterName === OBS_REC_FILTER) {
      obsState.recording = !!e.filterEnabled;
    }
  });
  obs.on('RecordStateChanged', (e) => {
    if (obsState.recMode === 'native') obsState.recording = !!e.outputActive;
  });
  obs.on('InputVolumeChanged', (e) => {
    if (e.inputName === OBS_AUDIO_INPUT) obsState.volume = mulToSlider(e.inputVolumeMul);
  });
  obs.on('InputMuteStateChanged', (e) => {
    if (e.inputName === OBS_AUDIO_INPUT) obsState.muted = !!e.inputMuted;
  });

  obsConnect();
  setInterval(obsPollStats, 2000);
  setInterval(() => { if (obsState.connected) obsRefreshScene(); }, 15000);
}

function obsGuard(res) {
  if (!obs) { res.status(503).json({ error: 'obs-websocket-js not installed' }); return false; }
  if (!obsState.connected) { res.status(502).json({ error: 'OBS not connected: ' + obsState.lastError }); return false; }
  return true;
}

// ---- status -------------------------------------------------
app.get('/api/obs', (req, res) => res.json(obsState));

// ---- streaming ----------------------------------------------
// Branch Output interlock is set to "Streaming" in OBS, so starting
// the main stream starts Dhuvas too. One call drives both outputs.
app.post('/api/obs/stream', async (req, res) => {
  if (!obsGuard(res)) return;
  try {
    const action = (req.body && req.body.action) || 'toggle';
    if (action === 'start') await obs.call('StartStream');
    else if (action === 'stop') await obs.call('StopStream');
    else await obs.call('ToggleStream');
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- TAKE (switch camera inside Program) --------------------
app.post('/api/obs/take', async (req, res) => {
  if (!obsGuard(res)) return;
  try {
    const want = (req.body && req.body.id != null) ? Number(req.body.id) : null;
    const wantName = req.body && req.body.name;
    const target = obsState.cams.find(
      (c) => (want != null && c.id === want) || (wantName && c.name === wantName)
    );
    if (!target) return res.status(404).json({ error: 'camera not found' });

    for (const c of obsState.cams) {
      const on = c.id === target.id;
      if (c.live !== on) {
        await obs.call('SetSceneItemEnabled', {
          sceneName: OBS_SCENE_PROGRAM, sceneItemId: c.id, sceneItemEnabled: on,
        });
        c.live = on;
      }
    }
    res.json({ ok: true, live: target.name });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- FTB (fade to black on BOTH branded scenes) -------------
app.post('/api/obs/ftb', async (req, res) => {
  if (!obsGuard(res)) return;
  try {
    const on = (req.body && typeof req.body.on === 'boolean') ? req.body.on : !obsState.ftb;
    for (const [scene, src] of [[OBS_SCENE_VOICE, OBS_FTB_VOICE], [OBS_SCENE_DHUVAS, OBS_FTB_DHUVAS]]) {
      try {
        const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName: scene, sourceName: src });
        await obs.call('SetSceneItemEnabled', { sceneName: scene, sceneItemId, sceneItemEnabled: on });
      } catch (e) { /* one scene missing its FTB source shouldn't kill the other */ }
    }
    obsState.ftb = on;
    res.json({ ok: true, ftb: on });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- audio ---------------------------------------------------
app.post('/api/obs/volume', async (req, res) => {
  if (!obsGuard(res)) return;
  try {
    const v = Number(req.body && req.body.value);
    if (!isFinite(v)) return res.status(400).json({ error: 'value required' });
    await obs.call('SetInputVolume', {
      inputName: OBS_AUDIO_INPUT, inputVolumeMul: sliderToMul(v),
    });
    obsState.volume = Math.round(v);
    res.json({ ok: true, volume: obsState.volume });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/obs/mute', async (req, res) => {
  if (!obsGuard(res)) return;
  try {
    const muted = (req.body && typeof req.body.muted === 'boolean') ? req.body.muted : !obsState.muted;
    await obs.call('SetInputMute', { inputName: OBS_AUDIO_INPUT, inputMuted: muted });
    obsState.muted = muted;
    res.json({ ok: true, muted });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- Branch Output (Dhuvas) ---------------------------------
// Normally follows the main stream via interlock; this is the manual
// override for running one brand without the other.
app.post('/api/obs/branch', async (req, res) => {
  if (!obsGuard(res)) return;
  try {
    const target = (req.body && req.body.target) || 'dhuvas';
    const isYT = target === 'youtube';
    const scene = isYT ? OBS_SCENE_VOICE : OBS_SCENE_DHUVAS;
    const filter = isYT ? OBS_YT_FILTER : OBS_BRANCH_FILTER;
    const currently = isYT ? obsState.ytLive : obsState.branchLive;
    const enabled = (req.body && typeof req.body.enabled === 'boolean') ? req.body.enabled : !currently;

    await obs.call('SetSourceFilterEnabled', {
      sourceName: scene, filterName: filter, filterEnabled: enabled,
    });
    if (isYT) obsState.ytLive = enabled; else obsState.branchLive = enabled;
    res.json({ ok: true, target, enabled });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- recording (clean Program feed) -------------------------
// Manual override. The event flow arms and disarms this on its own; this is
// for starting a recording outside an event, or rescuing one left running.
app.post('/api/obs/record', async (req, res) => {
  if (!obsGuard(res)) return;
  try {
    const enabled = (req.body && typeof req.body.enabled === 'boolean')
      ? req.body.enabled : !obsState.recording;
    await setRecordEnabled(enabled);
    res.json({ ok: true, recording: enabled, mode: obsState.recMode });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- destinations (used by the Facebook automation) ---------
// VOICE goes on the main OBS stream service; Dhuvas goes into the
// Branch Output filter. Neither can change while streaming, so set
// them BEFORE StartStream.
app.post('/api/obs/destination', async (req, res) => {
  if (!obsGuard(res)) return;
  try {
    const { target, server, key } = req.body || {};
    if (!server || !key) return res.status(400).json({ error: 'server and key required' });

    if (target === 'voice') {
      await obs.call('SetStreamServiceSettings', {
        streamServiceType: 'rtmp_custom',
        streamServiceSettings: { server, key, use_auth: false },
      });
    } else if (target === 'dhuvas') {
      // Read first, patch, write back — the plugin stores far more than
      // these two fields and a bare set would wipe the rest.
      const cur = await obs.call('GetSourceFilter', {
        sourceName: OBS_SCENE_DHUVAS, filterName: OBS_BRANCH_FILTER,
      });
      const settings = Object.assign({}, cur.filterSettings, { server, key });
      await obs.call('SetSourceFilterSettings', {
        sourceName: OBS_SCENE_DHUVAS, filterName: OBS_BRANCH_FILTER,
        filterSettings: settings, overlay: true,
      });
    } else if (target === 'youtube') {
      const cur = await obs.call('GetSourceFilter', {
        sourceName: OBS_SCENE_VOICE, filterName: OBS_YT_FILTER,
      });
      await obs.call('SetSourceFilterSettings', {
        sourceName: OBS_SCENE_VOICE, filterName: OBS_YT_FILTER,
        filterSettings: Object.assign({}, cur.filterSettings, { server, key }),
        overlay: true,
      });
    } else {
      return res.status(400).json({ error: "target must be 'voice', 'dhuvas' or 'youtube'" });
    }
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---- raw passthrough, for anything not wrapped above ---------
app.post('/api/obs/call', async (req, res) => {
  if (!obsGuard(res)) return;
  try {
    const { request, data } = req.body || {};
    if (!request) return res.status(400).json({ error: 'request required' });
    const out = await obs.call(request, data || {});
    res.json({ ok: true, data: out });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ============================================================
// MATCH AUTOMATION — Facebook Live via Graph API
//
// One call creates a live video on the selected pages, writes each
// page's stream key into the right place in OBS, and starts streaming.
// Another call ends the match and closes what it opened.
//
// DESTINATIONS: POST /api/match/start accepts
//   {"destinations": {"voice": true, "dhuvas": true, "youtube": false}}
// Omit the object entirely and all three are used, so every older
// caller behaves exactly as before. The three are genuinely independent
// in OBS: VOICE is the main encoder output, DHUVAS and YouTube are
// Branch Output filters which — under Interlock "Always ON" — broadcast
// on their own the moment they are enabled. So a DHUVAS-only event is a
// real thing: create the DHUVAS broadcast, arm its branch, and never
// call StartStream at all. What changes per selection:
//   voice    → create the VOICE video, SetStreamServiceSettings, StartStream
//   dhuvas   → create the DHUVAS video, write the branch key, arm the branch
//   youtube  → create the bound YouTube broadcast, arm the YouTube branch
// VOICE stays the selected scene in OBS regardless — the branches encode
// their own source scene, and clicking DHUVAS to "match" a DHUVAS-only
// event would swap branding on every output.
//
// Sequence used by /api/match/start:
//   1. create both live videos as UNPUBLISHED (nothing visible yet)
//   2. write VOICE's key to the OBS stream service,
//      Dhuvas's key into the Branch Output filter
//   3. StartStream
//   4. ~10s later, once OBS confirms it is actually streaming,
//      flip both to LIVE_NOW
//
// Creating them UNPUBLISHED first is deliberate: LIVE_NOW publishes
// the post immediately, so a failure anywhere after that leaves a
// dead broadcast on both pages with viewers staring at a spinner.
//
// REHEARSAL MODE: POST /api/match/start with {"publish": false} runs
// steps 1-3 and skips step 4 entirely. The broadcasts are created,
// the keys land in OBS, the encoder runs and Facebook ingests the
// feed — but nothing is ever flipped to LIVE_NOW, so nothing appears
// on either page and no follower is notified. /api/match/end closes
// the unpublished broadcasts and leaves no VOD behind. Use this to
// exercise the whole path at any hour without going public.
// ============================================================
const FB_API_VERSION = process.env.FB_API_VERSION || 'v25.0';
const FB_GRAPH = `https://graph.facebook.com/${FB_API_VERSION}`;

const FB_PAGES = {
  voice: {
    label: 'VOICE',
    id: process.env.FB_VOICE_PAGE_ID || '248813165823102',
    token: process.env.FB_VOICE_TOKEN || '',
  },
  dhuvas: {
    label: 'Dhuvas',
    id: process.env.FB_DHUVAS_PAGE_ID || '',
    token: process.env.FB_DHUVAS_TOKEN || '',
  },
};

const matchState = {
  live: false,
  rehearsal: false,        // true when started with {publish:false} — never auto-publishes
  youtube: null,           // { id, url, title } when a YouTube broadcast was created
  title: '',
  startedAt: 0,
  publishedAt: 0,
  videos: { voice: null, dhuvas: null },   // { id, permalink, published }
  // Which destinations THIS event selected. Not cosmetic: /api/match/end
  // must close only what was opened, and the publish timer has to know
  // which signal proves ingest (see ingestProven()).
  dests: { voice: false, dhuvas: false, youtube: false },
  // True only when THIS event started the recording. A recording somebody
  // armed by hand is theirs to stop — END LIVE must not silently kill it.
  record: false,
  lastError: '',
};

// ---- destination selection ---------------------------------------
// Default is all three, so every existing caller — the PowerShell
// snippets, the control panel, an older cached golive.html — keeps
// behaving exactly as before. When `destinations` IS supplied, only
// the keys explicitly set true are used: a partial object means
// precisely what it names, never "these plus the rest".
function pickDests(body) {
  const want = body && body.destinations;
  if (!want || typeof want !== 'object') {
    return { voice: true, dhuvas: true, youtube: true };
  }
  return {
    voice: want.voice === true,
    dhuvas: want.dhuvas === true,
    youtube: want.youtube === true,
  };
}

// Proof that bytes are actually flowing before anything is published.
// VOICE rides the main encoder, so GetStreamStatus is the signal. A
// DHUVAS-only event never calls StartStream at all — under Interlock
// "Always ON" the branch filter IS the output, so its enabled state is
// what has to be true. Checking the wrong one would leave a perfectly
// healthy DHUVAS event permanently UNPUBLISHED.
async function ingestProven(dests) {
  if (dests.voice) {
    const st = await obs.call('GetStreamStatus');
    return !!st.outputActive;
  }
  if (dests.dhuvas) {
    const f = await obs.call('GetSourceFilter', {
      sourceName: OBS_SCENE_DHUVAS, filterName: OBS_BRANCH_FILTER,
    });
    return !!f.filterEnabled;
  }
  return true;   // YouTube-only: nothing on Facebook to publish anyway
}

async function fbCall(path, params, method) {
  const url = new URL(FB_GRAPH + path);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    if (method === 'POST') body.append(k, String(v));
    else url.searchParams.append(k, String(v));
  }
  const r = await fetch(url.toString(), method === 'POST'
    ? { method: 'POST', body }
    : { method: 'GET' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const m = (j.error && j.error.message) || ('HTTP ' + r.status);
    throw new Error(m);
  }
  return j;
}

// "rtmps://live-api-s.facebook.com:443/rtmp/FB-123-456" splits into
// server "rtmps://live-api-s.facebook.com:443/rtmp/" and key "FB-123-456".
function splitStreamUrl(u) {
  const i = u.lastIndexOf('/');
  if (i < 0) throw new Error('unexpected stream url: ' + u);
  return { server: u.slice(0, i + 1), key: u.slice(i + 1) };
}

// Branch Output's Interlock is set to "Always ON", which means a filter
// broadcasts the moment it is enabled — it no longer waits for StartStream.
// That is what makes the Monitor branch usable as a permanent preview, but
// it also removes the safety net that used to exist by accident: an enabled
// DHUVAS or YouTube filter is live as soon as OBS opens. So the invariant
// between events is Monitor ON, DHUVAS and YouTube OFF, and these two
// functions are what maintain it. Never leave them enabled by hand.
async function setBranchEnabled(target, enabled) {
  const isYT = target === 'youtube';
  await obs.call('SetSourceFilterEnabled', {
    sourceName: isYT ? OBS_SCENE_VOICE : OBS_SCENE_DHUVAS,
    filterName: isYT ? OBS_YT_FILTER : OBS_BRANCH_FILTER,
    filterEnabled: enabled,
  });
  if (isYT) obsState.ytLive = enabled; else obsState.branchLive = enabled;
}

// Recording is deliberately NOT a destination. Nothing is published, nothing
// goes public, and the failure mode is the opposite of a broadcast's: an event
// that records nothing has lost an archive, not leaked one. So it is armed
// FIRST and disarmed LAST — the file covers the whole event, ramp-up and
// wind-down included — and a recording failure never aborts a go-live.
async function setRecordEnabled(enabled) {
  if (obsState.recMode === 'branch') {
    await obs.call('SetSourceFilterEnabled', {
      sourceName: OBS_SCENE_PROGRAM, filterName: OBS_REC_FILTER, filterEnabled: enabled,
    });
  } else if (obsState.recMode === 'native') {
    // StartRecord on a running recorder throws, and so does StopRecord on an
    // idle one — which would turn a clean end into "ended with problems".
    if (enabled === obsState.recording) return;
    await obs.call(enabled ? 'StartRecord' : 'StopRecord');
  } else {
    throw new Error('no recording output in OBS — add a "' + OBS_REC_FILTER +
      '" Branch Output filter to the ' + OBS_SCENE_PROGRAM + ' scene, server and key blank');
  }
  obsState.recording = enabled;
}

async function setDestination(brand, server, key) {
  if (brand === 'voice') {
    await obs.call('SetStreamServiceSettings', {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { server, key, use_auth: false },
    });
  } else {
    const cur = await obs.call('GetSourceFilter', {
      sourceName: OBS_SCENE_DHUVAS, filterName: OBS_BRANCH_FILTER,
    });
    await obs.call('SetSourceFilterSettings', {
      sourceName: OBS_SCENE_DHUVAS, filterName: OBS_BRANCH_FILTER,
      filterSettings: Object.assign({}, cur.filterSettings, { server, key }),
      overlay: true,
    });
  }
}

// ============================================================
// YOUTUBE DATA API v3
//
// Facebook is fully API-driven; YouTube was not. It rode a persistent
// stream key set in the OBS Branch Output filter, so its title was
// whatever Studio happened to have — an easy thing to forget, and
// invisible when forgotten.
//
// This keeps the persistent key (OBS never changes) and instead creates
// a NEW BROADCAST per event and binds it to that existing stream. The
// broadcast carries the event name and caption, and `enableAutoStart`
// makes it go live the moment the branch starts pushing.
//
// ⚠ The refresh token only lasts 7 days unless the Google OAuth consent
// screen publishing status is "In production". Testing mode expires it —
// same silent-failure shape as the Facebook data-access clock.
// ============================================================
const YT_CLIENT_ID     = process.env.YT_CLIENT_ID || '';
const YT_CLIENT_SECRET = process.env.YT_CLIENT_SECRET || '';
const YT_REFRESH_TOKEN = process.env.YT_REFRESH_TOKEN || '';
const YT_STREAM_ID     = process.env.YT_STREAM_ID || '';      // optional override
const YT_PRIVACY       = process.env.YT_PRIVACY || 'public';
const YT_REDIRECT      = process.env.YT_REDIRECT || 'https://mix.vxd.news/oauth/youtube/callback';
const YT_SCOPE         = 'https://www.googleapis.com/auth/youtube.force-ssl';

const ytConfigured = () => !!(YT_CLIENT_ID && YT_CLIENT_SECRET && YT_REFRESH_TOKEN);

// Access tokens last an hour; cache and refresh a minute early.
let ytAccess = { token: '', expires: 0 };
async function ytToken() {
  if (ytAccess.token && Date.now() < ytAccess.expires - 60000) return ytAccess.token;
  const body = new URLSearchParams({
    client_id: YT_CLIENT_ID, client_secret: YT_CLIENT_SECRET,
    refresh_token: YT_REFRESH_TOKEN, grant_type: 'refresh_token',
  });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error('YouTube token refresh failed: ' + (j.error_description || j.error || ('HTTP ' + r.status)));
  }
  ytAccess = { token: j.access_token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
  return ytAccess.token;
}

async function ytCall(pathname, { method = 'GET', params = {}, body } = {}) {
  const url = new URL('https://www.googleapis.com/youtube/v3' + pathname);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.append(k, String(v));
  const opt = { method, headers: { Authorization: 'Bearer ' + (await ytToken()) } };
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(url.toString(), opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`YouTube ${method} ${pathname}: ` + ((j.error && j.error.message) || ('HTTP ' + r.status)));
  return j;
}

// The channel's reusable ingest stream — the one whose key is already in
// the OBS Branch Output filter. Looked up once per event rather than
// stored, so rotating the key in Studio doesn't silently break us.
async function ytFindStream() {
  if (YT_STREAM_ID) return YT_STREAM_ID;
  // liveStreams.list?mine=true is a long-standing source of HTTP 500
  // "Internal error encountered" on some channels, and the `part` combination
  // is one trigger. Ask for progressively less until one works, rather than
  // failing the whole event over a Google-side quirk.
  const parts = ['id,snippet,cdn,contentDetails,status', 'id,snippet,cdn', 'id,cdn', 'id'];
  let lastErr;
  for (const part of parts) {
    try {
      const j = await ytCall('/liveStreams', { params: { part, mine: true, maxResults: 50 } });
      const items = j.items || [];
      const pick = items.find(x => x.contentDetails && x.contentDetails.isReusable) || items[0];
      if (!pick) throw new Error('no reusable ingest stream found on the YouTube channel');
      return pick.id;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// Escape hatch for when the list call is unusable: make our own reusable
// ingest stream and pin its id in YT_STREAM_ID. The returned key then goes
// into the OBS YouTube Branch Output filter. Deliberately NOT automatic —
// creating streams silently on every failure would litter the channel.
async function ytCreateStream(title) {
  const j = await ytCall('/liveStreams', {
    method: 'POST',
    params: { part: 'id,snippet,cdn,contentDetails' },
    body: {
      snippet: { title: String(title || 'VxD Relay Ingest').slice(0, 128) },
      cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
      contentDetails: { isReusable: true },
    },
  });
  const ing = (j.cdn && j.cdn.ingestionInfo) || {};
  return {
    streamId: j.id,
    streamKey: ing.streamName,
    rtmpUrl: ing.ingestionAddress,
    backupUrl: ing.backupIngestionAddress,
    title: j.snippet && j.snippet.title,
  };
}

async function ytStartBroadcast(title, description) {
  const streamId = await ytFindStream();
  const b = await ytCall('/liveBroadcasts', {
    method: 'POST',
    params: { part: 'snippet,status,contentDetails' },
    body: {
      snippet: {
        title: String(title).slice(0, 100),          // YouTube hard limit
        description: String(description || '').slice(0, 5000),
        scheduledStartTime: new Date(Date.now() + 30000).toISOString(),
      },
      status: { privacyStatus: YT_PRIVACY, selfDeclaredMadeForKids: false },
      contentDetails: {
        enableAutoStart: true,   // goes live when the branch starts pushing
        enableAutoStop: true,    // and ends when it stops
        enableDvr: true,
        monitorStream: { enableMonitorStream: false },
      },
    },
  });
  await ytCall('/liveBroadcasts/bind', {
    method: 'POST',
    params: { id: b.id, streamId, part: 'id,contentDetails' },
  });
  return { id: b.id, url: 'https://www.youtube.com/watch?v=' + b.id, title: String(title).slice(0, 100) };
}

async function ytEndBroadcast(id) {
  // autoStop usually handles this, but be explicit — a broadcast left
  // "live" with no ingest sits on the channel looking broken.
  try {
    await ytCall('/liveBroadcasts/transition', {
      method: 'POST', params: { id, broadcastStatus: 'complete', part: 'id,status' },
    });
  } catch (e) {
    // Already complete, or never started: both are fine, not failures.
    if (!/redundant|invalid transition|not currently live/i.test(e.message)) throw e;
  }
}

// ---- one-time OAuth, to obtain the refresh token -------------------
app.get('/oauth/youtube/start', (req, res) => {
  if (!YT_CLIENT_ID || !YT_CLIENT_SECRET) {
    return res.status(400).send('Set YT_CLIENT_ID and YT_CLIENT_SECRET on Railway first.');
  }
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', YT_CLIENT_ID);
  u.searchParams.set('redirect_uri', YT_REDIRECT);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', YT_SCOPE);
  u.searchParams.set('access_type', 'offline');
  // 'consent' forces a refresh_token every time. 'select_account' forces the
  // account chooser, which is the ONLY place Google offers Brand Account
  // channels — sign in straight through and you silently authorise the
  // personal channel instead, which is not live-enabled.
  u.searchParams.set('prompt', 'select_account consent');
  res.redirect(u.toString());
});

app.get('/oauth/youtube/callback', async (req, res) => {
  const code = req.query && req.query.code;
  if (!code) return res.status(400).send('No code returned. Error: ' + ((req.query && req.query.error) || 'unknown'));
  try {
    const body = new URLSearchParams({
      code, client_id: YT_CLIENT_ID, client_secret: YT_CLIENT_SECRET,
      redirect_uri: YT_REDIRECT, grant_type: 'authorization_code',
    });
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.refresh_token) {
      return res.status(502).send('<pre>No refresh token returned.\n' +
        JSON.stringify(j, null, 2) +
        '\n\nIf refresh_token is missing, Google has already issued one to this client.\n' +
        'Remove the app at myaccount.google.com/permissions and try again.</pre>');
    }
    res.set('Content-Type', 'text/html').send(
      '<!doctype html><meta charset=utf-8><title>YouTube refresh token</title>' +
      '<body style="font-family:ui-monospace,monospace;background:#141413;color:#f2f0ec;padding:2rem;line-height:1.6">' +
      '<h1 style="font-family:ui-sans-serif,system-ui">Copy this into Railway as <code>YT_REFRESH_TOKEN</code></h1>' +
      '<p style="color:#f0915e">Shown once. Treat it like a password — it grants ongoing access to the channel.</p>' +
      '<textarea readonly rows=4 style="width:100%;font:inherit;background:#1e1d1b;color:#f2f0ec;border:1px solid #2e2d2a;padding:1rem;border-radius:6px">' +
      String(j.refresh_token).replace(/[<>&]/g, '') + '</textarea>' +
      '<p>Then redeploy and run <b>RUN PREFLIGHT</b> on /golive.</p></body>');
  } catch (e) {
    res.status(502).send('Token exchange failed: ' + e.message);
  }
});

app.post('/api/match/start', async (req, res) => {
  if (!obsGuard(res)) return;
  const title = (req.body && req.body.title || '').trim();
  // Facebook shows `title` on the video itself, but the POST TEXT people
  // read in the feed comes from `description`. A title with no description
  // produces a live post with no caption — which is what happened on the
  // 15 Sep event. Fall back to the title so there is always copy.
  const description = (req.body && req.body.description || '').trim() || title;
  // Rehearsal: only an explicit false opts out of publishing. Anything
  // else — absent, undefined, a stray string — behaves exactly as before,
  // so a real match can never be silently turned into a rehearsal.
  const autoPublish = !(req.body && req.body.publish === false);
  // Recording defaults ON. Destinations default to nothing because a stray
  // broadcast is public and irreversible; a stray recording is a file you
  // delete. The costly mistake here is the one you only notice afterwards,
  // when the match you wanted to cut from was never written to disk.
  const wantRecord = !(req.body && req.body.record === false);
  const dests = pickDests(req.body);
  if (!title) return res.status(400).json({ error: 'title required' });
  if (matchState.live) return res.status(409).json({ error: 'a match is already live — end it first' });
  if (!dests.voice && !dests.dhuvas && !dests.youtube) {
    return res.status(400).json({ error: 'pick at least one destination' });
  }

  // Work with whatever pages are configured AND selected. A brand with no
  // token is skipped entirely — its OBS destination is left exactly as it
  // is, so a manually-configured persistent stream key keeps working.
  const active = Object.entries(FB_PAGES).filter(([k, p]) => dests[k] && p.id && p.token);
  if (!active.length && !dests.youtube) {
    const why = (dests.voice || dests.dhuvas)
      ? 'the selected Facebook page has no token — set FB_*_PAGE_ID and FB_*_TOKEN'
      : 'no Facebook pages configured — set FB_*_PAGE_ID and FB_*_TOKEN';
    return res.status(400).json({ error: why });
  }
  const skipped = Object.entries(FB_PAGES)
    .filter(([k, p]) => dests[k] && !(p.id && p.token))
    .map(([k]) => k);

  // Stream settings can't be changed while streaming. This still applies
  // even to an event that never calls StartStream: OBS streaming with no
  // event of ours running means someone started it by hand, and quietly
  // arming a branch alongside it is how you end up with two broadcasts.
  if (obsState.streaming) {
    return res.status(409).json({ error: 'OBS is already streaming — stop it before starting a match' });
  }

  const created = {};
  let ytBroadcast = null, ytError = '', recError = '', recArmed = false;
  try {
    // 0. recording first, before anything touches Facebook, so the file
    //    starts ahead of the broadcast rather than after it. A recording
    //    failure is reported and stepped over — never a reason to stop an
    //    event that is otherwise ready to go.
    if (wantRecord) {
      try { await setRecordEnabled(true); recArmed = true; }
      catch (e) { recError = e.message; }
    }

    // 1. create the broadcasts, unpublished
    for (const [brand, page] of active) {
      const v = await fbCall(`/${page.id}/live_videos`, {
        status: 'UNPUBLISHED',
        title,
        description,
        access_token: page.token,
      }, 'POST');
      if (!v.secure_stream_url) throw new Error(`${page.label}: no secure_stream_url returned`);
      created[brand] = { id: v.id, ...splitStreamUrl(v.secure_stream_url) };
    }

    // 2. point OBS at them
    for (const [brand, c] of Object.entries(created)) {
      await setDestination(brand, c.server, c.key);
    }

    // 2b. arm the branches. Dhuvas is safe either way — its broadcast is
    // still UNPUBLISHED at this point, so the bytes go somewhere invisible.
    // YouTube has no unpublished state and auto-starts on ingest, so it is
    // armed ONLY for a real go-live, never for a rehearsal.
    if (dests.dhuvas && created.dhuvas) await setBranchEnabled('dhuvas', true);

    // 2c. YouTube: create the broadcast and bind it to the persistent
    // stream BEFORE the branch starts pushing, so enableAutoStart fires
    // on OUR titled broadcast rather than whatever Studio had.
    // A YouTube failure must never take down the Facebook event — it is
    // recorded and surfaced, not thrown.
    if (dests.youtube && autoPublish && ytConfigured()) {
      try { ytBroadcast = await ytStartBroadcast(title, description); }
      catch (e) { ytError = e.message; }
    }
    if (dests.youtube && autoPublish) await setBranchEnabled('youtube', true);

    // 3. go. Only VOICE rides the main encoder — a DHUVAS-only or
    //    YouTube-only event is already on air from the branch filter
    //    alone, and StartStream would push the main output at whatever
    //    stream key was last configured. So it is deliberately skipped.
    if (dests.voice) await obs.call('StartStream');

    matchState.live = true;
    matchState.dests = dests;
    matchState.rehearsal = !autoPublish;
    matchState.title = title;
    matchState.startedAt = Date.now();
    matchState.publishedAt = 0;
    matchState.lastError = '';
    matchState.videos = { voice: null, dhuvas: null };
    for (const [brand, c] of Object.entries(created)) {
      matchState.videos[brand] = { id: c.id, published: false };
    }
    matchState.skipped = skipped;
    matchState.youtube = ytBroadcast;
    matchState.record = recArmed;
    if (ytError) matchState.lastError = 'YouTube: ' + ytError;
    if (recError) matchState.lastError =
      (matchState.lastError ? matchState.lastError + ' | ' : '') + 'recording: ' + recError;

    // 4. publish once OBS confirms ingest is actually running.
    //    Skipped entirely in rehearsal mode — the broadcasts stay
    //    UNPUBLISHED until /api/match/end closes them.
    if (autoPublish) setTimeout(async () => {
      try {
        if (!await ingestProven(dests)) {
          matchState.lastError = dests.voice
            ? 'OBS did not start streaming — broadcasts left unpublished'
            : 'the DHUVAS branch is not armed — broadcasts left unpublished';
          return;
        }
        for (const [brand, page] of active) {
          const vid = matchState.videos[brand];
          if (!vid || vid.published) continue;
          await fbCall(`/${vid.id}`, { status: 'LIVE_NOW', access_token: page.token }, 'POST');
          vid.published = true;
        }
        matchState.publishedAt = Date.now();
      } catch (e) {
        matchState.lastError = 'publish failed: ' + e.message;
      }
    }, Number(process.env.FB_PUBLISH_DELAY_MS || 10000));

    res.json({ ok: true, title, rehearsal: matchState.rehearsal, videos: matchState.videos,
               dests, skipped, youtube: ytBroadcast, youtubeError: ytError || undefined,
               recording: recArmed, recordMode: obsState.recMode,
               recordError: recError || undefined });
  } catch (e) {
    // Disarm first: under Always ON a branch we managed to enable before the
    // failure would keep broadcasting to a broadcast we are about to kill.
    for (const t of ['dhuvas', 'youtube']) {
      try { await setBranchEnabled(t, false); } catch (_) { /* best effort */ }
    }
    // Only unwind a recording this call started. One that was already running
    // belongs to whoever armed it.
    if (recArmed) { try { await setRecordEnabled(false); } catch (_) {} }
    // Roll back anything we created so we don't leave orphan broadcasts.
    if (ytBroadcast) { try { await ytEndBroadcast(ytBroadcast.id); } catch (_) {} }
    for (const [brand, c] of Object.entries(created)) {
      try {
        await fbCall(`/${c.id}`, { end_live_video: true, access_token: FB_PAGES[brand].token }, 'POST');
      } catch (_) { /* best effort */ }
    }
    matchState.lastError = e.message;
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/match/publish', async (req, res) => {
  if (!matchState.live) return res.status(409).json({ error: 'no match is live' });
  try {
    for (const [brand, page] of Object.entries(FB_PAGES)) {
      const vid = matchState.videos[brand];
      if (!vid || vid.published || !page.token) continue;
      await fbCall(`/${vid.id}`, { status: 'LIVE_NOW', access_token: page.token }, 'POST');
      vid.published = true;
    }
    matchState.publishedAt = Date.now();
    res.json({ ok: true, videos: matchState.videos });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/match/end', async (req, res) => {
  const errors = [];

  // Stop the encoder first — ending the broadcasts while OBS is still
  // pushing leaves Facebook trying to ingest a stream nobody is watching.
  if (obs && obsState.connected) {
    // Disarm the broadcast branches BEFORE StopStream. Under Always ON they
    // do not stop with the main stream — leaving either enabled keeps it
    // pushing after the event has "ended", which is the worst way to find
    // out this setting changed. Monitor is deliberately left running.
    for (const t of ['dhuvas', 'youtube']) {
      try { await setBranchEnabled(t, false); }
      catch (e) { errors.push(`branch ${t}: ${e.message}`); }
    }
    // Only stop the encoder if it is actually running. A DHUVAS-only or
    // YouTube-only event never started it, and StopStream on an idle OBS
    // throws — which would report a clean end as "ended with problems".
    if (obsState.streaming) {
      try { await obs.call('StopStream'); }
      catch (e) { errors.push('OBS: ' + e.message); }
    }
    // Recording last, so the file runs past the final whistle rather than
    // stopping on it. Untouched if this event did not start it.
    if (matchState.record) {
      try { await setRecordEnabled(false); }
      catch (e) { errors.push('recording: ' + e.message); }
    }
  } else {
    errors.push('OBS not connected — stop the stream manually');
  }

  for (const [brand, page] of Object.entries(FB_PAGES)) {
    const vid = matchState.videos[brand];
    if (!vid || !vid.id) continue;
    try {
      await fbCall(`/${vid.id}`, { end_live_video: true, access_token: page.token }, 'POST');
    } catch (e) {
      errors.push(`${page.label}: ${e.message}`);
    }
  }

  if (matchState.youtube) {
    try { await ytEndBroadcast(matchState.youtube.id); }
    catch (e) { errors.push('YouTube: ' + e.message); }
  }

  matchState.live = false;
  matchState.rehearsal = false;
  matchState.videos = { voice: null, dhuvas: null };
  matchState.dests = { voice: false, dhuvas: false, youtube: false };
  matchState.record = false;
  matchState.youtube = null;
  matchState.lastError = errors.join(' | ');

  res.json({ ok: errors.length === 0, errors });
});

// ---- broadcasts we did not create ---------------------------------
// matchState only knows the ids it made. Anything started from Live
// Producer, from a persistent key, or by someone else on the team is
// invisible to it — and after a relay restart, so is our own event.
// This scans both pages for whatever is still live.
//
// Ending is deliberately a SEPARATE, EXPLICIT call taking the exact ids
// to close. Killing a colleague's broadcast by accident is a worse
// failure than leaving one running, so nothing here ends anything on
// its own.
// ⚠ VERIFIED LIMITATION (16 Sep 2026): this edge does NOT return
// UNPUBLISHED broadcasts. A rehearsal with two open unpublished videos
// returned only older VODs. So the scan finds PUBLISHED lives — a Live
// Producer stream, a persistent-key stream, a colleague's broadcast —
// which is the case that matters, but it cannot recover an unpublished
// broadcast orphaned by a relay restart. Only persisting matchState
// fixes that. `broadcast_status` is not served on this edge either.
async function scanLiveVideos() {
  const out = [];
  for (const [brand, page] of Object.entries(FB_PAGES)) {
    if (!page.id || !page.token) continue;
    try {
      const j = await fbCall(`/${page.id}/live_videos`, {
        fields: 'id,status,title,creation_time',
        limit: 10,
        access_token: page.token,
      });
      for (const v of (j.data || [])) {
        // Blacklist the finished states rather than whitelisting live
        // ones — the status vocabulary is not fully documented, and
        // missing an open broadcast is worse than listing a stale one.
        if (v.status === 'VOD' || v.status === 'PROCESSING') continue;
        const ours = Object.values(matchState.videos || {})
          .some(x => x && x.id === v.id);
        out.push({
          brand, label: page.label, id: v.id, status: v.status,
          title: v.title || '(no title)', creation_time: v.creation_time, ours,
        });
      }
    } catch (e) {
      out.push({ brand, label: page.label, error: e.message });
    }
  }
  return out;
}

app.get('/api/live/scan', async (req, res) => {
  try { res.json({ ok: true, videos: await scanLiveVideos() }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// Diagnostic: what does liveStreams.list actually return, part by part?
// Exists because a bare "Internal error encountered" tells you nothing about
// which part combination Google objected to.
app.get('/api/youtube/streams', async (req, res) => {
  if (!ytConfigured()) return res.status(400).json({ error: 'YouTube is not configured' });
  const out = { attempts: [] };
  for (const part of ['id,snippet,cdn,contentDetails,status', 'id,snippet,cdn', 'id,cdn', 'id']) {
    try {
      const j = await ytCall('/liveStreams', { params: { part, mine: true, maxResults: 50 } });
      out.attempts.push({ part, ok: true, count: (j.items || []).length });
      out.streams = (j.items || []).map(s => ({
        id: s.id,
        title: s.snippet && s.snippet.title,
        reusable: s.contentDetails ? s.contentDetails.isReusable : undefined,
        status: s.status && s.status.streamStatus,
      }));
      break;
    } catch (e) { out.attempts.push({ part, ok: false, error: e.message }); }
  }
  res.status(out.streams ? 200 : 502).json(out);
});

// Create a reusable ingest stream we own. POST so it cannot happen by
// accident from a browser address bar.
app.post('/api/youtube/stream/create', async (req, res) => {
  if (!ytConfigured()) return res.status(400).json({ error: 'YouTube is not configured' });
  try {
    const made = await ytCreateStream(req.body && req.body.title);
    res.json({
      ok: true, ...made,
      next: 'Set YT_STREAM_ID to streamId on Railway, and put streamKey into the OBS YouTube Branch Output filter.',
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/live/end', async (req, res) => {
  const items = (req.body && req.body.videos) || [];
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'videos required: [{brand, id}]' });
  }
  const ended = [], errors = [];
  for (const it of items) {
    const page = FB_PAGES[it && it.brand];
    if (!page || !page.token) { errors.push(`${it && it.id}: unknown brand`); continue; }
    try {
      await fbCall(`/${it.id}`, { end_live_video: true, access_token: page.token }, 'POST');
      ended.push(it.id);
    } catch (e) {
      errors.push(`${page.label} ${it.id}: ${e.message}`);
    }
  }
  res.json({ ok: errors.length === 0, ended, errors });
});

// A page token can read "Expires: Never" and still stop working.
// Separately from token expiry, Facebook enforces DATA ACCESS expiry:
// roughly 90 days after the granting user last interacted with the app.
// When it lapses the token starts failing with no prior warning — which,
// for an automation that fires at kickoff, is the worst possible moment
// to find out. So the preflight reports the remaining days and goes
// non-ok below the threshold, turning a silent failure into a visible
// line on the pre-match checklist.
//
// The cure is to re-run the token procedure (see FACEBOOK-SETUP.md) or,
// permanently, to move the pages into a Business Portfolio and use a
// System User token, which has no data-access clock at all.
const FB_EXPIRY_WARN_DAYS = Number(process.env.FB_EXPIRY_WARN_DAYS || 14);

async function tokenHealth(token) {
  const j = await fbCall('/debug_token', { input_token: token, access_token: token });
  const d = (j && j.data) || {};
  const now = Math.floor(Date.now() / 1000);
  const daysFrom = (ts) => (ts ? Math.floor((ts - now) / 86400) : null);
  return {
    neverExpires: d.expires_at === 0,
    expiresInDays: d.expires_at === 0 ? null : daysFrom(d.expires_at),
    dataAccessExpiresAt: d.data_access_expires_at || null,
    dataAccessDays: daysFrom(d.data_access_expires_at),
    scopes: d.scopes || [],
  };
}

// Preflight — proves both page tokens still work, without creating
// anything. Token revocation is otherwise silent and you'd find out at
// kickoff. Run this as part of the pre-match checklist.
app.get('/api/match/check', async (req, res) => {
  const out = {
    ok: true,
    obs: { connected: obsState.connected, streaming: obsState.streaming },
    pages: {},
    warnings: [],
  };
  let configuredCount = 0;
  for (const [brand, page] of Object.entries(FB_PAGES)) {
    if (!page.id || !page.token) {
      // Deliberately manual (e.g. a page whose token we can't get yet).
      // Not a failure — but it won't be automated either.
      out.pages[brand] = { ok: true, skipped: true, note: 'not configured — this page stays manual' };
      continue;
    }
    configuredCount++;
    try {
      const j = await fbCall(`/${page.id}`, { fields: 'name,id', access_token: page.token });
      out.pages[brand] = { ok: true, name: j.name, id: j.id };
    } catch (e) {
      out.pages[brand] = { ok: false, error: e.message };
      out.ok = false;
      continue;
    }

    // Health is advisory: if debug_token itself fails we say so, but we
    // don't fail a preflight whose actual page call just succeeded.
    try {
      const h = await tokenHealth(page.token);
      const p = out.pages[brand];
      p.dataAccessDays = h.dataAccessDays;
      p.neverExpires = h.neverExpires;
      if (h.dataAccessExpiresAt) {
        p.dataAccessExpires = new Date(h.dataAccessExpiresAt * 1000).toISOString().slice(0, 10);
      }

      if (!h.neverExpires) {
        out.warnings.push(`${page.label}: token is NOT permanent — expires in ${h.expiresInDays} day(s). Re-derive it from a long-lived user token.`);
        out.ok = false;
      }
      if (!h.scopes.includes('pages_manage_posts')) {
        out.warnings.push(`${page.label}: token is missing pages_manage_posts — live video creation will fail with (#200).`);
        out.ok = false;
      }
      if (h.dataAccessDays !== null && h.dataAccessDays <= FB_EXPIRY_WARN_DAYS) {
        out.warnings.push(`${page.label}: DATA ACCESS expires in ${h.dataAccessDays} day(s) (${p.dataAccessExpires}). Re-run the token procedure or move to a System User token.`);
        out.ok = false;
      }
    } catch (e) {
      out.warnings.push(`${page.label}: could not read token health — ${e.message}`);
    }
  }
  if (!obsState.connected) out.ok = false;
  if (!configuredCount) { out.ok = false; out.error = 'no Facebook pages configured'; }

  // Interlock is "Always ON", so an armed branch outside an event is not
  // merely untidy — it is broadcasting right now. Treat it as a failure.
  out.branches = { dhuvas: obsState.branchLive, youtube: obsState.ytLive, live: matchState.live };
  // Say plainly which recorder is wired up. "Recording: on" means nothing if
  // the file turns out to be the branded output you cannot re-cut.
  out.recording = {
    mode: obsState.recMode,
    active: obsState.recording,
    clean: obsState.recMode === 'branch',
  };
  if (obsState.recMode === 'none') {
    out.warnings.push('No recording output in OBS — add a "' + OBS_REC_FILTER +
      '" Branch Output filter to the ' + OBS_SCENE_PROGRAM +
      ' scene (server and key blank) to archive the clean feed.');
  } else if (obsState.recMode === 'native') {
    out.warnings.push('Recording falls back to OBS\'s own recorder, which captures the BRANDED ' +
      OBS_SCENE_VOICE + ' output — not the clean ' + OBS_SCENE_PROGRAM + ' feed.');
  }

  out.youtube = { configured: ytConfigured(), privacy: YT_PRIVACY };
  if (ytConfigured()) {
    // Proves the refresh token still works. Google silently expires it
    // after 7 days if the consent screen is left in Testing mode.
    try { await ytToken(); out.youtube.token = 'ok'; }
    catch (e) {
      out.youtube.token = 'FAILED';
      out.warnings.push('YouTube: ' + e.message + ' — the event name will not reach YouTube.');
      out.ok = false;
    }
    // A working token is NOT enough. liveBroadcasts.bind needs a reusable
    // ingest stream to bind to, and that only exists if a persistent stream
    // key was created in YouTube Studio (Go live -> Stream). If it is absent
    // ytFindStream() throws at GO LIVE time — i.e. with the crowd already
    // there. Surface it here, where it costs nothing.
    if (out.youtube.token === 'ok') {
      // WHICH channel did we actually get consent for? A Brand Account channel
      // is only used if it is picked at the consent screen; sign in without
      // picking and you authorise the personal channel instead — which is not
      // live-enabled, and fails later with the misleading "user is not enabled
      // for live streaming". Print the channel so a mismatch is visible
      // immediately rather than inferred.
      try {
        const me = await ytCall('/channels', { params: { part: 'snippet', mine: true } });
        const ch = (me.items || [])[0];
        out.youtube.channel = ch
          ? (ch.snippet.customUrl || ch.snippet.title) + ' [' + ch.id + ']'
          : 'NONE — this Google account has no YouTube channel';
        if (!ch) out.ok = false;
      } catch (e) {
        out.youtube.channel = 'unknown — ' + e.message;
      }
      try { out.youtube.streamId = await ytFindStream(); }
      catch (e) {
        out.youtube.streamId = 'MISSING';
        out.warnings.push('YouTube: ' + e.message + ' — create a persistent stream key in YouTube Studio (Go live -> Stream), or set YT_STREAM_ID.');
        out.ok = false;
      }
    }
  } else {
    out.warnings.push('YouTube is not configured — its title still comes from Studio.');
  }
  out.auth = { required: authRequired(), sessionHours: AUTH_HOURS };
  if (!authRequired()) {
    out.warnings.push('No PIN set — anyone who reaches this URL can start or end a broadcast. Set GOLIVE_PIN.');
  }
  if (!matchState.live) {
    if (obsState.branchLive) {
      out.warnings.push('Dhuvas branch is ARMED with no event running — it is pushing to Facebook right now.');
      out.ok = false;
    }
    if (obsState.ytLive) {
      out.warnings.push('YouTube branch is ARMED with no event running — it is pushing to YouTube right now.');
      out.ok = false;
    }
    // Not a failure — nothing is public — but it is eating the disk the
    // match is about to need, which is worth seeing before kickoff.
    if (obsState.recording) {
      out.warnings.push('Recording is RUNNING with no event — it is writing to disk right now.');
    }
  }
  if (!out.warnings.length) delete out.warnings;
  res.status(out.ok ? 200 : 502).json(out);
});

app.get('/api/match/status', (req, res) => {
  res.json({
    live: matchState.live,
    rehearsal: matchState.rehearsal,
    youtube: matchState.youtube,
    title: matchState.title,
    startedAt: matchState.startedAt,
    publishedAt: matchState.publishedAt,
    videos: matchState.videos,
    dests: matchState.dests,
    record: matchState.record,
    recording: obsState.recording,
    recMode: obsState.recMode,
    lastError: matchState.lastError,
    configured: {
      voice: !!(FB_PAGES.voice.id && FB_PAGES.voice.token),
      dhuvas: !!(FB_PAGES.dhuvas.id && FB_PAGES.dhuvas.token),
    },
    apiVersion: FB_API_VERSION,
  });
});

// Get NGINX-RTMP stats
app.get('/api/relay-stats', async (req, res) => {
  try {
    const response = await fetch('http://127.0.0.1:8888/stat.xml');
    const text = await response.text();
    res.set('Content-Type', 'text/xml');
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: 'Cannot reach RTMP stats: ' + e.message });
  }
});

// Serve HLS from nginx
app.get('/hls/:file', async (req, res) => {
  try {
    const response = await fetch(`http://127.0.0.1:8888/hls/${req.params.file}`);
    if (!response.ok) {
      return res.status(response.status).send(`Upstream ${response.status} for ${req.params.file}`);
    }
    const buffer = await response.arrayBuffer();
    const ext = req.params.file.split('.').pop();
    const types = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t' };
    res.set('Content-Type', types[ext] || 'application/octet-stream');
    // Playlists must never be cached; segments are immutable once written.
    res.set('Cache-Control', ext === 'ts' ? 'public, max-age=60' : 'no-cache, no-store');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(buffer));
  } catch (e) {
    console.error('[hls] proxy error for', req.params.file, '-', e.message);
    res.status(502).send('Relay cannot reach nginx: ' + e.message);
  }
});

// ---- Reporters (persisted to Postgres when available) ----
// Shape: { id, name, location, photo, tagVisible, pv }
//   photo: base64 data URL or '' (optional — tag shows text-only without it)
//   pv:    photo version — bumps whenever the photo changes, so the overlay
//          can poll light state every second and only refetch the heavy photo
//          when pv actually changes.
let reporters = [];

const findReporter = (id) => reporters.find(r => r.id === id);

app.get('/api/reporters', (req, res) => {
  res.json(reporters);
});

// Full single reporter (includes the heavy photo) — overlay fetches this only on pv change
app.get('/api/reporters/:id', (req, res) => {
  const r = findReporter(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

// Lightweight tag state — overlay polls this every second (no photo payload)
app.get('/api/reporters/:id/tag', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const r = findReporter(req.params.id);
  if (!r) return res.json({ ok: false, visible: false });
  res.json({ ok: true, visible: !!r.tagVisible, name: r.name, location: r.location || '', pv: r.pv || 0 });
});

// Single "active" reporter for the on-page bug overlay (tv / control views).
// Picks the most recently toggled-on reporter. No photo payload — bug fetches it by id on pv change.
app.get('/api/active-tag', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const vis = reporters.filter(r => r.tagVisible);
  if (!vis.length) return res.json({ ok: true, active: false });
  const r = vis.reduce((a, b) => ((b.tagAt || 0) >= (a.tagAt || 0) ? b : a));
  res.json({ ok: true, active: true, id: r.id, name: r.name, location: r.location || '', pv: r.pv || 0 });
});

app.post('/api/reporters', async (req, res) => {
  const { name, location = '', photo = '' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = 'vxd' + Date.now().toString(36);
  const r = {
    id, name,
    location: String(location || ''),
    photo: photo ? String(photo) : '',
    tagVisible: false,
    pv: photo ? Date.now() : 0
  };
  reporters.push(r);
  if (pool) {
    try {
      await pool.query(
        'INSERT INTO reporters (id, name, location, photo, tag_visible, pv, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, r.name, r.location, r.photo, r.tagVisible, r.pv, Date.now()]
      );
    } catch (e) { console.error('reporters insert failed:', e.message); }
  }
  res.json(reporters);
});

// Edit reporter fields (name / location / photo). Bumps pv when the photo changes.
app.put('/api/reporters/:id', async (req, res) => {
  const r = findReporter(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const { name, location, photo } = req.body || {};
  if (typeof name === 'string' && name.trim()) r.name = name.trim();
  if (typeof location === 'string') r.location = location;
  if (typeof photo === 'string' && photo !== r.photo) { r.photo = photo; r.pv = Date.now(); }
  if (pool) {
    try {
      await pool.query(
        'UPDATE reporters SET name=$2, location=$3, photo=$4, pv=$5 WHERE id=$1',
        [r.id, r.name, r.location, r.photo, r.pv]
      );
    } catch (e) { console.error('reporters update failed:', e.message); }
  }
  res.json(reporters);
});

// Toggle the lower-third on/off (returns just this reporter so the control
// panel can flip the button in place without re-rendering the live iframes)
app.post('/api/reporters/:id/tag', async (req, res) => {
  const r = findReporter(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  r.tagVisible = !!(req.body && req.body.visible);
  if (r.tagVisible) r.tagAt = Date.now();   // recency — the page bug shows the most recent
  if (pool) {
    try { await pool.query('UPDATE reporters SET tag_visible=$2 WHERE id=$1', [r.id, r.tagVisible]); }
    catch (e) { console.error('tag toggle failed:', e.message); }
  }
  res.json({ ok: true, id: r.id, visible: r.tagVisible });
});

app.delete('/api/reporters/:id', async (req, res) => {
  reporters = reporters.filter(r => r.id !== req.params.id);
  if (pool) {
    try { await pool.query('DELETE FROM reporters WHERE id=$1', [req.params.id]); }
    catch (e) { console.error('reporters delete failed:', e.message); }
  }
  res.json(reporters);
});

// ---- SOS alerts from field reporters ----
let sosAlerts = [];

app.get('/api/sos', (req, res) => {
  res.json(sosAlerts);
});

app.post('/api/sos', (req, res) => {
  const alert = req.body;
  alert.id = Date.now();
  alert.read = false;
  sosAlerts.unshift(alert);
  if (sosAlerts.length > 50) sosAlerts = sosAlerts.slice(0, 50);
  res.json({ ok: true });
});

app.delete('/api/sos/:id', (req, res) => {
  sosAlerts = sosAlerts.filter(a => a.id !== parseInt(req.params.id));
  res.json(sosAlerts);
});

app.post('/api/sos/ack', (req, res) => {
  const { alertId, reporterId } = req.body;
  const alert = sosAlerts.find(a => a.id === alertId);
  if (alert) {
    alert.acknowledged = true;
    alert.ackAt = Date.now();
  }
  // Store ack for reporter to poll
  if (!sosAcks[reporterId]) sosAcks[reporterId] = [];
  sosAcks[reporterId].push({ alertId, message: 'Being attended', time: Date.now() });
  res.json({ ok: true });
});

app.get('/api/sos/ack-poll', (req, res) => {
  const id = req.query.id;
  const acks = sosAcks[id] || [];
  // Return and clear
  sosAcks[id] = [];
  res.json({ acks });
});

let sosAcks = {};

// === Director ↔ reporter messaging (/api/msg/*) — in-memory by design ===
const msgStore = Object.create(null);
const msgNow = () => Date.now();
const mkMsgId = () => msgNow().toString(36) + Math.random().toString(36).slice(2, 6);

app.use('/api/msg', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

app.post('/api/msg/send', (req, res) => {
  const { id, text = '', action = '' } = req.body || {};
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  const msgId = mkMsgId();
  msgStore[id] = { msgId, text: String(text).slice(0, 300), action: String(action || ''), sentAt: msgNow(), status: 'pending', respAt: 0 };
  res.json({ ok: true, msgId });
});

app.get('/api/msg/poll', (req, res) => {
  res.json({ ok: true, msg: msgStore[req.query.id] || null });
});

app.post('/api/msg/ack', (req, res) => {
  const { id, msgId, response } = req.body || {};
  const m = msgStore[id];
  if (!m || m.msgId !== msgId) return res.json({ ok: false, error: 'stale' });
  if (response !== 'yes' && response !== 'ignore') return res.status(400).json({ ok: false, error: 'bad response' });
  m.status = response;
  m.respAt = msgNow();
  res.json({ ok: true });
});

app.get('/api/msg/status', (req, res) => {
  res.json({ ok: true, msg: msgStore[req.query.id] || null });
});

app.post('/api/msg/clear', (req, res) => {
  if (req.body && req.body.id) delete msgStore[req.body.id];
  res.json({ ok: true });
});

// ============================================================
// SOCCER SCOREBOARD  (/api/score/*)
// One live match at a time. The overlay polls the LIGHT payload
// every second; team logos are heavy base64 so they live behind
// /api/score/logo/:side and are refetched only when that side's
// logo version (lv) changes.
//
// The clock is stored as (baseMs, startedAt, running) rather than
// a tick count, so the overlay stays smooth and accurate even if a
// poll is dropped: it computes elapsed itself from serverNow.
// ============================================================
const emptySide = (color) => ({
  name: '', short: '', color,
  score: 0, yellow: 0, red: 0, fouls: 0,
  logo: '', lv: 0
});

const blankScoreboard = () => ({
  visible: false,             // corner bug (top-left by default)
  mainVisible: false,         // big centre board — when on, everything else hides
  lang: 'en',                 // 'en' (LTR, Latin) | 'dv' (RTL, Thaana)
  showCards: true,
  showFouls: false,
  home: emptySide('#1d4ed8'),
  away: emptySide('#dc2626'),
  clock: { running: false, baseMs: 0, startedAt: 0, period: 'PRE' },
  pens: { visible: false, home: [], away: [] },   // arrays of 'goal' | 'miss'
  event: { visible: false, type: 'GOAL', side: 'home', text: '', sub: '', at: 0, dur: 8 }
});

let scoreboard = blankScoreboard();

// Everything except the base64 logos, plus the server clock for drift correction.
function scoreLight() {
  const strip = (s) => { const { logo, ...rest } = s; return rest; };
  return {
    ...scoreboard,
    home: strip(scoreboard.home),
    away: strip(scoreboard.away),
    serverNow: Date.now()
  };
}

let scoreSaveTimer = null;
function saveScoreboard() {
  if (!pool) return;
  // Coalesce bursts (holding + on a score button, dragging a colour picker)
  clearTimeout(scoreSaveTimer);
  scoreSaveTimer = setTimeout(async () => {
    // Materialise the running clock into baseMs before writing, so a restore
    // lands on the real elapsed time instead of the last time someone paused.
    const snap = { ...scoreboard, clock: { ...scoreboard.clock } };
    if (snap.clock.running) {
      snap.clock.baseMs += Date.now() - snap.clock.startedAt;
      snap.clock.running = false;
      snap.clock.startedAt = 0;
    }
    try {
      await pool.query(
        'INSERT INTO scoreboard (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data=$2',
        ['match', snap]
      );
    } catch (e) { console.error('scoreboard save failed:', e.message); }
  }, 400);
}

// While the clock runs nobody may touch the API for minutes at a time — keep a
// warm snapshot on disk so a mid-half redeploy doesn't lose the running time.
setInterval(() => { if (scoreboard.clock.running) saveScoreboard(); }, 20000).unref?.();

app.use('/api/score', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

app.get('/api/score', (req, res) => res.json(scoreLight()));

// Heavy logo payload — fetched only when lv changes
app.get('/api/score/logo/:side', (req, res) => {
  const s = scoreboard[req.params.side];
  if (!s) return res.status(404).json({ error: 'Unknown side' });
  res.json({ logo: s.logo || '', lv: s.lv || 0 });
});

// Patch any subset of state. Nested objects merge one level deep, so
// { home: { score: 2 } } leaves the rest of `home` alone.
app.post('/api/score', (req, res) => {
  const patch = req.body || {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'clock') continue;                       // clock only moves via /api/score/clock
    const cur = scoreboard[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      // A changed logo bumps that side's version so overlays know to refetch
      if ((k === 'home' || k === 'away') && typeof v.logo === 'string' && v.logo !== cur.logo) {
        v.lv = Date.now();
      }
      Object.assign(cur, v);
    } else {
      scoreboard[k] = v;
    }
  }
  saveScoreboard();
  res.json(scoreLight());
});

// Relative score change — safer than sending an absolute value from two
// browsers at once, and never lets the score go negative.
app.post('/api/score/goal', (req, res) => {
  const { side, delta = 1 } = req.body || {};
  const s = scoreboard[side];
  if (!s) return res.status(400).json({ error: 'Unknown side' });
  s.score = Math.max(0, (s.score || 0) + Number(delta));
  saveScoreboard();
  res.json(scoreLight());
});

// Minute the match clock is at right now — used to stamp events automatically
function currentMatchMinute() {
  const c = scoreboard.clock;
  const starts = { PRE: 0, '1H': 0, HT: 45, '2H': 45, FT: 90, ET1: 90, ET2: 105, PENS: 120 };
  const elapsed = c.baseMs + (c.running ? Date.now() - c.startedAt : 0);
  return (starts[c.period] || 0) + Math.floor(elapsed / 60000);
}

app.post('/api/score/clock', (req, res) => {
  const { action, ms, period } = req.body || {};
  const c = scoreboard.clock;
  const now = Date.now();

  if (typeof period === 'string' && period) c.period = period;

  if (action === 'start') {
    if (!c.running) { c.running = true; c.startedAt = now; }
  } else if (action === 'pause') {
    if (c.running) { c.baseMs += now - c.startedAt; c.running = false; c.startedAt = 0; }
  } else if (action === 'reset') {
    c.running = false; c.startedAt = 0; c.baseMs = 0;
  } else if (action === 'set') {
    c.baseMs = Math.max(0, Number(ms) || 0);
    if (c.running) c.startedAt = now;               // re-anchor so the jump isn't double-counted
  }

  saveScoreboard();
  res.json(scoreLight());
});

// Fire an announcement banner (goal / card / sub / free text).
// `at` is stamped server-side so the overlay can expire it on its own.
app.post('/api/score/event', (req, res) => {
  const { type = 'GOAL', side = 'home', text = '', sub = '', dur = 8, minute } = req.body || {};
  const stamp = (minute === undefined || minute === null || minute === '')
    ? currentMatchMinute() + "'"
    : String(minute);
  scoreboard.event = {
    visible: true,
    type: String(type),
    side: side === 'away' ? 'away' : 'home',
    text: String(text).slice(0, 120),
    sub: sub ? String(sub).slice(0, 80) : stamp,
    at: Date.now(),
    dur: Math.max(2, Number(dur) || 8)
  };
  saveScoreboard();
  res.json(scoreLight());
});

app.post('/api/score/event/hide', (req, res) => {
  scoreboard.event.visible = false;
  saveScoreboard();
  res.json(scoreLight());
});

// New match: wipes scores, clock, cards and penalties but KEEPS the two
// teams (names, colours, logos) so a double-header doesn't mean re-uploading.
app.post('/api/score/reset', (req, res) => {
  const keepTeam = (s) => ({ ...emptySide(s.color), name: s.name, short: s.short, logo: s.logo, lv: s.lv });
  const prev = scoreboard;
  scoreboard = blankScoreboard();
  scoreboard.lang = prev.lang;
  scoreboard.visible = prev.visible;          // don't yank the bug off air mid-broadcast
  scoreboard.showCards = prev.showCards;
  scoreboard.showFouls = prev.showFouls;
  scoreboard.home = keepTeam(prev.home);
  scoreboard.away = keepTeam(prev.away);
  saveScoreboard();
  res.json(scoreLight());
});

// ============================================================
// VOLLEYBALL SCOREBOARD  (/api/volley/*)
// Separate live match from the soccer board, so a volleyball game
// and a football game never fight over the same state.
//
// No clock — volleyball is rally scoring, so the interesting state
// is points, sets, serve and timeouts. Because points come fast and
// an operator WILL misclick, every mutating call pushes a snapshot
// onto an undo stack.
// ============================================================
const emptyVSide = (color) => ({
  name: '', short: '', color,
  pts: 0, sets: 0, to: 0,          // to = timeouts used this set
  logo: '', lv: 0
});

const blankVolley = () => ({
  visible: false,          // corner bug
  mainVisible: false,      // big centre board — when on, everything else hides
  lang: 'en',
  bestOf: 5,               // 3 or 5
  pointsTo: 25,            // target for a normal set
  decidingTo: 15,          // target for the deciding (last possible) set
  cap: 0,                  // hard cap, 0 = play on until 2 clear
  maxTo: 2,                // timeouts per team per set
  autoSet: true,           // finish the set by itself once it's mathematically won
  showTimeouts: true,
  showHistory: true,       // per-set chips
  serve: '',               // '' | 'home' | 'away'
  set: 1,
  status: 'PRE',           // PRE | LIVE | BREAK | TO | FINAL
  history: [],             // [{ h, a }] completed sets, in order
  home: emptyVSide('#1d4ed8'),
  away: emptyVSide('#dc2626'),
  event: { visible: false, type: 'POINT', side: 'home', text: '', sub: '', at: 0, dur: 8 }
});

let volley = blankVolley();
let volleyUndo = [];

function volleyLight() {
  const strip = (s) => { const { logo, ...rest } = s; return rest; };
  return {
    ...volley,
    home: strip(volley.home),
    away: strip(volley.away),
    canUndo: volleyUndo.length > 0,
    serverNow: Date.now()
  };
}

// Snapshot before anything that changes the match, so a misclick during a
// rally is one tap to reverse. Logos are excluded — they're heavy and never
// change as part of scoring.
function volleyMark() {
  const light = { ...volley, home: { ...volley.home }, away: { ...volley.away } };
  delete light.home.logo; delete light.away.logo;
  volleyUndo.push(JSON.stringify({ ...light, history: volley.history.slice() }));
  if (volleyUndo.length > 40) volleyUndo.shift();
}

let volleySaveTimer = null;
function saveVolley() {
  if (!pool) return;
  clearTimeout(volleySaveTimer);
  volleySaveTimer = setTimeout(async () => {
    try {
      await pool.query(
        'INSERT INTO volleyball (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data=$2',
        ['match', volley]
      );
    } catch (e) { console.error('volleyball save failed:', e.message); }
  }, 400);
}

const vSetsToWin = () => Math.floor((volley.bestOf || 5) / 2) + 1;
const vIsDeciding = () => volley.set >= (volley.bestOf || 5);
const vTarget = () => (vIsDeciding() ? volley.decidingTo : volley.pointsTo) || 25;

// Close the current set: bank the score, credit the winner, reset for the next.
function vEndSet() {
  const h = volley.home.pts, a = volley.away.pts;
  if (h === a) return false;                      // nothing decided yet
  const w = h > a ? 'home' : 'away';
  volley.history.push({ h, a });
  volley[w].sets += 1;
  volley.home.pts = 0; volley.away.pts = 0;
  volley.home.to = 0;  volley.away.to = 0;

  if (volley[w].sets >= vSetsToWin()) {
    volley.status = 'FINAL';
  } else {
    volley.set += 1;
    volley.status = 'BREAK';
    // Teams alternate first serve each set
    volley.serve = volley.serve === 'home' ? 'away' : volley.serve === 'away' ? 'home' : '';
  }
  return true;
}

// Has the set just been won? Two clear points past the target, or the cap hit.
function vSetIsWon() {
  const t = vTarget(), h = volley.home.pts, a = volley.away.pts;
  const hi = Math.max(h, a), lo = Math.min(h, a);
  if (hi < t) return false;
  if (volley.cap > 0 && hi >= volley.cap) return true;
  return hi - lo >= 2;
}

app.use('/api/volley', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

app.get('/api/volley', (req, res) => res.json(volleyLight()));

app.get('/api/volley/logo/:side', (req, res) => {
  const s = volley[req.params.side];
  if (!s) return res.status(404).json({ error: 'Unknown side' });
  res.json({ logo: s.logo || '', lv: s.lv || 0 });
});

// Patch any subset. Nested home/away merge one level deep, same as /api/score.
app.post('/api/volley', (req, res) => {
  const patch = req.body || {};
  volleyMark();
  for (const [k, v] of Object.entries(patch)) {
    const cur = volley[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      if ((k === 'home' || k === 'away') && typeof v.logo === 'string' && v.logo !== cur.logo) v.lv = Date.now();
      Object.assign(cur, v);
    } else {
      volley[k] = v;
    }
  }
  saveVolley();
  res.json(volleyLight());
});

// A rally point. Scoring also wins the serve (side-out), and the set closes
// itself when it's mathematically over unless autoSet is switched off.
app.post('/api/volley/point', (req, res) => {
  const { side, delta = 1 } = req.body || {};
  const s = volley[side];
  if (!s) return res.status(400).json({ error: 'Unknown side' });
  volleyMark();

  s.pts = Math.max(0, (s.pts || 0) + Number(delta));
  if (Number(delta) > 0) {
    volley.serve = side;
    if (volley.status === 'PRE' || volley.status === 'BREAK' || volley.status === 'TO') volley.status = 'LIVE';
    if (volley.autoSet && vSetIsWon()) vEndSet();
  }
  saveVolley();
  res.json(volleyLight());
});

app.post('/api/volley/serve', (req, res) => {
  const { side } = req.body || {};
  volleyMark();
  volley.serve = (side === 'home' || side === 'away') ? side : '';
  saveVolley();
  res.json(volleyLight());
});

// Timeout counter per team per set. Flipping status to TO lets the overlay
// show a TIMEOUT flag; the next point clears it.
app.post('/api/volley/timeout', (req, res) => {
  const { side, delta = 1 } = req.body || {};
  const s = volley[side];
  if (!s) return res.status(400).json({ error: 'Unknown side' });
  volleyMark();
  s.to = Math.max(0, Math.min(volley.maxTo || 2, (s.to || 0) + Number(delta)));
  if (Number(delta) > 0) volley.status = 'TO';
  saveVolley();
  res.json(volleyLight());
});

// Explicit set control for when autoSet is off, or the operator needs to
// correct history by hand.
app.post('/api/volley/set', (req, res) => {
  const { action } = req.body || {};
  volleyMark();

  if (action === 'end') {
    vEndSet();
  } else if (action === 'award') {
    // Hand the set to a side outright (forfeit, or a score nobody tracked)
    const side = req.body.side === 'away' ? 'away' : 'home';
    const other = side === 'home' ? 'away' : 'home';
    volley[side].pts = Math.max(volley[side].pts, vTarget());
    if (volley[other].pts >= volley[side].pts) volley[other].pts = volley[side].pts - 2;
    vEndSet();
  } else if (action === 'resume') {
    // Come back off a break / timeout without touching the score
    volley.status = 'LIVE';
  } else if (action === 'reopen') {
    // Undo a set close: pull the last banked set back onto the board
    const last = volley.history.pop();
    if (last) {
      const w = last.h > last.a ? 'home' : 'away';
      volley[w].sets = Math.max(0, volley[w].sets - 1);
      volley.home.pts = last.h; volley.away.pts = last.a;
      volley.set = Math.max(1, volley.history.length + 1);
      volley.status = 'LIVE';
    }
  } else if (action === 'editHistory') {
    if (Array.isArray(req.body.history)) {
      volley.history = req.body.history
        .slice(0, 5)
        .map(x => ({ h: Math.max(0, Number(x.h) || 0), a: Math.max(0, Number(x.a) || 0) }));
      volley.home.sets = volley.history.filter(x => x.h > x.a).length;
      volley.away.sets = volley.history.filter(x => x.a > x.h).length;
      volley.set = Math.max(1, volley.history.length + 1);
    }
  }
  saveVolley();
  res.json(volleyLight());
});

app.post('/api/volley/undo', (req, res) => {
  const snap = volleyUndo.pop();
  if (snap) {
    const prev = JSON.parse(snap);
    const hLogo = volley.home.logo, hLv = volley.home.lv;
    const aLogo = volley.away.logo, aLv = volley.away.lv;
    volley = Object.assign(blankVolley(), prev);
    volley.home.logo = hLogo; volley.home.lv = hLv;   // undo never touches logos
    volley.away.logo = aLogo; volley.away.lv = aLv;
    saveVolley();
  }
  res.json(volleyLight());
});

app.post('/api/volley/event', (req, res) => {
  const { type = 'POINT', side = 'home', text = '', sub = '', dur = 8 } = req.body || {};
  volley.event = {
    visible: true,
    type: String(type),
    side: side === 'away' ? 'away' : 'home',
    text: String(text).slice(0, 120),
    sub: String(sub).slice(0, 80),
    at: Date.now(),
    dur: Math.max(2, Number(dur) || 8)
  };
  saveVolley();
  res.json(volleyLight());
});

app.post('/api/volley/event/hide', (req, res) => {
  volley.event.visible = false;
  saveVolley();
  res.json(volleyLight());
});

// New match: wipes points, sets, timeouts and history but KEEPS the teams
// and the chosen format, so a double-header is one tap.
app.post('/api/volley/reset', (req, res) => {
  const keepTeam = (s) => ({ ...emptyVSide(s.color), name: s.name, short: s.short, logo: s.logo, lv: s.lv });
  const prev = volley;
  volley = blankVolley();
  volleyUndo = [];
  for (const k of ['lang', 'visible', 'bestOf', 'pointsTo', 'decidingTo', 'cap', 'maxTo',
                   'autoSet', 'showTimeouts', 'showHistory']) volley[k] = prev[k];
  volley.home = keepTeam(prev.home);
  volley.away = keepTeam(prev.away);
  saveVolley();
  res.json(volleyLight());
});

// ---- Ticker states (persisted to Postgres when available) ----
let tickers = {
  voice: {
    visible: false,
    label: 'ބްރޭކިންގ',
    text: '',
    mode: 'scroll',
    speed: 15,
    direction: 'rtl',
    labelColor: '#ef4444'
  },
  dhuvas: {
    visible: false,
    label: 'ބްރޭކިންގ',
    text: '',
    mode: 'scroll',
    speed: 15,
    direction: 'rtl',
    labelColor: '#ef4444'
  }
};

app.get('/api/ticker/:id', (req, res) => {
  const id = req.params.id;
  if (tickers[id]) res.json(tickers[id]);
  else res.status(404).json({ error: 'Unknown ticker' });
});

app.post('/api/ticker/:id', async (req, res) => {
  const id = req.params.id;
  if (!tickers[id]) return res.status(404).json({ error: 'Unknown ticker' });
  Object.assign(tickers[id], req.body);
  if (pool) {
    try { await pool.query('INSERT INTO tickers (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data=$2', [id, tickers[id]]); }
    catch (e) { console.error('ticker save failed:', e.message); }
  }
  res.json(tickers[id]);
});

// ---- VOICE news feed for on-air graphics -----------------------------------
// voice.mv has no RSS or JSON API, so we read its public HTML server-side and
// hand the overlays clean JSON. Homepage gives the latest article ids (and the
// short homepage headline); each article page is fetched once and cached for
// the full headline, category, time and original image.
//
//   GET /api/voice/latest?limit=10    -> { updated, source, stale, items: [...] }
//   Refreshed in the background every 60 s.
//
// item: { id, url, headline, short, summary, category, date, time, image, thumb, author }
const VOICE_BASE = 'https://voice.mv';
const VOICE_HOME_TTL = 60 * 1000;          // re-read the homepage at most once a minute
const VOICE_ARTICLE_MAX = 200;             // article cache size (they never change much)
const VOICE_UA = 'Mozilla/5.0 (VxD Broadcast graphics; +https://mix.vxd.news)';

const voiceCache = { list: [], updated: 0, error: null, inflight: null };
const voiceArticles = new Map();           // id -> item

function voiceDecode(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/\s+/g, ' ').trim();
}
const voiceOriginal = u => u ? u.replace(/\/(small|large)_thumb_/, '/original_') : '';

async function voiceGet(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(VOICE_BASE + path, { headers: { 'User-Agent': VOICE_UA, 'Accept': 'text/html' }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`voice.mv ${path} -> HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

// Homepage: every <a href="/12345"> card. Returns id -> { short, thumb, category, date }
function voiceParseHome(html) {
  const out = new Map();
  const re = /<a href="\/(\d{4,7})"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const id = +m[1], body = m[2];
    const rec = out.get(id) || { id };
    const img = body.match(/<img[^>]+src="([^"]+naaboli[^"]+)"/);
    if (img && !rec.thumb) rec.thumb = img[1];
    const spans = [...body.matchAll(/<span[^>]*>([^<]+)<\/span>/g)].map(x => voiceDecode(x[1]));
    if (spans.length >= 2 && !rec.category) { rec.date = spans[0]; rec.category = spans[1]; }
    const texts = [...body.matchAll(/<div[^>]*class="[^"]*(?:waheed|dv-bold)[^"]*"[^>]*>([^<]{8,})<\/div>/g)].map(x => voiceDecode(x[1]));
    if (texts.length && !rec.short) rec.short = texts[texts.length - 1];
    out.set(id, rec);
  }
  return out;
}

// Article page: full Thaana headline, category, date | time, original image, author, summary
function voiceParseArticle(id, html) {
  const pick = (re) => { const m = html.match(re); return m ? voiceDecode(m[1]) : ''; };
  const headline = pick(/<div class="dv-bold lg:text-4xl[^"]*"[^>]*>([^<]+)<\/div>/);
  const category = pick(/<div class="lg:text-xl text-lg text-\[#FF4E00\] dv-bold rtl">([^<]+)<\/div>/);
  const stamp = pick(/<div class="text-xs en-font ltr opacity-50[^"]*">([^<]+)<\/div>/);   // "22 Sep 2026 | 11:24"
  const [date, time] = stamp.split('|').map(s => (s || '').trim());
  const image = (html.match(/<img class="w-full lg:rounded-3xl[^"]*" src="([^"]+)"/) || [])[1]
    || voiceOriginal((html.match(/<meta name="image" content="([^"]+)"/) || [])[1]);
  const summary = pick(/<meta name="description" content="([^"]*)"/);
  const author = pick(/<div class="opacity-75 waheed">([^<]+)<\/div>/);
  if (!headline) throw new Error(`voice.mv /${id}: headline not found (markup changed?)`);
  return { id, url: `${VOICE_BASE}/${id}`, headline, summary, category, date, time: time || '', image, author };
}

async function voiceRefresh(limit) {
  const home = voiceParseHome(await voiceGet('/'));
  const ids = [...home.keys()].sort((a, b) => b - a).slice(0, Math.max(limit, 12));
  const items = [];
  for (const id of ids) {                    // sequential on purpose: be gentle with voice.mv
    let art = voiceArticles.get(id);
    if (!art) {
      try {
        art = voiceParseArticle(id, await voiceGet('/' + id));
        voiceArticles.set(id, art);
        if (voiceArticles.size > VOICE_ARTICLE_MAX) voiceArticles.delete(voiceArticles.keys().next().value);
      } catch (e) { console.error('voice article', id, e.message); continue; }
    }
    const h = home.get(id) || {};
    items.push({ ...art, short: h.short || art.headline, thumb: h.thumb || '', image: art.image || voiceOriginal(h.thumb) });
  }
  if (!items.length) throw new Error('voice.mv: no articles parsed');
  voiceCache.list = items;
  voiceCache.updated = Date.now();
  voiceCache.error = null;
}

function voiceKick() {
  if (!voiceCache.inflight) {
    voiceCache.inflight = voiceRefresh(12)
      .catch(e => { voiceCache.error = e.message; console.error('voice feed:', e.message); })
      .finally(() => { voiceCache.inflight = null; });
  }
  return voiceCache.inflight;
}
// Refresh in the background so overlays never wait on voice.mv: one homepage read a minute,
// plus one article read per new story.
voiceKick();
setInterval(voiceKick, VOICE_HOME_TTL).unref();

app.get('/api/voice/latest', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 30);
  res.set('Access-Control-Allow-Origin', '*');   // public, read-only; lets any overlay/browser source read it
  res.set('Cache-Control', 'no-store');
  if (!voiceCache.list.length) await voiceKick();  // only the very first request after boot can wait
  if (!voiceCache.list.length) return res.status(502).json({ error: voiceCache.error || 'voice feed unavailable' });
  res.json({
    updated: new Date(voiceCache.updated).toISOString(),
    source: VOICE_BASE,
    stale: !!voiceCache.error,          // true = voice.mv failed on the last try; serving the previous list
    error: voiceCache.error || undefined,
    items: voiceCache.list.slice(0, limit)
  });
});

// Pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/relay', (req, res) => res.sendFile(path.join(__dirname, 'public', 'relay.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/ticker', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ticker.html')));
app.get('/go', (req, res) => res.sendFile(path.join(__dirname, 'public', 'go.html')));
app.get('/live', (req, res) => res.sendFile(path.join(__dirname, 'public', 'live.html')));
app.get('/golive', (req, res) => res.sendFile(path.join(__dirname, 'public', 'golive.html'))); // phone-friendly match start/end
app.get('/news-scene', (req, res) => res.sendFile(path.join(__dirname, 'public', 'news-scene.html'))); // VOICE Stream news graphics (OBS browser source)
// Required by Meta before the app can leave Development mode. Public pages,
// no auth — a reviewer has to be able to open them while logged out.
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/data-deletion', (req, res) => res.sendFile(path.join(__dirname, 'public', 'data-deletion.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/streamer-tag', (req, res) => res.sendFile(path.join(__dirname, 'public', 'streamer-tag.html')));
app.get('/scorebug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'scorebug.html')));  // vMix overlay input
app.get('/score', (req, res) => res.sendFile(path.join(__dirname, 'public', 'score.html')));        // director control (desktop setup)
app.get('/control', (req, res) => res.sendFile(path.join(__dirname, 'public', 'control.html')));    // iPad match control (controls only)
app.get('/volleybug', (req, res) => res.sendFile(path.join(__dirname, 'public', 'volleybug.html'))); // vMix overlay input
app.get('/volley', (req, res) => res.sendFile(path.join(__dirname, 'public', 'volley.html')));       // director control (desktop setup)
app.get('/vcontrol', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vcontrol.html')));   // iPad match control (controls only)

// ---- Load persisted data, then start the server ----
async function initDB() {
  if (!pool) {
    console.log('No DATABASE_URL — running in-memory (data resets on deploy)');
    return;
  }
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS reporters (id text PRIMARY KEY, name text NOT NULL, created_at bigint)');
    // Additive migrations — safe on existing rows, no-op if already present
    await pool.query("ALTER TABLE reporters ADD COLUMN IF NOT EXISTS location text DEFAULT ''");
    await pool.query("ALTER TABLE reporters ADD COLUMN IF NOT EXISTS photo text DEFAULT ''");
    await pool.query("ALTER TABLE reporters ADD COLUMN IF NOT EXISTS tag_visible boolean DEFAULT false");
    await pool.query("ALTER TABLE reporters ADD COLUMN IF NOT EXISTS pv bigint DEFAULT 0");
    await pool.query('CREATE TABLE IF NOT EXISTS tickers (id text PRIMARY KEY, data jsonb NOT NULL)');
    await pool.query('CREATE TABLE IF NOT EXISTS scoreboard (id text PRIMARY KEY, data jsonb NOT NULL)');
    await pool.query('CREATE TABLE IF NOT EXISTS volleyball (id text PRIMARY KEY, data jsonb NOT NULL)');

    const rr = await pool.query('SELECT id, name, location, photo, tag_visible, pv FROM reporters ORDER BY created_at ASC');
    reporters = rr.rows.map(r => ({
      id: r.id,
      name: r.name,
      location: r.location || '',
      photo: r.photo || '',
      tagVisible: !!r.tag_visible,
      pv: Number(r.pv) || 0
    }));

    for (const id of ['voice', 'dhuvas']) {
      const tr = await pool.query('SELECT data FROM tickers WHERE id=$1', [id]);
      if (tr.rows.length) tickers[id] = tr.rows[0].data;
      else await pool.query('INSERT INTO tickers (id, data) VALUES ($1,$2)', [id, tickers[id]]);
    }

    // Scoreboard — restore the match, but never come back from a deploy with a
    // clock that "ran" while the service was down.
    const sr = await pool.query('SELECT data FROM scoreboard WHERE id=$1', ['match']);
    if (sr.rows.length) {
      scoreboard = Object.assign(blankScoreboard(), sr.rows[0].data);
      // Freeze wherever it was last committed rather than crediting downtime,
      // which could be days. The operator nudges and hits START again.
      const c = scoreboard.clock;
      c.running = false; c.startedAt = 0;
    } else {
      await pool.query('INSERT INTO scoreboard (id, data) VALUES ($1,$2)', ['match', scoreboard]);
    }

    // Volleyball — no clock to worry about, so this restores exactly as saved.
    const vr = await pool.query('SELECT data FROM volleyball WHERE id=$1', ['match']);
    if (vr.rows.length) {
      volley = Object.assign(blankVolley(), vr.rows[0].data);
      volleyUndo = [];
    } else {
      await pool.query('INSERT INTO volleyball (id, data) VALUES ($1,$2)', ['match', volley]);
    }

    console.log(`PostgreSQL connected — ${reporters.length} reporters loaded, data persists across deploys`);
  } catch (e) {
    console.error('DB init failed, falling back to in-memory:', e.message);
    pool = null;
  }
}

initDB().finally(() => {
  app.listen(PORT, () => console.log(`VxD Relay running on port ${PORT}`));
});
