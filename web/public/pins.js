/* Pin editor map logic. Reads window.PIN_DATA, renders a satellite map, lets
   the user click/drag to place a hole's cup, and POSTs it to the web server
   (which forwards to the API with the session cookie). */
(function () {
  var D = window.PIN_DATA || { holes: [], center: null, postUrl: '' };
  var hasCenter = Array.isArray(D.center);
  var center = hasCenter ? D.center : [39.5, -98.35];
  var zoom = hasCenter ? 17 : 4;

  var map = L.map('map').setView(center, zoom);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 20, attribution: 'Imagery &copy; Esri',
  }).addTo(map);

  var marker = null, latlng = null, selected = null;
  var info = document.getElementById('pin-info');
  var saveBtn = document.getElementById('pin-save');
  var msg = document.getElementById('pin-msg');

  function findHole(n) {
    for (var i = 0; i < D.holes.length; i++) if (D.holes[i].n === n) return D.holes[i];
    return null;
  }

  function updateBar() {
    if (selected == null) { info.textContent = 'Select a hole to begin.'; saveBtn.disabled = true; return; }
    if (!latlng) { info.textContent = 'Hole ' + selected + ': click the cup on the green.'; saveBtn.disabled = true; return; }
    info.textContent = 'Hole ' + selected + ': ' + latlng.lat.toFixed(5) + ', ' + latlng.lng.toFixed(5);
    saveBtn.disabled = false;
  }

  function setMarker(lat, lng) {
    latlng = { lat: lat, lng: lng };
    if (marker) { marker.setLatLng([lat, lng]); }
    else {
      marker = L.marker([lat, lng], { draggable: true }).addTo(map);
      marker.on('dragend', function () { var p = marker.getLatLng(); latlng = { lat: p.lat, lng: p.lng }; updateBar(); });
    }
    updateBar();
  }
  function clearMarker() { if (marker) { map.removeLayer(marker); marker = null; } latlng = null; }

  function selectHole(n) {
    selected = n; msg.textContent = '';
    var btns = document.querySelectorAll('.hole-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('sel', Number(btns[i].getAttribute('data-n')) === n);
    }
    var h = findHole(n);
    if (h && h.lat != null && h.lng != null) { map.setView([h.lat, h.lng], 19); setMarker(h.lat, h.lng); }
    else { clearMarker(); updateBar(); }
  }

  map.on('click', function (e) {
    if (selected == null) { msg.textContent = 'Pick a hole first.'; return; }
    setMarker(e.latlng.lat, e.latlng.lng);
  });

  var btns = document.querySelectorAll('.hole-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function () { selectHole(Number(this.getAttribute('data-n'))); });
  }

  saveBtn.addEventListener('click', function () {
    if (selected == null || !latlng) return;
    saveBtn.disabled = true; msg.textContent = 'Saving...';
    fetch(D.postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holeNum: selected, lat: latlng.lat, lng: latlng.lng }),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok && res.j && res.j.ok) {
          msg.textContent = 'Saved pin for hole ' + selected + '.';
          var b = document.querySelector('.hole-btn[data-n="' + selected + '"]');
          if (b) b.classList.add('has-pin');
          var h = findHole(selected); if (h) { h.lat = latlng.lat; h.lng = latlng.lng; }
        } else {
          msg.textContent = (res.j && res.j.error) ? res.j.error : 'Could not save pin.';
        }
        saveBtn.disabled = false;
      })
      .catch(function () { msg.textContent = 'Network error. Try again.'; saveBtn.disabled = false; });
  });
})();
