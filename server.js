const express = require('express');
const path = require('path');
const app = express();
const PORT = 8080;

app.use(express.json({ limit: '3mb' })); // 3mb headroom for base64 reporter photos
app.use(express.static(path.join(__dirname, 'public')));

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
  branchLive: false,       // Branch Output filter enabled (Dhuvas)
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
    const enabled = (req.body && typeof req.body.enabled === 'boolean') ? req.body.enabled : !obsState.branchLive;
    await obs.call('SetSourceFilterEnabled', {
      sourceName: OBS_SCENE_DHUVAS, filterName: OBS_BRANCH_FILTER, filterEnabled: enabled,
    });
    obsState.branchLive = enabled;
    res.json({ ok: true, enabled });
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
    } else {
      return res.status(400).json({ error: "target must be 'voice' or 'dhuvas'" });
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
// One call creates a live video on BOTH pages, writes each page's
// stream key into the right place in OBS, and starts streaming.
// Another call ends the match and closes both broadcasts.
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
  title: '',
  startedAt: 0,
  publishedAt: 0,
  videos: { voice: null, dhuvas: null },   // { id, permalink, published }
  lastError: '',
};

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

app.post('/api/match/start', async (req, res) => {
  if (!obsGuard(res)) return;
  const title = (req.body && req.body.title || '').trim();
  const description = (req.body && req.body.description || '').trim();
  if (!title) return res.status(400).json({ error: 'title required' });
  if (matchState.live) return res.status(409).json({ error: 'a match is already live — end it first' });

  const missing = Object.entries(FB_PAGES)
    .filter(([, p]) => !p.id || !p.token)
    .map(([k]) => k);
  if (missing.length) {
    return res.status(400).json({ error: 'missing page id/token for: ' + missing.join(', ') });
  }

  // Stream settings can't be changed while streaming.
  if (obsState.streaming) {
    return res.status(409).json({ error: 'OBS is already streaming — stop it before starting a match' });
  }

  const created = {};
  try {
    // 1. create both broadcasts, unpublished
    for (const [brand, page] of Object.entries(FB_PAGES)) {
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

    // 3. go
    await obs.call('StartStream');

    matchState.live = true;
    matchState.title = title;
    matchState.startedAt = Date.now();
    matchState.publishedAt = 0;
    matchState.lastError = '';
    matchState.videos = {
      voice: { id: created.voice.id, published: false },
      dhuvas: { id: created.dhuvas.id, published: false },
    };

    // 4. publish once OBS confirms ingest is actually running
    setTimeout(async () => {
      try {
        const st = await obs.call('GetStreamStatus');
        if (!st.outputActive) {
          matchState.lastError = 'OBS did not start streaming — broadcasts left unpublished';
          return;
        }
        for (const [brand, page] of Object.entries(FB_PAGES)) {
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

    res.json({ ok: true, title, videos: matchState.videos });
  } catch (e) {
    // Roll back anything we created so we don't leave orphan broadcasts.
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
      if (!vid || vid.published) continue;
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
    try { await obs.call('StopStream'); }
    catch (e) { errors.push('OBS: ' + e.message); }
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

  matchState.live = false;
  matchState.videos = { voice: null, dhuvas: null };
  matchState.lastError = errors.join(' | ');

  res.json({ ok: errors.length === 0, errors });
});

app.get('/api/match/status', (req, res) => {
  res.json({
    live: matchState.live,
    title: matchState.title,
    startedAt: matchState.startedAt,
    publishedAt: matchState.publishedAt,
    videos: matchState.videos,
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

// Pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/relay', (req, res) => res.sendFile(path.join(__dirname, 'public', 'relay.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/ticker', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ticker.html')));
app.get('/go', (req, res) => res.sendFile(path.join(__dirname, 'public', 'go.html')));
app.get('/live', (req, res) => res.sendFile(path.join(__dirname, 'public', 'live.html')));
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
