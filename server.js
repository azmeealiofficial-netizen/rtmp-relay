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

// Ticker state
let tickerState = {
  visible: false,
  label: 'ބްރޭކިންގ',
  text: '',
  mode: 'scroll',
  speed: 15,
  direction: 'rtl',
  labelColor: '#ef4444'
};

app.get('/api/ticker', (req, res) => {
  res.json(tickerState);
});

app.post('/api/ticker', (req, res) => {
  Object.assign(tickerState, req.body);
  res.json(tickerState);
});

// Pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/team', (req, res) => res.sendFile(path.join(__dirname, 'public', 'team.html')));
app.get('/relay', (req, res) => res.sendFile(path.join(__dirname, 'public', 'relay.html')));
app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, 'public', 'settings.html')));
app.get('/ticker', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ticker.html')));

app.listen(PORT, () => {
  console.log(`VxD Relay running on port ${PORT}`);
});
