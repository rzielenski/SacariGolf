/* Course polygon editor. Reads window.POLY_DATA, renders a satellite map with
   any already-traced shapes, and lets the user click out a new one point by
   point. Drawing is hand-rolled rather than pulled from Leaflet.draw: it's a
   click handler and a polyline, and it keeps the page dependency-light and
   consistent with pins.js. */
(function () {
  var D = window.POLY_DATA || { holes: [], kinds: [], polygons: [], center: null, baseUrl: '' };
  var hasCenter = Array.isArray(D.center);
  var map = L.map('map').setView(hasCenter ? D.center : [39.5, -98.35], hasCenter ? 17 : 4);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 20, attribution: 'Imagery &copy; Esri',
  }).addTo(map);

  var colorOf = {}, labelOf = {};
  for (var i = 0; i < D.kinds.length; i++) {
    colorOf[D.kinds[i].key] = D.kinds[i].color;
    labelOf[D.kinds[i].key] = D.kinds[i].label;
  }

  var kind = D.kinds.length ? D.kinds[0].key : 'green';
  var pts = [];             // in-progress vertices, [lat,lng]
  var draft = null;         // polyline showing the trace so far
  var vertexDots = [];
  var saved = {};           // polygon_id -> leaflet layer
  var busy = false;

  var info = document.getElementById('poly-info');
  var msg = document.getElementById('poly-msg');
  var elFinish = document.getElementById('poly-finish');
  var elUndo = document.getElementById('poly-undo');
  var elCancel = document.getElementById('poly-cancel');
  var elHole = document.getElementById('poly-hole');
  var elList = document.getElementById('poly-list');
  var elCount = document.getElementById('poly-count');

  function say(text, isErr) {
    msg.textContent = text || '';
    msg.className = 'pin-msg' + (isErr ? ' err' : text ? ' ok' : '');
  }

  function holeLabel(n) { return n == null ? 'Whole course' : 'Hole ' + n; }

  function updateBar() {
    elFinish.disabled = busy || pts.length < 3;
    elUndo.disabled = busy || pts.length === 0;
    elCancel.disabled = busy || pts.length === 0;
    if (!pts.length) {
      info.textContent = 'Tracing ' + labelOf[kind] + '. Click the map to drop the first point.';
    } else if (pts.length < 3) {
      info.textContent = labelOf[kind] + ': ' + pts.length + ' point' + (pts.length === 1 ? '' : 's')
        + '. At least 3 needed.';
    } else {
      info.textContent = labelOf[kind] + ' on ' + holeLabel(currentHole()) + ': '
        + pts.length + ' points. Press Finish to save.';
    }
  }

  function currentHole() {
    var v = elHole.value;
    return v === '' ? null : Number(v);
  }

  // ── in-progress drawing ───────────────────────────────────────────────────
  function redrawDraft() {
    if (draft) { map.removeLayer(draft); draft = null; }
    for (var i = 0; i < vertexDots.length; i++) map.removeLayer(vertexDots[i]);
    vertexDots = [];
    if (!pts.length) return;
    // Show it closed once it's a real shape, so the user sees the actual area.
    var line = pts.length >= 3 ? pts.concat([pts[0]]) : pts;
    draft = L.polyline(line, {
      color: colorOf[kind], weight: 3, dashArray: '6,6', fillOpacity: 0,
    }).addTo(map);
    for (var k = 0; k < pts.length; k++) {
      vertexDots.push(L.circleMarker(pts[k], {
        radius: 4, color: '#fff', weight: 2, fillColor: colorOf[kind], fillOpacity: 1,
      }).addTo(map));
    }
  }

  map.on('click', function (e) {
    if (busy) return;
    pts.push([e.latlng.lat, e.latlng.lng]);
    redrawDraft();
    updateBar();
    say('');
  });

  elUndo.addEventListener('click', function () {
    pts.pop(); redrawDraft(); updateBar();
  });
  elCancel.addEventListener('click', function () {
    pts = []; redrawDraft(); updateBar(); say('');
  });

  // ── kind palette ──────────────────────────────────────────────────────────
  var kindBtns = document.querySelectorAll('.kind-btn');
  for (var b = 0; b < kindBtns.length; b++) {
    kindBtns[b].addEventListener('click', function () {
      for (var m = 0; m < kindBtns.length; m++) kindBtns[m].classList.remove('active');
      this.classList.add('active');
      kind = this.getAttribute('data-kind');
      redrawDraft();   // recolour the in-progress trace
      updateBar();
    });
  }

  // ── jump to a hole ────────────────────────────────────────────────────────
  document.getElementById('poly-jump').addEventListener('click', function () {
    var n = currentHole();
    if (n == null) {
      if (hasCenter) map.setView(D.center, 16);
      return;
    }
    var h = null;
    for (var i = 0; i < D.holes.length; i++) if (D.holes[i].n === n) h = D.holes[i];
    if (!h) return;
    if (h.tee && h.pin) map.fitBounds([h.tee, h.pin], { padding: [40, 40] });
    else if (h.pin) map.setView(h.pin, 18);
    else if (h.tee) map.setView(h.tee, 18);
    else say('Hole ' + n + ' has no pin or tee marked yet, so there is nothing to jump to.', true);
  });
  elHole.addEventListener('change', updateBar);

  // ── saved shapes ──────────────────────────────────────────────────────────
  function addSaved(p) {
    var layer = L.polygon(p.ring, {
      color: colorOf[p.kind] || '#fff',
      fillColor: colorOf[p.kind] || '#fff',
      fillOpacity: 0.35, weight: 2,
    }).addTo(map);
    layer.bindTooltip((labelOf[p.kind] || p.kind) + ' · ' + holeLabel(p.hole));
    saved[p.id] = layer;
  }

  function renderList() {
    var ids = Object.keys(saved);
    elCount.textContent = String(ids.length);
    if (!ids.length) {
      elList.innerHTML = '<div class="empty">Nothing traced yet.</div>';
      return;
    }
    // Sort by hole (whole-course first), then type.
    var items = D.polygons.filter(function (p) { return saved[p.id]; });
    items.sort(function (a, b) {
      var ah = a.hole == null ? -1 : a.hole, bh = b.hole == null ? -1 : b.hole;
      if (ah !== bh) return ah - bh;
      return String(a.kind).localeCompare(String(b.kind));
    });
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var p = items[i];
      html += '<div class="poly-item" data-id="' + p.id + '">'
        + '<span class="kind-swatch" style="background:' + (colorOf[p.kind] || '#fff') + '"></span>'
        + '<span class="poly-item-name">' + (labelOf[p.kind] || p.kind) + '</span>'
        + '<span class="poly-item-hole">' + holeLabel(p.hole) + '</span>'
        + '<button type="button" class="poly-show" data-id="' + p.id + '">Show</button>'
        + '<button type="button" class="poly-del" data-id="' + p.id + '">Delete</button>'
        + '</div>';
    }
    elList.innerHTML = html;
  }

  elList.addEventListener('click', function (e) {
    var id = e.target.getAttribute && e.target.getAttribute('data-id');
    if (!id) return;
    if (e.target.classList.contains('poly-show')) {
      if (saved[id]) map.fitBounds(saved[id].getBounds(), { padding: [40, 40] });
      return;
    }
    if (e.target.classList.contains('poly-del')) {
      if (!window.confirm('Delete this shape?')) return;
      e.target.disabled = true;
      fetch(D.baseUrl + '/' + id, { method: 'DELETE', headers: { 'Accept': 'application/json' } })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (out) {
          if (!out.ok) throw new Error((out.d && out.d.error) || 'Could not delete');
          if (saved[id]) { map.removeLayer(saved[id]); delete saved[id]; }
          D.polygons = D.polygons.filter(function (p) { return p.id !== id; });
          renderList();
          say('Shape deleted.');
        })
        .catch(function (err) { e.target.disabled = false; say(err.message, true); });
    }
  });

  // ── save ──────────────────────────────────────────────────────────────────
  elFinish.addEventListener('click', function () {
    if (pts.length < 3) return;
    busy = true; updateBar(); say('Saving…');
    var payload = { kind: kind, holeNum: currentHole(), ring: pts };
    fetch(D.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (out) {
        if (!out.ok) throw new Error((out.d && out.d.error) || 'Could not save');
        var p = out.d.polygon;
        var entry = { id: p.polygon_id, hole: p.hole_num, kind: p.kind, ring: p.ring };
        D.polygons.push(entry);
        addSaved(entry);
        renderList();
        pts = []; redrawDraft();
        say(labelOf[entry.kind] + ' saved on ' + holeLabel(entry.hole) + '.');
      })
      .catch(function (err) { say(err.message, true); })
      .then(function () { busy = false; updateBar(); });
  });

  // ── boot ──────────────────────────────────────────────────────────────────
  for (var q = 0; q < D.polygons.length; q++) addSaved(D.polygons[q]);
  renderList();
  updateBar();

  // Frame everything already traced, else the course centre.
  var ids = Object.keys(saved);
  if (ids.length) {
    var group = L.featureGroup(ids.map(function (id) { return saved[id]; }));
    map.fitBounds(group.getBounds(), { padding: [40, 40] });
  }
})();
