// Small helpers for the docs pages: copy buttons on code blocks, language tabs, heading links.
(function () {
  // Examples use https://jef.example.com; show this site's real address instead.
  if (/^https?:$/.test(location.protocol)) {
    document.querySelectorAll('pre code, code').forEach(function (el) {
      if (el.children.length === 0 && el.textContent.indexOf('https://jef.example.com') !== -1) {
        el.textContent = el.textContent.split('https://jef.example.com').join(location.origin);
      }
    });
  }

  // Language tabs: <div class="tabs"> holding several <pre data-lang="…">.
  var saved = null;
  try { saved = localStorage.getItem('jef-lang'); } catch (e) { /* private mode */ }
  var groups = [];
  document.querySelectorAll('.tabs').forEach(function (box, g) {
    var panels = Array.prototype.slice.call(box.querySelectorAll(':scope > pre[data-lang]'));
    if (panels.length < 2) return;
    var list = document.createElement('div');
    list.setAttribute('role', 'tablist');
    var buttons = panels.map(function (pre, i) {
      var id = 'tab-' + g + '-' + i;
      pre.id = id;
      pre.setAttribute('role', 'tabpanel');
      var b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-controls', id);
      b.textContent = pre.getAttribute('data-lang');
      b.addEventListener('click', function () { selectAll(pre.getAttribute('data-lang')); });
      list.appendChild(b);
      return b;
    });
    box.insertBefore(list, box.firstChild);
    function select(lang) {
      var idx = panels.findIndex(function (p) { return p.getAttribute('data-lang') === lang; });
      if (idx < 0) return false;
      panels.forEach(function (p, i) { p.hidden = i !== idx; buttons[i].setAttribute('aria-selected', String(i === idx)); });
      return true;
    }
    groups.push(select);
    if (!(saved && select(saved))) select(panels[0].getAttribute('data-lang'));
  });
  function selectAll(lang) {
    groups.forEach(function (s) { s(lang); });
    try { localStorage.setItem('jef-lang', lang); } catch (e) { /* ignore */ }
  }

  // Copy buttons.
  document.querySelectorAll('pre').forEach(function (pre) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'copy';
    b.textContent = 'Copy';
    b.setAttribute('aria-label', 'Copy code');
    b.addEventListener('click', function () {
      var text = (pre.querySelector('code') || pre).innerText;
      navigator.clipboard.writeText(text).then(function () {
        b.textContent = 'Copied';
        setTimeout(function () { b.textContent = 'Copy'; }, 1500);
      });
    });
    pre.appendChild(b);
  });

  // "#" links on headings that have ids.
  document.querySelectorAll('.content h2[id], .content h3[id]').forEach(function (h) {
    var a = document.createElement('a');
    a.className = 'anchor';
    a.href = '#' + h.id;
    a.textContent = '#';
    a.setAttribute('aria-label', 'Link to this section');
    h.appendChild(a);
  });
})();
