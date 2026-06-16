/* VxD on-page reporter bug — shared by tv.html, team.html, index.html (NOT go.html).
   Single persistent overlay, bottom-right above the ticker line. Shows whichever
   reporter is currently toggled ON (most recent wins). Same look as the vMix tag. */
(function () {
  if (window.__vxdTagBug) return;          // guard: never inject twice
  window.__vxdTagBug = true;

  var ORIGIN = location.origin;

  var css =
      "@font-face{font-family:'MVWaheed';src:url('fonts/MVWaheed.otf') format('opentype')}"
    + "@font-face{font-family:'MvEamaan';src:url('fonts/Mv_Eamaan_XP.otf') format('opentype')}"
    + "#vxd-tagbug{position:fixed;right:24px;bottom:84px;z-index:9999;display:flex;align-items:center;gap:10px;"
    +   "direction:rtl;pointer-events:none;filter:drop-shadow(0 8px 20px rgba(0,0,0,.5));"
    +   "opacity:0;transform:translateY(16px);transition:opacity .4s ease,transform .4s cubic-bezier(.22,1,.36,1);"
    +   "font-family:'MvEamaan','Segoe UI',Arial,sans-serif}"
    + "#vxd-tagbug.show{opacity:1;transform:translateY(0)}"
    + "#vxd-tagbug .vtb-photo{width:54px;height:54px;flex:0 0 54px;border-radius:50%;object-fit:cover;"
    +   "border:3px solid #f5821f;background:#0a0a12;display:none}"
    + "#vxd-tagbug .vtb-photo.show{display:block}"
    + "#vxd-tagbug .vtb-panel{display:flex;flex-direction:column;border-radius:9px;overflow:hidden;max-width:360px}"
    + "#vxd-tagbug .vtb-name{background:#16161c;color:#fff;font-family:'MVWaheed','Segoe UI',Arial,sans-serif;"
    +   "font-size:20px;line-height:1.2;padding:6px 16px 5px;direction:rtl;text-align:right;white-space:nowrap}"
    + "#vxd-tagbug .vtb-loc{background:#f5821f;color:#16161c;font-family:'MvEamaan','Segoe UI',Arial,sans-serif;"
    +   "font-size:13px;font-weight:600;line-height:1.2;padding:4px 16px 5px;direction:rtl;text-align:right;white-space:nowrap}"
    + "#vxd-tagbug .vtb-loc.empty{display:none}";

  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  var bug = document.createElement('div');
  bug.id = 'vxd-tagbug';
  bug.innerHTML =
      '<img class="vtb-photo" id="vtb-photo" alt="">'
    + '<div class="vtb-panel">'
    +   '<div class="vtb-name" id="vtb-name"></div>'
    +   '<div class="vtb-loc empty" id="vtb-loc"></div>'
    + '</div>';
  document.body.appendChild(bug);

  var photo  = bug.querySelector('#vtb-photo');
  var nameEl = bug.querySelector('#vtb-name');
  var locEl  = bug.querySelector('#vtb-loc');

  var lastId = '', lastKey = '', lastPv = -1;

  function loadPhoto(id) {
    fetch(ORIGIN + '/api/reporters/' + id)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        if (d.photo) { photo.src = d.photo; photo.classList.add('show'); }
        else { photo.removeAttribute('src'); photo.classList.remove('show'); }
      })
      .catch(function () {});
  }

  function poll() {
    fetch(ORIGIN + '/api/active-tag?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.active) { bug.classList.remove('show'); lastId = ''; lastPv = -1; return; }

        if (d.id !== lastId) {                  // switched reporter — drop the old photo first
          photo.classList.remove('show');
          photo.removeAttribute('src');
          lastPv = -1;
        }
        if (d.pv !== lastPv) { lastPv = d.pv; loadPhoto(d.id); }
        lastId = d.id;

        var key = JSON.stringify([d.name, d.location]);
        if (key !== lastKey) {
          lastKey = key;
          nameEl.textContent = d.name || '';
          if (d.location) { locEl.textContent = d.location; locEl.classList.remove('empty'); }
          else { locEl.textContent = ''; locEl.classList.add('empty'); }
        }
        bug.classList.add('show');
      })
      .catch(function () {});
  }

  poll();
  setInterval(poll, 1000);
})();
