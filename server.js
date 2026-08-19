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

let vmixProxyUrl = 'https://vmix.vxd.news';

// vMix URL management
app.post('/api/set-vmix-url', (req, res) => {
  vmixProxyUrl = req.body.url || '';
  res.json({ ok: true, url: vmixProxyUrl });
});

app.get('/api/get-vmix-url', (req, res) => {
  res.json({ url: vmixProxyUrl });
});

// Proxy vMix API status
app.get('/api/vmix', async (req, res) => {
  if (!vmixProxyUrl) return res.status(400).json({ error: 'No vMix URL configured' });
  try {
    const response = await fetch(`${vmixProxyUrl}/api/${req.query.path || ''}`);
    const text = await response.text();
    res.set('Content-Type', 'text/xml');
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: 'Cannot reach vMix: ' + e.message });
  }
});

// Proxy vMix commands
app.get('/api/vmix-cmd', async (req, res) => {
  if (!vmixProxyUrl) return res.status(400).json({ error: 'No vMix URL configured' });
  try {
    const func = req.query.Function || '';
    const params = Object.entries(req.query)
      .filter(([k]) => k !== 'Function')
      .map(([k, v]) => `&${k}=${v}`)
      .join('');
    await fetch(`${vmixProxyUrl}/api/?Function=${func}${params}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'Command failed: ' + e.message });
  }
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
app.get('/score', (req, res) => res.sendFile(path.join(__dirname, 'public', 'score.html')));        // director control

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

    console.log(`PostgreSQL connected — ${reporters.length} reporters loaded, data persists across deploys`);
  } catch (e) {
    console.error('DB init failed, falling back to in-memory:', e.message);
    pool = null;
  }
}

initDB().finally(() => {
  app.listen(PORT, () => console.log(`VxD Relay running on port ${PORT}`));
});
