/* Read-only hole-by-hole viewer for a course page. Reads window.COURSE_DATA,
   renders a satellite map (tee -> green) and steps through holes showing par,
   the selected tee's yardage, and stroke index. Mirrors the in-app course
   preview, minus GPS. Degrades gracefully when a hole (or the course) has no
   mapped coordinates. */
(function () {
  var D = window.COURSE_DATA || { holes: [], tees: [], center: null };
  var holes = D.holes || [];
  if (!holes.length) return;

  var info = document.getElementById('hv-info');
  var prevBtn = document.getElementById('hv-prev');
  var nextBtn = document.getElementById('hv-next');
  var teeSel = document.getElementById('hv-tee');
  var mapEl = document.getElementById('hv-map');

  var curIdx = 0;          // index into holes[]
  var curTee = 0;          // index into D.tees[]

  // ----- Map (optional) -----------------------------------------------------
  var map = null, teeLayer = null, pinLayer = null, lineLayer = null;
  if (mapEl && window.L) {
    var c = Array.isArray(D.center) ? D.center : [39.5, -98.35];
    map = L.map('hv-map', { zoomControl: true, attributionControl: true })
      .setView(c, Array.isArray(D.center) ? 16 : 4);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 20, attribution: 'Imagery &copy; Esri',
    }).addTo(map);
  }

  function clearMap() {
    if (!map) return;
    if (teeLayer) { map.removeLayer(teeLayer); teeLayer = null; }
    if (pinLayer) { map.removeLayer(pinLayer); pinLayer = null; }
    if (lineLayer) { map.removeLayer(lineLayer); lineLayer = null; }
  }

  // Haversine distance in yards between two [lat,lng] points.
  function distYds(a, b) {
    var R = 6371000;
    var dLat = (b[0] - a[0]) * Math.PI / 180;
    var dLng = (b[1] - a[1]) * Math.PI / 180;
    var la1 = a[0] * Math.PI / 180, la2 = b[0] * Math.PI / 180;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return Math.round(2 * R * Math.asin(Math.sqrt(x)) * 1.09361);
  }

  function pinIcon() {
    return L.divIcon({ className: 'hv-pin-icon', html: '⛳', iconSize: [22, 22], iconAnchor: [4, 20] });
  }

  function drawHole(h) {
    if (!map) return null;
    clearMap();
    var hasTee = h.tlat != null && h.tlng != null;
    var hasPin = h.plat != null && h.plng != null;
    var straight = null;

    if (hasTee) {
      teeLayer = L.circleMarker([h.tlat, h.tlng], {
        radius: 6, color: '#fff', weight: 2, fillColor: '#d4a93f', fillOpacity: 1,
      }).addTo(map).bindTooltip('Tee', { permanent: false });
    }
    if (hasPin) {
      pinLayer = L.marker([h.plat, h.plng], { icon: pinIcon() }).addTo(map);
    }
    if (hasTee && hasPin) {
      lineLayer = L.polyline([[h.tlat, h.tlng], [h.plat, h.plng]], {
        color: '#d4a93f', weight: 2, dashArray: '6 6', opacity: 0.9,
      }).addTo(map);
      map.fitBounds(lineLayer.getBounds(), { padding: [60, 60], maxZoom: 18 });
      straight = distYds([h.tlat, h.tlng], [h.plat, h.plng]);
    } else if (hasPin) {
      map.setView([h.plat, h.plng], 18);
    } else if (hasTee) {
      map.setView([h.tlat, h.tlng], 18);
    }
    return straight;
  }

  function yardageFor(h) {
    var tee = D.tees[curTee];
    if (tee && tee.yards && tee.yards[h.n] != null) return tee.yards[h.n];
    return null;
  }

  function select(idx) {
    if (idx < 0) idx = holes.length - 1;
    if (idx >= holes.length) idx = 0;
    curIdx = idx;
    var h = holes[idx];

    var btns = document.querySelectorAll('.hole-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('sel', Number(btns[i].getAttribute('data-n')) === h.n);
    }

    var straight = drawHole(h);

    var parts = ['Hole ' + h.n];
    if (h.par != null) parts.push('Par ' + h.par);
    var yd = yardageFor(h);
    if (yd != null) parts.push(yd + ' yds');
    if (h.si != null) parts.push('SI ' + h.si);
    var line = parts.join(' · ');
    if (straight != null) line += '  (' + straight + ' yds tee to green)';
    else if (!map || (h.plat == null && h.tlat == null)) line += '  · not mapped yet';
    if (info) info.textContent = line;
  }

  // ----- Wiring -------------------------------------------------------------
  var btns = document.querySelectorAll('.hole-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function () {
      var n = Number(this.getAttribute('data-n'));
      for (var k = 0; k < holes.length; k++) { if (holes[k].n === n) { select(k); break; } }
    });
  }
  if (prevBtn) prevBtn.addEventListener('click', function () { select(curIdx - 1); });
  if (nextBtn) nextBtn.addEventListener('click', function () { select(curIdx + 1); });
  if (teeSel) teeSel.addEventListener('change', function () { curTee = Number(this.value) || 0; select(curIdx); });

  // Leaflet needs a size recalc once it's actually visible/laid out.
  if (map) setTimeout(function () { map.invalidateSize(); select(0); }, 0);
  else select(0);
})();
