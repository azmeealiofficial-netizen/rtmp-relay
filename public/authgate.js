/* ============================================================
   VxD PIN gate — shared by /golive and the control panel.

   Two jobs:
     1. On load, ask the server whether a PIN is required and
        whether this browser already holds a valid session.
     2. Wrap window.fetch so that ANY 401 from a state-changing
        call re-raises the lock screen instead of failing silently.

   (2) matters more than (1). The page can be open for hours; a
   session can expire between loading the page and pressing GO
   LIVE. Without the wrapper the button would simply do nothing.

   The real enforcement is server-side. This file is convenience,
   not security — it exists so an operator sees a keypad rather
   than a dead button.
   ============================================================ */
(function () {
  'use strict';

  var state = { required: false, authed: true, checked: false };
  var pending = null;   // resolve fn for the promise a caller is awaiting

  // ---------- lock screen ----------
  function el(tag, css, text) {
    var n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildOverlay() {
    var wrap = el('div',
      'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;' +
      'justify-content:center;background:#0b0b0c;font-family:system-ui,-apple-system,' +
      '"Segoe UI",Roboto,sans-serif;padding:24px');

    var card = el('div', 'width:100%;max-width:320px;text-align:center');

    var brand = el('div',
      'font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#8b8b90;' +
      'margin-bottom:28px', 'VxD Broadcast');

    var title = el('div',
      'font-size:20px;font-weight:600;color:#f4f4f5;margin-bottom:6px', 'Enter PIN');

    var sub = el('div',
      'font-size:13px;color:#8b8b90;margin-bottom:24px;line-height:1.5',
      'Required to start or end a broadcast.');

    var input = el('input',
      'width:100%;box-sizing:border-box;font-size:28px;letter-spacing:.35em;' +
      'text-align:center;padding:14px;border-radius:10px;border:1px solid #2a2a2e;' +
      'background:#141416;color:#f4f4f5;outline:none;-webkit-text-security:disc');
    input.type = 'password';
    input.inputMode = 'numeric';
    input.autocomplete = 'one-time-code';
    input.setAttribute('aria-label', 'PIN');

    var err = el('div',
      'min-height:20px;margin-top:10px;font-size:13px;color:#f87171', '');

    var btn = el('button',
      'width:100%;margin-top:14px;padding:15px;border:0;border-radius:10px;' +
      'background:#dc2626;color:#fff;font-size:16px;font-weight:600;cursor:pointer',
      'UNLOCK');

    function submit() {
      var pin = input.value.trim();
      if (!pin) return;
      btn.disabled = true;
      btn.textContent = 'CHECKING…';
      err.textContent = '';
      rawFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pin }),
      }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, j: j }; });
      }).then(function (res) {
        btn.disabled = false;
        btn.textContent = 'UNLOCK';
        if (!res.ok) {
          err.textContent = (res.j && res.j.error) || 'Wrong PIN';
          input.value = '';
          input.focus();
          return;
        }
        state.authed = true;
        document.body.removeChild(wrap);
        if (pending) { var p = pending; pending = null; p(true); }
      }).catch(function (e) {
        btn.disabled = false;
        btn.textContent = 'UNLOCK';
        err.textContent = 'Network error — ' + e.message;
      });
    }

    btn.addEventListener('click', submit);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });

    card.appendChild(brand);
    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(input);
    card.appendChild(err);
    card.appendChild(btn);
    wrap.appendChild(card);

    setTimeout(function () { input.focus(); }, 60);
    return wrap;
  }

  var overlayOpen = false;
  function lock() {
    if (overlayOpen) return new Promise(function (res) { pending = res; });
    overlayOpen = true;
    var node = buildOverlay();
    document.body.appendChild(node);
    return new Promise(function (res) {
      pending = function (v) { overlayOpen = false; res(v); };
    });
  }

  // ---------- fetch wrapper ----------
  var rawFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    return rawFetch(input, init).then(function (r) {
      if (r.status !== 401) return r;
      // Only auth 401s carry this flag; anything else passes through
      // so a genuine upstream 401 isn't swallowed by a PIN prompt.
      return r.clone().json().catch(function () { return {}; }).then(function (j) {
        if (!j || !j.authRequired) return r;
        state.authed = false;
        return lock().then(function () { return rawFetch(input, init); });
      });
    });
  };

  // ---------- boot ----------
  function boot() {
    rawFetch('/api/auth/status')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.required = !!j.authRequired;
        state.authed = !!j.authed;
        state.checked = true;
        if (state.required && !state.authed) lock();
      })
      .catch(function () { /* relay unreachable — the page's own error path handles it */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.VXD_AUTH = {
    state: state,
    lock: lock,
    logout: function () {
      return rawFetch('/api/auth/logout', { method: 'POST' })
        .then(function () { location.reload(); });
    },
  };
})();
