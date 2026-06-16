/* Player search autocomplete. Type-ahead against /api/players/search; clicking
   a suggestion (or pressing Enter) opens that player's profile. */
(function () {
  var input = document.getElementById('player-q');
  var list = document.getElementById('player-ac');
  if (!input || !list) return;
  var timer = null, lastQ = '', items = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function hide() { list.hidden = true; list.innerHTML = ''; }

  function render(arr) {
    items = arr || [];
    if (!items.length) { hide(); return; }
    list.innerHTML = items.map(function (p) {
      return '<a class="ac-item" href="/u/' + encodeURIComponent(p.username) + '">' +
        '<span class="ac-name">' + esc(p.username) + '</span>' +
        (p.rankLabel ? '<span class="ac-loc" style="color:' + esc(p.color || '') + '">' + esc(p.rankLabel) + '</span>' : '') +
        '</a>';
    }).join('');
    list.hidden = false;
  }

  function search() {
    var q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    if (q === lastQ) { return; }
    lastQ = q;
    fetch('/api/players/search?q=' + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (arr) { if (input.value.trim() === q) render(arr); })
      .catch(hide);
  }

  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(search, 180); });
  input.addEventListener('focus', function () { if (list.innerHTML) list.hidden = false; });
  input.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
  document.addEventListener('click', function (e) {
    if (e.target !== input && !list.contains(e.target)) hide();
  });

  // Enter: jump to the top suggestion, or to the typed username as a fallback.
  if (input.form) {
    input.form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = input.value.trim();
      if (!q) return;
      var target = items.length ? items[0].username : q;
      window.location.href = '/u/' + encodeURIComponent(target);
    });
  }
})();
