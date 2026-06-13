// messages.js — two-way director ↔ reporter comms for VxD
// Drop this file next to server.js, then add ONE line to server.js:
//     require('./messages')(app);
// (put it after `app` and the JSON body parser exist — same place your ticker routes live)
//
// In-memory + polling, exactly like the ticker state. Resets on Railway redeploy,
// which is fine for ephemeral on-air comms. One active message per reporter id.

module.exports = function attachMessaging(app) {
  // store[id] = { msgId, text, action, sentAt, status, respAt }
  // status: 'pending' | 'yes' | 'ignore'
  const store = Object.create(null);
  const now = () => Date.now();
  const mkId = () => now().toString(36) + Math.random().toString(36).slice(2, 6);

  // DIRECTOR → send a message to a reporter
  app.post('/api/msg/send', (req, res) => {
    const { id, text = '', action = '' } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
    const msgId = mkId();
    store[id] = {
      msgId,
      text: String(text).slice(0, 300),
      action: String(action || ''),
      sentAt: now(),
      status: 'pending',
      respAt: 0
    };
    res.json({ ok: true, msgId });
  });

  // REPORTER → poll for the current message
  app.get('/api/msg/poll', (req, res) => {
    res.json({ ok: true, msg: store[req.query.id] || null });
  });

  // REPORTER → acknowledge (yes / ignore)
  app.post('/api/msg/ack', (req, res) => {
    const { id, msgId, response } = req.body || {};
    const m = store[id];
    if (!m || m.msgId !== msgId) return res.json({ ok: false, error: 'stale' });
    if (response !== 'yes' && response !== 'ignore')
      return res.status(400).json({ ok: false, error: 'bad response' });
    m.status = response;
    m.respAt = now();
    res.json({ ok: true });
  });

  // DIRECTOR → poll the status of the message it sent
  app.get('/api/msg/status', (req, res) => {
    res.json({ ok: true, msg: store[req.query.id] || null });
  });

  // DIRECTOR → clear (reset the card, ready for the next message)
  app.post('/api/msg/clear', (req, res) => {
    if (req.body && req.body.id) delete store[req.body.id];
    res.json({ ok: true });
  });
};
