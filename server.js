const express = require('express');
const path = require('path');
const app = express();
const PORT = 8080;

app.use(express.json());
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
    if (!response.ok) throw new Error('Not found');
    const buffer = await response.arrayBuffer();
    const ext = req.params.file.split('.').pop();
    const types = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t' };
    res.set('Content-Type', types[ext] || 'application/octet-stream');
    res.set('Cache-Control', 'no-cache');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(buffer));
  } catch (e) {
    res.status(404).send('Stream not found');
  }
});

// ---- Reporters (persisted to Postgres when available) ----
let reporters = [];

app.get('/api/reporters', (req, res) => {
  res.json(reporters);
});

app.post('/api/reporters', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = 'vxd' + Date.now().toString(36);
  reporters.push({ name, id });
  if (pool) {
    try { await pool.query('INSERT INTO reporters (id, name, created_at) VALUES ($1,$2,$3)', [id, name, Date.now()]); }
    catch (e) { console.error('reporters insert failed:', e.message); }
  }
  res.json(reporters);
});

app.delete('/api/reporters/:id', async (req, res) => {
  reporters = reporters.filter(r => r.id !== req.params.id);
  if (pool) {
    try { await pool.query('DELETE FROM reporters WHERE id=$1', [req.params.id]); }
    catch (e) { console.error('reporters delete failed:', e.message); }
  }
  res.json(reporters);
});

// ---- Ticker states — one per outlet (persisted to Postgres when available) ----
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

// Pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/tv', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tv.html')));
app.get('/team', (req, res) => res.sendFile(path.join(__dirname, 'public', 'team.html')));
app.get('/relay', (req, res) => res.sendFile(path.join(__dirname, 'public', 'relay.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/ticker', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ticker.html')));
app.get('/go', (req, res) => res.sendFile(path.join(__dirname, 'public', 'go.html')));

// ---- Load persisted data, then start the server ----
async function initDB() {
  if (!pool) {
    console.log('No DATABASE_URL — running in-memory (data resets on deploy)');
    return;
  }
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS reporters (id text PRIMARY KEY, name text NOT NULL, created_at bigint)');
    await pool.query('CREATE TABLE IF NOT EXISTS tickers (id text PRIMARY KEY, data jsonb NOT NULL)');

    const rr = await pool.query('SELECT id, name FROM reporters ORDER BY created_at ASC');
    reporters = rr.rows.map(r => ({ id: r.id, name: r.name }));

    for (const id of ['voice', 'dhuvas']) {
      const tr = await pool.query('SELECT data FROM tickers WHERE id=$1', [id]);
      if (tr.rows.length) tickers[id] = tr.rows[0].data;
      else await pool.query('INSERT INTO tickers (id, data) VALUES ($1,$2)', [id, tickers[id]]);
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
