const express = require('express');
const path = require('path');
const app = express();
const PORT = 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let vmixProxyUrl = '';

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

// Reporters (server-side storage so all devices see the same list)
let reporters = [];

app.get('/api/reporters', (req, res) => {
  res.json(reporters);
});

app.post('/api/reporters', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = 'vxd' + Date.now().toString(36);
  reporters.push({ name, id });
  res.json(reporters);
});

app.delete('/api/reporters/:id', (req, res) => {
  reporters = reporters.filter(r => r.id !== req.params.id);
  res.json(reporters);
});

// SOS alerts from field reporters
let sosAlerts = [];

app.get('/api/sos', (req, res) => {
  res.json(sosAlerts);
});

app.post('/api/sos', (req, res) => {
  const alert = req.body;
  alert.id = Date.now();
  alert.read = false;
  sosAlerts.unshift(alert);
  // Keep only last 50 alerts
  if (sosAlerts.length > 50) sosAlerts = sosAlerts.slice(0, 50);
  res.json({ ok: true });
});

app.delete('/api/sos/:id', (req, res) => {
  sosAlerts = sosAlerts.filter(a => a.id !== parseInt(req.params.id));
  res.json(sosAlerts);
});

// === Director ↔ reporter messaging (/api/msg/*) — in-memory ===
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

// Ticker states — one per outlet
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

app.post('/api/ticker/:id', (req, res) => {
  const id = req.params.id;
  if (tickers[id]) {
    Object.assign(tickers[id], req.body);
    res.json(tickers[id]);
  } else res.status(404).json({ error: 'Unknown ticker' });
});

// Pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/team', (req, res) => res.sendFile(path.join(__dirname, 'public', 'team.html')));
app.get('/relay', (req, res) => res.sendFile(path.join(__dirname, 'public', 'relay.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/ticker', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ticker.html')));
app.get('/go', (req, res) => res.sendFile(path.join(__dirname, 'public', 'go.html')));
app.get('/live', (req, res) => res.sendFile(path.join(__dirname, 'public', 'live.html')));

app.listen(PORT, () => {
  console.log(`VxD Relay running on port ${PORT}`);
});
