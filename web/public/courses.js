/* Course search autocomplete. Type-ahead against /api/courses/search; clicking
   a suggestion opens that course. The form still submits to /courses?q= for a
   full results page as a fallback. */
(function () {
  var input = document.getElementById('course-q');
  var list = document.getElementById('course-ac');
  if (!input || !list) return;
  var timer = null, lastQ = '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function hide() { list.hidden = true; list.innerHTML = ''; }

  function render(items) {
    if (!items || !items.length) { hide(); return; }
    list.innerHTML = items.map(function (c) {
      var loc = [c.city, c.state, c.country].filter(Boolean).join(', ');
      return '<a class="ac-item" href="/course/' + encodeURIComponent(c.course_id) + '">' +
        '<span class="ac-name">' + esc(c.course_name) + '</span>' +
        (loc ? '<span class="ac-loc">' + esc(loc) + '</span>' : '') +
        '</a>';
    }).join('');
    list.hidden = false;
  }

  function search() {
    var q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    if (q === lastQ) { return; }
    lastQ = q;
    fetch('/api/courses/search?q=' + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (items) { if (input.value.trim() === q) render(items); })
      .catch(hide);
  }

  input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(search, 180); });
  input.addEventListener('focus', function () { if (list.innerHTML) list.hidden = false; });
  input.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
  document.addEventListener('click', function (e) {
    if (e.target !== input && !list.contains(e.target)) hide();
  });
})();
